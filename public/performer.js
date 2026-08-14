// Local Network Diagnostics — performer page.
//
// Minimal mobile client: joins the score server automatically (recovering
// the client id via the persisted claim token) and answers every
// diagnostics probe immediately so the server can measure the real round
// trip. The page shows exactly one thing: "Connected, testing…".

const P = window.PNDS;

const app = document.getElementById("app");

app.innerHTML =
  "<header>" +
  "<h1>Local Network Diagnostics</h1>" +
  '<span class="sub">Performer</span>' +
  "</header>" +
  '<div class="perf">' +
  '<span class="dot" id="perf-dot"></span>' +
  '<p class="status" id="perf-status">Connecting…</p>' +
  '<p class="meta" id="perf-meta"></p>' +
  "</div>";

const dot = document.getElementById("perf-dot");
const statusEl = document.getElementById("perf-status");
const metaEl = document.getElementById("perf-meta");

const socket = io(
  "http://" + location.hostname + ":" + P.performerPort,
  { reconnection: true, reconnectionDelay: 1000 },
);

socket.on(P.events.joined, (data) => {
  localStorage.setItem(P.tokenKey, data.token);
  setJoined(true, data.id);
});

socket.on(P.events.rejected, (data) => {
  setJoined(false);
  statusEl.textContent = "Rejected: " + (data && data.reason ? data.reason : "");
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
    dot.classList.add("ok");
    statusEl.textContent = "Connected, testing…";
    metaEl.textContent = "Client " + id;
  } else {
    dot.classList.remove("ok");
    statusEl.textContent = "Connecting…";
    metaEl.textContent = "";
  }
}

setJoined(false);
