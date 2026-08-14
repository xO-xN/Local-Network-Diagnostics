// Network diagnostics: pure, unit-testable metrics and status logic.
//
// Three layers:
//   percentile / decideStatus  — tiny pure functions
//   MetricsCollector           — per-client sliding window of RTT samples,
//                                timeouts and jitter (p95 of |ΔRTT|)
//   StatusMachine              — per-client status with the spec's priority
//                                order, Gray warm-up and hysteresis
//   DiagnosticsSession         — one collector + machine per client, plus
//                                Overall = worst online status
//
// The server owns all timers and sockets; this module is deterministic and
// depends on nothing but Node built-ins.

const PROBE_INTERVAL_MS = 1000;
const BASELINE_TIMEOUT_MS = 500;

// Status copy comes from public/shared.js — the single source of truth the
// monitor page renders from too.
const shared = require("../public/shared");

const STATUS = {
  GRAY: "gray",
  GREEN: "green",
  YELLOW: "yellow",
  RED: "red",
};

const STATUS_RANK = { gray: 0, green: 1, yellow: 2, red: 3 };
const STATUS_BY_RANK = ["gray", "green", "yellow", "red"];

const REASON = {
  warmup: shared.statusCopy.gray,
  disconnected: "Disconnected",
  consecutiveTimeouts: "3 consecutive probe timeouts",
  burstTimeoutRate: "Burst timeout rate above 5%",
  jitter: "High timing variation",
  rtt: "Slow responses",
  timeout: "Recent probe timeouts",
  green: shared.statusCopy.green,
  outsideSafe: "Outside safe thresholds",
};

// Nearest-rank percentile of a sample set. Returns null when empty.
// p95 of 20 samples is the 19th value, p50 the 10th (0-based).
function percentile(values, p) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1),
  );

  return sorted[index];
}

// The spec's status decision, in strict priority order (highest first):
//   1. Disconnected                    → Red
//   2. 3 consecutive probe timeouts    → Red
//   3. Burst timeout rate > 5%         → Red
//   4. Jitter p95 > 25 ms              → Yellow
//   5. RTT p95 > 100 ms                → Yellow
//   6. 1–2 consecutive timeouts        → Yellow
//   7. Green (jitter < 10, RTT < 50)   → Green
// Rule 6 fills a spec gap: ≥3 timeouts is Red, but a client that is
// currently timing out must not be Green (that would also let recovery
// credit accrue while the link is failing). Between the yellow and the
// green thresholds (e.g. RTT 50–100 ms) the client is not safe either, so
// it falls back to Yellow.
function decideStatus({
  disconnected,
  consecutiveTimeouts,
  burstTimeoutRate,
  jitterP95,
  rttP95,
}) {
  if (disconnected) {
    return { status: STATUS.RED, reason: REASON.disconnected };
  }

  if ((consecutiveTimeouts || 0) >= 3) {
    return { status: STATUS.RED, reason: REASON.consecutiveTimeouts };
  }

  if ((burstTimeoutRate || 0) > 0.05) {
    return { status: STATUS.RED, reason: REASON.burstTimeoutRate };
  }

  const jitter = jitterP95 ?? 0;
  const rtt = rttP95 ?? 0;

  if (jitter > 25) {
    return { status: STATUS.YELLOW, reason: REASON.jitter };
  }

  if (rtt > 100) {
    return { status: STATUS.YELLOW, reason: REASON.rtt };
  }

  if ((consecutiveTimeouts || 0) >= 1) {
    return { status: STATUS.YELLOW, reason: REASON.timeout };
  }

  if (jitter < 10 && rtt < 50) {
    return { status: STATUS.GREEN, reason: REASON.green };
  }

  return { status: STATUS.YELLOW, reason: REASON.outsideSafe };
}

// Per-client metrics: a sliding window of RTT samples (RTT p50/p95,
// jitter = p95 of |RTTₙ − RTTₙ₋₁| within the window), timeout totals and
// the consecutive-timeout streak that drives the Red rule.
class MetricsCollector {
  constructor({ windowSize = 10 } = {}) {
    this.windowSize = windowSize;
    this.reset();
  }

  reset() {
    this.samples = [];
    this.timeouts = 0;
    this.consecutiveTimeouts = 0;
    this.lastRtt = null;
    this.lastProcessingMs = null;
  }

  record(rttMs, processingMs = null) {
    this.samples.push(rttMs);

    if (this.samples.length > this.windowSize) {
      this.samples.shift();
    }

    this.consecutiveTimeouts = 0;
    this.lastRtt = rttMs;

    if (typeof processingMs === "number") {
      this.lastProcessingMs = processingMs;
    }
  }

  recordTimeout() {
    this.timeouts += 1;
    this.consecutiveTimeouts += 1;
  }

  get rttP50() {
    return percentile(this.samples, 0.5);
  }

  get rttP95() {
    return percentile(this.samples, 0.95);
  }

  get jitterP95() {
    if (this.samples.length < 2) {
      return 0;
    }

    const diffs = [];

    for (let i = 1; i < this.samples.length; i += 1) {
      diffs.push(Math.abs(this.samples[i] - this.samples[i - 1]));
    }

    return percentile(diffs, 0.95);
  }
}

