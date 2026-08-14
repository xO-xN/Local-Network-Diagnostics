// Local Network Diagnostics — score server entry point.
//
// Orchestrates the reusable core (lib/) and the work layer (audio/controller.js):
// - serves performer + monitor pages from public/ on both ports
// - exposes /__pnds/health on both ports
// - assigns client ids, restores them on reconnect (claim token)
// - forwards fader controls to the audio layer
// - broadcasts client state to the monitor page
// - runs the network diagnostics probe loop (start/stop from the monitor)
// - shuts down cleanly on SIGINT / SIGTERM

const path = require("node:path");
const express = require("express");

const {
  loadManifest,
  parseCliOptions,
  printUsage,
  resolveAudioMode,
  resolveOscTarget,
  resolveServerConfig,
  formatAudioMode,
} = require("./lib/config");
const { resolveHostLanIp } = require("./lib/network");
const { HealthTracker } = require("./lib/health");
const { AudioEngine } = require("./lib/audio-engine");
const { PlayerRegistry } = require("./lib/players");
const {
  DiagnosticsSession,
  PROBE_INTERVAL_MS,
  BASELINE_TIMEOUT_MS,
} = require("./lib/diagnostics");
const { qrHandler } = require("./lib/qr");
const { ProjectAudio } = require("./audio/controller");
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

const audioMode = resolveAudioMode(cliOptions.audioMode, manifest);
const oscTarget = resolveOscTarget(
  cliOptions.oscTarget,
  manifest,
  process.env,
);
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

