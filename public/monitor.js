// Local Network Diagnostics — monitor page.
//
// Operator console in the "Multichannel Signal Generator" visual language:
// light theme, centered column — an Overall banner on top and one card per
// joined performer, with a per-client details modal (p95, loss rate,
// processing time, event log). Opening the page starts the test
// automatically. Diagnostics data arrives inside the regular "state"
// broadcast as `diag` — see lib/diagnostics.js on the server.
//
// All copy renders through the shared bilingual tables (shared.js `copy`),
// picked by the current locale (locale.js follows the App language, so the
// page re-renders live on every language switch; default English).

const P = window.PNDS;
const L = window.PNDS_LOCALE;

const app = document.getElementById("app");

app.innerHTML =
  "<header>" +
  "<h1>Local Network Diagnostics</h1>" +
  '<span class="sub" id="sub-label"></span>' +
  "</header>" +
  '<div class="overall st-idle" id="overall">' +
  '<span class="dot"></span>' +
  '<span class="overall-label" id="overall-label"></span>' +
  '<span class="overall-copy" id="overall-copy"></span>' +
  "</div>" +
  '<div id="cards"></div>' +
  '<div class="hint" id="empty"></div>' +
  '<div class="hint" id="hint"></div>' +
  '<div class="qr-row">' +
  '<img src="/qr" id="qr-img" alt="" />' +
  '<span class="sub" id="scan-label"></span>' +
  "</div>" +
  '<div class="modal hidden" id="modal">' +
  '<div class="modal-card" id="modal-card"></div>' +
  "</div>";

const subLabelEl = document.getElementById("sub-label");
const overallEl = document.getElementById("overall");
const overallLabelEl = document.getElementById("overall-label");
const overallCopyEl = document.getElementById("overall-copy");
const cardsEl = document.getElementById("cards");
const emptyEl = document.getElementById("empty");
const hintEl = document.getElementById("hint");
const qrImgEl = document.getElementById("qr-img");
const scanLabelEl = document.getElementById("scan-label");
const modalEl = document.getElementById("modal");
const modalCardEl = document.getElementById("modal-card");

let diag = null;
let selectedId = null;

// The copy table of the current locale (English fallback — the table
// the page rendered before locale following existed).
function T() {
  return P.copy[L.current()] || P.copy.en;
}

const socket = io(
  "http://" + location.hostname + ":" + P.performerPort,
  { reconnection: true },
);

// The test starts automatically with the page (and after any reconnect —
// the server ignores a start while the test is already running).
socket.on("connect", () => {
  socket.emit(P.events.diagStart);
});

socket.on(P.events.state, (data) => {
  diag = data.diag || null;
  render();
});

// The App language switch re-renders the whole console through the new
// locale's copy table (latest value wins; same value re-pushes change
// nothing).
L.subscribe(render);

modalEl.addEventListener("click", (event) => {
  if (event.target === modalEl) {
    closeDetails();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeDetails();
  }
});

// ------------------------------------------------------------
// Rendering
// ------------------------------------------------------------

function statusClass(status) {
  return "st-" + (status || "idle");
}

function statusWord(status) {
  return (T().monitor.statusWord[status] || status || "").toUpperCase();
}

function reasonText(reason) {
  return reason ? T().reasons[reason] || "" : "";
}

function render() {
  const t = T();

  subLabelEl.textContent = t.monitor.sub;
  overallLabelEl.textContent = t.monitor.overall;
  hintEl.textContent = t.monitor.hint;
  qrImgEl.setAttribute("alt", t.monitor.qrAlt);
  scanLabelEl.textContent = t.monitor.scan;

  renderOverall();
  renderCards();
  renderDetails();
}

function renderOverall() {
  const t = T();
  const running = Boolean(diag && diag.running);
  const status = running ? (diag && diag.overall) || "gray" : "idle";

  overallEl.classList.remove(
    "st-idle",
    "st-gray",
    "st-green",
    "st-yellow",
    "st-red",
  );
  overallEl.classList.add(statusClass(status));

  let copy;

  if (!running) {
    copy = t.monitor.notRunning;
  } else if (clientIds().length === 0) {
    copy = t.monitor.noPerformers;
  } else {
    copy = t.monitor.overallPrefix + (t.status[status] || "");
  }

  overallCopyEl.textContent = copy;
}

