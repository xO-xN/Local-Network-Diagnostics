const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// Exercise live socket snapshots against the actual page scripts. The DOM
// double tracks node moves and focus, which are the monitor's live UI risks.
function loadPage(search = "") {
  const elements = new Map();
  const handlers = {};
  const listeners = {};
  const emitted = [];
  const document = {
    documentElement: { lang: "en" },
    activeElement: null,
    createElement: makeElement,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement("div"));
      return elements.get(id);
    },
  };
  function makeElement(tag) {
    let content = "";
    const events = {};
    return {
      tagName: tag.toUpperCase(),
      children: [],
      attributes: {},
      moves: 0,
      className: "",
      open: false,
      parentNode: null,
      get textContent() {
        return content + this.children.map((n) => n.textContent).join("");
      },
      set textContent(value) {
        content = String(value);
        this.children.forEach((n) => {
          n.parentNode = null;
        });
        this.children = [];
      },
      append(...nodes) {
        nodes.forEach((node) => this.insertBefore(node, null));
      },
      insertBefore(node, before) {
        node.remove();
        const index = before
          ? this.children.indexOf(before)
          : this.children.length;
        this.children.splice(index, 0, node);
        node.parentNode = this;
        this.moves++;
      },
      remove() {
        if (this.parentNode) {
          const siblings = this.parentNode.children;
          siblings.splice(siblings.indexOf(this), 1);
          this.parentNode = null;
        }
      },
      setAttribute(key, value) {
        this.attributes[key] = String(value);
      },
      addEventListener(type, callback) {
        (events[type] ||= []).push(callback);
      },
      fire(type, event = {}) {
        (events[type] || []).forEach((fn) => fn({ target: this, ...event }));
      },
      focus() {
        document.activeElement = this;
      },
      showModal() {
        this.open = true;
      },
      close() {
        this.open = false;
      },
    };
  }
  const page = {
    document,
    location: { hostname: "localhost", search },
    __PNDS_PORTS__: { performerPort: 6868, monitorPort: 6869 },
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    io: () => ({
      on(type, fn) {
        handlers[type] = fn;
      },
      emit(...args) {
        emitted.push(args);
      },
    }),
  };
  page.window = page;
  page.self = page;
  const context = vm.createContext(page);
  for (const file of ["shared.js", "locale.js", "monitor.js"]) {
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, "../public", file), "utf8"),
      context,
    );
  }
  return {
    P: page.PNDS,
    document,
    emitted,
    element: (id) => document.getElementById(id),
    connect: () => handlers.connect(),
    state: (diag) => handlers[page.PNDS.events.state]({ diag }),
    locale: (locale) =>
      listeners.message.forEach((fn) =>
        fn({ data: { type: "pnds:locale", version: 1, locale } }),
      ),
    card: (id) =>
      document
        .getElementById("cards")
        .children.find((n) => n.attributes["data-client-id"] === String(id)),
  };
}
function descendants(node, cls) {
  return node.children.flatMap((child) => [
    ...(child.className.split(" ").includes(cls) ? [child] : []),
    ...descendants(child, cls),
  ]);
}
function client(overrides = {}) {
  return {
    connected: true,
    status: "green",
    reason: "green",
    metrics: { rttP50: 12.4, rttP95: 24.6, jitterP95: 3.2 },
    events: [],
    ...overrides,
  };
}
function snapshot(clients, overall = "green") {
  return { running: true, overall, clients };
}

test("empty monitor auto-starts on each connect without joining as a device", () => {
  const page = loadPage();
  assert.equal(page.element("connected-count").textContent, "00");
  assert.equal(page.element("empty").hidden, false);
  assert.equal(
    page.element("overall-copy").textContent,
    page.P.copy.en.monitor.notRunning,
  );
  page.connect();
  page.connect();
  assert.deepEqual(page.emitted, [
    [page.P.events.diagStart],
    [page.P.events.diagStart],
  ]);
  for (const malformed of [null, {}, { clients: null }])
    assert.doesNotThrow(() => page.state(malformed));
});

