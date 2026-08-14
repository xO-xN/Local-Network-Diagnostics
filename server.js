// Local Network Diagnostics — score server entry point.
//
// A network-only PNDS project: no audio engine, no SuperCollider. The
// server:
// - serves the performer page (join + probe answering) and the monitor
//   page (diagnostics console) on both ports
// - exposes /__pnds/health on both ports (audio mode "none")
// - assigns client ids, restores them on reconnect (claim token)
// - runs the network diagnostics test (baseline + burst phases, start/stop
//   from the monitor, disconnect tracking)
// - shuts down cleanly on SIGINT / SIGTERM

const path = require("node:path");
const express = require("express");

const {
  loadManifest,
  parseCliOptions,
  printUsage,
  resolveServerConfig,
} = require("./lib/config");
const { resolveHostLanIp } = require("./lib/network");
const { HealthTracker } = require("./lib/health");
const { PlayerRegistry } = require("./lib/players");
const {
  DiagnosticsSession,
  PROBE_INTERVAL_MS,
  BASELINE_TIMEOUT_MS,
  BURST_INTERVAL_MS,
  BURST_TIMEOUT_MS,
  BURST_PHASE_MS,
  CALM_PHASE_MS,
} = require("./lib/diagnostics");
const { qrHandler } = require("./lib/qr");
const {
  attachShutdown,
  closeHttpServer,
} = require("./lib/lifecycle");
const shared = require("./public/shared");

const PROJECT_ROOT = __dirname;
const { events: EVENTS } = shared;

// ------------------------------------------------------------
// Configuration
// ------------------------------------------------------------

const manifest = loadManifest(PROJECT_ROOT);
const cliOptions = parseCliOptions(process.argv.slice(2));

if (cliOptions.help) {
  printUsage();
  process.exit(0);
}

const serverConfig = resolveServerConfig(manifest);
const hostLanIp = resolveHostLanIp(process.env.PNDS_HOST_IP);

// ------------------------------------------------------------
// HTTP servers (performer port + monitor port share public/)
// ------------------------------------------------------------

const app = express();
const monitorApp = express();

app.use(express.static(path.join(PROJECT_ROOT, "public")));
monitorApp.use(express.static(path.join(PROJECT_ROOT, "public")));

// Injects manifest ports into the browser so shared.js can read them.
// The single source of truth is manifest.json — shared.js no longer
// hardcodes ports.
function configScript(request, response) {
  response.type("application/javascript").send(
    `window.__PNDS_PORTS__ = { performerPort: ${serverConfig.performerPort}, monitorPort: ${serverConfig.monitorPort} };`
  );
}

app.get("/__config.js", configScript);
monitorApp.get("/__config.js", configScript);

// No audio: the runtime contract's "none" mode (audio.status "disabled").
const health = new HealthTracker({
  projectId: manifest.id,
  audioMode: "none",
  performerPort: serverConfig.performerPort,
  monitorPort: serverConfig.monitorPort,
});

app.get("/__pnds/health", health.handler());
monitorApp.get("/__pnds/health", health.handler());

// QR code for the performer page, shown on the monitor page.
monitorApp.get(
  "/qr",
  qrHandler(`http://${hostLanIp}:${serverConfig.performerPort}/`),
);

// ------------------------------------------------------------
// Client registry + network diagnostics session
// ------------------------------------------------------------

const registry = new PlayerRegistry({
  maxClients: shared.maxClients,
});

// Network diagnostics session (lib/diagnostics.js): per-client metrics and
// status. The probe loop below owns all timers.
const diag = new DiagnosticsSession();

// In-flight probes per client id: id -> seq -> { sentAt, timer }. A probe is
// pending from the moment it is sent until its ack or its timeout. Burst
// phase sends ~30 probes per second per client, so several can be in flight
// at once — hence the per-seq map (baseline's single-pending invariant no
// longer holds).
const pendings = new Map();
const probeSeqs = new Map(); // per-client probe sequence counters

