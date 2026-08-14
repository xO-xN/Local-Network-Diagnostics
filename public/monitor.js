// Local Network Diagnostics — monitor page (p5).
//
// Operator view: a prominent Overall banner on top (with the current burst/
// calm phase), a Start/Stop Test button, and one status card per joined
// performer (status colour, Typical Response, Worst-case Response,
// Stability, latest event). Clicking a card opens the per-client details
// panel (p95, loss rate, processing time, event log). The QR code for the
// performer page sits in the bottom-right corner. Diagnostics data arrives
// inside the regular "state" broadcast as `diag` — see lib/diagnostics.js
// on the server.

const P = window.PNDS;

let clients = [];
let diag = null;
let qrImage = null;
let startButton = null;
let selectedId = null;
let cardRects = [];

const socket = io(
  "http://" + location.hostname + ":" + P.performerPort,
  { reconnection: true },
);

socket.on(P.events.state, (data) => {
  clients = data.clients || [];
  diag = data.diag || null;
  updateButton();
});

// ------------------------------------------------------------
// Layout
// ------------------------------------------------------------

const BANNER_X = 24;
const BANNER_Y = 20;
const BANNER_H = 56;
const CARD_W = 280;
const CARD_H = 192;
const CARD_GAP = 16;
const QR_SIZE = 150;
const BUTTON_W = 150;
const BUTTON_H = 42;
const PANEL_W = 320;
const PANEL_MARGIN = 24;

const STATUS_COLORS = {
  idle: [90, 98, 116],
  gray: [150, 160, 180],
  green: [74, 222, 128],
  yellow: [250, 204, 21],
  red: [248, 113, 113],
};

// Status copy is shared with the server via shared.js (single source of
// truth); Red must be explicit (spec).
const STATUS_COPY = P.statusCopy;

function overallCopy(status) {
  return "Overall: " + (P.statusCopy[status] || "");
}

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent("stage");
  qrImage = createImg("/qr", "QR code for the performer page");
  qrImage.class("qr-image");
  startButton = createButton("Start Test");
  startButton.class("diag-button");
  startButton.mousePressed(() => {
    const running = Boolean(diag && diag.running);
    socket.emit(running ? P.events.diagStop : P.events.diagStart);
  });
  layoutOverlays();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  layoutOverlays();
}

function layoutOverlays() {
  if (startButton) {
    startButton.position(
      width - BUTTON_W - BANNER_X,
      BANNER_Y + (BANNER_H - BUTTON_H) / 2,
    );
  }

  if (qrImage) {
    qrImage.position(width - QR_SIZE - 16, height - QR_SIZE - 16);
    qrImage.size(QR_SIZE, QR_SIZE);
  }
}

function updateButton() {
  if (!startButton) {
    return;
  }

  const running = Boolean(diag && diag.running);

  startButton.html(running ? "Stop Test" : "Start Test");

  if (running) {
    startButton.addClass("running");
  } else {
    startButton.removeClass("running");
  }
}

// ------------------------------------------------------------
// Drawing
// ------------------------------------------------------------

function draw() {
  background(20, 22, 28);
  drawBanner();
  drawCards();
  drawDetailsPanel();

  if (cardList().length === 0) {
    drawEmpty();
  } else if (!selectedId) {
    textAlign(LEFT, BOTTOM);
    textSize(11);
    fill(120, 130, 150);
    text("Click a card for details", BANNER_X, height - 14);
  }
}

// The card grid is driven by the diagnostics roster (diag.clients), which
// keeps disconnected clients as Red cards — the audio snapshot drops them
// on disconnect, so it cannot drive the grid.
function cardList() {
  if (diag && diag.clients) {
    return Object.keys(diag.clients).map((id) => ({ id }));
  }

  return clients;
}

