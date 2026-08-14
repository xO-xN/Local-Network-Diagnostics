const assert = require("node:assert/strict");
const test = require("node:test");
const { spawn } = require("node:child_process");
const path = require("node:path");

const { io } = require("socket.io-client");

const PROJECT_ROOT = path.join(__dirname, "..");
const PERFORMER_URL = "http://127.0.0.1:6868";
const MONITOR_URL = "http://127.0.0.1:6869";
const HEALTH_URL = `${PERFORMER_URL}/__pnds/health`;

const { events: EVENTS } = require("../public/shared");
const { STATUS } = require("../lib/diagnostics");

function waitForHealthReady() {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    const tick = async () => {
      attempts += 1;

      try {
        const response = await fetch(HEALTH_URL);
        const payload = await response.json();

        if (payload.status === "ready") {
          resolve(payload);
          return;
        }
      } catch {
        // server not up yet
      }

      if (attempts >= 40) {
        reject(new Error("server never reported health ready"));
        return;
      }

      setTimeout(tick, 250);
    };

    tick();
  });
}

function joinWithToken(token) {
  return new Promise((resolve, reject) => {
    const socket = io(PERFORMER_URL, { reconnection: false });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("join timeout"));
    }, 5000);

    socket.on("connect", () => {
      socket.emit("join", { token: token || null });
    });

    socket.on("joined", (data) => {
      clearTimeout(timer);
      resolve({ socket, data });
    });

    socket.on("rejected", (data) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(`rejected: ${data.reason}`));
    });
  });
}

// Waits for the next "state" broadcast that satisfies the predicate.
// (The server also broadcasts on join, so a plain once() can catch a stale
// snapshot.)
function waitForState(socket, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("state", onState);
      reject(new Error("state timeout"));
    }, timeoutMs);

    const onState = (data) => {
      if (predicate(data)) {
        clearTimeout(timer);
        resolve(data);
      }
    };

    socket.on("state", onState);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Kills the spawned server and waits for the process to actually exit, so
// the next test can bind the same ports. Graceful SIGTERM first (exercises
// the shutdown path), SIGKILL as a backstop.
function stopServer(server) {
  return new Promise((resolve) => {
    if (server.exitCode !== null || server.signalCode !== null) {
      resolve();
      return;
    }

    const force = setTimeout(() => server.kill("SIGKILL"), 3000);
    server.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    server.kill("SIGTERM");
  });
}

// A plain Socket.IO connection that never joins — this is how the monitor
// page connects (it receives state broadcasts but is never probed).
function connectMonitorSocket() {
  return new Promise((resolve, reject) => {
    const socket = io(PERFORMER_URL, { reconnection: false });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("monitor connect timeout"));
    }, 5000);

    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

test("score server: health, join, reconnect, pages", async (t) => {
  const server = spawn(process.execPath, ["server.js", "--audio-mode", "none"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
  });

  t.after(async () => stopServer(server));

  const health = await waitForHealthReady();

  assert.equal(health.projectId, "local-network-diagnostics");
  assert.equal(health.audioMode, "none");
  assert.equal(health.audio.status, "disabled", "no-audio project reports disabled");
  assert.equal(health.scoreServer.performerPort, 6868);
  assert.equal(health.scoreServer.monitorPort, 6869);

  // --- join: first client gets id 1 + a claim token ---
  const first = await joinWithToken(null);
  t.after(() => first.socket.close());

  assert.equal(first.data.id, 1);
  assert.equal(typeof first.data.token, "string");
  assert.equal(first.data.token.length, 48);
  assert.equal(first.data.recovered, false);

  // --- reconnect with token recovers id 1 ---
  first.socket.close();

  const rejoined = await joinWithToken(first.data.token);
  t.after(() => rejoined.socket.close());

  // The claim token restores the identity: the id comes back (free-id
  // reuse) and the diagnostics session records a Reconnected event. The
  // registry's `recovered` flag means "token matched a still-live
  // assignment" — after a disconnect the assignment is gone, so it is false
  // here by design.
  assert.equal(rejoined.data.id, 1);
  assert.equal(rejoined.data.recovered, false);

  // --- pages served on both ports: one index, two role scripts ---
  const performerResponse = await fetch(`${PERFORMER_URL}/`);
  const monitorResponse = await fetch(`${MONITOR_URL}/`);

  assert.equal(performerResponse.status, 200);
  assert.equal(monitorResponse.status, 200);

  const performerHtml = await performerResponse.text();
  const monitorHtml = await monitorResponse.text();

  assert.match(performerHtml, /performer\.js/);
  assert.match(monitorHtml, /monitor\.js/);

  // The performer page is the minimal "connected, testing" client…
  const performerJs = await (await fetch(`${PERFORMER_URL}/performer.js`)).text();
  assert.match(performerJs, /Connected, testing/);
  assert.doesNotMatch(performerJs, /p5/);

  // …and the monitor page is the operator console: it auto-starts the test
  // on open (no Start button) and shows the centered Overall banner.
  const monitorJs = await (await fetch(`${MONITOR_URL}/monitor.js`)).text();
  assert.match(monitorJs, /diagStart/);
  assert.match(monitorJs, /Overall/);
  assert.doesNotMatch(monitorJs, /p5/);
  assert.doesNotMatch(monitorJs, /Start Test/);
});

