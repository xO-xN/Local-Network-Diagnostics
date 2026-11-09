// Manifest, CLI and port resolution.
//
// Reusable PNDS core: every score server needs to load manifest.json, parse
// a few CLI flags and resolve the server ports.
//
// This project runs without audio (mode is always "none"), so the audio-mode
// / OSC machinery of the template has been removed. `--audio-mode` is still
// accepted for App compatibility (the App launches the entry with the
// manifest's defaultMode) but its value is ignored.

const fs = require("node:fs");
const path = require("node:path");

function loadManifest(projectRoot) {
  const manifestPath = path.join(projectRoot, "manifest.json");
  const raw = fs.readFileSync(manifestPath, "utf8");
  return JSON.parse(raw);
}

function parseCliOptions(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--audio-mode") {
      // Accepted for App compatibility; this project always runs with
      // audio disabled ("none").
      options.audioMode = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--audio-mode=")) {
      options.audioMode = argument.slice("--audio-mode=".length);
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    }
  }

  return options;
}

function printUsage() {
  console.log(
    [
      "Usage: node server.js [options]",
      "",
      "Options:",
      "  --audio-mode <mode>  Accepted for App compatibility (ignored: this",
      "                      project always runs with audio disabled)",
      "  -h, --help           Show this help",
      "",
      "Environment:",
      "  PNDS_HOST_IP         LAN IP advertised to performers",
    ].join("\n"),
  );
}

function parseHttpPort(value, label) {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535.`);
  }

  return port;
}

function resolveServerConfig(manifest, environment = process.env) {
  const scoreServer = manifest.scoreServer;

  if (!scoreServer) {
    throw new Error("manifest.json must declare a scoreServer object.");
  }

  const runtimeAssignment = environment.PNDS_RUNTIME_PORTS === undefined
    ? null : JSON.parse(environment.PNDS_RUNTIME_PORTS);
  if (environment.PNDS_RUNTIME_PORTS !== undefined && (
    !runtimeAssignment || typeof runtimeAssignment !== "object" ||
    runtimeAssignment.version !== 1 ||
    typeof runtimeAssignment.runId !== "string" || !runtimeAssignment.runId ||
    typeof runtimeAssignment.reportPath !== "string" || !path.isAbsolute(runtimeAssignment.reportPath) ||
    !Array.isArray(runtimeAssignment.services) || runtimeAssignment.services.length !== 2 ||
    !["performer", "monitor"].every(role => runtimeAssignment.services.filter(service =>
      service?.role === role && Number.isInteger(service.fd) && service.fd >= 3
    ).length === 1) ||
    runtimeAssignment.services[0].fd === runtimeAssignment.services[1].fd
  )) throw new Error("Unsupported PNDS runtime listener assignment.");
  const assignedPort = role => runtimeAssignment?.services.find(service => service.role === role)?.port;
  const performerPort = parseHttpPort(
    assignedPort("performer") ?? scoreServer.performerPort,
    "scoreServer.performerPort",
  );
  const monitorPort = parseHttpPort(
    assignedPort("monitor") ?? scoreServer.monitorPort,
    "scoreServer.monitorPort",
  );

  if (performerPort === monitorPort) {
    throw new Error(
      "scoreServer.performerPort and monitorPort must be different.",
    );
  }

  return {
    entry: scoreServer.entry,
    workingDirectory: scoreServer.workingDirectory || ".",
    performerPort,
    monitorPort,
    ...(runtimeAssignment ? { runtimeAssignment } : {}),
  };
}

module.exports = {
  loadManifest,
  parseCliOptions,
  printUsage,
  resolveServerConfig,
};
