// Unit tests for lib/diagnostics.js — metrics, status rules, hysteresis.
//
// The state machine and metric math are pure (no timers, no sockets), so
// every rule from the spec is testable without a server.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  STATUS,
  percentile,
  decideStatus,
  MetricsCollector,
  StatusMachine,
  DiagnosticsSession,
} = require("../lib/diagnostics");

// ------------------------------------------------------------
// percentile
// ------------------------------------------------------------

test("percentile: nearest-rank p50/p95 over unsorted values", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([10], 0.5), 10);
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2); // ceil(0.5*4) - 1 = index 1
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);

  const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(twenty, 0.95), 19); // index 18
  assert.equal(percentile(twenty, 0.5), 10); // index 9
});

// ------------------------------------------------------------
// MetricsCollector
// ------------------------------------------------------------

test("MetricsCollector: sliding window, jitter from adjacent RTT diffs", () => {
  const collector = new MetricsCollector({ windowSize: 3 });

  assert.equal(collector.rttP50, null);
  assert.equal(collector.jitterP95, 0);

  collector.record(10);
  collector.record(20);
  assert.equal(collector.jitterP95, 10); // single diff [10] → p95 10

  collector.record(30);
  collector.record(40); // window is now [20, 30, 40]

  assert.equal(collector.samples.length, 3);
  assert.equal(collector.rttP50, 30);
  assert.equal(collector.rttP95, 40);
  assert.equal(collector.jitterP95, 10); // diffs [10, 10]
  assert.equal(collector.lastRtt, 40);

  collector.record(7, 1.5);
  assert.equal(collector.lastProcessingMs, 1.5);
});

test("MetricsCollector: timeouts count up, a successful ack resets the streak", () => {
  const collector = new MetricsCollector();

  collector.recordTimeout();
  collector.recordTimeout();
  assert.equal(collector.timeouts, 2);
  assert.equal(collector.consecutiveTimeouts, 2);

  collector.record(5);
  assert.equal(collector.consecutiveTimeouts, 0);
  assert.equal(collector.timeouts, 2); // total is not reset
});

test("MetricsCollector: reset clears everything", () => {
  const collector = new MetricsCollector();

  collector.record(5, 1);
  collector.recordTimeout();
  collector.reset();

  assert.equal(collector.rttP50, null);
  assert.equal(collector.rttP95, null);
  assert.equal(collector.jitterP95, 0);
  assert.equal(collector.timeouts, 0);
  assert.equal(collector.consecutiveTimeouts, 0);
  assert.equal(collector.samples.length, 0);
  assert.equal(collector.lastRtt, null);
  assert.equal(collector.acks, 0);
  assert.equal(collector.lateAcks, 0);
  assert.equal(collector.lossRate, 0);
  assert.equal(collector.burstTimeoutRate, 0);
});

test("MetricsCollector: loss rate = timeouts / (acks + timeouts)", () => {
  const collector = new MetricsCollector();

  assert.equal(collector.lossRate, 0, "no probes yet → 0");

  collector.record(5);
  collector.record(5);
  collector.record(5);
  assert.equal(collector.acks, 3);
  assert.equal(collector.lossRate, 0);

  collector.recordTimeout();
  assert.equal(collector.timeouts, 1);
  assert.equal(collector.lossRate, 0.25, "1 timeout out of 4 probes");
});

test("MetricsCollector: burst timeout rate is computed per completed burst window", () => {
  const collector = new MetricsCollector();

  assert.equal(collector.burstTimeoutRate, 0, "no window completed yet");

  collector.beginBurstWindow();
  collector.record(5);
  collector.record(5);
  collector.recordTimeout();
  collector.recordTimeout();
  // During the window the rate is still the last completed window's (0).
  assert.equal(collector.burstTimeoutRate, 0);

  collector.endBurstWindow();
  assert.equal(collector.burstTimeoutRate, 0.5, "2 timeouts out of 4 probes");

  // A new window starts from scratch; the frozen rate survives until the
  // next window completes.
  collector.beginBurstWindow();
  collector.record(5);
  assert.equal(collector.burstTimeoutRate, 0.5);
  collector.endBurstWindow();
  assert.equal(collector.burstTimeoutRate, 0, "1 ack, 0 timeouts");

  // An empty window keeps the previous rate rather than dividing by zero.
  collector.beginBurstWindow();
  collector.endBurstWindow();
  assert.equal(collector.burstTimeoutRate, 0);
});