// ------------------------------------------------------------
// Diagnostics (issues #3–#8): baseline + burst probe loop, status machine,
// burst timeout stats, disconnect/event log, Overall aggregation
// ------------------------------------------------------------

test("diagnostics: start → live probes (burst + calm), client acks to Green; stop halts probing", async (t) => {
  const server = spawn(process.execPath, ["server.js", "--audio-mode", "none"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
  });

  t.after(async () => stopServer(server));

  await waitForHealthReady();

  const client = await joinWithToken(null);
  t.after(() => client.socket.close());

  let probes = 0;

  // The performer page behaviour: ack every probe immediately.
  client.socket.on(EVENTS.diagProbe, (payload) => {
    probes += 1;
    const t0 = performance.now();

    client.socket.emit(EVENTS.diagAck, {
      seq: payload.seq,
      t0,
      t1: performance.now(),
    });
  });

  const monitor = await connectMonitorSocket();
  t.after(() => monitor.close());

  monitor.emit(EVENTS.diagStart);

  // Warm-up is 2 probe cycles (~2 s); with healthy loopback RTTs the
  // client should reach Green shortly after.
  const green = await waitForState(
    client.socket,
    (state) =>
      state.diag &&
      state.diag.running === true &&
      state.diag.clients["1"] &&
      state.diag.clients["1"].status === STATUS.GREEN,
    15000,
  );

  const metrics = green.diag.clients["1"].metrics;

  assert.equal(typeof metrics.rttP50, "number");
  assert.equal(typeof metrics.rttP95, "number");
  assert.equal(typeof metrics.jitterP95, "number");
  assert.ok(metrics.samples >= 1, "expected at least one sample");
  assert.equal(metrics.timeouts, 0);
  assert.equal(green.diag.overall, STATUS.GREEN);
  assert.ok(probes >= 2, "expected at least 2 probes before Green");

  // A second client joining mid-test warms up, reaches Green, and both are
  // reflected in Overall (multi-client smoke).
  const second = await joinWithToken(null);
  t.after(() => second.socket.close());

  assert.equal(second.data.id, 2);

  second.socket.on(EVENTS.diagProbe, (payload) => {
    const t0 = performance.now();

    second.socket.emit(EVENTS.diagAck, {
      seq: payload.seq,
      t0,
      t1: performance.now(),
    });
  });

  const bothGreen = await waitForState(
    client.socket,
    (state) =>
      state.diag &&
      state.diag.running === true &&
      state.diag.clients["1"] &&
      state.diag.clients["1"].status === STATUS.GREEN &&
      state.diag.clients["2"] &&
      state.diag.clients["2"].status === STATUS.GREEN,
    15000,
  );

  assert.equal(bothGreen.diag.overall, STATUS.GREEN);

  // Stop: the server stops probing. A few probes may already be in flight
  // (the burst phase sends ~30 msg/s), so allow a small tail, then require
  // silence.
  monitor.emit(EVENTS.diagStop);

  await waitForState(
    client.socket,
    (state) => state.diag && state.diag.running === false,
    5000,
  );

  const probesAtStop = probes;
  await delay(1400);
  const probesLater = probes;

  assert.ok(
    probesLater <= probesAtStop + 5,
    `probes kept arriving after stop: ${probesAtStop} → ${probesLater}`,
  );

  await delay(1200);
  assert.equal(probes, probesLater, "probes still arriving after stop");
});

