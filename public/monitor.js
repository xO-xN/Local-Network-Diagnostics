// Local Network Diagnostics — monitor page (p5).
//
// Operator view: a prominent Overall banner on top, a Start/Stop Test
// button, and one status card per joined performer (status colour, Typical
// Response, Stability). The QR code for the performer page sits in the
// bottom-right corner. Diagnostics data arrives inside the regular "state"
// broadcast as `diag` — see lib/diagnostics.js on the server.

const P = window.PNDS;

let clients = [];
let diag = null;
let qrImage = null;
let startButton = null;

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
const CARD_H = 168;
const CARD_GAP = 16;
const QR_SIZE = 150;
const BUTTON_W = 150;
const BUTTON_H = 42;

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

  if (clients.length === 0) {
    drawEmpty();
  }
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
  } else if (clients.length === 0) {
    copy = "No performers connected";
  } else {
    copy = overallCopy(status);
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

  clients.forEach((client, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);

    drawCard(
      client,
      startX + col * (CARD_W + CARD_GAP),
      startY + row * (CARD_H + CARD_GAP),
    );
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
    y + 104,
  );
  text(
    "Worst-case Response: " + formatMs(metrics && metrics.rttP95),
    x + 24,
    y + 124,
  );
  text(
    "Stability (Timing Variation): " + formatMs(metrics && metrics.jitterP95),
    x + 24,
    y + 144,
  );
}

function formatMs(value) {
  return typeof value === "number" ? Math.round(value) + " ms" : "—";
}

function drawEmpty() {
  textAlign(CENTER, CENTER);
  textSize(16);
  fill(120, 130, 150);
  text("Waiting for performers…", width / 2, height / 2 - 10);
  textSize(13);
  text("Press Start Test once devices are connected", width / 2, height / 2 + 16);
}
