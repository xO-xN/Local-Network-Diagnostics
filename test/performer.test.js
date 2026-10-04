// Performer page wiring: the dot mirrors the server's live verdict for
// this client (green / yellow / red), stays gray while warming up or
// idle, and malformed payloads never throw.
//
// The page script is plain browser JS with no imports, so the harness
// loads shared.js + performer.js into a context with a hand-rolled DOM
// and socket, then drives the socket handlers by hand.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

function makeElement() {
  const classes = new Set();

  return {
    innerHTML: "",
    textContent: "",
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
  };
}

function loadPerformerPage() {
  const elements = new Map();
  const handlers = {};
  const storage = new Map();

  const page = {
    document: {
      getElementById: (id) => {
        if (!elements.has(id)) {
          elements.set(id, makeElement());
        }
        return elements.get(id);
      },
    },
    location: { hostname: "localhost" },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
    },
    performance: { now: () => 0 },
    io: () => ({
      on: (event, handler) => {
        (handlers[event] = handlers[event] || []).push(handler);
      },
      emit: () => {},
    }),
    __PNDS_PORTS__: { performerPort: 6868, monitorPort: 6869 },
  };

  page.window = page;
  page.self = page;

  const context = vm.createContext(page);

  vm.runInContext(
    fs.readFileSync(path.join(PUBLIC_DIR, "shared.js"), "utf8"),
    context,
  );
  vm.runInContext(
    fs.readFileSync(path.join(PUBLIC_DIR, "performer.js"), "utf8"),
    context,
  );

  const P = page.PNDS;

  return {
    P,
    handlers,
    storage,
    element: (id) => elements.get(id),
    state: (payload) => handlers[P.events.state][0](payload),
    join: (id) => handlers[P.events.joined][0]({ token: "t-" + id, id }),
  };
}

test("performer wiring: the dot mirrors the server's verdict for this client", () => {
  const page = loadPerformerPage();
  const dot = page.element("perf-dot");
  const statusEl = page.element("perf-status");

  // Before joining, state broadcasts change nothing.
  page.state({ diag: { running: true, clients: {} } });
  assert.equal(statusEl.textContent, "Connecting…");

  page.join(7);
  assert.equal(statusEl.textContent, "Connected");
  assert.equal(page.element("perf-meta").textContent, "Client 7");
  assert.equal(page.element("perf-id").textContent, "07");
  assert.equal(page.storage.get(page.P.tokenKey), "t-7");
  assert.ok(!dot.classList.contains("ok"), "gray until a verdict exists");

  // Warming up (gray) while the test runs: dot stays uncolored.
  page.state({ diag: { running: true, clients: { 7: { status: "gray" } } } });
  assert.equal(statusEl.textContent, "Connected, testing…");
  assert.ok(!dot.classList.contains("ok"));

  // The verdicts land as colors, exactly one at a time.
  for (const [status, cls] of [
    ["green", "ok"],
    ["yellow", "warn"],
    ["red", "bad"],
  ]) {
    page.state({ diag: { running: true, clients: { 7: { status } } } });
    assert.ok(dot.classList.contains(cls), status + " → " + cls);
    assert.equal(
      page.element("perf-verdict").textContent,
      page.P.copy.en.status[status],
    );

    for (const other of ["ok", "warn", "bad"]) {
      if (other !== cls) {
        assert.ok(!dot.classList.contains(other));
      }
    }
  }

  // Test stopped: back to gray and the copy drops "testing".
  page.state({ diag: { running: false, clients: { 7: { status: "green" } } } });
  assert.ok(!dot.classList.contains("ok"));
  assert.equal(statusEl.textContent, "Connected");

  // Another client's verdict is not ours.
  page.state({ diag: { running: true, clients: { 8: { status: "red" } } } });
  assert.ok(!dot.classList.contains("bad"));
});

test("performer wiring: malformed state payloads never throw or paint", () => {
  const page = loadPerformerPage();
  const dot = page.element("perf-dot");
  page.join(3);

  for (const payload of [
    null,
    {},
    { diag: null },
    { diag: {} },
    { diag: { running: true } },
    { diag: { running: true, clients: null } },
  ]) {
    assert.doesNotThrow(() => page.state(payload));
  }

  assert.ok(!dot.classList.contains("ok"));
  assert.ok(!dot.classList.contains("warn"));
  assert.ok(!dot.classList.contains("bad"));
});

test("performer wiring: a disconnect resets to Connecting and ignores state", () => {
  const page = loadPerformerPage();
  const dot = page.element("perf-dot");
  const statusEl = page.element("perf-status");
  page.join(5);

  page.state({ diag: { running: true, clients: { 5: { status: "red" } } } });
  assert.ok(dot.classList.contains("bad"));

  page.handlers.disconnect[0]();
  assert.equal(statusEl.textContent, "Connecting…");
  assert.equal(page.element("perf-id").textContent, "—");
  assert.equal(
    page.element("perf-verdict").textContent,
    page.P.copy.en.performer.waiting,
  );
  assert.ok(!dot.classList.contains("bad"));

  // Late state from the old session must not repaint a connecting page.
  page.state({ diag: { running: true, clients: { 5: { status: "green" } } } });
  assert.equal(statusEl.textContent, "Connecting…");
  assert.ok(!dot.classList.contains("ok"));
});