test("diagnostics: Yellow under simulated latency, Red after 3 consecutive timeouts", async (t) => {
  const server = spawn(process.execPath, ["server.js", "--audio-mode", "none"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
  });

  t.after(async () => stopServer(server));

  await waitForHealthReady();

  const client = await joinWithToken(null);
  t.after(() => client.socket.close());

  let acking = true;

  // 150 ms added latency: RTT ≈ 150 ms (below the 200 ms burst timeout and
  // the 500 ms baseline timeout, above the 100 ms Yellow threshold — in
  // both phases).
  client.socket.on(EVENTS.diagProbe, (payload) => {
    if (!acking) {
      return;
    }

    const t0 = performance.now();

    setTimeout(() => {
      client.socket.emit(EVENTS.diagAck, {
        seq: payload.seq,
        t0,
        t1: performance.now(),
      });
    }, 150);
  });

  const monitor = await connectMonitorSocket();
  t.after(() => monitor.close());

  monitor.emit(EVENTS.diagStart);

  const yellow = await waitForState(
    client.socket,
    (state) =>
      state.diag &&
      state.diag.clients["1"] &&
      state.diag.clients["1"].status === STATUS.YELLOW,
    15000,
  );

  assert.ok(
    yellow.diag.clients["1"].metrics.rttP95 > 100,
    "expected RTT p95 above the Yellow threshold",
  );
  assert.equal(yellow.diag.overall, STATUS.YELLOW);

  // Stop acking: three consecutive 500 ms timeouts → Red.
  acking = false;

  const red = await waitForState(
    client.socket,
    (state) =>
      state.diag &&
      state.diag.clients["1"] &&
      state.diag.clients["1"].status === STATUS.RED,
    15000,
  );

  assert.ok(
    red.diag.clients["1"].metrics.consecutiveTimeouts >= 3,
    "expected at least 3 consecutive timeouts",
  );
  assert.equal(red.diag.overall, STATUS.RED);

  // The mandated Red copy must be in the served pages (shared.js is the
  // single source of truth the monitor renders from).
  const sharedResponse = await fetch(`${MONITOR_URL}/shared.js`);
  const sharedJs = await sharedResponse.text();

  assert.match(sharedJs, /Not suitable for performance/);
});

test("diagnostics: Overall follows the worst online client across several clients (issue #7)", async (t) => {
  const server = spawn(process.execPath, ["server.js", "--audio-mode", "none"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
  });

  t.after(async () => stopServer(server));

  await waitForHealthReady();

  const clients = [];

  const joinAcker = async () => {
    const joined = await joinWithToken(null);
    let mode = "fast"; // "fast" | "slow" | "off"

    joined.socket.on(EVENTS.diagProbe, (payload) => {
      if (mode === "off") {
        return;
      }

      const t0 = performance.now();

      setTimeout(() => {
        joined.socket.emit(EVENTS.diagAck, {
          seq: payload.seq,
          t0,
          t1: performance.now(),
        });
      }, mode === "slow" ? 150 : 0);
    });

    joined.mode = (next) => {
      mode = next;
    };
    return joined;
  };

  t.after(() => clients.forEach((joined) => joined.socket.close()));

  const monitor = await connectMonitorSocket();
  t.after(() => monitor.close());

  // Two clients join before the test starts…
  clients.push(await joinAcker());
  clients.push(await joinAcker());

  monitor.emit(EVENTS.diagStart);

  // …and a third joins mid-test: it must be probed and included after its
  // warm-up (issue #7 AC: "A client joining mid-test is automatically
  // included after its warm-up").
  clients.push(await joinAcker());
  assert.equal(clients[2].data.id, 3);

  // All three warm up to Green; the late joiner is included automatically.
  const allGreen = await waitForState(
    monitor,
    (state) =>
      state.diag &&
      state.diag.running === true &&
      ["1", "2", "3"].every(
        (id) => state.diag.clients[id] && state.diag.clients[id].status === STATUS.GREEN,
      ),
    20000,
  );
  assert.equal(allGreen.diag.overall, STATUS.GREEN);

  // Client 3 degrades to ~150 ms RTT → Yellow → Overall Yellow.
  clients[2].mode("slow");

  const yellow = await waitForState(
    monitor,
    (state) =>
      state.diag &&
      state.diag.clients["3"] &&
      state.diag.clients["3"].status === STATUS.YELLOW &&
      state.diag.overall === STATUS.YELLOW,
    20000,
  );

  assert.ok(
    yellow.diag.clients["3"].metrics.rttP95 > 100,
    "expected client 3 RTT p95 above the Yellow threshold",
  );

  // Client 3 stops acking → Red → Overall Red.
  clients[2].mode("off");

  const red = await waitForState(
    monitor,
    (state) =>
      state.diag &&
      state.diag.clients["3"] &&
      state.diag.clients["3"].status === STATUS.RED &&
      state.diag.overall === STATUS.RED,
    20000,
  );

  assert.ok(
    red.diag.clients["3"].metrics.consecutiveTimeouts >= 3,
    "expected client 3 to reach Red via consecutive timeouts",
  );

  monitor.emit(EVENTS.diagStop);

  await waitForState(
    monitor,
    (state) => state.diag && state.diag.running === false,
    5000,
  );
});