// Burst phase state: the test alternates [2 s burst @ 30 msg/s] →
// [2 s calm @ 1 Hz] while running (spec; issue #5).
let burstActive = false;
let phaseTimer = null;
let freezeTimer = null; // defers the burst-window freeze past the window tail

// ------------------------------------------------------------
// Startup
// ------------------------------------------------------------

const server = app.listen(serverConfig.performerPort, "0.0.0.0", () => {
  printRuntimeInfo();
});

const monitorServer = monitorApp.listen(
  serverConfig.monitorPort,
  "0.0.0.0",
  () => {
    console.log(
      `Monitor page: http://${hostLanIp}:${serverConfig.monitorPort}/`,
    );
  },
);

server.on("error", (error) => {
  console.error(
    `Performer HTTP server failed on port ${serverConfig.performerPort}:`,
    error,
  );
  process.exitCode = 1;
});

monitorServer.on("error", (error) => {
  console.error(
    `Monitor HTTP server failed on port ${serverConfig.monitorPort}:`,
    error,
  );
  process.exitCode = 1;
});

const io = require("socket.io")(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Nothing to wait for: no audio engine, so the project is ready as soon as
// the HTTP servers are up.
health.setAudioDisabled();

// ------------------------------------------------------------
// Socket.IO protocol
// ------------------------------------------------------------

io.on("connection", (socket) => {
  socket.on(EVENTS.join, (payload) => {
    const result = registry.allocate({
      socketId: socket.id,
      claimToken: payload && payload.token,
    });

    if (result.status === "rejected") {
      socket.emit(EVENTS.rejected, {
        reason: result.message,
      });
      socket.disconnect(true);
      return;
    }

    diag.addClient(result.id, Date.now());
    socket.emit(EVENTS.joined, {
      id: result.id,
      token: result.token,
      recovered: result.status === "recovered",
    });
    broadcastState();
  });

  // Diagnostics: the monitor page starts and stops the test; probes go to
  // joined performers only (the monitor socket never joins, so it is never
  // probed itself). Joined performers cannot control the test.
  socket.on(EVENTS.diagStart, () => {
    if (registry.findIdBySocket(socket.id) !== null || diag.running) {
      return;
    }

    diag.start();
    enterBurstPhase();
    broadcastState();
  });

  socket.on(EVENTS.diagStop, () => {
    if (registry.findIdBySocket(socket.id) !== null || !diag.running) {
      return;
    }

    stopBurstCycle();
    clearAllPending();
    diag.stop();
    broadcastState();
  });

  socket.on(EVENTS.diagAck, (payload) => {
    const id = registry.findIdBySocket(socket.id);

    if (id === null || !payload || typeof payload.seq !== "number") {
      return;
    }

    const bySeq = pendings.get(id);
    const pending = bySeq && bySeq.get(payload.seq);

    // A late ack for an already-timed-out probe carries a stale seq and is
    // ignored; the timeout already counted.
    if (!pending) {
      return;
    }

    removePending(id, payload.seq);

    const processingMs =
      typeof payload.t1 === "number" && typeof payload.t0 === "number"
        ? payload.t1 - payload.t0
        : null;

    diag.recordAck(id, Date.now() - pending.sentAt, processingMs);
  });

  socket.on("disconnect", () => {
    const released = registry.releaseBySocket(socket.id);

    if (!released) {
      return;
    }

    clearPending(released.id);

    // The card stays, flips Red immediately and the disconnect is logged
    // (issue #6); a reconnect restores the identity via the claim token.
    diag.disconnectClient(released.id, Date.now());
    broadcastState();
  });
});

function broadcastState() {
  io.emit(EVENTS.state, {
    diag: diag.snapshot(Date.now()),
  });
}

// ------------------------------------------------------------
// Diagnostics probe loop
// ------------------------------------------------------------

function sendProbe(id, socket, timeoutMs) {
  const seq = (probeSeqs.get(id) || 0) + 1;
  const sentAt = Date.now();
  const timer = setTimeout(() => {
    if (removePending(id, seq)) {
      diag.recordTimeout(id);
    }
  }, timeoutMs);

  probeSeqs.set(id, seq);

  let bySeq = pendings.get(id);

  if (!bySeq) {
    bySeq = new Map();
    pendings.set(id, bySeq);
  }

  bySeq.set(seq, { sentAt, timer });
  socket.emit(EVENTS.diagProbe, { seq });
}

// Removes one in-flight probe and prunes the per-client map when it empties.
// Returns true when the probe was actually pending.
function removePending(id, seq) {
  const bySeq = pendings.get(id);

  if (!bySeq || !bySeq.has(seq)) {
    return false;
  }

  clearTimeout(bySeq.get(seq).timer);
  bySeq.delete(seq);

  if (bySeq.size === 0) {
    pendings.delete(id);
  }

  return true;
}

function clearPending(id) {
  const bySeq = pendings.get(id);

  if (bySeq) {
    for (const pending of bySeq.values()) {
      clearTimeout(pending.timer);
    }

    pendings.delete(id);
  }
}

function clearAllPending() {
  for (const id of [...pendings.keys()]) {
    clearPending(id);
  }
}

// One probe cycle per second: baseline probes only in the calm phase (the
// burst timer covers the burst phase), then a status cycle + broadcast.
function diagTick() {
  if (!diag.running) {
    return;
  }

  if (!burstActive) {
    for (const assignment of registry.list()) {
      const socket = io.sockets.sockets.get(assignment.socketId);

      if (socket) {
        sendProbe(assignment.id, socket, BASELINE_TIMEOUT_MS);
      }
    }
  }

  diag.cycleAll();
  broadcastState();
}

const diagTimer = setInterval(diagTick, PROBE_INTERVAL_MS);

// ------------------------------------------------------------
// Burst phase (issue #5): while the test runs, alternate 2 s of 30 msg/s
// probes (200 ms timeout) with 2 s of baseline (1 Hz / 500 ms), repeating.
// ------------------------------------------------------------

function burstTick() {
  if (!diag.running || !burstActive) {
    return;
  }

  for (const assignment of registry.list()) {
    const socket = io.sockets.sockets.get(assignment.socketId);

    if (socket) {
      sendProbe(assignment.id, socket, BURST_TIMEOUT_MS);
    }
  }
}

const burstTimer = setInterval(burstTick, BURST_INTERVAL_MS);

function enterBurstPhase() {
  burstActive = true;
  diag.setPhase(shared.diagPhases.burst);
  diag.beginBurstWindow();
  phaseTimer = setTimeout(enterCalmPhase, BURST_PHASE_MS);
}

function enterCalmPhase() {
  burstActive = false;
  diag.setPhase(shared.diagPhases.calm);
  // Freeze the window's timeout rate a burst-timeout after the last probe:
  // probes sent in the window's tail time out up to 200 ms later and must
  // still count towards this window, not the next one.
  freezeTimer = setTimeout(() => {
    diag.endBurstWindow();
    freezeTimer = null;
  }, BURST_TIMEOUT_MS);
  phaseTimer = setTimeout(enterBurstPhase, CALM_PHASE_MS);
}

function stopBurstCycle() {
  burstActive = false;
  diag.setPhase(shared.diagPhases.calm);
  clearTimeout(phaseTimer);
  phaseTimer = null;
  clearTimeout(freezeTimer);
  freezeTimer = null;
  diag.endBurstWindow();
}

// ------------------------------------------------------------
// Shutdown
// ------------------------------------------------------------

attachShutdown({
  onShutdown: async () => {
    health.setStopping();
    clearInterval(diagTimer);
    clearInterval(burstTimer);
    clearTimeout(phaseTimer);
    clearTimeout(freezeTimer);
    clearAllPending();
    io.close();
    await closeHttpServer(server);
    await closeHttpServer(monitorServer);
  },
});

// ------------------------------------------------------------
// Console output
// ------------------------------------------------------------

function printRuntimeInfo() {
  console.log(`[server] ${manifest.name} v${manifest.version}`);
  console.log(`[server] audio: disabled (network-only project)`);
  console.log(
    `[server] performer page: http://${hostLanIp}:${serverConfig.performerPort}/`,
  );
}
