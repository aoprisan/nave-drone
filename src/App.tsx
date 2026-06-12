import { useState, useRef, useEffect } from "react";

// ─────────────────────────────────────────────────────────────
// NAVE — drone engine v0
// Fixed chain: [Drone + Noise + Granular(sample)] → Filter →
//              Reverb(+freeze) → Rot → Limiter → Out/Record
// All pitch locked to one root. No tempo. LFOs ≤ 0.5 Hz.
// ─────────────────────────────────────────────────────────────

const ROOTS = { B0: 30.87, D1: 36.71, E1: 41.2, G1: 49.0, A1: 55.0 } as const;
const SPACES = { chapel: 4, cistern: 9, infinite: 18 } as const;
const SAMPLES = ["bowed metal", "choir", "wind tape"] as const;

const RANGES = {
  droneLevel: [0, 0.9], droneDark: [0, 1],
  sampleLevel: [0, 0.9], grainSize: [0.05, 2], grainDensity: [1, 30],
  spray: [0, 1], position: [0, 1],
  noiseLevel: [0, 0.7],
  cutoff: [120, 8000], lfoDepth: [0, 1], lfoRate: [0.01, 0.5],
  wet: [0.3, 1], drive: [0, 1], flutter: [0, 1], hiss: [0, 0.6],
} satisfies Record<string, readonly [number, number]>;

type RootName = keyof typeof ROOTS;
type SpaceName = keyof typeof SPACES;
type SampleName = (typeof SAMPLES)[number];
type RangeKey = keyof typeof RANGES;

interface Patch {
  root: RootName;
  sampleType: SampleName;
  space: SpaceName;
  droneLevel: number;
  droneDark: number;
  sampleLevel: number;
  grainSize: number;
  grainDensity: number;
  spray: number;
  position: number;
  noiseLevel: number;
  cutoff: number;
  lfoDepth: number;
  lfoRate: number;
  wet: number;
  freeze: boolean;
  drive: number;
  flutter: number;
  hiss: number;
  seed: number;
}

const DEFAULT_PATCH: Patch = {
  root: "D1", sampleType: "bowed metal", space: "cistern",
  droneLevel: 0.55, droneDark: 0.7,
  sampleLevel: 0.45, grainSize: 0.6, grainDensity: 8, spray: 0.3, position: 0.3,
  noiseLevel: 0.18,
  cutoff: 900, lfoDepth: 0.35, lfoRate: 0.06,
  wet: 0.75, freeze: false,
  drive: 0.3, flutter: 0.35, hiss: 0.15,
  seed: 271,
};

// The live Web Audio graph. Built once in start(); thereafter only its params
// are ramped (see applyPatch). React state `patch` is the UI source of truth;
// this object is the audio source of truth — applyPatch is the only bridge.
interface Engine {
  ctx: AudioContext;
  limiter: DynamicsCompressorNode;
  master: GainNode;
  analyser: AnalyserNode;
  recDest: MediaStreamAudioDestinationNode;
  driveIn: GainNode;
  shaper: WaveShaperNode;
  wowDelay: DelayNode;
  wowLFO: OscillatorNode;
  wowGain: GainNode;
  rotMakeup: GainNode;
  hissSrc: AudioBufferSourceNode;
  hissFilter: BiquadFilterNode;
  hissGain: GainNode;
  irs: Record<SpaceName, AudioBuffer>;
  preRev: GainNode;
  dry: GainNode;
  wet: GainNode;
  convolver: ConvolverNode;
  freezeDelay: DelayNode;
  freezeFb: GainNode;
  filter: BiquadFilterNode;
  lfo1: OscillatorNode;
  lfo1Gain: GainNode;
  mix: GainNode;
  droneFilter: BiquadFilterNode;
  droneGain: GainNode;
  drift: OscillatorNode;
  driftGain: GainNode;
  droneOscs: OscillatorNode[];
  subOsc: OscillatorNode;
  subGain: GainNode;
  noiseSrc: AudioBufferSourceNode;
  noiseFilter: BiquadFilterNode;
  noiseGain: GainNode;
  granGain: GainNode;
  samples: Partial<Record<SampleName, AudioBuffer>>;
  nextGrain: number;
  grainTimer: ReturnType<typeof setInterval>;
}