test("MetricsCollector: jitter ignores the phase step and the wake-up sample", () => {
  const collector = new MetricsCollector({ windowSize: 10 });

  // A hot burst block; the calm block sits at the woken (idle) level — the
  // Wi-Fi power-save wake-up every idle second adds to a 1 Hz probe.
  [3, 3, 3, 3, 3, 3, 3, 3].forEach((rtt) => {
    collector.record(rtt, null, "burst");
  });
  [80, 80].forEach((rtt) => collector.record(rtt, null, "calm"));

  // Legacy whole-window math diffed 3 → 80 and reported the phase step
  // itself as ~77 ms of jitter for the whole calm phase. Scoped: only
  // same-phase, adjacent, non-wake-up pairs count.
  assert.equal(collector.jitterP95, 0);
  assert.equal(collector.rttP95, 3, "calm samples stay out of the RTT metrics");
  assert.equal(collector.burstSampleCount, 8);
  assert.equal(collector.lastRtt, 80, "the raw latest probe is untouched");
});

test("MetricsCollector: a burst that opens with a wake-up sample stays clean", () => {
  const collector = new MetricsCollector({ windowSize: 10 });

  [80, 80].forEach((rtt) => collector.record(rtt, null, "calm"));
  // The first burst probe pays the wake-up; the radio is hot from the next.
  collector.record(80, null, "burst");
  [3, 3, 3].forEach((rtt) => collector.record(rtt, null, "burst"));

  assert.equal(collector.jitterP95, 0, "the wake-up sample forms no pair");
  assert.equal(collector.rttP95, 3, "nor enters the RTT percentiles");
  assert.equal(collector.burstSampleCount, 3);
});

// ------------------------------------------------------------
// Late acks — delivered-but-slow probes (v0.6.0)
// ------------------------------------------------------------

test("MetricsCollector: a late ack withdraws the loss it caused", () => {
  const collector = new MetricsCollector();

  collector.beginBurstWindow();
  collector.record(5);
  collector.recordTimeout();
  assert.equal(collector.timeouts, 1);
  assert.equal(collector.consecutiveTimeouts, 1);

  collector.recordLateAck(240, null, "burst");

  assert.equal(collector.lateAcks, 1);
  assert.equal(collector.timeouts, 0, "a delivered probe is no loss");
  assert.equal(collector.acks, 2, "both probes were delivered");
  assert.equal(collector.consecutiveTimeouts, 0, "the client is answering");
  assert.equal(collector.lastRtt, 240, "the slow RTT is kept");

  collector.endBurstWindow();
  assert.equal(
    collector.burstTimeoutRate,
    0,
    "the window counts deliveries, not deadlines",
  );
  assert.equal(collector.lossRate, 0);
});

test("MetricsCollector: after the window freezes, a late ack corrects only the lifetime totals", () => {
  const collector = new MetricsCollector();

  collector.beginBurstWindow();
  collector.recordTimeout();
  collector.endBurstWindow();
  assert.equal(collector.burstTimeoutRate, 1);

  collector.recordLateAck(240, null, "burst");

  assert.equal(collector.timeouts, 0);
  assert.equal(
    collector.burstTimeoutRate,
    1,
    "the frozen rate is history — it cannot be rewritten",
  );
});

test("MetricsCollector: a late sample colors RTT but never jitter", () => {
  const collector = new MetricsCollector({ windowSize: 10 });

  collector.record(3, null, "burst");
  collector.record(3, null, "burst");
  collector.recordLateAck(280, null, "burst");
  collector.record(3, null, "burst");
  collector.record(3, null, "burst");

  // The stall RTT is real load-condition evidence: it enters the RTT
  // percentiles (a link answering everything over-timeout must read
  // Yellow on RTT, never Green)…
  assert.equal(collector.rttP95, 280);
  assert.equal(collector.burstSampleCount, 5);
  // …but it forms no jitter pair — one stall must not read as instability.
  assert.equal(collector.jitterP95, 0);
});

