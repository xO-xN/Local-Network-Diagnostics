// Local Network Diagnostics — instrument panel monitor.
// The server owns all verdicts and measurements. DOM nodes remain stable
// across live snapshots so keyboard focus and the open details survive.

const P = window.PNDS;
const L = window.PNDS_LOCALE;
const app = document.getElementById("app");

app.innerHTML = `
  <div class="brand">
    <svg viewBox="0 0 28 20" fill="none" aria-hidden="true"><path d="M7 7v6m0-3h14M21 7v6" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="1" width="8" height="6" rx="1" stroke="currentColor"/><rect x="17" y="1" width="8" height="6" rx="1" stroke="currentColor"/><rect x="3" y="13" width="8" height="6" rx="1" stroke="currentColor"/><rect x="17" y="13" width="8" height="6" rx="1" stroke="currentColor"/></svg>
    <span>PNDS UTILITY</span>
  </div>
  <header>
    <div><h1>Local Diagnostics</h1><p class="sub" id="sub-label"></p></div>
    <div class="activity">
      <span class="activity-value"><span id="connected-count">00</span><small id="capacity"></small></span>
      <span class="activity-label" id="activity-label"></span>
    </div>
  </header>
  <section class="panel" aria-labelledby="devices-label">
    <div class="overall st-idle" id="overall">
      <div class="verdict">
        <span class="overall-label"><span class="dot on" aria-hidden="true"></span><span id="overall-label"></span></span>
        <p class="overall-copy" id="overall-copy" role="status"></p>
      </div>
      <div class="status-summary">
        <div><span class="summary-value st-green" id="ready-count">00</span><span id="ready-label"></span></div>
        <div><span class="summary-value st-yellow" id="attention-count">00</span><span id="attention-label"></span></div>
        <div><span class="summary-value st-gray" id="warming-count">00</span><span id="warming-label"></span></div>
      </div>
    </div>
    <div class="roster">
      <div class="section-head"><h2 id="devices-label" tabindex="-1"></h2><span class="section-note" id="metrics-label"></span></div>
      <div id="cards"></div>
      <div class="empty" id="empty"><span class="empty-mark" aria-hidden="true">+</span><h3 id="empty-title"></h3><p id="empty-copy"></p></div>
    </div>
  </section>
  <footer>
    <p class="hint" id="hint"></p>
    <details class="remote">
      <summary><svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="4.5" y="1.5" width="7" height="13" rx="1.5" stroke="currentColor"/><path d="M7 12h2" stroke="currentColor" stroke-linecap="round"/></svg><span id="join-label"></span></summary>
      <div class="qr-row"><img src="/qr" id="qr-img" alt=""/><span class="sub" id="scan-label"></span></div>
    </details>
  </footer>
  <dialog class="modal" id="modal" aria-labelledby="details-title">
    <div class="modal-card st-gray" id="modal-card">
      <div class="modal-head"><h2 id="details-title"></h2><button type="button" class="close" id="details-close">×</button></div>
      <div id="details-body"></div>
    </div>
  </dialog>`;

const byId = (id) => document.getElementById(id);
const overallEl = byId("overall");
const cardsEl = byId("cards");
const modalEl = byId("modal");
const modalCardEl = byId("modal-card");
const closeButton = byId("details-close");
const clientCards = new Map();
let diag = null;
let selectedId = null;

function T() {
  return P.copy[L.current()] || P.copy.en;
}

const socket = io("http://" + location.hostname + ":" + P.performerPort, {
  reconnection: true,
});
socket.on("connect", () => socket.emit(P.events.diagStart));
socket.on(P.events.state, (data) => {
  diag = data && data.diag ? data.diag : null;
  render();
});
L.subscribe(render);

closeButton.addEventListener("click", closeDetails);
modalEl.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeDetails();
});
modalEl.addEventListener("click", (event) => {
  if (event.target === modalEl) closeDetails();
});

function statusClass(status) {
  return "st-" + (status || "gray");
}

function statusWord(info) {
  const t = T();
  return (
    info.connected === false
      ? t.monitor.offline
      : t.monitor.statusWord[info.status] || ""
  ).toUpperCase();
}