// mulberry32 seeded PRNG
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeIR(ctx: AudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate, len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, 2.5) * Math.exp(-3 * t);
      const n = Math.random() * 2 - 1;
      lp = lp * 0.93 + n * 0.07; // darken the tail
      d[i] = lp * env * 2.2;
    }
  }
  return buf;
}

function makeBrownNoise(ctx: AudioContext, seconds = 5): AudioBuffer {
  const sr = ctx.sampleRate, len = sr * seconds;
  const buf = ctx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    d[i] = last * 3.5;
  }
  return buf;
}

// Procedural sample bank, rendered offline. Base pitch = 110 Hz (A1 × 2);
// grain playbackRate is scaled by root/55 so everything stays key-locked.
async function renderSample(type: SampleName, sr: number): Promise<AudioBuffer> {
  const dur = 8;
  const off = new OfflineAudioContext(2, sr * dur, sr);
  const out = off.createGain();
  out.gain.value = 0.5;
  out.connect(off.destination);
  const base = 110;

  if (type === "bowed metal") {
    const ratios = [1, 2.32, 3.01, 4.27, 5.43, 6.79];
    ratios.forEach((r, i) => {
      const o = off.createOscillator();
      o.type = "sine"; o.frequency.value = base * r;
      o.detune.value = i % 2 ? 4 : -4;
      const g = off.createGain();
      g.gain.value = 0.5 / (i + 1);
      const lfo = off.createOscillator();
      lfo.frequency.value = 0.07 + i * 0.045;
      const lg = off.createGain();
      lg.gain.value = 0.2 / (i + 1);
      lfo.connect(lg); lg.connect(g.gain);
      o.connect(g); g.connect(out);
      o.start(); lfo.start();
    });
  } else if (type === "choir") {
    [-7, 0, 7].forEach((det) => {
      const o = off.createOscillator();
      o.type = "sawtooth"; o.frequency.value = base; o.detune.value = det;
      ([[520, 6, 0.5], [900, 8, 0.35], [1450, 10, 0.2]] as const).forEach(([f, q, a]) => {
        const bp = off.createBiquadFilter();
        bp.type = "bandpass"; bp.frequency.value = f; bp.Q.value = q;
        const g = off.createGain(); g.gain.value = a * 0.35;
        o.connect(bp); bp.connect(g); g.connect(out);
      });
      o.start();
    });
  } else { // wind tape
    const nb = off.createBuffer(1, sr * dur, sr);
    const d = nb.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.03 * w) / 1.03;
      d[i] = last * 3;
    }
    const src = off.createBufferSource();
    src.buffer = nb;
    const bp = off.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = 400; bp.Q.value = 1.2;
    const lfo = off.createOscillator(); lfo.frequency.value = 0.09;
    const lg = off.createGain(); lg.gain.value = 250;
    lfo.connect(lg); lg.connect(bp.frequency);
    src.connect(bp); bp.connect(out);
    src.start(); lfo.start();
  }
  return off.startRendering();
}