// ------------------------------------------------------------
// Metrics window — one full burst (v0.6.0)
// ------------------------------------------------------------

test("MetricsCollector: the default window holds a full burst, so p95 tolerates outliers", () => {
  const collector = new MetricsCollector();

  assert.equal(collector.windowSize, 60);

  for (let i = 0; i < 57; i += 1) {
    collector.record(5, null, "burst");
  }

  // Three scheduling outliers inside one burst window…
  collector.record(90, null, "burst");
  collector.record(70, null, "burst");
  collector.record(80, null, "burst");

  // …stay below the nearest-rank p95 (the 57th of 60 sorted samples).
  // The 10-sample window read the max (90) and flipped the card Yellow.
  assert.equal(collector.rttP95, 5);
});

// ------------------------------------------------------------
// decideStatus — spec priority order
// ------------------------------------------------------------

const good = {
  disconnected: false,
  consecutiveTimeouts: 0,
  burstTimeoutRate: 0,
  jitterP95: 5,
  rttP95: 40,
  samples: 1,
};

test("decideStatus: Green when every metric is inside the safe thresholds", () => {
  assert.deepEqual(decideStatus(good), {
    status: STATUS.GREEN,
    reason: "green",
  });

  // The v0.6.0 calibrated green line: normal Wi-Fi under show load
  // (jitter 10–24, RTT 50–99) is safe, not "between thresholds".
  assert.equal(
    decideStatus({ ...good, jitterP95: 24, rttP95: 99 }).status,
    STATUS.GREEN,
  );
});

test("decideStatus: priority order, highest first", () => {
  assert.equal(decideStatus({ ...good, disconnected: true }).status, STATUS.RED);
  assert.equal(
    decideStatus({ ...good, disconnected: true, rttP95: 0 }).status,
    STATUS.RED,
    "disconnected wins over every other rule",
  );

  assert.equal(
    decideStatus({ ...good, consecutiveTimeouts: 3 }).status,
    STATUS.RED,
  );
  assert.equal(
    decideStatus({ ...good, consecutiveTimeouts: 2 }).status,
    STATUS.YELLOW,
    "1–2 consecutive timeouts is not Red yet, but not Green either",
  );

  assert.equal(
    decideStatus({ ...good, burstTimeoutRate: 0.06 }).status,
    STATUS.RED,
  );
  assert.equal(
    decideStatus({ ...good, burstTimeoutRate: 0.05 }).status,
    STATUS.GREEN,
    "exactly 5% is not > 5%",
  );

  assert.equal(decideStatus({ ...good, jitterP95: 51 }).status, STATUS.YELLOW);
  assert.equal(decideStatus({ ...good, rttP95: 201 }).status, STATUS.YELLOW);
});

test("decideStatus: between green and yellow thresholds is Yellow", () => {
  // Green requires jitter < 25 AND rtt p95 < 100; anything at or above a
  // green line but below the yellow triggers still fails the green check.
  assert.equal(decideStatus({ ...good, jitterP95: 25 }).status, STATUS.YELLOW); // not < 25
  assert.equal(decideStatus({ ...good, jitterP95: 49 }).status, STATUS.YELLOW);
  assert.equal(decideStatus({ ...good, rttP95: 100 }).status, STATUS.YELLOW); // not < 100
  assert.equal(decideStatus({ ...good, rttP95: 199 }).status, STATUS.YELLOW);
});

test("decideStatus: missing metrics count as zero, not as violations", () => {
  assert.equal(decideStatus({ ...good, jitterP95: null, rttP95: null }).status, STATUS.GREEN);
});

test("decideStatus: 1–2 consecutive timeouts are Yellow, never Green", () => {
  assert.equal(decideStatus({ ...good, consecutiveTimeouts: 1 }).status, STATUS.YELLOW);
  assert.equal(decideStatus({ ...good, consecutiveTimeouts: 2 }).status, STATUS.YELLOW);
  assert.equal(decideStatus({ ...good, consecutiveTimeouts: 1 }).reason, "timeout");
});

