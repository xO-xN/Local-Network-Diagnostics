// PNDS Template — sine voice SynthDef source (创作期源码).
//
// Run this file in the SuperCollider IDE to register the SynthDef locally
// (needed when debugging the external bridge with sclang). To compile the
// runtime artifact, run build-synthdef.scd (or `npm run build:synthdef`).
//
// Voice contract:
// - out:     first output bus of the voice (set by the score server)
// - amp:     fader value 0..1 (audio-taper curve applied by the server),
//            capped at -6 dB per voice (amp * 0.5)
// - freq:    frequency in Hz (from the freqRange in public/shared.js)
// - lagAmp / lagFreq: smoothing times in seconds (scsynth Lag.kr), so
//            fader movements glide instead of stepping.

SynthDef(\templateSine, {
    | out = 0, amp = 0, freq = 100, lagAmp = 0.05, lagFreq = 0.1 |
    var smoothAmp = Lag.kr(amp, lagAmp);
    var smoothFreq = Lag.kr(freq, lagFreq);
    var sig = SinOsc.ar(smoothFreq, 0, smoothAmp * 0.5); // -6 dB ceiling per voice
    Out.ar(out, sig);
}).add;