const health = new HealthTracker({
  projectId: manifest.id,
  audioMode,
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
// Audio layer
// ------------------------------------------------------------

const audioEngine = new AudioEngine({
  mode: audioMode,
  target: oscTarget,
  projectRoot: PROJECT_ROOT,
  manifest,
  environment: process.env,
});
const projectAudio = new ProjectAudio(audioEngine);

const registry = new PlayerRegistry({
  maxClients: audioEngine.outputChannels,
});

// Network diagnostics session (lib/diagnostics.js): per-client metrics and
// status. The probe loop below owns all timers.
const diag = new DiagnosticsSession();

// In-flight probes per client id: { seq, sentAt, timer }. A probe is
// pending from the moment it is sent until its ack or its timeout.
const pendings = new Map();
const probeSeqs = new Map(); // per-client probe sequence counters

// Last known controls per claim token, restored when a client reconnects.
// (Ids are reused after a disconnect; the token is the persistent identity.)
const lastControls = new Map();

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

async function startAudio() {
  health.setAudioStarting();

  try {
    await projectAudio.start();
    health.setAudioReady(oscTarget);
  } catch (error) {
    console.error("[audio] start failed:", error);
    health.setError(error);
    process.exitCode = 1;
  }
}

startAudio();

// ------------------------------------------------------------
// Socket.IO protocol
// ------------------------------------------------------------

io.on("connection", (socket) => {
  socket.on(EVENTS.join, async (payload) => {
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

    diag.addClient(result.id);

    try {
      if (!projectAudio.voices.has(result.id)) {
        await projectAudio.addVoice(result.id);
      }

      // State recovery is keyed by the persistent claim token, not the id:
      // ids are reused after a disconnect, the token is the identity.
      const last = lastControls.get(result.token);

      if (last) {
        await projectAudio.setControls(result.id, last);
        await projectAudio.setOutChannel(result.id, last.out);
      }

      socket.emit(EVENTS.joined, {
        id: result.id,
        token: result.token,
        recovered: Boolean(last),
      });

      broadcastState();
    } catch (error) {
      console.error(`[server] failed to create voice for client ${result.id}:`, error);
      registry.release(result.id);
      diag.removeClient(result.id);
      socket.emit(EVENTS.rejected, {
        reason: "Audio voice could not be created.",
      });
      socket.disconnect(true);
    }
  });

  socket.on(EVENTS.control, async (payload) => {
    const id = registry.findIdBySocket(socket.id);

    if (id === null) {
      return;
    }

    try {
      await projectAudio.setControls(id, {
        amp: payload && payload.amp,
        freq: payload && payload.freq,
      });

      const voice = projectAudio.voices.get(id);
      const token = registry.getTokenBySocket(socket.id);

      if (voice && token) {
        lastControls.set(token, {
          amp: voice.amp,
          freq: voice.freq,
          out: voice.out,
        });
      }

      broadcastState();
    } catch (error) {
      console.error(`[server] control failed for client ${id}:`, error);
    }
  });

  socket.on(EVENTS.setOut, async (payload) => {
    const id = registry.findIdBySocket(socket.id);

    if (id === null || !payload || payload.out === undefined) {
      return;
    }

    try {
      await projectAudio.setOutChannel(id, payload.out);

      const voice = projectAudio.voices.get(id);
      const token = registry.getTokenBySocket(socket.id);

      if (voice && token) {
        lastControls.set(token, {
          amp: voice.amp,
          freq: voice.freq,
          out: voice.out,
        });
      }

      broadcastState();
    } catch (error) {
      console.error(`[server] set-out failed for client ${id}:`, error);
    }
  });

  // Diagnostics: the monitor page starts and stops the test; probes go to
  // joined performers only (the monitor socket never joins, so it is never
  // probed itself). Joined performers cannot control the test.
  socket.on(EVENTS.diagStart, () => {
    if (registry.findIdBySocket(socket.id) !== null) {
      return;
    }

    diag.start();
    broadcastState();
  });

  socket.on(EVENTS.diagStop, () => {
    if (registry.findIdBySocket(socket.id) !== null) {
      return;
    }

    clearAllPending();
    diag.stop();
    broadcastState();
  });

  socket.on(EVENTS.diagAck, (payload) => {
    const id = registry.findIdBySocket(socket.id);

    if (id === null || !payload || typeof payload.seq !== "number") {
      return;
    }

    const pending = pendings.get(id);

    // A late ack for an already-timed-out probe carries a stale seq and is
    // ignored; the timeout already counted.
    if (!pending || pending.seq !== payload.seq) {
      return;
    }

    clearTimeout(pending.timer);
    pendings.delete(id);

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
    diag.removeClient(released.id);

    const voice = projectAudio.voices.get(released.id);

    if (voice) {
      lastControls.set(released.claimToken, {
        amp: voice.amp,
        freq: voice.freq,
        out: voice.out,
      });
    }

    projectAudio
      .removeVoice(released.id)
      .catch((error) => {
        console.error(`[server] failed to release voice for client ${released.id}:`, error);
      })
      .finally(() => {
        broadcastState();
      });
  });
});

function broadcastState() {
  io.emit(EVENTS.state, {
    clients: projectAudio.snapshot(),
    diag: diag.snapshot(),
  });
}

// ------------------------------------------------------------
// Diagnostics probe loop
// ------------------------------------------------------------

function sendProbe(id, socket) {
  const seq = (probeSeqs.get(id) || 0) + 1;
  const sentAt = Date.now();
  const timer = setTimeout(() => {
    const pending = pendings.get(id);

    if (pending && pending.seq === seq) {
      pendings.delete(id);
      diag.recordTimeout(id);
    }
  }, BASELINE_TIMEOUT_MS);

  probeSeqs.set(id, seq);
  pendings.set(id, { seq, sentAt, timer });
  socket.emit(EVENTS.diagProbe, { seq });
}

function clearPending(id) {
  const pending = pendings.get(id);

  if (pending) {
    clearTimeout(pending.timer);
  }

  pendings.delete(id);
}

function clearAllPending() {
  for (const id of [...pendings.keys()]) {
    clearPending(id);
  }
}

// One baseline probe per second per joined client, then a status cycle.
function diagTick() {
  if (!diag.running) {
    return;
  }

  for (const assignment of registry.list()) {
    const socket = io.sockets.sockets.get(assignment.socketId);

    if (socket) {
      sendProbe(assignment.id, socket);
    }
  }

  diag.cycleAll();
  broadcastState();
}

const diagTimer = setInterval(diagTick, PROBE_INTERVAL_MS);

// ------------------------------------------------------------
// Shutdown
// ------------------------------------------------------------

attachShutdown({
  onShutdown: async () => {
    health.setStopping();
    clearInterval(diagTimer);
    clearAllPending();
    io.close();
    await projectAudio.stop();
    await closeHttpServer(server);
    await closeHttpServer(monitorServer);
  },
});

// ------------------------------------------------------------
// Console output
// ------------------------------------------------------------

function printRuntimeInfo() {
  console.log(`[server] ${manifest.name} v${manifest.version}`);
  console.log(
    `[server] audio mode: ${formatAudioMode(audioMode)} (target ${oscTarget})`,
  );
  console.log(
    `[server] output: ${audioEngine.outputChannels} channels from bus ${audioEngine.outputBus}`,
  );
  console.log(
    `[server] performer page: http://${hostLanIp}:${serverConfig.performerPort}/`,
  );
}