test("decideStatus: reasons describe the winning rule", () => {
  assert.equal(decideStatus({ ...good, disconnected: true }).reason, "disconnected");
  assert.equal(
    decideStatus({ ...good, consecutiveTimeouts: 3 }).reason,
    "consecutiveTimeouts",
  );
  assert.equal(
    decideStatus({ ...good, burstTimeoutRate: 0.06 }).reason,
    "burstTimeoutRate",
  );
  assert.equal(decideStatus({ ...good, jitterP95: 51 }).reason, "jitter");
  assert.equal(decideStatus({ ...good, rttP95: 201 }).reason, "rtt");
  assert.equal(decideStatus({ ...good, rttP95: 150 }).reason, "outsideSafe");
});

// ------------------------------------------------------------
// StatusMachine — warm-up, rules, hysteresis
// ------------------------------------------------------------

test("StatusMachine: gray while warming up, then green", () => {
  const machine = new StatusMachine({ warmupCycles: 2 });

  assert.equal(machine.status, STATUS.GRAY);

  // Even a red-level input does not skip the warm-up.
  machine.cycle({ ...good, consecutiveTimeouts: 9 });
  assert.equal(machine.status, STATUS.GRAY);

  machine.cycle(good);
  assert.equal(machine.status, STATUS.GREEN);
  assert.equal(machine.reason, "green");
});

test("StatusMachine: gray until there is evidence, red still reachable without any ack", () => {
  const machine = new StatusMachine({ warmupCycles: 1 });

  // No ack yet and no timeouts → gray (warming up).
  machine.cycle({ ...good, samples: 0 });
  assert.equal(machine.status, STATUS.GRAY);

  // One or two timeouts with zero acks: still no evidence → gray.
  machine.cycle({ ...good, samples: 0, consecutiveTimeouts: 1 });
  assert.equal(machine.status, STATUS.GRAY);

  // Three consecutive timeouts with zero acks → Red (must not be stuck gray).
  machine.cycle({ ...good, samples: 0, consecutiveTimeouts: 3 });
  assert.equal(machine.status, STATUS.RED);
});

test("StatusMachine: red after 3 consecutive timeouts, yellow on jitter/rtt", () => {
  const machine = new StatusMachine({ warmupCycles: 1 });

  machine.cycle({ ...good, samples: 1 });
  assert.equal(machine.status, STATUS.GREEN);

  machine.cycle({ ...good, consecutiveTimeouts: 3, samples: 1 });
  assert.equal(machine.status, STATUS.RED);
  assert.equal(machine.reason, "consecutiveTimeouts");

  const yellow = new StatusMachine({ warmupCycles: 1 });
  yellow.cycle({ ...good, jitterP95: 60, samples: 1 });
  assert.equal(yellow.status, STATUS.YELLOW);
  assert.equal(yellow.reason, "jitter");
});

test("StatusMachine: worsening is instant, recovery needs 10 good cycles", () => {
  const machine = new StatusMachine({ warmupCycles: 1, hysteresisCycles: 10 });

  machine.cycle({ ...good, samples: 1 });
  assert.equal(machine.status, STATUS.GREEN);

  // Instant worsening.
  machine.cycle({ ...good, rttP95: 250, samples: 1 });
  assert.equal(machine.status, STATUS.YELLOW);
  assert.equal(machine.goodCycles, 0);

  // 9 good cycles: still Yellow, counter climbing.
  for (let i = 0; i < 9; i += 1) {
    machine.cycle({ ...good, samples: 1 });
  }
  assert.equal(machine.status, STATUS.YELLOW);
  assert.equal(machine.goodCycles, 9);

  // The 10th consecutive good cycle recovers to Green.
  machine.cycle({ ...good, samples: 1 });
  assert.equal(machine.status, STATUS.GREEN);
  assert.equal(machine.goodCycles, 0);
});

