const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const {
  loadManifest,
  parseCliOptions,
  resolveServerConfig,
} = require("../lib/config");

const PROJECT_ROOT = path.join(__dirname, "..");

test("loadManifest reads the project manifest", () => {
  const manifest = loadManifest(PROJECT_ROOT);

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.scoreServer.performerPort, 6868);
  assert.equal(manifest.scoreServer.monitorPort, 6869);
  assert.notEqual(
    manifest.scoreServer.performerPort,
    manifest.scoreServer.monitorPort,
  );

  // No-audio project: the only supported mode is "none".
  assert.deepEqual(manifest.audio.supportedModes, ["none"]);
  assert.equal(manifest.audio.defaultMode, "none");
});

test("parseCliOptions accepts --audio-mode for App compatibility and --help", () => {
  assert.equal(parseCliOptions(["--audio-mode", "none"]).audioMode, "none");
  assert.equal(parseCliOptions(["--audio-mode=internal"]).audioMode, "internal");
  assert.equal(parseCliOptions(["--help"]).help, true);
  assert.deepEqual(parseCliOptions([]), {});
});

test("resolveServerConfig returns valid distinct ports", () => {
  const config = resolveServerConfig(loadManifest(PROJECT_ROOT));

  assert.equal(config.performerPort, 6868);
  assert.equal(config.monitorPort, 6869);
  assert.equal(config.entry, "server.js");
});

test("resolveServerConfig rejects equal ports", () => {
  const manifest = loadManifest(PROJECT_ROOT);
  manifest.scoreServer = {
    performerPort: 6868,
    monitorPort: 6868,
  };

  assert.throws(() => resolveServerConfig(manifest), /must be different/);
});