test("diagnostics: burst cycle alternates ~30 msg/s with 1 Hz calm, repeating (issue #5)", async (t) => {
  const server = spawn(process.execPath, ["server.js", "--audio-mode", "none"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
  });

  t.after(async () => stopServer(server));

  await waitForHealthReady();

  const client = await joinWithToken(null);
  t.after(() => client.socket.close());

  let probes = 0;

  client.socket.on(EVENTS.diagProbe, (payload) => {
    probes += 1;
    const t0 = performance.now();

    client.socket.emit(EVENTS.diagAck, {
      seq: payload.seq,
      t0,
      t1: performance.now(),
    });
  });

  const monitor = await connectMonitorSocket();
  t.after(() => monitor.close());

  monitor.emit(EVENTS.diagStart);

  // Phase 1: the test starts in the burst phase — ~30 probes per second.
  await waitForState(
    monitor,
    (state) => state.diag && state.diag.phase === "burst",
    5000,
  );

  const atBurstStart = probes;
  await delay(1100);
  const burstRate = probes - atBurstStart;

  assert.ok(
    burstRate >= 20 && burstRate <= 45,
    `burst cadence off: ${burstRate} probes in ~1.1 s (expect ~30)`,
  );

  // Phase 2: calm — back to ~1 probe per second.
  await waitForState(
    monitor,
    (state) => state.diag && state.diag.phase === "calm",
    8000,
  );

  const atCalmStart = probes;
  await delay(1100);
  const calmRate = probes - atCalmStart;

  assert.ok(
    calmRate <= 3,
    `calm cadence off: ${calmRate} probes in ~1.1 s (expect ~1)`,
  );

  // The cycle repeats: burst → calm once more.
  await waitForState(
    monitor,
    (state) => state.diag && state.diag.phase === "burst",
    8000,
  );
  await waitForState(
    monitor,
    (state) => state.diag && state.diag.phase === "calm",
    8000,
  );

  // Stop halts probing entirely.
  monitor.emit(EVENTS.diagStop);

  await waitForState(
    monitor,
    (state) => state.diag && state.diag.running === false,
    5000,
  );

  const probesAtStop = probes;
  await delay(1400);
  const probesLater = probes;

  assert.ok(
    probesLater <= probesAtStop + 5,
    `probes kept arriving after stop: ${probesAtStop} → ${probesLater}`,
  );

  await delay(1200);
  assert.equal(probes, probesLater, "probes still arriving after stop");
});

test("diagnostics: burst timeout rate above 5% drives Red (issue #5)", async (t) => {
  const server = spawn(process.execPath, ["server.js", "--audio-mode", "none"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
  });

  t.after(async () => stopServer(server));

  await waitForHealthReady();

  const client = await joinWithToken(null);
  t.after(() => client.socket.close());

  let dropEveryFifth = false;

  // Drop every 5th probe (isolated losses): the dropped probes hit the
  // 200 ms burst timeout, so the burst window ends at ~20% timeouts while
  // the consecutive-timeout streak never reaches 3 — the burst-rate rule
  // (spec priority 3) is the one that turns the card Red, not the
  // consecutive-timeout rule (priority 2, which fires at 30 msg/s as soon
  // as three probes in a row go missing).
  client.socket.on(EVENTS.diagProbe, (payload) => {
    if (dropEveryFifth && payload.seq % 5 === 0) {
      return;
    }

    const t0 = performance.now();

    client.socket.emit(EVENTS.diagAck, {
      seq: payload.seq,
      t0,
      t1: performance.now(),
    });
  });

  const monitor = await connectMonitorSocket();
  t.after(() => monitor.close());

  monitor.emit(EVENTS.diagStart);

  await waitForState(
    monitor,
    (state) => state.diag && state.diag.phase === "burst",
    5000,
  );

  dropEveryFifth = true;

  const red = await waitForState(
    monitor,
    (state) =>
      state.diag &&
      state.diag.clients["1"] &&
      state.diag.clients["1"].status === STATUS.RED,
    15000,
  );

  const metrics = red.diag.clients["1"].metrics;

  assert.ok(
    metrics.burstTimeoutRate > 0.05,
    `expected burst timeout rate > 5%, got ${metrics.burstTimeoutRate}`,
  );
  assert.ok(
    metrics.consecutiveTimeouts < 3,
    "Red must come from the burst-timeout rule, not consecutive timeouts",
  );
  assert.equal(
    red.diag.clients["1"].reason,
    "Burst timeout rate above 5%",
  );

  monitor.emit(EVENTS.diagStop);

  await waitForState(
    monitor,
    (state) => state.diag && state.diag.running === false,
    5000,
  );
});