test("StatusMachine: an isolated bad Yellow cycle costs 2 cycles, not a full reset", () => {
  const machine = new StatusMachine({ warmupCycles: 1, hysteresisCycles: 10 });

  machine.cycle({ ...good, consecutiveTimeouts: 3, samples: 1 });
  assert.equal(machine.status, STATUS.RED);

  for (let i = 0; i < 5; i += 1) {
    machine.cycle({ ...good, samples: 1 });
  }
  assert.equal(machine.goodCycles, 5);

  // One Yellow-level cycle (jitter over the yellow threshold): the credit
  // decays by 2 instead of resetting — an isolated outlier must not undo
  // five clean seconds.
  machine.cycle({ ...good, jitterP95: 60, samples: 1 });
  assert.equal(machine.status, STATUS.YELLOW);
  assert.equal(machine.goodCycles, 3);

  // 7 more good cycles land the recovery (3 + 7 = 10).
  for (let i = 0; i < 6; i += 1) {
    machine.cycle({ ...good, samples: 1 });
  }
  assert.equal(machine.status, STATUS.YELLOW);

  machine.cycle({ ...good, samples: 1 });
  assert.equal(machine.status, STATUS.GREEN);
});

test("StatusMachine: a flapping link never nets back to Green", () => {
  const machine = new StatusMachine({ warmupCycles: 1, hysteresisCycles: 10 });

  machine.cycle({ ...good, jitterP95: 60, samples: 1 });
  assert.equal(machine.status, STATUS.YELLOW);

  // Good/bad alternation earns +1 then pays 2 — the credit never climbs
  // back to the threshold, so a link failing half of its seconds stays
  // Yellow for as long as it flaps.
  for (let i = 0; i < 12; i += 1) {
    machine.cycle({ ...good, samples: 1 });
    machine.cycle({ ...good, jitterP95: 60, samples: 1 });
  }
  assert.equal(machine.status, STATUS.YELLOW);
  assert.equal(machine.goodCycles, 0);
});

test("StatusMachine: a Red-level cycle burns all recovery credit", () => {
  const machine = new StatusMachine({ warmupCycles: 1, hysteresisCycles: 10 });

  machine.cycle({ ...good, jitterP95: 60, samples: 1 });
  for (let i = 0; i < 5; i += 1) {
    machine.cycle({ ...good, samples: 1 });
  }
  assert.equal(machine.goodCycles, 5);

  // Red is definite evidence, not noise: no partial credit survives it.
  machine.cycle({ ...good, burstTimeoutRate: 0.5, samples: 1 });
  assert.equal(machine.status, STATUS.RED);
  assert.equal(machine.goodCycles, 0);
});

test("StatusMachine: a timing-out client is not Green and loses recovery credit", () => {
  const machine = new StatusMachine({ warmupCycles: 1, hysteresisCycles: 10 });

  machine.cycle({ ...good, consecutiveTimeouts: 3, samples: 1 });
  assert.equal(machine.status, STATUS.RED);

  for (let i = 0; i < 4; i += 1) {
    machine.cycle({ ...good, samples: 1 });
  }
  assert.equal(machine.goodCycles, 4);

  // One timeout cycle: instant status is Yellow, so it neither shows Green
  // nor counts towards the 10 good cycles — but being an isolated Yellow
  // blip it only decays the credit (4 − 2).
  machine.cycle({ ...good, consecutiveTimeouts: 1, samples: 1 });
  assert.equal(machine.status, STATUS.YELLOW);
  assert.equal(machine.goodCycles, 2, "a timeout cycle decays credit by 2");
});

test("StatusMachine: reset returns to gray", () => {
  const machine = new StatusMachine({ warmupCycles: 1 });

  machine.cycle({ ...good, consecutiveTimeouts: 3, samples: 1 });
  assert.equal(machine.status, STATUS.RED);

  machine.reset();
  assert.equal(machine.status, STATUS.GRAY);
  assert.equal(machine.cycles, 0);
});