// The card grid is driven by the diagnostics roster (diag.clients), which
// keeps disconnected clients as Red cards.
function clientIds() {
  if (diag && diag.clients) {
    return Object.keys(diag.clients);
  }

  return [];
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function renderCards() {
  const t = T();

  cardsEl.textContent = "";
  const ids = clientIds();

  emptyEl.textContent = ids.length === 0 ? t.monitor.empty : "";

  for (const id of ids) {
    const info = diag.clients[id];
    const status = info ? info.status : "gray";
    const metrics = info ? info.metrics : null;
    const lastEvent = info && info.lastEvent;

    const card = el("div", "client-card " + statusClass(status));
    card.addEventListener("click", () => openDetails(id));

    const head = el("div", "head");
    head.append(el("span", "dot on"), el("span", null, t.monitor.client + id));
    card.append(head);

    card.append(
      el("div", "status-word", statusWord(status)),
      el("div", "copy", t.status[status] || ""),
    );

    card.append(el("div", "reason", reasonText(info && info.reason)));

    card.append(metricRow(t.monitor.typical, formatMs(metrics && metrics.rttP50)));
    card.append(metricRow(t.monitor.worst, formatMs(metrics && metrics.rttP95)));
    card.append(
      metricRow(t.monitor.stability, formatMs(metrics && metrics.jitterP95)),
    );

    const eventText = lastEvent
      ? eventLabel(lastEvent.type) + " · " + agoText(lastEvent.agoMs)
      : t.monitor.noEvents;
    const eventEl = el("div", "event", eventText);

    if (lastEvent && lastEvent.type === P.diagEvents.disconnected) {
      eventEl.classList.add("disconnected");
    }

    card.append(eventEl);
    cardsEl.append(card);
  }

  hintEl.style.display = ids.length === 0 ? "none" : "";
}

function metricRow(label, value) {
  const row = el("div", "row");
  row.append(el("span", "k", label), el("span", "v", value));
  return row;
}

// ------------------------------------------------------------
// Details modal
// ------------------------------------------------------------

function openDetails(id) {
  selectedId = id;
  modalEl.classList.remove("hidden");
  renderDetails();
}

function closeDetails() {
  selectedId = null;
  modalEl.classList.add("hidden");
}

function renderDetails() {
  if (!selectedId || !diag || !diag.clients || !diag.clients[selectedId]) {
    closeDetails();
    return;
  }

  const t = T();
  const info = diag.clients[selectedId];
  const status = info.status;
  const metrics = info.metrics || {};

  modalCardEl.classList.remove(
    "st-idle",
    "st-gray",
    "st-green",
    "st-yellow",
    "st-red",
  );
  modalCardEl.classList.add(statusClass(status));
  modalCardEl.textContent = "";

  const head = el("div", "head");
  const title = el("div", "title");
  title.append(
    el("span", "dot on"),
    el("span", null, t.monitor.client + selectedId),
    el("span", "status-word", statusWord(status)),
  );

  const close = el("button", "close", "×");
  close.setAttribute("aria-label", t.monitor.close);
  close.addEventListener("click", closeDetails);

  head.append(title, close);
  modalCardEl.append(head);

  modalCardEl.append(
    el("div", "status-line", t.status[status] || ""),
  );

  if (info.reason) {
    modalCardEl.append(el("div", "reason", reasonText(info.reason)));
  }

  const rows = el("div", "rows");
  rows.append(
    metricRow(t.monitor.typical, formatMs(metrics.rttP50)),
    metricRow(t.monitor.worst, formatMs(metrics.rttP95)),
    metricRow(t.monitor.stability, formatMs(metrics.jitterP95)),
    metricRow(t.monitor.loss, formatPct(metrics.lossRate)),
    metricRow(t.monitor.processing, formatMs(metrics.lastProcessingMs, 1)),
  );
  modalCardEl.append(rows);

  modalCardEl.append(el("h3", null, t.monitor.log));

  const log = el("div", "log");
  const events = info.events || [];

  if (events.length === 0) {
    log.append(el("div", "entry", t.monitor.noEvents));
  } else {
    for (const event of events.slice(-8).reverse()) {
      const entry = el("div", "entry");
      const type = el("b", null, eventLabel(event.type));
      entry.append(type, document.createTextNode("  ·  " + agoText(event.agoMs)));
      log.append(entry);
    }
  }

  modalCardEl.append(log);
}

// ------------------------------------------------------------
// Formatting helpers
// ------------------------------------------------------------

function formatMs(value, digits = 0) {
  return typeof value === "number" ? value.toFixed(digits) + " ms" : "—";
}

function formatPct(value) {
  return typeof value === "number" ? (value * 100).toFixed(1) + "%" : "—";
}

function eventLabel(type) {
  return T().events[type] || type.charAt(0).toUpperCase() + type.slice(1);
}

function agoText(agoMs) {
  const t = T();

  if (typeof agoMs !== "number") {
    return "";
  }

  if (agoMs < 1000) {
    return t.ago.just;
  }

  if (agoMs < 60000) {
    return Math.round(agoMs / 1000) + t.ago.seconds;
  }

  return Math.round(agoMs / 60000) + t.ago.minutes;
}

render();
