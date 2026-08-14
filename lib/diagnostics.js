// Network diagnostics: pure, unit-testable metrics and status logic.
//
// Layers:
//   percentile / decideStatus  — tiny pure functions
//   MetricsCollector           — per-client sliding window of RTT samples,
//                                timeouts, jitter (p95 of |ΔRTT|), loss rate
//                                and the per-burst-window timeout rate
//   StatusMachine              — per-client status with the spec's priority
//                                order, Gray warm-up and hysteresis
//   DiagnosticsSession         — one collector + machine + event log per
//                                client, the burst/calm phase flag and
//                                Overall = worst online status
//
// The server owns all timers and sockets; this module is deterministic and
// depends on nothing but Node built-ins.

const PROBE_INTERVAL_MS = 1000;
const BASELINE_TIMEOUT_MS = 500;

// Burst cycle (spec): 2 s at 30 msg/s with a 200 ms timeout, then 2 s of
// baseline (1 Hz / 500 ms) — repeating while a test runs.
const BURST_INTERVAL_MS = 1000 / 30; // ~33.3 ms → 30 probes/s
const BURST_TIMEOUT_MS = 200;
const BURST_PHASE_MS = 2000;
const CALM_PHASE_MS = 2000;

// Per-client event log cap (Connected / Disconnected / Reconnected).
const MAX_EVENTS = 20;

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
// the consecutive-timeout streak that drives the Red rule. Also the
// lifetime probe counters (acks/timeouts → loss rate) and the per-burst-
// window timeout rate (frozen when a burst window completes).
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
    this.acks = 0;
    this.burstWindowTotal = 0;
    this.burstWindowTimeouts = 0;
    this.burstTimeoutRate = 0;
  }

  record(rttMs, processingMs = null) {
    this.samples.push(rttMs);

    if (this.samples.length > this.windowSize) {
      this.samples.shift();
    }

    this.consecutiveTimeouts = 0;
    this.lastRtt = rttMs;
    this.acks += 1;
    this.burstWindowTotal += 1;

    if (typeof processingMs === "number") {
      this.lastProcessingMs = processingMs;
    }
  }

  recordTimeout() {
    this.timeouts += 1;
    this.consecutiveTimeouts += 1;
    this.burstWindowTotal += 1;
    this.burstWindowTimeouts += 1;
  }

  // A new burst window starts counting probes from scratch.
  beginBurstWindow() {
    this.burstWindowTotal = 0;
    this.burstWindowTimeouts = 0;
  }

  // Freezes the completed window's timeout rate (0 for an empty window);
  // the rate stays visible until the next window completes.
  endBurstWindow() {
    this.burstTimeoutRate =
      this.burstWindowTotal === 0
        ? 0
        : this.burstWindowTimeouts / this.burstWindowTotal;
    this.burstWindowTotal = 0;
    this.burstWindowTimeouts = 0;
  }

  // Lifetime loss rate: timeouts / (acks + timeouts). Detail-panel only —
  // never feeds the status decision.
  get lossRate() {
    const total = this.acks + this.timeouts;

    return total === 0 ? 0 : this.timeouts / total;
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

    // Disconnected is the spec's priority-1 rule and bypasses the warm-up
    // gray guard: a client that drops out of the test is Red immediately.
    if (input.disconnected) {
      this.goodCycles = 0;
      this.status = STATUS.RED;
      this.reason = REASON.disconnected;
      return this.status;
    }

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

// One collector + machine + event log per client that has joined, plus the
// Overall status (worst status among online clients that finished warming
// up; Gray when there are none). Disconnected clients stay in the session
// as Red cards — the server removes them only on a rejected join.
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
    this.phase = shared.diagPhases.calm; // set by the server's phase timer
    this.overall = STATUS.GRAY;
    this.clients = new Map(); // id -> { collector, machine, connected, events }
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

  setPhase(phase) {
    this.phase = phase;
  }

  // Join (or rejoin — the server restores the id from the claim token).
  // A brand-new id gets a "connected" event; an id that already exists is a
  // reconnect: the metrics and machine start over (Gray warm-up) and a
  // "reconnected" event is appended. The event log itself is never cleared.
  addClient(id, now = 0) {
    const existing = this.clients.get(id);

    if (existing) {
      existing.connected = true;
      existing.collector.reset();
      existing.machine.reset();
      this.pushEvent(existing, shared.diagEvents.reconnected, now);
      return;
    }

    const entry = {
      collector: new MetricsCollector({ windowSize: this.windowSize }),
      machine: new StatusMachine({
        warmupCycles: this.warmupCycles,
        hysteresisCycles: this.hysteresisCycles,
      }),
      connected: true,
      events: [],
    };

    this.clients.set(id, entry);
    this.pushEvent(entry, shared.diagEvents.connected, now);
  }

  // The client's socket dropped: the card stays, flips Red immediately and
  // the disconnect is recorded. No-op when already disconnected.
  disconnectClient(id, now = 0) {
    const entry = this.clients.get(id);

    if (!entry || !entry.connected) {
      return;
    }

    entry.connected = false;
    this.pushEvent(entry, shared.diagEvents.disconnected, now);
    entry.machine.cycle({ disconnected: true });
    this.overall = this.computeOverall();
  }

  removeClient(id) {
    this.clients.delete(id);
  }

  pushEvent(entry, type, now) {
    entry.events.push({ type, at: now });

    if (entry.events.length > MAX_EVENTS) {
      entry.events.shift();
    }
  }

  // A new burst window starts counting probes for every client.
  beginBurstWindow() {
    for (const entry of this.clients.values()) {
      entry.collector.beginBurstWindow();
    }
  }

  // Freezes each client's burst-window timeout rate (server calls this when
  // the burst phase ends).
  endBurstWindow() {
    for (const entry of this.clients.values()) {
      entry.collector.endBurstWindow();
    }
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
        disconnected: !entry.connected,
        consecutiveTimeouts: metrics.consecutiveTimeouts,
        burstTimeoutRate: metrics.burstTimeoutRate,
        jitterP95: metrics.jitterP95,
        rttP95: metrics.rttP95,
        samples: metrics.samples.length,
      });
    }

    this.overall = this.computeOverall();
  }

  // Overall = worst status among online, non-Gray clients (spec: "all
  // online clients"; disconnected clients are offline and excluded — their
  // Red cards remain visible, but a dead device does not drive the banner).
  computeOverall() {
    let worst = 0;

    for (const entry of this.clients.values()) {
      if (!entry.connected) {
        continue;
      }

      const rank = STATUS_RANK[entry.machine.status] || 0;

      if (rank > worst) {
        worst = rank;
      }
    }

    return STATUS_BY_RANK[worst];
  }

  snapshot(now = 0) {
    const clients = {};

    for (const [id, entry] of this.clients) {
      const metrics = entry.collector;
      const last = entry.events[entry.events.length - 1] || null;

      clients[id] = {
        status: entry.machine.status,
        reason: entry.machine.reason,
        connected: entry.connected,
        lastEvent: last
          ? {
              type: last.type,
              at: last.at,
              agoMs: now ? Math.max(0, now - last.at) : 0,
            }
          : null,
        events: entry.events.map((event) => ({
          type: event.type,
          at: event.at,
          agoMs: now ? Math.max(0, now - event.at) : 0,
        })),
        metrics: {
          rttP50: metrics.rttP50,
          rttP95: metrics.rttP95,
          jitterP95: metrics.jitterP95,
          lastRtt: metrics.lastRtt,
          lastProcessingMs: metrics.lastProcessingMs,
          timeouts: metrics.timeouts,
          consecutiveTimeouts: metrics.consecutiveTimeouts,
          samples: metrics.samples.length,
          acks: metrics.acks,
          lossRate: metrics.lossRate,
          burstTimeoutRate: metrics.burstTimeoutRate,
        },
      };
    }

    return {
      running: this.running,
      overall: this.overall,
      phase: this.phase,
      clients,
    };
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
  BURST_INTERVAL_MS,
  BURST_TIMEOUT_MS,
  BURST_PHASE_MS,
  CALM_PHASE_MS,
};
