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
    reason: "Suitable for performance",
  });
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

  assert.equal(decideStatus({ ...good, jitterP95: 26 }).status, STATUS.YELLOW);
  assert.equal(decideStatus({ ...good, rttP95: 101 }).status, STATUS.YELLOW);
});

test("decideStatus: between yellow and green thresholds is Yellow", () => {
  // Green requires jitter < 10 AND rtt p95 < 50; anything above that but
  // below the yellow thresholds still fails the green check.
  assert.equal(decideStatus({ ...good, jitterP95: 12 }).status, STATUS.YELLOW);
  assert.equal(decideStatus({ ...good, jitterP95: 10 }).status, STATUS.YELLOW); // not < 10
  assert.equal(decideStatus({ ...good, rttP95: 60 }).status, STATUS.YELLOW);
  assert.equal(decideStatus({ ...good, rttP95: 100 }).status, STATUS.YELLOW); // not < 50
});

test("decideStatus: missing metrics count as zero, not as violations", () => {
  assert.equal(decideStatus({ ...good, jitterP95: null, rttP95: null }).status, STATUS.GREEN);
});

test("decideStatus: 1–2 consecutive timeouts are Yellow, never Green", () => {
  assert.equal(decideStatus({ ...good, consecutiveTimeouts: 1 }).status, STATUS.YELLOW);
  assert.equal(decideStatus({ ...good, consecutiveTimeouts: 2 }).status, STATUS.YELLOW);
  assert.equal(decideStatus({ ...good, consecutiveTimeouts: 1 }).reason, "Recent probe timeouts");
});

test("decideStatus: reasons describe the winning rule", () => {
  assert.equal(decideStatus({ ...good, disconnected: true }).reason, "Disconnected");
  assert.equal(
    decideStatus({ ...good, consecutiveTimeouts: 3 }).reason,
    "3 consecutive probe timeouts",
  );
  assert.equal(
    decideStatus({ ...good, burstTimeoutRate: 0.06 }).reason,
    "Burst timeout rate above 5%",
  );
  assert.equal(decideStatus({ ...good, jitterP95: 26 }).reason, "High timing variation");
  assert.equal(decideStatus({ ...good, rttP95: 101 }).reason, "Slow responses");
  assert.equal(decideStatus({ ...good, rttP95: 60 }).reason, "Outside safe thresholds");
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
  assert.equal(machine.reason, "Suitable for performance");
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
  assert.equal(machine.reason, "3 consecutive probe timeouts");

  const yellow = new StatusMachine({ warmupCycles: 1 });
  yellow.cycle({ ...good, jitterP95: 30, samples: 1 });
  assert.equal(yellow.status, STATUS.YELLOW);
  assert.equal(yellow.reason, "High timing variation");
});

test("StatusMachine: worsening is instant, recovery needs 10 good cycles", () => {
  const machine = new StatusMachine({ warmupCycles: 1, hysteresisCycles: 10 });

  machine.cycle({ ...good, samples: 1 });
  assert.equal(machine.status, STATUS.GREEN);

  // Instant worsening.
  machine.cycle({ ...good, rttP95: 120, samples: 1 });
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

test("StatusMachine: any bad cycle resets the recovery counter", () => {
  const machine = new StatusMachine({ warmupCycles: 1, hysteresisCycles: 10 });

  machine.cycle({ ...good, consecutiveTimeouts: 3, samples: 1 });
  assert.equal(machine.status, STATUS.RED);

  for (let i = 0; i < 5; i += 1) {
    machine.cycle({ ...good, samples: 1 });
  }
  assert.equal(machine.goodCycles, 5);

  machine.cycle({ ...good, jitterP95: 40, samples: 1 });
  assert.equal(machine.status, STATUS.YELLOW);
  assert.equal(machine.goodCycles, 0);

  for (let i = 0; i < 9; i += 1) {
    machine.cycle({ ...good, samples: 1 });
  }
  assert.equal(machine.status, STATUS.YELLOW, "counter restarted from 0");

  machine.cycle({ ...good, samples: 1 });
  assert.equal(machine.status, STATUS.GREEN);
});

test("StatusMachine: a timing-out client is not Green and earns no recovery credit", () => {
  const machine = new StatusMachine({ warmupCycles: 1, hysteresisCycles: 10 });

  machine.cycle({ ...good, consecutiveTimeouts: 3, samples: 1 });
  assert.equal(machine.status, STATUS.RED);

  for (let i = 0; i < 4; i += 1) {
    machine.cycle({ ...good, samples: 1 });
  }
  assert.equal(machine.goodCycles, 4);

  // One timeout cycle: instant status is Yellow, so it neither shows Green
  // nor counts towards the 10 good cycles.
  machine.cycle({ ...good, consecutiveTimeouts: 1, samples: 1 });
  assert.equal(machine.status, STATUS.YELLOW);
  assert.equal(machine.goodCycles, 0, "timeout cycle must not count as good");
});

test("StatusMachine: reset returns to gray", () => {
  const machine = new StatusMachine({ warmupCycles: 1 });

  machine.cycle({ ...good, consecutiveTimeouts: 3, samples: 1 });
  assert.equal(machine.status, STATUS.RED);

  machine.reset();
  assert.equal(machine.status, STATUS.GRAY);
  assert.equal(machine.cycles, 0);
});

// ------------------------------------------------------------
// DiagnosticsSession
// ------------------------------------------------------------

test("DiagnosticsSession: per-client statuses, gray excluded from Overall", () => {
  const session = new DiagnosticsSession();

  session.addClient(1);
  session.addClient(2);
  session.start();

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

  session.recordAck(1, 2);
  session.recordAck(2, 2);
  session.recordAck(3, 2);
  session.cycleAll();
  session.cycleAll();
  assert.equal(session.snapshot().overall, STATUS.GREEN);

  // Client 2 degrades to Yellow (jitter from swinging RTTs).
  session.recordAck(2, 2);
  session.recordAck(2, 40);
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
