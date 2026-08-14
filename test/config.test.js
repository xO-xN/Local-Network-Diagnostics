const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const {
  loadManifest,
  resolveAudioMode,
  resolveOscTarget,
  resolveServerConfig,
} = require("../lib/config");

const PROJECT_ROOT = path.join(__dirname, "..");

test("loadManifest reads the project manifest", () => {
  const manifest = loadManifest(PROJECT_ROOT);

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.audio.outputChannels, 16);
  assert.notEqual(
    manifest.scoreServer.performerPort,
    manifest.scoreServer.monitorPort,
  );
});

test("resolveAudioMode falls back to the manifest default", () => {
  const manifest = loadManifest(PROJECT_ROOT);

  assert.equal(resolveAudioMode(undefined, manifest), "internal");
  assert.equal(resolveAudioMode("none", manifest), "none");
  assert.throws(() => resolveAudioMode("bogus", manifest));
});

test("resolveOscTarget priority: env > cli > manifest", () => {
  const manifest = loadManifest(PROJECT_ROOT);

  assert.equal(
    resolveOscTarget(undefined, manifest, {
      PNDS_OSC_TARGET: "10.0.0.5:9999",
    }),
    "10.0.0.5:9999",
  );
  assert.equal(
    resolveOscTarget("127.0.0.1:57120", manifest, {}),
    "127.0.0.1:57120",
  );
  assert.equal(
    resolveOscTarget(undefined, manifest, {}),
    "127.0.0.1:57110",
  );
});

test("resolveServerConfig returns valid distinct ports", () => {
  const config = resolveServerConfig(loadManifest(PROJECT_ROOT));

  assert.equal(config.performerPort, 6868);
  assert.equal(config.monitorPort, 6869);
});
