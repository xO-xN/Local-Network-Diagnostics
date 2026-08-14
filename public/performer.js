// PNDS Template — performer page (p5).
//
// Landscape touch UI: two curved faders that follow the natural arc of the
// thumbs (the pivot is the wrist, outside the lower corners of the phone).
// Each fader is a TRUE circular arc (circle through the top end, the bottom
// end and a mid point bulging toward the center of the screen), sampled by
// angle; a touch projects radially onto the circle, so the whole thumb arc
// maps to the full fader range. Roles follow string instruments: the LEFT
// hand controls pitch (FREQ, like pressing the string), the RIGHT hand
// controls tone (AMP, like bowing). Portrait orientation shows a rotate
// hint and ignores input. The page joins the score server automatically
// and recovers its client id after a reconnect via the persisted claim
// token.

const P = window.PNDS;

let socket = null;
let joined = false;
let myId = null;
let rejectedReason = null;

let ampValue = 0;
let freqValue = 0;
let lastSentAmp = -1;
let lastSentFreq = -1;

const SEND_THRESHOLD = 0.002;
const TWO_PI = Math.PI * 2;

// Fader geometry (fractions of the window). Each arc runs from the top end
// (value 1) near its own edge down to the bottom end (value 0) closer to
// the center. The circle passes through both ends and a mid point that
// bulges toward the center — the thumb pivots at the wrist (outside the
// lower corners), so its tip traces an arc on the far side of the chord.
const FADER_TOP_X = 0.12; // top end distance from the outer edge
const FADER_TOP_Y = 0.08;
const FADER_BOTTOM_X = 0.4; // bottom end distance from the center
const FADER_BOTTOM_Y = 0.85;
const FADER_BULGE = 0.1; // arc height = 10% of the chord length (~38 px)
const TRACK_WEIGHT = 36;
const KNOB_RADIUS = 36; // knob diameter (p5 circle() takes a diameter)
const CURVE_STEPS = 60; // arc sampling resolution for rendering
const VALUE_OFFSET = 30; // value chip inset from the knob, away from the thumb
const LABEL_INSET = 80; // role labels inset from the screen edges

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent("stage");
  connectSocket();
  updateRotateOverlay();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  updateRotateOverlay();
}

function updateRotateOverlay() {
  const overlay = document.getElementById("rotate-overlay");
  overlay.classList.toggle("hidden", !isPortrait());
}

function isPortrait() {
  return window.innerHeight > window.innerWidth;
}

// ------------------------------------------------------------
// Socket.IO: join, recover, control
// ------------------------------------------------------------

function connectSocket() {
  socket = io("http://" + location.hostname + ":" + P.performerPort, {
    reconnection: true,
    reconnectionDelay: 1000,
  });

  socket.on(P.events.joined, (data) => {
    joined = true;
    myId = data.id;
    rejectedReason = null;
    localStorage.setItem(P.tokenKey, data.token);
  });

  socket.on(P.events.rejected, (data) => {
    joined = false;
    myId = null;
    rejectedReason = data.reason || "Rejected";
  });

  socket.on("connect", () => {
    // Fires on first connect and after every reconnect: (re)join with the
    // persisted token so the server hands back the same client id.
    socket.emit(P.events.join, {
      token: localStorage.getItem(P.tokenKey) || null,
    });
  });

  socket.on("disconnect", () => {
    joined = false;
  });
}

// ------------------------------------------------------------
// Fader geometry: true circular arcs
// ------------------------------------------------------------

// Center + radius of the circle through (ax, ay), (bx, by), (px, py).
function circumcircle(ax, ay, bx, by, px, py) {
  const d =
    2 *
    (ax * (by - py) + bx * (py - ay) + px * (ay - by));

  if (Math.abs(d) < 1e-9) {
    return null; // collinear — cannot happen with the bulge applied
  }

  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const p2 = px * px + py * py;
  const x =
    (a2 * (by - py) + b2 * (py - ay) + p2 * (ay - by)) / d;
  const y =
    (a2 * (px - bx) + b2 * (ax - px) + p2 * (bx - ax)) / d;

  return { x, y, r: Math.hypot(ax - x, ay - y) };
}

// Clockwise sweep (angle increase, p5 coordinates) from start to end.
function sweepFrom(start, end) {
  return ((end - start) % TWO_PI + TWO_PI) % TWO_PI;
}