test("server verdict and finite measurements display while offline records stay visible", () => {
  const page = loadPage();
  page.state(
    snapshot(
      {
        1: client(),
        2: client({ status: "yellow" }),
        3: client({ status: "gray" }),
        4: client({
          status: "red",
          connected: false,
          reason: "disconnected",
          metrics: { rttP50: null, rttP95: Infinity, jitterP95: NaN },
        }),
      },
      "yellow",
    ),
  );
  assert.equal(
    page.element("overall-copy").textContent,
    page.P.copy.en.status.yellow,
  );
  assert.equal(page.element("connected-count").textContent, "03");
  assert.equal(page.element("ready-count").textContent, "01");
  assert.equal(page.element("attention-count").textContent, "01");
  assert.equal(page.element("warming-count").textContent, "01");
  assert.equal(page.element("cards").children.length, 4);
  assert.deepEqual(
    descendants(page.card(1), "metric-value").map((n) => n.textContent),
    ["12", "25", "3"],
  );
  assert.deepEqual(
    descendants(page.card(4), "metric-value").map((n) => n.textContent),
    ["—", "—", "—"],
  );
  assert.equal(
    descendants(page.card(4), "status-word")[0].textContent,
    "OFFLINE",
  );
  assert.equal(
    descendants(page.card(4), "copy")[0].textContent,
    "Not suitable for performance",
  );
  page.state(
    snapshot({ 4: client({ connected: false, status: "red" }) }, "gray"),
  );
  assert.equal(
    page.element("overall-copy").textContent,
    page.P.copy.en.monitor.noPerformers,
  );
});

test("live updates preserve focused card identity and dialog close focus through locale changes", () => {
  const page = loadPage();
  page.state(snapshot({ 7: client() }));
  const card = page.card(7);
  card.focus();
  const moves = page.element("cards").moves;
  page.state(snapshot({ 7: client({ status: "yellow" }) }, "yellow"));
  assert.equal(page.card(7), card);
  assert.equal(page.document.activeElement, card);
  assert.equal(page.element("cards").moves, moves);
  assert.equal(card.tagName, "BUTTON");
  assert.equal(card.attributes["aria-haspopup"], "dialog");
  card.fire("click");
  const close = page.element("details-close");
  assert.equal(page.element("modal").open, true);
  assert.equal(page.document.activeElement, close);
  page.state(snapshot({ 7: client({ status: "red" }) }, "red"));
  page.locale("zh-CN");
  assert.equal(page.document.activeElement, close);
  assert.equal(
    page.element("details-title").textContent,
    page.P.copy["zh-CN"].monitor.client + "7",
  );
  assert.equal(page.element("overall-copy").textContent, "不适合现场演出");
  assert.equal(
    page.emitted.length,
    0,
    "locale refresh has no socket side effects",
  );
  close.fire("click");
  assert.equal(page.element("modal").open, false);
  assert.equal(page.document.activeElement, card);
});

test("details show every retained event, newest first; Escape and removed devices restore focus", () => {
  const page = loadPage();
  const events = Array.from({ length: 20 }, (_, i) => ({
    type: "connected",
    agoMs: (20 - i) * 1000,
  }));
  page.state(snapshot({ 1: client({ events }) }));
  page.card(1).fire("click");
  const log = descendants(page.element("details-body"), "log")[0];
  assert.equal(log.children.length, 20);
  assert.equal(
    descendants(log.children[0], "event-time")[0].textContent,
    "1" + page.P.copy.en.ago.seconds,
  );
  let prevented = false;
  page.element("modal").fire("cancel", {
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(page.document.activeElement, page.card(1));
  page.card(1).fire("click");
  page.state(snapshot({}));
  assert.equal(page.element("modal").open, false);
  assert.equal(page.document.activeElement, page.element("devices-label"));
  assert.equal(page.element("empty").hidden, false);
});
