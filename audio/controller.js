// PNDS Template work layer: per-client sine voice control.
//
// This is the file creators edit to change the *semantics* of the work
// (what the faders do, how voices are routed). The transport and engine
// primitives live in lib/.
//
// Conventions:
// - Every joined client gets one voice (one sine synth in Internal mode).
// - Odd ids default to output channel 1, even ids to channel 2.
// - The monitor page can reassign any client to another output channel.
// - Each voice is capped at -6 dB in the SynthDef (amp * 0.5).

const {
  AudioEngine,
} = require("../lib/audio-engine");
const { oscFloat } = require("../lib/osc-transport");
const { freqRange } = require("../public/shared");

const SYNTH_NAME = "templateSine";
const GROUP_ID = 1000;
const NODE_BASE = 1000;
// Single source of truth: the same freqRange the performer page displays
// (public/shared.js). Change the range there, not here.
const FREQ_MIN = freqRange.min;
const FREQ_MAX = freqRange.max;

function clamp01(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.max(0, Math.min(1, number));
}

// Fader value (0..1) to frequency in Hz (range from shared.js freqRange).
function mapFreq(value01) {
  return Math.round(
    FREQ_MIN + clamp01(value01) * (FREQ_MAX - FREQ_MIN),
  );
}

// Fader response curve for amp (audio taper): the lower half of the fader
// gets finer control, matching how mixing-desk faders behave.
function mapAmp(value01) {
  const value = clamp01(value01);

  return value * value;
}

// Default output channel: odd ids -> channel 1, even ids -> channel 2.
function defaultOutChannel(id) {
  return id % 2 === 1 ? 1 : 2;
}

function validateOutChannel(channel, outputChannels) {
  const value = Number(channel);

  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > outputChannels
  ) {
    throw new Error(
      `Invalid output channel '${channel}': expected an integer from 1 to ${outputChannels}.`,
    );
  }

  return value;
}

class ProjectAudio {
  constructor(engine) {
    if (!(engine instanceof AudioEngine)) {
      throw new Error("ProjectAudio requires an AudioEngine instance.");
    }

    this.engine = engine;
    this.voices = new Map(); // id -> { nodeId, amp, freq, out }
  }

  get mode() {
    return this.engine.mode;
  }

  async start() {
    await this.engine.start();

    if (this.engine.mode === "internal") {
      // Project-owned group created before health reports ready.
      await this.engine.createGroup(GROUP_ID);
    }
  }

  async addVoice(id) {
    const voice = {
      nodeId: NODE_BASE + id,
      amp: 0,
      freq: FREQ_MIN,
      out: defaultOutChannel(id),
    };

    if (this.engine.mode === "internal") {
      await this.engine.createSynth({
        name: SYNTH_NAME,
        nodeId: voice.nodeId,
        groupId: GROUP_ID,
        out: this.busFor(voice.out),
        controls: {
          amp: voice.amp,
          freq: voice.freq,
        },
      });
    } else if (this.engine.mode === "external") {
      await this.sendVoiceState(id, voice);
    }

    this.voices.set(id, voice);

    return voice;
  }

  async setControls(id, { amp, freq }) {
    const voice = this.voices.get(id);

    if (!voice) {
      throw new Error(`No voice for client ${id}.`);
    }

    voice.amp = mapAmp(amp);
    voice.freq = mapFreq(freq);

    if (this.engine.mode === "internal") {
      await this.engine.setControls(voice.nodeId, {
        amp: voice.amp,
        freq: voice.freq,
      });
    } else if (this.engine.mode === "external") {
      await this.sendVoiceState(id, voice);
    }
  }

  async setOutChannel(id, channel) {
    const voice = this.voices.get(id);

    if (!voice) {
      throw new Error(`No voice for client ${id}.`);
    }

    voice.out = validateOutChannel(channel, this.engine.outputChannels);

    if (this.engine.mode === "internal") {
      await this.engine.setControls(voice.nodeId, {
        out: this.busFor(voice.out),
      });
    } else if (this.engine.mode === "external") {
      await this.engine.send(
        `/c${id}/out`,
        [oscFloat(voice.out)],
      );
    }
  }

  async removeVoice(id) {
    const voice = this.voices.get(id);

    if (!voice) {
      return;
    }

    if (this.engine.mode === "internal") {
      await this.engine.freeNode(voice.nodeId);
    }

    this.voices.delete(id);
  }

  async stop() {
    await this.engine.stop();
  }

  // Physical scsynth bus for a 1-based work channel.
  busFor(channel) {
    return this.engine.outputBus + channel - 1;
  }

  snapshot() {
    return [...this.voices.entries()].map(([id, voice]) => ({
      id,
      amp: voice.amp,
      freq: voice.freq,
      out: voice.out,
    }));
  }

  async sendVoiceState(id, voice) {
    await this.engine.send(`/c${id}/amp`, [oscFloat(voice.amp)]);
    await this.engine.send(`/c${id}/freq`, [oscFloat(voice.freq)]);
    await this.engine.send(`/c${id}/out`, [oscFloat(voice.out)]);
  }
}

module.exports = {
  ProjectAudio,
  clamp01,
  mapFreq,
  mapAmp,
  defaultOutChannel,
  validateOutChannel,
  SYNTH_NAME,
  GROUP_ID,
  NODE_BASE,
  FREQ_MIN,
  FREQ_MAX,
};
