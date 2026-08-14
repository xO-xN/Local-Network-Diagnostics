// Shared constants for both browser pages and the score server.
//
// Works as a plain browser global (window.PNDS) and as a Node module.
//
// Single source of truth:
//   Ports   → manifest.json (browser gets them via __config.js injected by the server)
//   Events  → here (events)
//   Token   → here (tokenKey)
//   Copy/vocabulary → here (statusCopy, diagPhases, diagEvents)

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory({ readPorts: readManifestPorts });
  } else {
    root.PNDS = factory({
      readPorts: function () {
        var cfg = root.__PNDS_PORTS__;
        if (!cfg) throw new Error("__PNDS_PORTS__ not set — ensure __config.js loads before shared.js");
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

    // Diagnostics status copy, shared by the server (reasons in
    // lib/diagnostics.js) and the monitor page (cards + Overall banner).
    // Single source of truth — the Red copy must stay explicit (spec).
    statusCopy: {
      gray: "Warming up…",
      green: "Suitable for performance",
      yellow: "Caution — borderline network",
      red: "Not suitable for performance",
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