test("diagnostics: disconnect → Red card, reconnect via token → warming up → Green (issue #6)", async (t) => {
  const server = spawn(process.execPath, ["server.js", "--audio-mode", "none"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
  });

  t.after(async () => stopServer(server));

  await waitForHealthReady();

  const client = await joinWithToken(null);
  t.after(() => client.socket.close());

  const token = client.data.token;

  client.socket.on(EVENTS.diagProbe, (payload) => {
    const t0 = performance.now();

    client.socket.emit(EVENTS.diagAck, {
      seq: payload.seq,
      t0,
      t1: performance.now(),
    });
  });

  const monitor = await connectMonitorSocket();
  t.after(() => monitor.close());

  monitor.emit(EVENTS.diagStart);

  await waitForState(
    monitor,
    (state) =>
      state.diag &&
      state.diag.running === true &&
      state.diag.clients["1"] &&
      state.diag.clients["1"].status === STATUS.GREEN,
    15000,
  );

  // The socket drops: the card stays and flips Red immediately.
  client.socket.close();

  const red = await waitForState(
    monitor,
    (state) =>
      state.diag &&
      state.diag.clients["1"] &&
      state.diag.clients["1"].status === STATUS.RED &&
      state.diag.clients["1"].connected === false,
    15000,
  );

  assert.equal(red.diag.clients["1"].reason, "Disconnected");
  assert.equal(red.diag.clients["1"].lastEvent.type, "disconnected");
  assert.ok(
    red.diag.clients["1"].lastEvent.agoMs < 5000,
    "expected the disconnect event to be recent",
  );
  // No online clients left → Overall is Gray (Overall only counts online
  // clients; the Red card remains the per-client signal).
  assert.equal(red.diag.overall, STATUS.GRAY);

  // Reconnect with the same claim token: identity restored (id 1), the
  // machine resets and returns through warm-up to Green. (The registry's
  // `recovered` flag stays false after a disconnect — see the health test.)
  const rejoined = await joinWithToken(token);
  t.after(() => rejoined.socket.close());

  assert.equal(rejoined.data.id, 1);

  rejoined.socket.on(EVENTS.diagProbe, (payload) => {
    const t0 = performance.now();

    rejoined.socket.emit(EVENTS.diagAck, {
      seq: payload.seq,
      t0,
      t1: performance.now(),
    });
  });

  // The ticket's full path: reconnect → warming up (Gray) → Green.
  const warming = await waitForState(
    monitor,
    (state) =>
      state.diag &&
      state.diag.clients["1"] &&
      state.diag.clients["1"].status === STATUS.GRAY &&
      state.diag.clients["1"].connected === true,
    10000,
  );

  assert.equal(warming.diag.clients["1"].lastEvent.type, "reconnected");

  const recovered = await waitForState(
    monitor,
    (state) =>
      state.diag &&
      state.diag.clients["1"] &&
      state.diag.clients["1"].status === STATUS.GREEN &&
      state.diag.clients["1"].connected === true,
    15000,
  );

  assert.equal(recovered.diag.clients["1"].lastEvent.type, "reconnected");
  assert.equal(recovered.diag.overall, STATUS.GREEN);

  monitor.emit(EVENTS.diagStop);

  await waitForState(
    monitor,
    (state) => state.diag && state.diag.running === false,
    5000,
  );
});
