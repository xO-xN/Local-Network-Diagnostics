const assert = require("node:assert/strict");
const test = require("node:test");
const { spawn } = require("node:child_process");
const path = require("node:path");

const { io } = require("socket.io-client");

const PROJECT_ROOT = path.join(__dirname, "..");
const PERFORMER_URL = "http://127.0.0.1:6868";
const MONITOR_URL = "http://127.0.0.1:6869";
const HEALTH_URL = `${PERFORMER_URL}/__pnds/health`;

const { freqRange } = require("../public/shared");

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

test("score server: health, join, control, set-out, reconnect, pages", async (t) => {
  const server = spawn(process.execPath, ["server.js", "--audio-mode", "none"], {
    cwd: PROJECT_ROOT,
    stdio: "ignore",
  });

  t.after(() => server.kill("SIGTERM"));

  const health = await waitForHealthReady();

  assert.equal(health.projectId, "pnds-template");
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
