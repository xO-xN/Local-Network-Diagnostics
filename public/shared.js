// Shared constants for both browser pages and the score server.
//
// Works as a plain browser global (window.PNDS) and as a Node module.
//
// Single source of truth:
//   Ports   → manifest.json (browser gets them via __config.js injected by the server)
//   Events  → here (events)
//   Token   → here (tokenKey)
//   Copy/vocabulary → here (copy, diagPhases, diagEvents)

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory({ readPorts: readManifestPorts });
  } else {
    root.PNDS = factory({
      readPorts: function () {
        var cfg = root.__PNDS_PORTS__;
        if (!cfg)
          throw new Error(
            "__PNDS_PORTS__ not set — ensure __config.js loads before shared.js",
          );
        return cfg;
      },
    });
  }
})(typeof self !== "undefined" ? self : this, function (deps) {
  var ports = deps.readPorts();

  return {
    // Read from manifest.json (or __config.js in the browser).
    // Change ports ONLY in manifest.json.
    performerPort: ports.performerPort,
    monitorPort: ports.monitorPort,

    // Client roster cap (id space, PlayerRegistry).
    maxClients: 16,

    // UI copy, per locale (bilingual since v0.3.0). Keys are
    // language-neutral; the monitor page renders through the table of
    // the current locale (public/locale.js follows the App language,
    // default "en"), while the server's state carries only the reason
    // keys (lib/diagnostics.js). "en" doubles as the fallback table and
    // is the page's historical copy — a session with no locale traffic
    // renders exactly as before. The Red status copy must stay explicit
    // (spec). test/locale.test.js asserts both tables share one shape.
    copy: {
      en: {
        status: {
          gray: "Warming up…",
          green: "Suitable for performance",
          yellow: "Caution — borderline network",
          red: "Not suitable for performance",
        },
        reasons: {
          warmup: "Warming up…",
          disconnected: "Disconnected",
          consecutiveTimeouts: "3 consecutive probe timeouts",
          burstTimeoutRate: "Burst timeout rate above 5%",
          jitter: "High timing variation",
          rtt: "Slow responses",
          timeout: "Recent probe timeouts",
          green: "Suitable for performance",
          outsideSafe: "Outside safe thresholds",
        },
        events: {
          connected: "Connected",
          disconnected: "Disconnected",
          reconnected: "Reconnected",
        },
        monitor: {
          sub: "Monitor — network test console",
          overall: "Overall",
          overallPrefix: "Overall: ",
          notRunning: "Test not running",
          noPerformers: "No performers connected",
          client: "Client ",
          statusWord: {
            gray: "Warming up",
            green: "Ready",
            yellow: "Caution",
            red: "Risk",
          },
          typical: "Typical Response",
          worst: "Worst-case Response",
          stability: "Stability (Timing Variation)",
          loss: "Loss Rate",
          processing: "Processing Time",
          log: "Event Log",
          noEvents: "No events yet",
          empty:
            "Open Join devices below and scan the code on a phone or tablet. The network test starts automatically.",
          hint: "Click a card for details",
          scan: "Scan to join as performer",
          qrAlt: "QR code for the performer page",
          close: "Close details",
          verdict: "Network verdict",
          connected: "Connected devices",
          ready: "Ready",
          attention: "Needs attention",
          warming: "Warming up",
          devices: "Devices",
          metrics: "RTT / jitter",
          emptyTitle: "Connect your first device",
          join: "Join devices",
          details: "Details",
          offline: "Offline",
          typicalShort: "Typical RTT",
          worstShort: "Worst RTT",
          jitterShort: "Jitter",
        },
        performer: {
          role: "Device connection",
          connecting: "Connecting…",
          connected: "Connected",
          testing: "Connected, testing…",
          waiting: "Waiting for a network measurement",
          rejected: "Connection rejected: ",
          helper: "Keep this page open while the host tests your connection.",
        },
        ago: { just: "just now", seconds: "s ago", minutes: "m ago" },
      },
      "zh-CN": {
        status: {
          gray: "预热中…",
          green: "适合现场演出",
          yellow: "注意 — 网络处于临界状态",
          red: "不适合现场演出",
        },
        reasons: {
          warmup: "预热中…",
          disconnected: "已断开",
          consecutiveTimeouts: "连续 3 次探针超时",
          burstTimeoutRate: "突发期超时率超过 5%",
          jitter: "时间抖动过大",
          rtt: "响应过慢",
          timeout: "近期探针超时",
          green: "适合现场演出",
          outsideSafe: "超出安全阈值",
        },
        events: {
          connected: "已连接",
          disconnected: "已断开",
          reconnected: "已重连",
        },
        monitor: {
          sub: "监视端 — 网络测试控制台",
          overall: "总体",
          overallPrefix: "总体：",
          notRunning: "测试未运行",
          noPerformers: "无演奏者连接",
          client: "客户端 ",
          statusWord: {
            gray: "预热",
            green: "就绪",
            yellow: "注意",
            red: "风险",
          },
          typical: "典型响应",
          worst: "最差响应",
          stability: "稳定性（时间抖动）",
          loss: "丢包率",
          processing: "处理耗时",
          log: "事件日志",
          noEvents: "暂无事件",
          empty:
            "展开下方「设备加入」，用手机或平板扫码。连接后自动开始网络测试。",
          hint: "点击卡片查看详情",
          scan: "扫码加入为演奏者",
          qrAlt: "演奏者页面二维码",
          close: "关闭详情",
          verdict: "网络评估",
          connected: "已连接设备",
          ready: "就绪",
          attention: "需要关注",
          warming: "预热中",
          devices: "设备",
          metrics: "响应 / 抖动",
          emptyTitle: "连接第一台设备",
          join: "设备加入",
          details: "详情",
          offline: "离线",
          typicalShort: "典型响应",
          worstShort: "最差响应",
          jitterShort: "时间抖动",
        },
        performer: {
          role: "设备连接",
          connecting: "连接中…",
          connected: "已连接",
          testing: "已连接，测试中…",
          waiting: "等待网络测量结果",
          rejected: "连接被拒绝：",
          helper: "测试期间请保持此页面打开。",
        },
        ago: { just: "刚刚", seconds: " 秒前", minutes: " 分钟前" },
      },
    },

    // Diagnostics protocol vocabulary, shared by lib/diagnostics.js
    // (producer) and the monitor page (consumer): the burst/calm phase and
    // the per-client event-log types. Single source of truth.
    diagPhases: { burst: "burst", calm: "calm" },
    diagEvents: {
      connected: "connected",
      disconnected: "disconnected",
      reconnected: "reconnected",
    },

    // Claim token persisted by the performer page so a reconnect recovers
    // the same client id (localStorage key).
    tokenKey: "local-network-diagnostics-token",

    events: {
      join: "join",
      joined: "joined",
      rejected: "rejected",
      state: "state",
      // Network diagnostics (see lib/diagnostics.js):
      //   probe: server → client, one per second while a test runs
      //   ack:   client → server, immediate reply with performance.now()
      //          receive/reply timestamps (RTT is measured server-side)
      //   start/stop: monitor page → server
      diagProbe: "pnds:diag:probe",
      diagAck: "pnds:diag:ack",
      diagStart: "pnds:diag:start",
      diagStop: "pnds:diag:stop",
    },
  };
});

// Node: read ports from manifest.json (the single source of truth).
function readManifestPorts() {
  var fs = require("node:fs");
  var path = require("node:path");
  // shared.js lives in public/; the manifest is one directory up.
  var manifestPath = path.join(__dirname, "..", "manifest.json");
  var manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return {
    performerPort: manifest.scoreServer.performerPort,
    monitorPort: manifest.scoreServer.monitorPort,
  };
}
