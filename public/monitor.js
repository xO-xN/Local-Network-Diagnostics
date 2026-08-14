// PNDS Template — monitor page (p5).
//
// Listens to the score server and draws every joined performer (id, amp,
// freq, output channel), centered on screen. The operator can reassign each
// client's output channel with a select. A QR code for the performer page
// sits below the table.

const P = window.PNDS;

let clients = [];
let selects = []; // p5 select elements, rebuilt when the client set changes
let qrImage = null;

const TABLE_WIDTH = 560;
const HEADER_HEIGHT = 44;
const ROW_HEIGHT = 52;
const QR_SIZE = 150;
const QR_SPACE = QR_SIZE + 24;
const SELECT_WIDTH = 64;

const socket = io(
  "http://" + location.hostname + ":" + P.performerPort,
  { reconnection: true },
);

socket.on(P.events.state, (data) => {
  const next = data.clients || [];
  const idsChanged =
    next.length !== clients.length ||
    next.some((client, index) => !clients[index] || client.id !== clients[index].id);

  clients = next;

  if (idsChanged) {
    rebuildSelects();
  } else {
    syncSelects();
  }
});

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent("stage");
  qrImage = createImg("/qr", "QR code for the performer page");
  rebuildSelects();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  layoutSelects();
}

// ------------------------------------------------------------
// Select management
// ------------------------------------------------------------

function rebuildSelects() {
  removeSelects();
  createSelects();
  layoutSelects();
}

function removeSelects() {
  for (const select of selects) {
    select.remove();
  }

  selects = [];
}

function createSelects() {
  for (const client of clients) {
    const select = createSelect();

    for (let channel = 1; channel <= P.maxClients; channel += 1) {
      select.option(String(channel));
    }

    select.selected(String(client.out));
    select.changed(() => {
      socket.emit(P.events.setOut, { out: Number(select.value()) });
    });

    select.style("background", "#22262f");
    select.style("color", "#e8ecf4");
    select.style("border", "1px solid #3a4050");
    select.style("border-radius", "6px");
    select.style("padding", "4px 8px");
    select.style("font-size", "14px");
    select.style("width", SELECT_WIDTH + "px");
    selects.push(select);
  }
}

// Client values changed but the set is the same: mirror out changes (e.g.
// after a reconnect restore) back into the selects.
function syncSelects() {
  selects.forEach((select, index) => {
    const client = clients[index];

    if (client && String(select.value()) !== String(client.out)) {
      select.selected(String(client.out));
    }
  });
}

function layoutSelects() {
  const top = tableY();

  selects.forEach((select, index) => {
    select.position(
      tableX() + 348,
      top + HEADER_HEIGHT + index * ROW_HEIGHT + 14,
    );
  });

  if (qrImage) {
    // Pin the QR to the bottom of the window; if the table is taller than
    // the window, clamp it just below the last row instead of overlapping.
    const tableBottom = top + HEADER_HEIGHT + clients.length * ROW_HEIGHT;
    const qrY = Math.max(height - QR_SPACE + 4, tableBottom + 16);

    qrImage.position(width / 2 - QR_SIZE / 2, qrY);
    qrImage.size(QR_SIZE, QR_SIZE);
  }
}

// ------------------------------------------------------------
// Layout math (all centered)
// ------------------------------------------------------------

function tableX() {
  return (width - TABLE_WIDTH) / 2;
}

function tableY() {
  const tableHeight = HEADER_HEIGHT + clients.length * ROW_HEIGHT;
  const totalHeight = tableHeight + (clients.length > 0 ? QR_SPACE : 0);
  return Math.max(8, (height - totalHeight) / 2);
}

// ------------------------------------------------------------
// Drawing
// ------------------------------------------------------------

function draw() {
  background(20, 22, 28);

  if (clients.length === 0) {
    drawEmpty();
    return;
  }

  drawHeader();
  clients.forEach((client, index) => {
    drawRow(client, tableY() + HEADER_HEIGHT + index * ROW_HEIGHT);
  });
}

function drawEmpty() {
  textAlign(CENTER, CENTER);
  textSize(16);
  fill(120, 130, 150);
  text("Waiting for performers…", width / 2, height / 2);
}

function drawHeader() {
  const x = tableX();
  const y = tableY();

  fill(160, 170, 190);
  textAlign(LEFT, CENTER);
  textSize(12);
  text("ID", x + 16, y + HEADER_HEIGHT / 2);
  text("AMP", x + 96, y + HEADER_HEIGHT / 2);
  text("FREQ", x + 216, y + HEADER_HEIGHT / 2);
  text("OUT CH", x + 348, y + HEADER_HEIGHT / 2);

  stroke(42, 46, 58);
  line(x, y + HEADER_HEIGHT, x + TABLE_WIDTH, y + HEADER_HEIGHT);
}

function drawRow(client, y) {
  const x = tableX();

  fill(94, 168, 255);
  textAlign(LEFT, CENTER);
  textSize(16);
  text(String(client.id), x + 16, y + ROW_HEIGHT / 2);

  fill(232, 236, 244);
  textSize(15);
  text(client.amp.toFixed(3), x + 96, y + ROW_HEIGHT / 2);
  text(Math.round(client.freq) + " Hz", x + 216, y + ROW_HEIGHT / 2);

  stroke(42, 46, 58);
  line(x, y + ROW_HEIGHT, x + TABLE_WIDTH, y + ROW_HEIGHT);
}