test("StatusMachine: disconnected is Red immediately, even during warm-up", () => {
  const machine = new StatusMachine({ warmupCycles: 2 });

  // A disconnect skips the warm-up gray guard — priority 1 of the spec.
  machine.cycle({ ...good, disconnected: true, samples: 0 });
  assert.equal(machine.status, STATUS.RED);
  assert.equal(machine.reason, "disconnected");

  // From Green, a disconnect flips Red instantly and resets recovery credit.
  const healthy = new StatusMachine({ warmupCycles: 1 });
  healthy.cycle({ ...good, samples: 1 });
  assert.equal(healthy.status, STATUS.GREEN);

  healthy.cycle({ ...good, disconnected: true, samples: 1 });
  assert.equal(healthy.status, STATUS.RED);
  assert.equal(healthy.goodCycles, 0);
});

// ------------------------------------------------------------
// DiagnosticsSession
// ------------------------------------------------------------

test("DiagnosticsSession: per-client statuses, gray excluded from Overall", () => {
  const session = new DiagnosticsSession();

  session.addClient(1);
  session.addClient(2);
  session.start();
  session.setPhase("burst"); // the server enters burst at diag:start

  session.recordAck(1, 2);
  session.recordAck(1, 3);
  session.cycleAll(); // cycle 1
  session.cycleAll(); // cycle 2

  const snap = session.snapshot();

  assert.equal(snap.running, true);
  assert.equal(snap.clients["1"].status, STATUS.GREEN);
  assert.equal(typeof snap.clients["1"].metrics.rttP50, "number");
  assert.equal(snap.clients["2"].status, STATUS.GRAY, "no samples yet → gray");
  assert.equal(snap.overall, STATUS.GREEN, "gray client does not drag Overall");
});

test("DiagnosticsSession: Overall = worst online status", () => {
  const session = new DiagnosticsSession();

  session.addClient(1);
  session.addClient(2);
  session.addClient(3);
  session.start();
  session.setPhase("burst");

  session.recordAck(1, 2);
  session.recordAck(2, 2);
  session.recordAck(3, 2);
  session.cycleAll();
  session.cycleAll();
  assert.equal(session.snapshot().overall, STATUS.GREEN);

  // Client 2 degrades to Yellow (jitter from swinging RTTs).
  session.recordAck(2, 2);
  session.recordAck(2, 60);
  session.recordAck(2, 2);
  session.cycleAll();
  assert.equal(session.snapshot().overall, STATUS.YELLOW);

  // Client 3 hits Red via 3 consecutive timeouts.
  session.recordTimeout(3);
  session.recordTimeout(3);
  session.recordTimeout(3);
  session.cycleAll();
  assert.equal(session.snapshot().overall, STATUS.RED);
});

test("DiagnosticsSession: start() resets every client for a fresh test", () => {
  const session = new DiagnosticsSession();

  session.addClient(1);
  session.start();
  session.recordTimeout(1);
  session.recordTimeout(1);
  session.recordTimeout(1);
  session.cycleAll();
  session.cycleAll();
  assert.equal(session.snapshot().clients["1"].status, STATUS.RED);

  session.start();
  const snap = session.snapshot();

  assert.equal(snap.running, true);
  assert.equal(snap.overall, STATUS.GRAY);
  assert.equal(snap.clients["1"].status, STATUS.GRAY);
  assert.equal(snap.clients["1"].metrics.samples, 0);
  assert.equal(snap.clients["1"].metrics.consecutiveTimeouts, 0);
});

test("DiagnosticsSession: removeClient drops a card, stop() reports idle", () => {
  const session = new DiagnosticsSession();

  session.addClient(1);
  session.start();
  session.removeClient(1);

  assert.equal(session.snapshot().clients["1"], undefined);

  session.stop();
  assert.equal(session.snapshot().running, false);
});

