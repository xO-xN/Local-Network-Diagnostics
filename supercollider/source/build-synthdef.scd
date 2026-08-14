// Compiles the SynthDef into supercollider/synthdefs/ as the runtime
// artifact referenced by manifest.json.
//
// Usage (from the project root):
//   sclang supercollider/source/build-synthdef.scd
// or:
//   npm run build:synthdef
//
// The compiled artifact is what PNDS App loads in Internal mode. The .scd
// sources are creation-time files only.
//
// NOTE: keep the SynthDef definition below in sync with template-sine.scd
// (the IDE-editable source). This script defines + writes in one step so it
// never depends on the sclang global library state.

(
var synthdefsDir = thisProcess.nowExecutingPath.dirname.dirname +/+ "synthdefs";
var defFile = synthdefsDir +/+ "templateSine.scsyndef";
var targetFile = synthdefsDir +/+ "template-sine.scsyndef";

File.mkdir(synthdefsDir);

SynthDef(\templateSine, {
    | out = 0, amp = 0, freq = 100, lagAmp = 0.05, lagFreq = 0.1 |
    var smoothAmp = Lag.kr(amp, lagAmp);
    var smoothFreq = Lag.kr(freq, lagFreq);
    var sig = SinOsc.ar(smoothFreq, 0, smoothAmp * 0.5); // -6 dB ceiling per voice
    Out.ar(out, sig);
}).writeDefFile(synthdefsDir);

// writeDefFile names the artifact after the SynthDef (templateSine);
// rename it to the manifest path (template-sine).
// (File.copy fails if the target already exists, so delete it first.)
if (defFile != targetFile && File.exists(defFile)) {
    File.delete(targetFile);
    File.copy(defFile, targetFile);
    File.delete(defFile);
};

"Wrote % to %".format(targetFile.basename, synthdefsDir).postln;
0.exit;
)
