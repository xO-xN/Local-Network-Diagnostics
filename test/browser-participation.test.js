const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const test = require("node:test");
const { io } = require("socket.io-client");

const ROOT = path.join(__dirname, "..");

async function startAssigned(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pnds-local-diagnostics-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const listeners = await Promise.all(["performer", "monitor"].map(async (role) => {
    const server = net.createServer();
    server.listen(0, "0.0.0.0");
    await once(server, "listening");
    return { role, port: server.address().port, server };
  }));
  const assignment = {
    version: 1,
    runId: "local-diagnostics-test-run",
    reportPath: path.join(directory, "bound.json"),
    services: listeners.map(({ role, port }, index) => ({ role, port, fd: index + 3 })),
  };
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PNDS_RUNTIME_PORTS: JSON.stringify(assignment) },
    stdio: ["ignore", "pipe", "pipe", ...listeners.map(({ server }) => server._handle.fd)],
  });
  let output = "";
  child.stdout.on("data", bytes => { output += bytes; });
  child.stderr.on("data", bytes => { output += bytes; });
  for (const { server } of listeners) server.close();
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, "exit");
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 2000);
    await done;
    clearTimeout(force);
  });
  let report;
  for (let i = 0; i < 100; i += 1) {
    try { report = JSON.parse(await fs.readFile(assignment.reportPath, "utf8")); break; } catch {}
    if (child.exitCode !== null) throw new Error(output);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.ok(report, `inherited listeners must publish a startup report: ${output}`);
  return { assignment, report, performer: `http://127.0.0.1:${listeners[0].port}`, monitor: `http://127.0.0.1:${listeners[1].port}` };
}

test("actual diagnostic service adopts both assigned listeners and exposes their role and run identity", async t => {
  const { assignment, report, performer, monitor } = await startAssigned(t);
  assert.deepEqual(report, {
    version: 1, runId: assignment.runId, status: "bound",
    services: assignment.services.map(({ role, port }) => ({ role, port })),
  });
  const health = await (await fetch(`${performer}/__pnds/health`)).json();
  assert.equal(health.status, "ready");
  assert.equal(health.audio.status, "disabled");
  assert.deepEqual(health.scoreServer, {
    performerPort: assignment.services[0].port,
    monitorPort: assignment.services[1].port,
    runtimeRunId: assignment.runId,
  });
  assert.match(await (await fetch(`${performer}/__config.js?probe=1`)).text(), /"role":"performer"/);
  assert.match(await (await fetch(`${monitor}/__config.js`)).text(), /"role":"monitor"/);
  const context = await fetch(`${performer}/__pnds/context.js`);
  assert.equal(context.status, 200);
  assert.match(context.headers.get("content-type"), /javascript/);
  const html = await (await fetch(performer)).text();
  assert.match(html, /src="__pnds\/context.js"/);
  assert.doesNotMatch(html, /location\.port/);
});

function connectedSocket(t, origin, transports) {
  const socket = io(origin, { transports, reconnection: false, forceNew: true });
  t.after(() => socket.close());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket connection timed out")), 4000);
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.once("connect_error", error => { clearTimeout(timer); reject(error); });
  });
}

function matchingState(socket, matches) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("state", check); reject(new Error("diagnostic state timed out")); }, 6000);
    function check(state) {
      if (!matches(state)) return;
      clearTimeout(timer);
      socket.off("state", check);
      resolve(state);
    }
    socket.on("state", check);
  });
}

test("assigned diagnostic listener measures polling and websocket devices with real probe acknowledgments", async t => {
  const { performer } = await startAssigned(t);
  const monitor = await connectedSocket(t, performer, ["websocket"]);
  const devices = [];
  for (const transport of ["polling", "websocket"]) {
    const device = await connectedSocket(t, performer, [transport]);
    const joined = once(device, "joined");
    device.emit("join", {});
    const [identity] = await joined;
    device.on("pnds:diag:probe", ({ seq }) => device.emit("pnds:diag:ack", { seq, t0: 1, t1: 1.5 }));
    devices.push({ device, identity });
  }
  const measured = matchingState(monitor, state => devices.every(({ identity }) => Number.isFinite(state.diag?.clients[identity.id]?.metrics.rttP95)));
  monitor.emit("pnds:diag:start");
  const state = await measured;
  assert.equal(state.diag.running, true);
  assert.equal(Object.keys(state.diag.clients).length, 2);
  for (const { identity } of devices) {
    const metrics = state.diag.clients[identity.id].metrics;
    assert.ok(metrics.rttP95 >= 0);
    assert.equal(metrics.lastProcessingMs, 0.5);
  }
  const stopped = matchingState(monitor, state => state.diag.running === false);
  monitor.emit("pnds:diag:stop");
  await stopped;
});

test("the served performer joins the real service, scopes its claim and reports page preparation only after admission", async t => {
  const { performer } = await startAssigned(t);
  const vm = require("node:vm");
  const elements = new Map();
  const storage = new Map([["local-network-diagnostics-token", "other-host-legacy-claim"]]);
  const key = "pnds:host-a:local-network-diagnostics:local-network-diagnostics-token";
  let reports = 0;
  let connected;
  const accepted = new Promise(resolve => { connected = resolve; });
  const page = {
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { classList: { add() {}, remove() {} }, innerHTML: "", textContent: "" });
      return elements.get(id);
    } },
    location: new URL(performer),
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    performance,
    PNDS_PARTICIPATION: {
      socketOptions: { path: "/socket.io/" },
      storageKey: name => `pnds:host-a:local-network-diagnostics:${name}`,
      reportPrepared: () => { reports += 1; connected(); },
    },
    io: (origin, options) => {
      const socket = io(origin, { ...options, forceNew: true });
      t.after(() => socket.close());
      return socket;
    },
  };
  page.window = page;
  page.self = page;
  const browser = vm.createContext(page);
  for (const script of ["__config.js", "shared.js", "performer.js"]) {
    vm.runInContext(await (await fetch(`${performer}/${script}?actual-page=1`)).text(), browser);
  }
  await Promise.race([accepted, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error("real performer did not report prepared after joining")), 3000);
    timer.unref();
  })]);
  assert.equal(reports, 1);
  assert.match(storage.get(key), /^[a-f\d]{48}$/);
  assert.equal(storage.get("local-network-diagnostics-token"), "other-host-legacy-claim");
  assert.equal(elements.get("perf-id").textContent, "01");
});

test("invalid listener assignments fail before the diagnostic service can start", async () => {
  const { promisify } = require("node:util");
  const { execFile } = require("node:child_process");
  const execute = promisify(execFile);
  for (const assignment of ["null", "{}", "{", JSON.stringify({ version: 9, services: [] })]) {
    await assert.rejects(execute(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: { ...process.env, PNDS_RUNTIME_PORTS: assignment },
      timeout: 2000,
    }), error => error.code === 1 && /assignment|JSON/.test(error.stderr));
  }
});