test("DiagnosticsSession: addClient records Connected; re-adding the same id is a Reconnect that resets to gray", () => {
  const session = new DiagnosticsSession();

  session.addClient(1, 1000);
  session.start();
  session.setPhase("burst");

  let snap = session.snapshot();
  assert.equal(snap.clients["1"].lastEvent.type, "connected");
  assert.equal(snap.clients["1"].lastEvent.at, 1000);
  assert.equal(snap.clients["1"].events.length, 1);

  session.recordAck(1, 2);
  session.recordAck(1, 3);
  session.cycleAll();
  session.cycleAll();
  assert.equal(session.snapshot().clients["1"].status, STATUS.GREEN);

  // Same id joins again (claim token restored the identity): the machine
  // and metrics start over, a "reconnected" event is appended.
  session.addClient(1, 5000);

  snap = session.snapshot();
  assert.equal(snap.clients["1"].status, STATUS.GRAY);
  assert.equal(snap.clients["1"].metrics.samples, 0);
  assert.equal(snap.clients["1"].lastEvent.type, "reconnected");
  assert.deepEqual(
    snap.clients["1"].events.map((event) => event.type),
    ["connected", "reconnected"],
  );
});

test("DiagnosticsSession: disconnectClient flips Red immediately and records the event", () => {
  const session = new DiagnosticsSession();

  session.addClient(1, 1000);
  session.start();
  session.setPhase("burst");
  session.recordAck(1, 2);
  session.recordAck(1, 3);
  session.cycleAll();
  session.cycleAll();
  assert.equal(session.snapshot().clients["1"].status, STATUS.GREEN);

  session.disconnectClient(1, 4000);

  const snap = session.snapshot();
  assert.equal(snap.clients["1"].status, STATUS.RED);
  assert.equal(snap.clients["1"].reason, "disconnected");
  assert.equal(snap.clients["1"].connected, false);
  assert.equal(snap.clients["1"].lastEvent.type, "disconnected");
  assert.equal(snap.clients["1"].lastEvent.at, 4000);

  // A second disconnect call is a no-op (no duplicate events).
  session.disconnectClient(1, 4500);
  assert.equal(session.snapshot().clients["1"].events.length, 2);

  // Reconnect restores the identity and returns through warm-up.
  session.addClient(1, 5000);
  session.cycleAll();
  assert.equal(session.snapshot().clients["1"].status, STATUS.GRAY);
});

test("DiagnosticsSession: disconnected clients are excluded from Overall", () => {
  const session = new DiagnosticsSession();

  session.addClient(1);
  session.addClient(2);
  session.start();
  session.setPhase("burst");

  session.recordAck(1, 2);
  session.recordAck(1, 3);
  session.cycleAll();
  session.cycleAll();
  assert.equal(session.snapshot().clients["1"].status, STATUS.GREEN);

  session.disconnectClient(2, 1000);
  assert.equal(session.snapshot().clients["2"].status, STATUS.RED);

  assert.equal(
    session.snapshot().overall,
    STATUS.GREEN,
    "the Red disconnected client must not drag Overall",
  );
});

test("DiagnosticsSession: burst window stats feed the status decision", () => {
  const session = new DiagnosticsSession({ warmupCycles: 1 });

  session.addClient(1);
  session.start();
  session.setPhase("burst");
  session.beginBurstWindow();

  // Interleaved acks/timeouts: 5 acks + 5 timeouts → 50% burst loss with a
  // consecutive-timeout streak of only 1, so the burst rule is the winner.
  for (let i = 0; i < 5; i += 1) {
    session.recordAck(1, 5);
    session.recordTimeout(1);
  }

  session.endBurstWindow();
  session.cycleAll();

  const snap = session.snapshot();
  assert.equal(snap.phase, "burst");
  assert.equal(snap.clients["1"].metrics.burstTimeoutRate, 0.5);
  assert.equal(snap.clients["1"].status, STATUS.RED);
  assert.equal(snap.clients["1"].reason, "burstTimeoutRate");
});

test("DiagnosticsSession: snapshot exposes loss rate, processing time and events", () => {
  const session = new DiagnosticsSession();

  session.addClient(1, 500);
  session.start();
  session.recordAck(1, 7, 1.25);
  session.recordAck(1, 9, 2.5);
  session.recordTimeout(1);

  const snap = session.snapshot(900);
  const metrics = snap.clients["1"].metrics;

  assert.equal(metrics.acks, 2);
  assert.equal(metrics.lossRate, 1 / 3);
  assert.equal(metrics.lastProcessingMs, 2.5);
  assert.equal(snap.clients["1"].lastEvent.type, "connected");
  assert.equal(snap.clients["1"].lastEvent.agoMs, 400, "900 - 500");
  assert.equal(snap.clients["1"].events.length, 1);
});

