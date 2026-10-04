// Local Network Diagnostics — performer page.
//
// Minimal mobile client: joins the score server automatically (recovering
// the client id via the persisted claim token) and answers every
// diagnostics probe immediately so the server can measure the real round
// trip. The page shows exactly one signal: the dot mirrors the server's
// live verdict for THIS client — green / yellow / red while a test runs,
// gray while warming up or before the operator starts one.

const P = window.PNDS;
const copy = P.copy.en;

const app = document.getElementById("app");
app.className = "performer-instrument";

app.innerHTML = `
  <div class="brand">
    <svg viewBox="0 0 28 20" fill="none" aria-hidden="true"><path d="M7 7v6m0-3h14M21 7v6" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="1" width="8" height="6" rx="1" stroke="currentColor"/><rect x="17" y="1" width="8" height="6" rx="1" stroke="currentColor"/><rect x="3" y="13" width="8" height="6" rx="1" stroke="currentColor"/><rect x="17" y="13" width="8" height="6" rx="1" stroke="currentColor"/></svg>
    <span>PNDS UTILITY</span>
  </div>
  <header><div><h1>Local Diagnostics</h1><p class="sub">${copy.performer.role}</p></div></header>
  <div class="perf">
    <p class="perf-meta" id="perf-meta"></p>
    <span class="perf-id" id="perf-id">—</span>
    <div class="perf-state"><span class="dot" id="perf-dot" aria-hidden="true"></span><p class="status" id="perf-status" role="status"></p></div>
    <p class="perf-verdict" id="perf-verdict"></p>
  </div>
  <p class="perf-helper">${copy.performer.helper}</p>`;

const dot = document.getElementById("perf-dot");
const statusEl = document.getElementById("perf-status");
const metaEl = document.getElementById("perf-meta");
const idEl = document.getElementById("perf-id");
const verdictEl = document.getElementById("perf-verdict");

// Server-measured status → dot class. Gray (warming up, or no test
// running) keeps the plain track-colored dot.
const STATUS_CLASS = { green: "ok", yellow: "warn", red: "bad" };

let clientId = null;

const socket = io("http://" + location.hostname + ":" + P.performerPort, {
  reconnection: true,
  reconnectionDelay: 1000,
});

socket.on(P.events.joined, (data) => {
  localStorage.setItem(P.tokenKey, data.token);
  clientId = data.id;
  setJoined(true, data.id);
});

socket.on(P.events.rejected, (data) => {
  setJoined(false);
  statusEl.textContent =
    copy.performer.rejected + (data && data.reason ? data.reason : "");
});

socket.on("connect", () => {
  // Fires on first connect and after every reconnect: (re)join with the
  // persisted token so the server hands back the same client id.
  socket.emit(P.events.join, {
    token: localStorage.getItem(P.tokenKey) || null,
  });
});

socket.on("disconnect", () => {
  setJoined(false);
});

// The state broadcast reaches every socket; this page reads only its own
// card out of the snapshot and mirrors the verdict on the dot.
socket.on(P.events.state, (state) => {
  if (clientId === null) {
    return;
  }

  const diag = state && state.diag;
  const me = diag && diag.clients ? diag.clients[clientId] : null;
  const cls = STATUS_CLASS[me && diag.running ? me.status : null];

  dot.classList.remove("ok", "warn", "bad");

  if (cls) {
    dot.classList.add(cls);
  }

  statusEl.textContent =
    diag && diag.running ? copy.performer.testing : copy.performer.connected;
  verdictEl.textContent =
    me && diag.running
      ? copy.status[me.status] || copy.performer.waiting
      : copy.performer.waiting;
});

// Diagnostics: answer every probe immediately so the server can measure
// the real round trip. t0/t1 are performance.now() timestamps around the
// reply — the server uses them only for the client processing time (the
// RTT itself is measured server-side).
socket.on(P.events.diagProbe, (payload) => {
  const t0 = performance.now();

  socket.emit(P.events.diagAck, {
    seq: payload && payload.seq,
    t0,
    t1: performance.now(),
  });
});

function setJoined(joined, id) {
  if (joined) {
    // The dot stays gray until the first state broadcast (the server
    // sends one right after "joined") paints the real status.
    statusEl.textContent = copy.performer.connected;
    metaEl.textContent = copy.monitor.client + id;
    idEl.textContent = String(id).padStart(2, "0");
    verdictEl.textContent = copy.performer.waiting;
  } else {
    clientId = null;
    dot.classList.remove("ok", "warn", "bad");
    statusEl.textContent = copy.performer.connecting;
    metaEl.textContent = "";
    idEl.textContent = "—";
    verdictEl.textContent = copy.performer.waiting;
  }
}

setJoined(false);