export default function App() {
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [patch, setPatch] = useState<Patch>(DEFAULT_PATCH);
  const [recording, setRecording] = useState(false);
  const [recUrl, setRecUrl] = useState<string | null>(null);
  const [mood, setMood] = useState("");
  const [claudeBusy, setClaudeBusy] = useState(false);
  const [claudeNote, setClaudeNote] = useState("");

  const E = useRef<Engine | null>(null); // engine node graph
  const patchRef = useRef<Patch>(patch); // for the grain scheduler
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  patchRef.current = patch;

  // ── engine construction ────────────────────────────────────
  const start = async () => {
    setLoading(true);
    const Ctor = window.AudioContext || window.webkitAudioContext!;
    const ctx = new Ctor();
    const sr = ctx.sampleRate;
    const e = { ctx } as Engine;

    // master
    e.limiter = ctx.createDynamicsCompressor();
    e.limiter.threshold.value = -8; e.limiter.knee.value = 2;
    e.limiter.ratio.value = 20; e.limiter.attack.value = 0.003; e.limiter.release.value = 0.25;
    e.master = ctx.createGain(); e.master.gain.value = 0.9;
    e.analyser = ctx.createAnalyser(); e.analyser.fftSize = 512; e.analyser.smoothingTimeConstant = 0.88;
    e.recDest = ctx.createMediaStreamDestination();
    e.limiter.connect(e.master);
    e.master.connect(e.analyser);
    e.analyser.connect(ctx.destination);
    e.master.connect(e.recDest);

    // rot: drive → wow/flutter delay → (+ hiss) → limiter
    e.driveIn = ctx.createGain();
    e.shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = i / 511.5 - 1;
      curve[i] = Math.tanh(2.2 * x);
    }
    e.shaper.curve = curve;
    e.wowDelay = ctx.createDelay(0.1); e.wowDelay.delayTime.value = 0.025;
    e.wowLFO = ctx.createOscillator(); e.wowLFO.frequency.value = 0.33;
    e.wowGain = ctx.createGain(); e.wowGain.gain.value = 0.002;
    e.wowLFO.connect(e.wowGain); e.wowGain.connect(e.wowDelay.delayTime); e.wowLFO.start();
    e.rotMakeup = ctx.createGain(); e.rotMakeup.gain.value = 0.7;
    e.driveIn.connect(e.shaper); e.shaper.connect(e.wowDelay);
    e.wowDelay.connect(e.rotMakeup); e.rotMakeup.connect(e.limiter);
    e.hissSrc = ctx.createBufferSource();
    const hb = ctx.createBuffer(1, sr * 2, sr);
    const hd = hb.getChannelData(0);
    for (let i = 0; i < hd.length; i++) hd[i] = (Math.random() * 2 - 1) * 0.4;
    e.hissSrc.buffer = hb; e.hissSrc.loop = true;
    e.hissFilter = ctx.createBiquadFilter(); e.hissFilter.type = "highpass"; e.hissFilter.frequency.value = 3000;
    e.hissGain = ctx.createGain(); e.hissGain.gain.value = 0.0;
    e.hissSrc.connect(e.hissFilter); e.hissFilter.connect(e.hissGain);
    e.hissGain.connect(e.limiter); e.hissSrc.start();

    // reverb section: preRev → dry + convolver(wet); freeze loop
    e.irs = { chapel: makeIR(ctx, SPACES.chapel), cistern: makeIR(ctx, SPACES.cistern), infinite: makeIR(ctx, SPACES.infinite) };
    e.preRev = ctx.createGain();
    e.dry = ctx.createGain(); e.wet = ctx.createGain();
    e.convolver = ctx.createConvolver(); e.convolver.buffer = e.irs.cistern;
    e.freezeDelay = ctx.createDelay(2); e.freezeDelay.delayTime.value = 1.2;
    e.freezeFb = ctx.createGain(); e.freezeFb.gain.value = 0.0;
    e.preRev.connect(e.dry);
    e.preRev.connect(e.convolver);
    e.preRev.connect(e.freezeDelay);
    e.freezeDelay.connect(e.freezeFb); e.freezeFb.connect(e.freezeDelay);
    e.freezeDelay.connect(e.convolver);
    e.convolver.connect(e.wet);
    e.dry.connect(e.driveIn); e.wet.connect(e.driveIn);

    // master filter + LFO1
    e.filter = ctx.createBiquadFilter(); e.filter.type = "lowpass"; e.filter.Q.value = 0.9;
    e.lfo1 = ctx.createOscillator(); e.lfo1.frequency.value = DEFAULT_PATCH.lfoRate;
    e.lfo1Gain = ctx.createGain();
    e.lfo1.connect(e.lfo1Gain); e.lfo1Gain.connect(e.filter.frequency); e.lfo1.start();
    e.filter.connect(e.preRev);

    e.mix = ctx.createGain(); e.mix.connect(e.filter);

    // voice A: drone — 5 detuned saws + sub, drift LFO, darkness LP
    const rootHz = ROOTS[DEFAULT_PATCH.root];
    e.droneFilter = ctx.createBiquadFilter(); e.droneFilter.type = "lowpass";
    e.droneGain = ctx.createGain(); e.droneGain.gain.value = 0;
    e.droneFilter.connect(e.droneGain); e.droneGain.connect(e.mix);
    e.drift = ctx.createOscillator(); e.drift.frequency.value = 0.05;
    e.driftGain = ctx.createGain(); e.driftGain.gain.value = 4; // ±4 cents
    e.drift.connect(e.driftGain); e.drift.start();
    e.droneOscs = [-9, -4, 0, 5, 11].map((cents) => {
      const o = ctx.createOscillator();
      o.type = "sawtooth"; o.frequency.value = rootHz; o.detune.value = cents;
      const g = ctx.createGain(); g.gain.value = 0.13;
      e.driftGain.connect(o.detune);
      o.connect(g); g.connect(e.droneFilter); o.start();
      return o;
    });
    e.subOsc = ctx.createOscillator();
    e.subOsc.type = "triangle"; e.subOsc.frequency.value = rootHz / 2;
    e.subGain = ctx.createGain(); e.subGain.gain.value = 0.4;
    e.subOsc.connect(e.subGain); e.subGain.connect(e.droneFilter); e.subOsc.start();

    // voice C: noise floor
    e.noiseSrc = ctx.createBufferSource();
    e.noiseSrc.buffer = makeBrownNoise(ctx); e.noiseSrc.loop = true;
    e.noiseFilter = ctx.createBiquadFilter(); e.noiseFilter.type = "lowpass"; e.noiseFilter.frequency.value = 350;
    e.noiseGain = ctx.createGain(); e.noiseGain.gain.value = 0;
    e.noiseSrc.connect(e.noiseFilter); e.noiseFilter.connect(e.noiseGain);
    e.noiseGain.connect(e.mix); e.noiseSrc.start();

    // voice B: granular over procedural sample
    e.granGain = ctx.createGain(); e.granGain.gain.value = 0;
    e.granGain.connect(e.mix);
    e.samples = {};
    for (const t of SAMPLES) e.samples[t] = await renderSample(t, sr);

    // grain scheduler (lookahead)
    e.nextGrain = ctx.currentTime + 0.1;
    e.grainTimer = setInterval(() => {
      const p = patchRef.current;
      const buf = e.samples[p.sampleType];
      if (!buf) return;
      const ahead = ctx.currentTime + 0.18;
      while (e.nextGrain < ahead) {
        const t = e.nextGrain;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const rootRatio = ROOTS[p.root] / 55;
        const pool = [0.5, 0.5, 1, 1, 1, 1, 1.5, 2, 1.0595]; // oct↓ root 5th oct↑ m2
        src.playbackRate.value = pool[Math.floor(Math.random() * pool.length)] * rootRatio;
        const dur = buf.duration;
        let off = p.position * dur + (Math.random() - 0.5) * p.spray * dur;
        off = Math.max(0, Math.min(dur - p.grainSize - 0.01, off));
        const g = ctx.createGain();
        const peak = 0.55 / Math.sqrt(Math.max(1, p.grainDensity * p.grainSize * 0.5));
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(peak, t + p.grainSize * 0.45);
        g.gain.linearRampToValueAtTime(0, t + p.grainSize);
        src.connect(g); g.connect(e.granGain);
        src.start(t, off, p.grainSize + 0.05);
        e.nextGrain += 1 / p.grainDensity;
      }
    }, 60);

    E.current = e;
    applyPatch(e, DEFAULT_PATCH, 3); // fade in over 3s
    setLoading(false);
    setStarted(true);
  };

  // ── apply a patch to the live graph ────────────────────────
  const applyPatch = (e: Engine, p: Patch, ramp = 0.08) => {
    const t = e.ctx.currentTime;
    const set = (param: AudioParam, v: number) => {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(v, t + ramp);
    };
    const rootHz = ROOTS[p.root];
    e.droneOscs.forEach((o) => set(o.frequency, rootHz));
    set(e.subOsc.frequency, rootHz / 2);
    set(e.droneGain.gain, p.droneLevel * 0.55);
    set(e.droneFilter.frequency, 2200 - p.droneDark * 2050);
    set(e.subGain.gain, 0.25 + p.droneDark * 0.45);
    set(e.noiseGain.gain, p.noiseLevel * 0.5);
    set(e.granGain.gain, p.sampleLevel * 0.9);
    set(e.filter.frequency, p.cutoff);
    set(e.lfo1Gain.gain, p.lfoDepth * p.cutoff * 0.6);
    set(e.lfo1.frequency, p.lfoRate);
    if (e.convolver.buffer !== e.irs[p.space]) e.convolver.buffer = e.irs[p.space];
    set(e.wet.gain, p.wet);
    set(e.dry.gain, 1 - p.wet * 0.6);
    set(e.freezeFb.gain, p.freeze ? 0.985 : 0.0);
    set(e.driveIn.gain, 0.4 + p.drive * 1.6);
    set(e.rotMakeup.gain, 0.75 - p.drive * 0.25);
    set(e.wowGain.gain, p.flutter * 0.0045);
    set(e.hissGain.gain, p.hiss * 0.025);
  };

  const update = <K extends keyof Patch>(key: K, value: Patch[K]) => {
    const p = { ...patch, [key]: value };
    setPatch(p);
    if (E.current) applyPatch(E.current, p, key === "freeze" ? 0.4 : 0.08);
  };

  // ── the ritual: seeded re-patch, slow crossfade ────────────
  const ritual = () => {
    const seed = (patch.seed * 16807 + Date.now()) % 2147483647;
    const r = rng(seed);
    const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(r() * arr.length)];
    const span = ([a, b]: readonly [number, number]) => a + r() * (b - a);
    const p: Patch = {
      ...patch, seed,
      root: pick(Object.keys(ROOTS) as RootName[]),
      sampleType: pick(SAMPLES),
      space: pick(Object.keys(SPACES) as SpaceName[]),
      droneLevel: span([0.3, 0.8]), droneDark: span([0.4, 1]),
      sampleLevel: span([0.2, 0.8]),
      grainSize: span([0.15, 1.8]), grainDensity: span([3, 22]),
      spray: span(RANGES.spray), position: span(RANGES.position),
      noiseLevel: span([0.05, 0.4]),
      cutoff: 200 + r() * r() * 4000,
      lfoDepth: span([0.1, 0.8]), lfoRate: span([0.02, 0.3]),
      wet: span([0.5, 1]), drive: span(RANGES.drive),
      flutter: span(RANGES.flutter), hiss: span([0, 0.45]),
    };
    setPatch(p);
    if (E.current) applyPatch(E.current, p, 7); // 7-second becoming
  };

  // ── BYOC: ask Claude to mutate the patch toward a mood ─────
  const askClaude = async () => {
    if (!mood.trim() || !E.current) return;
    setClaudeBusy(true); setClaudeNote("");
    try {
      const editable = Object.fromEntries((Object.keys(RANGES) as RangeKey[]).map((k) => [k, patch[k]]));
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `You are a dark ambient sound designer (think Lustmord, raison d'être, Cold Meat Industry). Mutate this synth patch toward the mood: "${mood}".
Current patch: ${JSON.stringify(editable)}
Parameter ranges: ${JSON.stringify(RANGES)}
Also choose: "root" from ${JSON.stringify(Object.keys(ROOTS))}, "sampleType" from ${JSON.stringify(SAMPLES)}, "space" from ${JSON.stringify(Object.keys(SPACES))}.
Notes: droneDark higher = darker; grainSize in seconds; lfoRate in Hz (slow); wet = reverb amount; drive/flutter/hiss = tape rot.
Respond with ONLY a JSON object: every key above, plus a "note" key with one short poetic sentence describing the scene. No markdown, no backticks.`,
          }],
        }),
      });
      const data = await res.json();
      const text = (data.content as Array<{ type: string; text: string }>)
        .filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      const p: Patch = { ...patch };
      for (const [k, [lo, hi]] of Object.entries(RANGES) as [RangeKey, [number, number]][]) {
        if (typeof parsed[k] === "number") p[k] = Math.min(hi, Math.max(lo, parsed[k]));
      }
      if (parsed.root in ROOTS) p.root = parsed.root as RootName;
      if (SAMPLES.includes(parsed.sampleType)) p.sampleType = parsed.sampleType as SampleName;
      if (parsed.space in SPACES) p.space = parsed.space as SpaceName;
      setPatch(p);
      applyPatch(E.current, p, 9); // Claude's edits arrive as weather
      setClaudeNote(parsed.note || "");
    } catch {
      setClaudeNote("The oracle was silent. Try again.");
    }
    setClaudeBusy(false);
  };

  // ── recording ──────────────────────────────────────────────
  const recRef = useRef<MediaRecorder | null>(null);
  const toggleRecord = () => {
    const e = E.current;
    if (!e) return;
    if (!recording) {
      const chunks: Blob[] = [];
      const mr = new MediaRecorder(e.recDest.stream);
      mr.ondataavailable = (ev) => chunks.push(ev.data);
      mr.onstop = () => setRecUrl(URL.createObjectURL(new Blob(chunks, { type: "audio/webm" })));
      mr.start();
      recRef.current = mr;
      if (recUrl) { URL.revokeObjectURL(recUrl); setRecUrl(null); }
      setRecording(true);
    } else {
      recRef.current?.stop();
      setRecording(false);
    }
  };

  // ── spectral smoke canvas ──────────────────────────────────
  useEffect(() => {
    if (!started) return;
    const cv = canvasRef.current, e = E.current;
    if (!cv || !e) return;
    const ctx2d = cv.getContext("2d")!;
    const data = new Uint8Array(e.analyser.frequencyBinCount);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const draw = () => {
      const w = cv.width = cv.offsetWidth * 2;
      const h = cv.height = cv.offsetHeight * 2;
      e.analyser.getByteFrequencyData(data);
      ctx2d.fillStyle = "rgba(16,12,9,0.28)";
      ctx2d.fillRect(0, 0, w, h);
      const bins = 96;
      for (let i = 0; i < bins; i++) {
        const v = data[Math.floor(i * 1.6)] / 255;
        const x = (i / bins) * w;
        const hgt = v * h * 0.92;
        const grad = ctx2d.createLinearGradient(0, h - hgt, 0, h);
        grad.addColorStop(0, "rgba(201,123,61,0)");
        grad.addColorStop(0.5, `rgba(150,60,40,${0.1 + v * 0.32})`);
        grad.addColorStop(1, `rgba(110,30,30,${0.22 + v * 0.4})`);
        ctx2d.fillStyle = grad;
        ctx2d.fillRect(x, h - hgt, w / bins - 1.5, hgt);
      }
      if (!reduced) raf = requestAnimationFrame(draw);
    };
    draw();
    if (reduced) { const id = setInterval(draw, 500); return () => clearInterval(id); }
    return () => cancelAnimationFrame(raf);
  }, [started]);

  useEffect(() => () => { // teardown
    const e = E.current;
    if (e) { clearInterval(e.grainTimer); e.ctx.close(); }
  }, []);

  // ── UI ─────────────────────────────────────────────────────
  const Slider = ({ k, label, fmt }: { k: RangeKey; label: string; fmt?: (v: number) => string }) => {
    const [lo, hi] = RANGES[k];
    const v = patch[k];
    return (
      <div className="row">
        <span className="lbl">{label}</span>
        <input
          type="range" min={lo} max={hi} step={(hi - lo) / 200} value={v}
          onChange={(ev) => update(k, parseFloat(ev.target.value))}
        />
        <span className="val">{fmt ? fmt(v) : v.toFixed(2)}</span>
      </div>
    );
  };

  const Choice = <K extends "root" | "sampleType" | "space">(
    { k, options, label }: { k: K; options: readonly Patch[K][]; label: string },
  ) => (
    <div className="row">
      <span className="lbl">{label}</span>
      <div className="choices">
        {options.map((o) => (
          <button
            key={String(o)} className={patch[k] === o ? "chip on" : "chip"}
            onClick={() => update(k, o)}
          >
            {String(o)}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="nave">
      <style>{CSS}</style>
      <header>
        <h1>NAVE</h1>
        <p className="sub">drone engine · vespers for the empty hall</p>
      </header>

      {!started ? (
        <div className="gate">
          <button className="big" onClick={start} disabled={loading}>
            {loading ? "preparing the space…" : "✦ light the coals"}
          </button>
          <p className="hint">headphones recommended · sound begins slowly</p>
        </div>
      ) : (
        <>
          <canvas ref={canvasRef} className="smoke" />

          <div className="actions">
            <button className="big" onClick={ritual}>☉ ritual — re-seed</button>
            <button
              className={patch.freeze ? "big on" : "big"}
              onClick={() => update("freeze", !patch.freeze)}
            >
              ❄ freeze {patch.freeze ? "· held" : ""}
            </button>
            <button className={recording ? "big rec" : "big"} onClick={toggleRecord}>
              {recording ? "■ stop" : "● record"}
            </button>
            {recUrl && <a className="big dl" href={recUrl} download="nave-drone.webm">↓ save take</a>}
          </div>

          <section>
            <h2>foundation</h2>
            <Choice k="root" label="root" options={Object.keys(ROOTS) as RootName[]} />
            <Slider k="droneLevel" label="drone" />
            <Slider k="droneDark" label="darkness" />
            <Slider k="noiseLevel" label="floor" />
          </section>

          <section>
            <h2>grains</h2>
            <Choice k="sampleType" label="source" options={SAMPLES} />
            <Slider k="sampleLevel" label="level" />
            <Slider k="grainSize" label="size" fmt={(v) => v.toFixed(2) + "s"} />
            <Slider k="grainDensity" label="density" fmt={(v) => v.toFixed(0) + "/s"} />
            <Slider k="position" label="position" />
            <Slider k="spray" label="spray" />
          </section>

          <section>
            <h2>air</h2>
            <Slider k="cutoff" label="filter" fmt={(v) => v.toFixed(0) + "Hz"} />
            <Slider k="lfoDepth" label="breath depth" />
            <Slider k="lfoRate" label="breath rate" fmt={(v) => v.toFixed(2) + "Hz"} />
            <Choice k="space" label="space" options={Object.keys(SPACES) as SpaceName[]} />
            <Slider k="wet" label="immersion" />
          </section>

          <section>
            <h2>rot</h2>
            <Slider k="drive" label="saturation" />
            <Slider k="flutter" label="wow" />
            <Slider k="hiss" label="hiss" />
          </section>

          <section className="oracle">
            <h2>oracle</h2>
            <div className="askrow">
              <input
                type="text" value={mood} placeholder="frostbitten · hollow · liturgical…"
                onChange={(ev) => setMood(ev.target.value)}
                onKeyDown={(ev) => ev.key === "Enter" && askClaude()}
              />
              <button className="big" onClick={askClaude} disabled={claudeBusy}>
                {claudeBusy ? "listening…" : "ask claude"}
              </button>
            </div>
            {claudeNote && <p className="note">“{claudeNote}”</p>}
          </section>

          <footer>seed {patch.seed} · everything is in key · nothing is in time</footer>
        </>
      )}
    </div>
  );
}

const CSS = `
.nave{min-height:100vh;background:#100c09;color:#d8cdb8;font-family:Georgia,'Palatino Linotype',serif;
  max-width:680px;margin:0 auto;padding:20px 16px 60px}
.nave *{box-sizing:border-box}
header{text-align:center;margin-bottom:14px}
h1{font-size:34px;letter-spacing:0.5em;margin:0;font-weight:400;color:#e6dcc4;text-indent:0.5em}
.sub{margin:4px 0 0;font-size:12px;letter-spacing:0.18em;color:#8a7d66;font-style:italic}
.gate{display:flex;flex-direction:column;align-items:center;gap:14px;padding:70px 0}
.hint{font-size:12px;color:#6e6350;letter-spacing:0.08em}
.smoke{width:100%;height:120px;display:block;background:#0c0907;border:1px solid #2a201a;margin-bottom:14px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
.big{background:#1c1410;border:1px solid #4a2a22;color:#d8cdb8;padding:10px 16px;font-family:inherit;
  font-size:13px;letter-spacing:0.12em;cursor:pointer;transition:all .25s}
.big:hover{background:#2a1a14;border-color:#7a2020}
.big.on{background:#3a1515;border-color:#a03030;color:#f0e6d0}
.big.rec{background:#5a1212;border-color:#c04040;animation:pulse 2s infinite}
.big.dl{text-decoration:none;border-color:#6a5a30;color:#cdbf90}
@keyframes pulse{50%{opacity:0.6}}
@media (prefers-reduced-motion: reduce){.big.rec{animation:none}}
section{border:1px solid #2a201a;padding:12px 14px;margin-bottom:12px;background:rgba(22,16,12,0.6)}
h2{font-size:11px;letter-spacing:0.3em;text-transform:uppercase;color:#9c5230;margin:0 0 10px;font-weight:400}
.row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.lbl{width:88px;font-size:12px;color:#a89878;letter-spacing:0.06em;flex-shrink:0}
.val{width:58px;font-size:11px;color:#c97b3d;font-family:ui-monospace,monospace;text-align:right;flex-shrink:0}
input[type=range]{flex:1;appearance:none;-webkit-appearance:none;height:2px;background:#3a2c22;outline:none}
input[type=range]::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:14px;height:14px;
  background:#7a2020;border:1px solid #c97b3d;border-radius:50%;cursor:pointer}
input[type=range]::-moz-range-thumb{width:13px;height:13px;background:#7a2020;border:1px solid #c97b3d;border-radius:50%;cursor:pointer}
input[type=range]:focus-visible::-webkit-slider-thumb{outline:2px solid #c97b3d;outline-offset:2px}
.choices{display:flex;flex-wrap:wrap;gap:6px}
.chip{background:transparent;border:1px solid #3a2c22;color:#a89878;padding:4px 10px;font-family:inherit;
  font-size:11px;letter-spacing:0.08em;cursor:pointer}
.chip.on{border-color:#a03030;color:#e6dcc4;background:#2a1212}
.oracle .askrow{display:flex;gap:8px}
.oracle input[type=text]{flex:1;background:#0c0907;border:1px solid #3a2c22;color:#d8cdb8;
  padding:10px 12px;font-family:inherit;font-size:13px;font-style:italic}
.oracle input[type=text]:focus{outline:1px solid #7a2020}
.note{font-size:13px;font-style:italic;color:#b08d5a;margin:10px 0 0;line-height:1.5}
footer{text-align:center;font-size:10px;letter-spacing:0.2em;color:#534838;margin-top:24px}
`;
