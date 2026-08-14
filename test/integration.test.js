const assert = require("node:assert/strict");
const test = require("node:test");
const { spawn } = require("node:child_process");
const path = require("node:path");

const { io } = require("socket.io-client");

const PROJECT_ROOT = path.join(__dirname, "..");
const PERFORMER_URL = "http://127.0.0.1:6868";
const MONITOR_URL = "http://127.0.0.1:6869";
const HEALTH_URL = `${PERFORMER_URL}/__pnds/health`;

const { freqRange, events: EVENTS } = require("../public/shared");
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

test("score server: health, join, control, set-out, reconnect, pages", async (t) => {
  const server = spawn(process.execPath, ["server.js", "--audio-mode", "none"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
  });

  t.after(async () => stopServer(server));

  const health = await waitForHealthReady();

  assert.equal(health.projectId, "local-network-diagnostics");
  assert.equal(health.audioMode, "none");
  assert.equal(health.scoreServer.performerPort, 6868);
  assert.equal(health.scoreServer.monitorPort, 6869);

  // --- join: first client gets id 1 + a claim token ---
  const first = await joinWithToken(null);
  t.after(() => first.socket.close());

  assert.equal(first.data.id, 1);
  assert.equal(typeof first.data.token, "string");
  assert.equal(first.data.token.length, 48);

  // --- control: monitor receives amp (audio-taper curve) and freq ---
  first.socket.emit("control", { amp: 0.5, freq: 0.5 });

  const expectedMidFreq = Math.round(
    freqRange.min + 0.5 * (freqRange.max - freqRange.min),
  );

  const controlState = await waitForState(
    first.socket,
    (state) =>
      state.clients.length === 1 &&
      state.clients[0].id === 1 &&
      state.clients[0].amp === 0.25 && // mapAmp(0.5) = 0.5^2
      state.clients[0].freq === expectedMidFreq, // freqRange.min + 0.5 * (max - min)
  );

  assert.equal(controlState.clients[0].amp, 0.25);
  assert.equal(controlState.clients[0].freq, expectedMidFreq);

  // --- set-out: channel reassignment is reflected ---
  first.socket.emit("set-out", { out: 5 });

  const outState = await waitForState(
    first.socket,
    (state) => state.clients.length === 1 && state.clients[0].out === 5,
  );

  assert.equal(outState.clients[0].out, 5);

  // --- second client: id 2, default channel 2 (even id) ---
  const second = await joinWithToken(null);
  t.after(() => second.socket.close());

  assert.equal(second.data.id, 2);

  second.socket.emit("control", { amp: 0.25, freq: 0 });

  const secondState = await waitForState(
    first.socket,
    (state) => state.clients.length === 2 && state.clients[1].id === 2,
  );

  assert.equal(secondState.clients[1].freq, freqRange.min); // freqValue 0 → freqRange.min
  assert.equal(secondState.clients[1].out, 2); // even id -> channel 2

  // --- reconnect with token recovers id 1 ---
  first.socket.close();

  const rejoined = await joinWithToken(first.data.token);
  t.after(() => rejoined.socket.close());

  assert.equal(rejoined.data.id, 1);
  assert.equal(rejoined.data.recovered, true);

  // --- pages served on both ports ---
  const performerResponse = await fetch(`${PERFORMER_URL}/`);
  const monitorResponse = await fetch(`${MONITOR_URL}/`);

  assert.equal(performerResponse.status, 200);
  assert.equal(monitorResponse.status, 200);

  const monitorHtml = await monitorResponse.text();
  assert.match(monitorHtml, /monitor\.js/);
});

// ------------------------------------------------------------
// Diagnostics (issues #3 + #4): baseline probe loop + status machine
// ------------------------------------------------------------

test("diagnostics: start → 1 Hz probes, client acks, live Green; stop halts probing", async (t) => {
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

  // Stop: the server stops probing. One probe may already be in flight, so
  // allow at most one late ack, then require silence.
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
    probesLater <= probesAtStop + 1,
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

  // 200 ms added latency: RTT ≈ 200 ms (below the 500 ms timeout, above
  // the 100 ms Yellow threshold).
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
    }, 200);
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