// { x, y, r, aBottom, sweep }: circle center/radius, the angle of the
// bottom end (value 0) and the SIGNED sweep from bottom to top along the
// arc that passes through the bulge mid point (positive = clockwise). The
// two faders are mirror images, so their sweep signs are opposite.
function faderArc(side) {
  const top = {
    x: width * (side === "left" ? FADER_TOP_X : 1 - FADER_TOP_X),
    y: height * FADER_TOP_Y,
  };
  const bottom = {
    x: width * (side === "left" ? FADER_BOTTOM_X : 1 - FADER_BOTTOM_X),
    y: height * FADER_BOTTOM_Y,
  };
  const dx = bottom.x - top.x;
  const dy = bottom.y - top.y;
  const chord = Math.hypot(dx, dy) || 1;
  const sign = side === "left" ? 1 : -1;
  // Chord normal pointing toward the center of the screen.
  const nx = (dy / chord) * sign;
  const ny = (-dx / chord) * sign;
  const mid = {
    x: (top.x + bottom.x) / 2 + nx * chord * FADER_BULGE,
    y: (top.y + bottom.y) / 2 + ny * chord * FADER_BULGE,
  };

  const circle = circumcircle(
    top.x,
    top.y,
    bottom.x,
    bottom.y,
    mid.x,
    mid.y,
  );
  const aTop = Math.atan2(top.y - circle.y, top.x - circle.x);
  const aBottom = Math.atan2(bottom.y - circle.y, bottom.x - circle.x);
  const aMid = Math.atan2(mid.y - circle.y, mid.x - circle.x);

  // Signed sweep from bottom to top along the arc through mid.
  let sweep = sweepFrom(aBottom, aTop); // clockwise candidate
  if (sweepFrom(aBottom, aMid) > sweep) {
    sweep = -sweepFrom(aTop, aBottom); // mid lies counterclockwise
  }

  return { x: circle.x, y: circle.y, r: circle.r, aBottom, sweep };
}

// Point on the arc at fader value 0..1 (0 = bottom, 1 = top).
function arcPoint(arc, value) {
  const theta = arc.aBottom + value * arc.sweep;

  return {
    x: arc.x + arc.r * Math.cos(theta),
    y: arc.y + arc.r * Math.sin(theta),
  };
}

function sampleArc(arc) {
  const points = [];

  for (let index = 0; index <= CURVE_STEPS; index += 1) {
    points.push(arcPoint(arc, index / CURVE_STEPS));
  }

  return points;
}

// Projects (x, y) radially onto the arc's circle. Returns
// { value (0..1), dist (px to the circle), x, y (projected point) }.
function projectOnArc(x, y, side) {
  const arc = faderArc(side);
  const d = Math.hypot(x - arc.x, y - arc.y) || 1;
  const theta = Math.atan2(y - arc.y, x - arc.x);
  let rel = theta - arc.aBottom;

  // Normalize the offset to [-π, π].
  while (rel > Math.PI) {
    rel -= TWO_PI;
  }
  while (rel < -Math.PI) {
    rel += TWO_PI;
  }

  let value;

  if (arc.sweep > 0) {
    // Arc lies clockwise from the bottom end.
    if (rel < 0) {
      value = 0;
    } else if (rel > arc.sweep) {
      value = 1;
    } else {
      value = rel / arc.sweep;
    }
  } else {
    // Arc lies counterclockwise from the bottom end.
    if (rel > 0) {
      value = 0;
    } else if (rel < arc.sweep) {
      value = 1;
    } else {
      value = rel / arc.sweep;
    }
  }

  const clamped = constrain(value, 0, 1);
  const thetaC = arc.aBottom + clamped * arc.sweep;

  return {
    value: clamped,
    dist: Math.abs(d - arc.r),
    x: arc.x + arc.r * Math.cos(thetaC),
    y: arc.y + arc.r * Math.sin(thetaC),
  };
}

// The two arcs meet near the bottom center; assign each touch to the arc
// it is closer to.
function sideForPoint(x, y) {
  const left = projectOnArc(x, y, "left");
  const right = projectOnArc(x, y, "right");

  return left.dist <= right.dist ? "left" : "right";
}

// String-instrument roles: the left hand picks pitch, the right hand tone.
function setFaderFromPoint(side, x, y) {
  const { value } = projectOnArc(x, y, side);

  if (side === "left") {
    freqValue = value;
  } else {
    ampValue = value;
  }
}

