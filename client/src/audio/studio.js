// Studio sound engine (Monochrome-inspired):
// MediaElementSource → preamp → 10-band peaking EQ → compressor → analyser → master → destination
// NOTE: WebAudio routing zeroes cross-origin streams without CORS, so Studio mode
// always plays via the same-origin /api/stream proxy (which sends ACAO:* + Range).

export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_LABELS = ['31', '62', '125', '250', '500', '1K', '2K', '4K', '8K', '16K'];
const EQ_Q = 1.5; // proper Q for octave-spaced bands

// Monochrome's 16-band ISO presets (dB) — interpolated down to 10 bands
const PRESETS_16 = {
  flat:        { name: 'Flat',            gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass_boost:  { name: 'Bass Boost',      gains: [6, 5, 4.5, 4, 3, 2, 1, 0.5, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass_cut:    { name: 'Bass Reducer',    gains: [-6, -5, -4, -3, -2, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  treble_boost:{ name: 'Treble Boost',    gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 5.5, 6] },
  treble_cut:  { name: 'Treble Reducer',  gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, -1, -2, -3, -4, -5, -5.5, -6] },
  vocal:       { name: 'Vocal Boost',     gains: [-2, -1, 0, 0, 1, 2, 3, 4, 4, 3, 2, 1, 0, 0, -1, -2] },
  loudness:    { name: 'Loudness',        gains: [5, 4, 3, 1, 0, -1, -1, 0, 0, 1, 2, 3, 4, 4.5, 4, 3] },
  rock:        { name: 'Rock',            gains: [4, 3.5, 3, 2, -1, -2, -1, 1, 2, 3, 3.5, 4, 4, 3, 2, 1] },
  pop:         { name: 'Pop',             gains: [-1, 0, 1, 2, 3, 3, 2, 1, 0, 1, 2, 2, 2, 2, 1, 0] },
  classical:   { name: 'Classical',       gains: [3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 3, 2] },
  jazz:        { name: 'Jazz',            gains: [3, 2, 1, 1, -1, -1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2] },
  electronic:  { name: 'Electronic',      gains: [4, 3.5, 3, 1, 0, -1, 0, 1, 2, 3, 3, 2, 2, 3, 4, 3.5] },
  hiphop:      { name: 'Hip-Hop',         gains: [5, 4.5, 4, 3, 1, 0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2] },
  randb:       { name: 'R&B',             gains: [3, 5, 4, 2, 1, 0, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1] },
  acoustic:    { name: 'Acoustic',        gains: [3, 2, 1, 1, 2, 2, 1, 0, 0, 1, 1, 2, 3, 3, 2, 1] },
  podcast:     { name: 'Podcast/Speech',  gains: [-3, -2, -1, 0, 1, 2, 3, 4, 4, 3, 2, 1, 0, -1, -2, -3] },
};

function interpolate(p16, n = 10) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const pos = (i / (n - 1)) * (p16.length - 1);
    const lo = Math.floor(pos), hi = Math.min(Math.ceil(pos), p16.length - 1), f = pos - lo;
    out.push(Math.round(((p16[lo] || 0) + ((p16[hi] || 0) - (p16[lo] || 0)) * f) * 10) / 10);
  }
  return out;
}

const PRESETS = {};
for (const [k, p] of Object.entries(PRESETS_16)) PRESETS[k] = { name: p.name, gains: interpolate(p.gains) };
export function getPresets() { return PRESETS; }

let ctx = null, source = null, currentEl = null;
let preamp = null, bands = [], comp = null, analyser = null, master = null;
let eqInPath = false;
let masterGainVal = 1; // volume boost multiplier (persists across graph rebuilds)

function silence(node) { try { node?.disconnect(); } catch { /* noop */ } }

function wire(withEq) {
  if (!source || !ctx) return;
  [source, preamp, comp, analyser, master, ...bands].forEach(silence);
  if (withEq) {
    source.connect(preamp);
    preamp.connect(bands[0]);
    for (let i = 0; i < bands.length - 1; i++) bands[i].connect(bands[i + 1]);
    bands[bands.length - 1].connect(comp);
  } else {
    source.connect(comp);
  }
  comp.connect(analyser);
  analyser.connect(master);
  master.connect(ctx.destination);
  eqInPath = withEq;
}

/** Build (or re-target) the graph for an <audio> element. Returns the analyser. */
export function ensureGraph(el) {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  if (currentEl === el && source) return analyser;
  silence(source);
  currentEl = el;
  source = ctx.createMediaElementSource(el);
  preamp = ctx.createGain();
  bands = EQ_FREQS.map(f => {
    const b = ctx.createBiquadFilter();
    b.type = 'peaking'; b.frequency.value = f; b.Q.value = EQ_Q; b.gain.value = 0;
    return b;
  });
  comp = ctx.createDynamicsCompressor();
  comp.threshold.value = 0; comp.ratio.value = 1; // transparent until Normalize is on
  comp.attack.value = 0.01; comp.release.value = 0.25; comp.knee.value = 12;
  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.75;
  master = ctx.createGain(); master.gain.value = masterGainVal;
  wire(true);
  return analyser;
}

export function setBandGain(i, db) {
  const b = bands[i];
  if (!b || !ctx) return;
  b.gain.setTargetAtTime(db, ctx.currentTime, 0.01);
}
export function setAllGains(arr) { (arr || []).forEach((g, i) => setBandGain(i, g)); }
export function applyPresetGains(key) {
  const p = PRESETS[key];
  if (p) setAllGains(p.gains);
  return p?.gains || null;
}
export function setPreamp(db) {
  if (!preamp || !ctx) return;
  preamp.gain.setTargetAtTime(Math.pow(10, (db || 0) / 20), ctx.currentTime, 0.01);
}
export function setMasterGain(mult) {
  masterGainVal = Math.min(2, Math.max(1, +mult || 1));
  if (master && ctx) master.gain.setTargetAtTime(masterGainVal, ctx.currentTime, 0.02);
}
export function getMasterGain() { return masterGainVal; }
export function setNormalize(on) {
  if (!comp || !ctx) return;
  const t = ctx.currentTime;
  comp.threshold.setTargetAtTime(on ? -18 : 0, t, 0.05);
  comp.ratio.setTargetAtTime(on ? 3 : 1, t, 0.05);
}
export function setEqEnabled(on) { if (source && on !== eqInPath) wire(!!on); }
/** Push persisted settings into a fresh graph (call after ensureGraph). */
export function syncFromState({ gains, preamp: pa, enabled, normalize, gain }) {
  if (!source) return;
  setAllGains(gains);
  setPreamp(pa);
  setNormalize(normalize);
  setMasterGain(gain == null ? 1 : gain);
  if (!!enabled !== eqInPath) wire(!!enabled);
}
export function getAnalyser() { return analyser; }
export function resume() { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); }
export function isRouted(el) { return currentEl === el && !!source; }