function drawBanner() {
  const running = Boolean(diag && diag.running);
  const status = running ? (diag && diag.overall) || "gray" : "idle";
  const color = STATUS_COLORS[status] || STATUS_COLORS.gray;

  fill(28, 31, 40);
  stroke(color);
  strokeWeight(1);
  rect(BANNER_X, BANNER_Y, width - BANNER_X * 2, BANNER_H, 12);

  noStroke();
  fill(color);
  rect(BANNER_X, BANNER_Y, 10, BANNER_H, 12);

  let copy;

  if (!running) {
    copy = "Test not running — press Start Test";
  } else if (cardList().length === 0) {
    copy = "No performers connected";
  } else {
    copy = overallCopy(status);

    if (diag && diag.phase === P.diagPhases.burst) {
      copy += "  ·  Burst phase";
    }
  }

  fill(232, 236, 244);
  textAlign(LEFT, CENTER);
  textSize(18);
  text(copy, BANNER_X + 28, BANNER_Y + BANNER_H / 2);
}

function drawCards() {
  const usable = width - BANNER_X * 2;
  const columns = Math.max(
    1,
    Math.floor((usable + CARD_GAP) / (CARD_W + CARD_GAP)),
  );
  const gridWidth = columns * CARD_W + (columns - 1) * CARD_GAP;
  const startX = BANNER_X + (usable - gridWidth) / 2;
  const startY = BANNER_Y + BANNER_H + 24;

  cardRects = [];

  cardList().forEach((client, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const x = startX + col * (CARD_W + CARD_GAP);
    const y = startY + row * (CARD_H + CARD_GAP);

    cardRects.push({ id: client.id, x, y, w: CARD_W, h: CARD_H });
    drawCard(client, x, y);
  });
}

function drawCard(client, x, y) {
  const info = diag && diag.clients ? diag.clients[client.id] : null;
  const status = info ? info.status : "gray";
  const metrics = info ? info.metrics : null;
  const color = STATUS_COLORS[status] || STATUS_COLORS.gray;

  fill(28, 31, 40);
  stroke(42, 46, 58);
  strokeWeight(1);
  rect(x, y, CARD_W, CARD_H, 12);

  noStroke();
  fill(color);
  rect(x, y, 8, CARD_H, 12);

  textAlign(LEFT, TOP);

  fill(232, 236, 244);
  textSize(15);
  text("Client " + client.id, x + 24, y + 12);

  fill(color);
  textSize(13);
  textStyle(BOLD);
  text(status.toUpperCase(), x + 24, y + 34);
  textStyle(NORMAL);

  textSize(13);
  text(STATUS_COPY[status] || "", x + 24, y + 54);

  if (info && info.reason) {
    fill(140, 150, 170);
    textSize(12);
    text(info.reason, x + 24, y + 76);
  }

  fill(200, 208, 224);
  textSize(13);
  text(
    "Typical Response: " + formatMs(metrics && metrics.rttP50),
    x + 24,
    y + 98,
  );
  text(
    "Worst-case Response: " + formatMs(metrics && metrics.rttP95),
    x + 24,
    y + 118,
  );
  text(
    "Stability (Timing Variation): " + formatMs(metrics && metrics.jitterP95),
    x + 24,
    y + 138,
  );

  const lastEvent = info && info.lastEvent;
  const eventText = lastEvent
    ? eventLabel(lastEvent.type) + " · " + agoText(lastEvent.agoMs)
    : "No events yet";

  fill(
    lastEvent && lastEvent.type === P.diagEvents.disconnected
      ? [248, 113, 113]
      : [200, 208, 224],
  );
  text(eventText, x + 24, y + 158);
}

function formatMs(value, digits = 0) {
  return typeof value === "number" ? value.toFixed(digits) + " ms" : "—";
}

function formatPct(value) {
  return typeof value === "number" ? (value * 100).toFixed(1) + "%" : "—";
}

