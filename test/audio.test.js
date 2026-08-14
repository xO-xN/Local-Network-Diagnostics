const assert = require("node:assert/strict");
const test = require("node:test");

const {
  resolveOutputBus,
  resolveOutputChannels,
} = require("../lib/audio-engine");
const {
  mapFreq,
  mapAmp,
  defaultOutChannel,
  validateOutChannel,
} = require("../audio/controller");

test("resolveOutputBus honours the PNDS contract", () => {
  assert.equal(resolveOutputBus({}), 0);
  assert.equal(resolveOutputBus({ PNDS_AUDIO_OUTPUT_BUS: "" }), 0);
  assert.equal(resolveOutputBus({ PNDS_AUDIO_OUTPUT_BUS: "2" }), 2);

  assert.throws(() => resolveOutputBus({ PNDS_AUDIO_OUTPUT_BUS: "-1" }));
  assert.throws(() => resolveOutputBus({ PNDS_AUDIO_OUTPUT_BUS: "left" }));
});

test("resolveOutputChannels falls back to manifest, then to 2", () => {
  assert.equal(
    resolveOutputChannels({}, { audio: { outputChannels: 16 } }),
    16,
  );
  assert.equal(resolveOutputChannels({}, {}), 2);
  assert.equal(
    resolveOutputChannels({ PNDS_AUDIO_OUTPUT_CHANNELS: "8" }, {}),
    8,
  );

  assert.throws(() =>
    resolveOutputChannels({ PNDS_AUDIO_OUTPUT_CHANNELS: "0" }, {}),
  );
  assert.throws(() =>
    resolveOutputChannels({ PNDS_AUDIO_OUTPUT_CHANNELS: "65" }, {}),
  );
});

const { freqRange } = require("../public/shared");

function midFreq(value01) {
  return Math.round(
    freqRange.min + value01 * (freqRange.max - freqRange.min),
  );
}

test("mapFreq maps the fader 0..1 to the freqRange from shared.js", () => {
  assert.equal(mapFreq(0), freqRange.min);
  assert.equal(mapFreq(1), freqRange.max);
  assert.equal(mapFreq(0.5), midFreq(0.5));
  assert.equal(mapFreq(-1), freqRange.min);   // clamped
  assert.equal(mapFreq(2), freqRange.max);    // clamped
});

test("mapAmp applies an audio-taper (squared) curve", () => {
  assert.equal(mapAmp(0), 0);
  assert.equal(mapAmp(1), 1);
  assert.equal(mapAmp(0.5), 0.25);
  assert.ok(Math.abs(mapAmp(0.1) - 0.01) < 1e-12); // 0.1^2 is not exact in binary
  assert.equal(mapAmp(-1), 0);
  assert.equal(mapAmp(2), 1);
});

test("defaultOutChannel: odd ids to channel 1, even ids to channel 2", () => {
  assert.equal(defaultOutChannel(1), 1);
  assert.equal(defaultOutChannel(2), 2);
  assert.equal(defaultOutChannel(3), 1);
  assert.equal(defaultOutChannel(16), 2);
});

test("validateOutChannel rejects out-of-range channels", () => {
  assert.equal(validateOutChannel(1, 16), 1);
  assert.equal(validateOutChannel(16, 16), 16);

  assert.throws(() => validateOutChannel(0, 16));
  assert.throws(() => validateOutChannel(17, 16));
  assert.throws(() => validateOutChannel("x", 16));
});