test("DiagnosticsSession: the calm wake-up step never flags a healthy client", () => {
  const session = new DiagnosticsSession();
  session.addClient(1);
  session.start();
  session.setPhase("burst");

  for (let i = 0; i < 8; i += 1) {
    session.recordAck(1, 3);
  }
  session.cycleAll();
  session.cycleAll();
  assert.equal(session.snapshot().overall, STATUS.GREEN);

  // Calm: every idle second lets Wi-Fi power save add its wake-up delay,
  // so each 1 Hz probe reads ~80 ms on an otherwise perfect link. The
  // legacy window kept the burst samples beside them, read the phase step
  // (~77 ms) off them as jitter and flagged Yellow for the whole calm
  // phase — and the 10-cycle hysteresis could never recover to Green.
  session.setPhase("calm");
  session.recordAck(1, 80);
  session.recordAck(1, 80);
  session.cycleAll();
  session.cycleAll();

  let snap = session.snapshot();
  assert.equal(snap.overall, STATUS.GREEN);
  assert.equal(snap.clients["1"].metrics.jitterP95, 0);
  assert.equal(snap.clients["1"].metrics.rttP95, 3);

  // The next burst opens with a wake-up sample before the radio is hot
  // again; it must not swing the metrics either.
  session.setPhase("burst");
  session.recordAck(1, 80);
  session.recordAck(1, 3);
  session.recordAck(1, 3);
  session.cycleAll();

  snap = session.snapshot();
  assert.equal(snap.overall, STATUS.GREEN);
  assert.equal(snap.clients["1"].metrics.jitterP95, 0);
  assert.equal(snap.clients["1"].metrics.rttP95, 3);
});

test("DiagnosticsSession: a client joining mid-calm stays Gray until load evidence", () => {
  const session = new DiagnosticsSession();
  session.addClient(1);
  session.start();
  session.setPhase("calm");

  session.recordAck(1, 80);
  session.recordAck(1, 80);
  session.cycleAll();
  session.cycleAll();
  session.cycleAll();
  assert.equal(
    session.snapshot().clients["1"].status,
    STATUS.GRAY,
    "calm acks alone are not show-condition evidence",
  );
});

test("DiagnosticsSession: a machine stall reads as RTT, not as loss", () => {
  const session = new DiagnosticsSession({ warmupCycles: 1 });
  session.addClient(1);
  session.start();
  session.setPhase("burst");
  session.beginBurstWindow();

  // Every probe crosses the 200 ms deadline, every answer still arrives:
  // the stall lands on RTT (Yellow), the loss rules stay quiet.
  for (let i = 0; i < 20; i += 1) {
    session.recordTimeout(1);
    session.recordLateAck(1, 240, null, "burst");
  }

  session.endBurstWindow();
  session.cycleAll();

  const card = session.snapshot().clients["1"];
  assert.equal(card.metrics.burstTimeoutRate, 0);
  assert.equal(card.metrics.rttP95, 240);
  assert.equal(card.metrics.lateAcks, 20);
  assert.equal(card.status, STATUS.YELLOW);
  assert.equal(card.reason, "rtt");
});

test("DiagnosticsSession: a sample carries the phase the probe was SENT in", () => {
  const session = new DiagnosticsSession({ warmupCycles: 1 });
  session.addClient(1);
  session.start();

  session.setPhase("burst");
  session.recordAck(1, 3); // stamped burst via the session phase

  // The phase flips to calm before a burst-tail probe's ack arrives: the
  // send-time stamp keeps it a burst sample.
  session.setPhase("calm");
  session.recordAck(1, 3, null, "burst");
  session.recordAck(1, 80, null, "calm"); // the calm wake-up probe

  session.cycleAll();

  const card = session.snapshot().clients["1"];
  assert.equal(card.metrics.samples, 3);
  assert.equal(
    card.metrics.rttP95,
    3,
    "burst-scoped: the burst-tail ack counts, the calm probe does not",
  );
  assert.equal(card.status, STATUS.GREEN);
});