// Per-client status decision, evaluated once per probe cycle. Newly joined
// clients stay Gray (warming up) for the first `warmupCycles` cycles and
// until the first sample exists; recovery from Red/Yellow to Green needs
// `hysteresisCycles` consecutive good cycles (any bad cycle resets the
// counter); worsening is instant.
class StatusMachine {
  constructor({ warmupCycles = 2, hysteresisCycles = 10 } = {}) {
    this.warmupCycles = warmupCycles;
    this.hysteresisCycles = hysteresisCycles;
    this.reset();
  }

  reset() {
    this.cycles = 0;
    this.goodCycles = 0;
    this.status = STATUS.GRAY;
    this.reason = REASON.warmup;
  }

  // One probe cycle. Input: { disconnected, consecutiveTimeouts,
  // burstTimeoutRate, jitterP95, rttP95, samples }.
  cycle(input) {
    this.cycles += 1;

    const samples = input.samples || 0;
    const consecutive = input.consecutiveTimeouts || 0;

    // Gray while warming up, and while there is no evidence either way
    // (no ack yet, but not enough timeouts to be Red either).
    if (this.cycles < this.warmupCycles || (samples < 1 && consecutive < 3)) {
      this.status = STATUS.GRAY;
      this.reason = REASON.warmup;
      return this.status;
    }

    const instant = decideStatus(input);

    if (instant.status === STATUS.GREEN) {
      if (this.status === STATUS.RED || this.status === STATUS.YELLOW) {
        this.goodCycles += 1;

        if (this.goodCycles >= this.hysteresisCycles) {
          this.goodCycles = 0;
          this.status = STATUS.GREEN;
          this.reason = instant.reason;
        }

        return this.status;
      }

      this.status = STATUS.GREEN;
      this.reason = instant.reason;
      return this.status;
    }

    this.goodCycles = 0;
    this.status = instant.status;
    this.reason = instant.reason;
    return this.status;
  }
}

// One collector + machine per joined client, plus the Overall status
// (worst status among clients that finished warming up; Gray when there
// are none).
class DiagnosticsSession {
  constructor({
    windowSize = 10,
    warmupCycles = 2,
    hysteresisCycles = 10,
  } = {}) {
    this.windowSize = windowSize;
    this.warmupCycles = warmupCycles;
    this.hysteresisCycles = hysteresisCycles;
    this.running = false;
    this.overall = STATUS.GRAY;
    this.clients = new Map(); // id -> { collector, machine }
  }

  start() {
    this.running = true;

    for (const entry of this.clients.values()) {
      entry.collector.reset();
      entry.machine.reset();
    }

    this.overall = STATUS.GRAY;
  }

  stop() {
    this.running = false;
  }

  addClient(id) {
    if (this.clients.has(id)) {
      return;
    }

    this.clients.set(id, {
      collector: new MetricsCollector({ windowSize: this.windowSize }),
      machine: new StatusMachine({
        warmupCycles: this.warmupCycles,
        hysteresisCycles: this.hysteresisCycles,
      }),
    });
  }

  removeClient(id) {
    this.clients.delete(id);
  }

  recordAck(id, rttMs, processingMs = null) {
    const entry = this.clients.get(id);

    if (entry) {
      entry.collector.record(rttMs, processingMs);
    }
  }

  recordTimeout(id) {
    const entry = this.clients.get(id);

    if (entry) {
      entry.collector.recordTimeout();
    }
  }

  // One probe cycle for every tracked client, then Overall.
  cycleAll() {
    for (const entry of this.clients.values()) {
      const metrics = entry.collector;

      entry.machine.cycle({
        // Disconnected clients are removed by the server today; retaining
        // them as Red cards is the disconnect/event-log ticket's work.
        disconnected: false,
        consecutiveTimeouts: metrics.consecutiveTimeouts,
        burstTimeoutRate: 0, // wired by the burst-phase ticket
        jitterP95: metrics.jitterP95,
        rttP95: metrics.rttP95,
        samples: metrics.samples.length,
      });
    }

    this.overall = this.computeOverall();
  }

  computeOverall() {
    let worst = 0;

    for (const entry of this.clients.values()) {
      const rank = STATUS_RANK[entry.machine.status] || 0;

      if (rank > worst) {
        worst = rank;
      }
    }

    return STATUS_BY_RANK[worst];
  }

  snapshot() {
    const clients = {};

    for (const [id, entry] of this.clients) {
      const metrics = entry.collector;

      clients[id] = {
        status: entry.machine.status,
        reason: entry.machine.reason,
        metrics: {
          rttP50: metrics.rttP50,
          rttP95: metrics.rttP95,
          jitterP95: metrics.jitterP95,
          lastRtt: metrics.lastRtt,
          lastProcessingMs: metrics.lastProcessingMs,
          timeouts: metrics.timeouts,
          consecutiveTimeouts: metrics.consecutiveTimeouts,
          samples: metrics.samples.length,
        },
      };
    }

    return { running: this.running, overall: this.overall, clients };
  }
}

module.exports = {
  STATUS,
  percentile,
  decideStatus,
  MetricsCollector,
  StatusMachine,
  DiagnosticsSession,
  PROBE_INTERVAL_MS,
  BASELINE_TIMEOUT_MS,
};