function eventLabel(type) {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function agoText(agoMs) {
  if (typeof agoMs !== "number") {
    return "";
  }

  if (agoMs < 1000) {
    return "just now";
  }

  if (agoMs < 60000) {
    return Math.round(agoMs / 1000) + "s ago";
  }

  return Math.round(agoMs / 60000) + "m ago";
}

// ------------------------------------------------------------
// Details panel (issue #8): per-client p95 / loss rate / processing time
// and the event log (issue #6). These metrics inform the operator only —
// the server never feeds them into the Green/Yellow/Red decision.
// ------------------------------------------------------------

function drawDetailsPanel() {
  if (!selectedId || !diag || !diag.clients) {
    selectedId = null;
    return;
  }

  const info = diag.clients[selectedId];

  if (!info) {
    selectedId = null;
    return;
  }

  const x = width - PANEL_W - PANEL_MARGIN;
  const y = BANNER_Y;
  const h = height - BANNER_Y - 16;
  const statusColor = STATUS_COLORS[info.status] || STATUS_COLORS.gray;

  fill(28, 31, 40);
  stroke(60, 66, 80);
  strokeWeight(1);
  rect(x, y, PANEL_W, h, 12);

  noStroke();
  fill(statusColor);
  rect(x, y, 8, h, 12);

  textAlign(LEFT, TOP);

  fill(232, 236, 244);
  textSize(16);
  textStyle(BOLD);
  text("Client " + selectedId, x + 24, y + 16);
  textStyle(NORMAL);

  fill(statusColor);
  textSize(13);
  text(
    info.status.toUpperCase() + " — " + (P.statusCopy[info.status] || ""),
    x + 24,
    y + 42,
  );

  if (info.reason) {
    fill(140, 150, 170);
    textSize(12);
    text(info.reason, x + 24, y + 64);
  }

  stroke(60, 66, 80);
  line(x + 24, y + 82, x + PANEL_W - 24, y + 82);

  const metrics = info.metrics || {};
  const rows = [
    ["Typical Response", formatMs(metrics.rttP50)],
    ["Worst-case Response", formatMs(metrics.rttP95)],
    ["Stability (Timing Variation)", formatMs(metrics.jitterP95)],
    ["Loss Rate", formatPct(metrics.lossRate)],
    ["Processing Time", formatMs(metrics.lastProcessingMs, 1)],
  ];

  rows.forEach((row, index) => {
    const ry = y + 96 + index * 22;

    fill(200, 208, 224);
    textSize(13);
    text(row[0], x + 24, ry);

    fill(232, 236, 244);
    textAlign(RIGHT, TOP);
    text(row[1], x + PANEL_W - 24, ry);
    textAlign(LEFT, TOP);
  });

  const logTop = y + 96 + rows.length * 22 + 12;

  stroke(60, 66, 80);
  line(x + 24, logTop - 6, x + PANEL_W - 24, logTop - 6);

  fill(232, 236, 244);
  textSize(13);
  textStyle(BOLD);
  text("Event Log", x + 24, logTop);
  textStyle(NORMAL);

  const events = info.events || [];
  const visible = events.slice(-8).reverse();

  fill(140, 150, 170);
  textSize(12);

  visible.forEach((event, index) => {
    text(
      eventLabel(event.type) + "  ·  " + agoText(event.agoMs),
      x + 24,
      logTop + 22 + index * 20,
    );
  });

  // Close handle (top-right corner; clicking anywhere outside also closes).
  fill(120, 130, 150);
  textSize(18);
  textAlign(CENTER, CENTER);
  text("×", x + PANEL_W - 28, y + 24);
  textAlign(LEFT, TOP);
}

function mousePressed() {
  // Cards win over the panel: clicking a card selects/toggles it.
  for (let i = cardRects.length - 1; i >= 0; i -= 1) {
    const rect = cardRects[i];

    if (
      mouseX >= rect.x &&
      mouseX <= rect.x + rect.w &&
      mouseY >= rect.y &&
      mouseY <= rect.y + rect.h
    ) {
      selectedId = selectedId === rect.id ? null : rect.id;
      return;
    }
  }

  if (!selectedId) {
    return;
  }

  const x = width - PANEL_W - PANEL_MARGIN;
  const y = BANNER_Y;
  const inPanel =
    mouseX >= x &&
    mouseX <= x + PANEL_W &&
    mouseY >= y &&
    mouseY <= y + height - BANNER_Y - 16;

  // The × handle closes the panel.
  if (Math.abs(mouseX - (x + PANEL_W - 28)) <= 14 && Math.abs(mouseY - (y + 24)) <= 14) {
    selectedId = null;
    return;
  }

  // A click outside the panel closes it.
  if (!inPanel) {
    selectedId = null;
  }
}

function drawEmpty() {
  textAlign(CENTER, CENTER);
  textSize(16);
  fill(120, 130, 150);
  text("Waiting for performers…", width / 2, height / 2 - 10);
  textSize(13);
  text("Press Start Test once devices are connected", width / 2, height / 2 + 16);
}