function reasonText(reason) {
  return reason ? T().reasons[reason] || "" : "";
}

function clientIds() {
  return diag && diag.clients ? Object.keys(diag.clients) : [];
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render() {
  const t = T();
  for (const [id, value] of Object.entries({
    "sub-label": t.monitor.sub,
    "activity-label": t.monitor.connected,
    "overall-label": t.monitor.verdict,
    "ready-label": t.monitor.ready,
    "attention-label": t.monitor.attention,
    "warming-label": t.monitor.warming,
    "devices-label": t.monitor.devices,
    "metrics-label": t.monitor.metrics,
    "empty-title": t.monitor.emptyTitle,
    "empty-copy": t.monitor.empty,
    hint: t.monitor.hint,
    "join-label": t.monitor.join,
    "scan-label": t.monitor.scan,
  }))
    byId(id).textContent = value;
  byId("capacity").textContent = " / " + P.maxClients;
  byId("qr-img").setAttribute("alt", t.monitor.qrAlt);
  closeButton.setAttribute("aria-label", t.monitor.close);
  renderOverall();
  renderCards();
  renderDetails();
}

function renderOverall() {
  const t = T();
  const ids = clientIds();
  const online = ids
    .map((id) => diag.clients[id])
    .filter((info) => info && info.connected);
  const running = Boolean(diag && diag.running);
  const status = running ? diag.overall || "gray" : "idle";
  overallEl.className = "overall " + statusClass(status);
  byId("overall-copy").textContent = !running
    ? t.monitor.notRunning
    : online.length === 0
      ? t.monitor.noPerformers
      : t.status[status] || t.status.gray;

  const counts = {
    "connected-count": online.length,
    "ready-count": online.filter((info) => info.status === "green").length,
    "attention-count": online.filter(
      (info) => info.status === "yellow" || info.status === "red",
    ).length,
    "warming-count": online.filter((info) => info.status === "gray").length,
  };
  for (const [id, value] of Object.entries(counts)) {
    byId(id).textContent = String(value).padStart(2, "0");
  }
}

function createCard(id) {
  const card = el("button", "client-card");
  card.type = "button";
  card.setAttribute("aria-haspopup", "dialog");
  card.setAttribute("data-client-id", id);
  card.addEventListener("click", () => openDetails(id));

  const identity = el("span", "identity");
  const clientLabel = el("span", "client-label");
  identity.append(
    clientLabel,
    el("span", "client-number", String(id).padStart(2, "0")),
  );
  const word = el("span", "status-word");
  const head = el("span", "card-head");
  head.append(identity, word);
  const copy = el("span", "copy");
  const reason = el("span", "reason");
  const metrics = el("span", "metrics");
  const readings = Array.from({ length: 3 }, () => {
    const metric = el("span", "metric");
    const label = el("span", "metric-label");
    const data = el("span", "metric-data");
    const value = el("span", "metric-value");
    const unit = el("span", "metric-unit");
    data.append(value, unit);
    metric.append(label, data);
    metrics.append(metric);
    return { label, value, unit };
  });
  const foot = el("span", "card-footer");
  const event = el("span", "event");
  const details = el("span", "details-link");
  foot.append(event, details);
  card.append(head, copy, reason, metrics, foot);
  return { card, clientLabel, word, copy, reason, readings, event, details };
}

function renderCards() {
  const t = T();
  const ids = clientIds();
  byId("empty").hidden = ids.length !== 0;

  for (const [id, entry] of clientCards) {
    if (!ids.includes(id)) {
      entry.card.remove();
      clientCards.delete(id);
    }
  }
  ids.forEach((id, index) => {
    let entry = clientCards.get(id);
    if (!entry) {
      entry = createCard(id);
      clientCards.set(id, entry);
    }
    const { card, clientLabel, word, copy, reason, readings, event, details } =
      entry;
    const info = diag.clients[id] || {};
    const metrics = info.metrics || {};
    const status = info.status || "gray";
    card.className = "client-card " + statusClass(status);
    card.setAttribute(
      "aria-label",
      t.monitor.client +
        id +
        ". " +
        (t.status[status] || "") +
        ". " +
        t.monitor.details,
    );
    clientLabel.textContent = t.monitor.client.trim();
    word.textContent = statusWord(info);
    copy.textContent = t.status[status] || "";
    const reasonCopy = reasonText(info.reason);
    reason.textContent = reasonCopy === copy.textContent ? "" : reasonCopy;
    const labels = [
      t.monitor.typicalShort,
      t.monitor.worstShort,
      t.monitor.jitterShort,
    ];
    const values = [metrics.rttP50, metrics.rttP95, metrics.jitterP95];
    readings.forEach((reading, i) => {
      reading.label.textContent = labels[i];
      reading.value.textContent = Number.isFinite(values[i])
        ? values[i].toFixed(0)
        : "—";
      reading.unit.textContent = Number.isFinite(values[i]) ? "ms" : "";
    });
    const last = info.lastEvent;
    event.textContent = last
      ? eventLabel(last.type) + " · " + agoText(last.agoMs)
      : t.monitor.noEvents;
    event.className =
      "event" +
      (last && last.type === P.diagEvents.disconnected ? " disconnected" : "");
    details.textContent = t.monitor.details + " →";
    // Avoid moving existing buttons on every broadcast: moving a focused
    // element would drop keyboard focus even if its identity is unchanged.
    const position = cardsEl.children[index];
    if (position !== card) cardsEl.insertBefore(card, position || null);
  });
}

function metricRow(label, value) {
  const row = el("div", "row");
  row.append(el("dt", "k", label), el("dd", "v", value));
  return row;
}

function openDetails(id) {
  selectedId = id;
  renderDetails();
  if (selectedId !== null) {
    if (!modalEl.open) modalEl.showModal();
    closeButton.focus();
  }
}

function closeDetails() {
  const id = selectedId;
  selectedId = null;
  if (modalEl.open) modalEl.close();
  (clientCards.get(id)?.card || byId("devices-label")).focus();
}

function renderDetails() {
  if (selectedId === null) return;
  if (!diag || !diag.clients || !diag.clients[selectedId]) {
    closeDetails();
    return;
  }
  const t = T();
  const info = diag.clients[selectedId];
  const metrics = info.metrics || {};
  modalCardEl.className = "modal-card " + statusClass(info.status);
  byId("details-title").textContent = t.monitor.client + selectedId;
  const body = byId("details-body");
  body.textContent = "";
  body.append(el("p", "status-line", t.status[info.status] || ""));
  if (info.reason) body.append(el("p", "reason", reasonText(info.reason)));
  const rows = el("dl", "rows");
  rows.append(
    metricRow(t.monitor.typical, formatMs(metrics.rttP50)),
    metricRow(t.monitor.worst, formatMs(metrics.rttP95)),
    metricRow(t.monitor.stability, formatMs(metrics.jitterP95)),
    metricRow(t.monitor.loss, formatPct(metrics.lossRate)),
    metricRow(t.monitor.processing, formatMs(metrics.lastProcessingMs, 1)),
  );
  body.append(rows, el("h3", null, t.monitor.log));
  const log = el("ol", "log");
  const events = info.events || [];
  if (events.length === 0) log.append(el("li", "entry", t.monitor.noEvents));
  else {
    for (const event of events.slice().reverse()) {
      const item = el("li", "entry");
      item.append(
        el("span", "event-name", eventLabel(event.type)),
        el("span", "event-time", agoText(event.agoMs)),
      );
      log.append(item);
    }
  }
  body.append(log);
}

function formatMs(value, digits = 0) {
  return Number.isFinite(value) ? value.toFixed(digits) + " ms" : "—";
}
function formatPct(value) {
  return Number.isFinite(value) ? (value * 100).toFixed(1) + "%" : "—";
}
function eventLabel(type) {
  return T().events[type] || type;
}
function agoText(agoMs) {
  const t = T();
  if (!Number.isFinite(agoMs)) return "";
  if (agoMs < 1000) return t.ago.just;
  if (agoMs < 60000) return Math.round(agoMs / 1000) + t.ago.seconds;
  return Math.round(agoMs / 60000) + t.ago.minutes;
}
render();