// ------------------------------------------------------------
// Input
// ------------------------------------------------------------

function touchStarted() {
  if (isPortrait()) {
    return false;
  }

  for (const touch of touches) {
    setFaderFromPoint(sideForPoint(touch.x, touch.y), touch.x, touch.y);
  }

  sendIfChanged();
  return false;
}

function touchMoved() {
  if (isPortrait()) {
    return false;
  }

  for (const touch of touches) {
    setFaderFromPoint(sideForPoint(touch.x, touch.y), touch.x, touch.y);
  }

  sendIfChanged();
  return false;
}

function touchEnded() {
  return false;
}

function mouseDragged() {
  if (isPortrait()) {
    return false;
  }

  setFaderFromPoint(sideForPoint(mouseX, mouseY), mouseX, mouseY);
  sendIfChanged();
  return false;
}

function sendIfChanged() {
  if (!joined) {
    return;
  }

  if (
    Math.abs(ampValue - lastSentAmp) < SEND_THRESHOLD &&
    Math.abs(freqValue - lastSentFreq) < SEND_THRESHOLD
  ) {
    return;
  }

  lastSentAmp = ampValue;
  lastSentFreq = freqValue;
  socket.emit(P.events.control, { amp: ampValue, freq: freqValue });
}

// ------------------------------------------------------------
// Drawing
// ------------------------------------------------------------

function formatFreq() {
  const hz = Math.round(
    P.freqRange.min +
      freqValue * (P.freqRange.max - P.freqRange.min),
  );
  return hz + " Hz";
}

function draw() {
  background(20, 22, 28);

  // Portrait shows the DOM overlay (#rotate-overlay) with bilingual text;
  // the canvas itself stays quiet.
  if (isPortrait()) {
    return;
  }

  drawFader("left", freqValue, formatFreq());
  drawFader("right", ampValue, ampValue.toFixed(2));
  drawLabels();
  drawStatus();
}

function drawFader(side, value, valueText) {
  const arc = faderArc(side);
  const knob = arcPoint(arc, value);

  // track: the true circular arc, sampled (p5 arc() angle conventions
  // don't cover counterclockwise sweeps, so render as a polyline)
  noFill();
  stroke(42, 46, 58);
  strokeWeight(TRACK_WEIGHT);
  strokeCap(ROUND);
  strokeJoin(ROUND);
  beginShape();
  for (const point of sampleArc(arc)) {
    vertex(point.x, point.y);
  }
  endShape(OPEN);

  // knob: white dot
  noStroke();
  fill(255);
  circle(knob.x, knob.y, KNOB_RADIUS);

  // value: inset toward the center of the screen so the thumb never
  // covers it
  const chipX = side === "left" ? knob.x + VALUE_OFFSET : knob.x - VALUE_OFFSET;
  drawValueChip(valueText, chipX, knob.y, side);
}

// NOTE: the parameter is named valueText, not text — a parameter named
// `text` would shadow p5's global text() function.
function drawValueChip(valueText, x, y, side) {
  textSize(16);
  const chipWidth = textWidth(valueText) + 14;
  const chipHeight = 24;
  const chipX = side === "left" ? x : x - chipWidth;

  fill(14, 15, 20, 200);
  rect(chipX, y - chipHeight / 2, chipWidth, chipHeight, 6);

  fill(255);
  textAlign(side === "left" ? LEFT : RIGHT, CENTER);
  text(valueText, side === "left" ? x + 7 : x - 7, y + 1);
}

// Role labels pinned to the lower corners (left = pitch, right = tone),
// inset from the edges so they do not hug the screen border.
function drawLabels() {
  textSize(14);
  fill(180, 190, 210);

  textAlign(LEFT, BOTTOM);
  text("FREQ", LABEL_INSET, height - 16);

  textAlign(RIGHT, BOTTOM);
  text("AMP", width - LABEL_INSET, height - 16);
}

function drawStatus() {
  textAlign(CENTER, TOP);
  textSize(24);

  if (rejectedReason) {
    fill(255, 120, 120);
    text("rejected: " + rejectedReason, width / 2, 14);
  } else if (joined) {
    fill(120, 220, 150);
    text("performer " + myId, width / 2, 14);
  } else {
    fill(200, 200, 210);
    text("connecting…", width / 2, 14);
  }
}
