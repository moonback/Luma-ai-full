import type { SectionLabel, SongAnalysis, SongSection } from '../model/schemas';
import { cosine, mean, median, N_BANDS, spectralFlux, Spectrum } from './dsp';

/**
 * Offline song analysis: tempo, beat grid (dynamic programming, Ellis 2007), downbeats, structure (bar-level
 * self-similarity + checkerboard novelty, boundaries snapped to 4-bar phrases), section labels (repetition and
 * energy rules), key (Krumhansl–Schmuckler) and events (impacts, risers, silences).
 * Signal processing and explicit rules only: no trained model. Labels are estimates; the UI lets the user edit them.
 */
export interface AnalyzeOptions {
  bpmMin?: number;
  bpmMax?: number;
  /** Called with 0..1 while analysing. */
  onProgress?: (p: number) => void;
  /** Awaited between chunks so a UI thread stays responsive (e.g. `() => new Promise(r => setTimeout(r))`). */
  yieldFn?: () => Promise<void>;
}

interface Frames {
  fr: number; // frames per second
  offset: number; // seconds: frame i is centred at i / fr + offset
  onset: Float32Array;
  bassFlux: Float32Array;
  rms: Float32Array;
  centroid: Float32Array;
  bass: Float32Array;
  high: Float32Array;
  bands: Float32Array[];
  chroma: Float32Array[];
}

async function extract(samples: Float32Array, sr: number, o: AnalyzeOptions): Promise<Frames> {
  const size = 2 ** Math.round(Math.log2(sr * 0.093));
  const hop = size / 4;
  const spec = new Spectrum(size, sr);
  const n = Math.max(1, Math.floor((samples.length - size) / hop) + 1);
  const f: Frames = {
    fr: sr / hop, offset: size / 2 / sr,
    onset: new Float32Array(n), bassFlux: new Float32Array(n), rms: new Float32Array(n), centroid: new Float32Array(n),
    bass: new Float32Array(n), high: new Float32Array(n), bands: new Array(n), chroma: new Array(n),
  };
  let prev: Float32Array | null = null, prevBass = 0;
  for (let i = 0; i < n; i++) {
    const x = spec.frame(samples, i * hop);
    f.onset[i] = spectralFlux(prev, x.bands);
    f.bassFlux[i] = i ? Math.max(0, x.bass - prevBass) : 0;
    prev = x.bands;
    prevBass = x.bass;
    f.rms[i] = x.rms; f.centroid[i] = x.centroid; f.bass[i] = x.bass; f.high[i] = x.high;
    f.bands[i] = x.bands; f.chroma[i] = x.chroma;
    if (i % 2000 === 1999) {
      o.onProgress?.((0.7 * i) / n);
      await o.yieldFn?.();
    }
  }
  // Onset envelope: subtract a 1 s moving average, half-wave rectify, unit standard deviation.
  const w = Math.round(f.fr / 2);
  const env = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n + w; i++) {
    if (i < n) acc += f.onset[i]!;
    if (i - 2 * w - 1 >= 0) acc -= f.onset[i - 2 * w - 1]!;
    const c = i - w;
    if (c >= 0 && c < n) env[c] = Math.max(0, f.onset[c]! - acc / (Math.min(i, n - 1) - Math.max(0, i - 2 * w) + 1));
  }
  const sd = Math.sqrt(mean(env.map((v) => v * v))) || 1;
  f.onset = env.map((v) => v / sd);
  return f;
}

/* ---------------- Tempo & beats ---------------- */

function autocorr(x: Float32Array, maxLag: number): Float64Array {
  const r = new Float64Array(maxLag + 2);
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < x.length; i++) s += x[i]! * x[i - lag]!;
    r[lag] = s / (x.length - lag);
  }
  return r;
}

const interp = (r: Float64Array, x: number) => {
  const i = Math.floor(x);
  if (i + 1 >= r.length) return 0;
  return r[i]! + (r[i + 1]! - r[i]!) * (x - i);
};

/**
 * Global tempo: comb over the onset autocorrelation, with a log-normal prior centred on the range's geometric mean.
 * `halfPenalty` (for a kick/bass envelope): a strong pulse half-way through the candidate period means the real beat
 * is twice as fast, so that candidate is penalised instead of rewarded.
 */
export function estimateTempo(onset: Float32Array, fr: number, bpmMin = 70, bpmMax = 180, halfPenalty = false): number {
  const maxLag = Math.ceil((60 * fr * 4) / bpmMin);
  const r = autocorr(onset, Math.min(maxLag, onset.length - 2));
  const centre = Math.sqrt(bpmMin * bpmMax);
  const at = (bpm: number) => {
    const lag = (60 * fr) / bpm;
    const score = interp(r, lag) + 0.5 * interp(r, 2 * lag) + 0.5 * interp(r, 4 * lag) + (halfPenalty ? -0.75 : 0.25) * interp(r, lag / 2);
    return score * Math.exp(-0.5 * (Math.log2(bpm / centre) / 0.9) ** 2);
  };
  let best = centre, bestScore = -Infinity;
  for (let bpm = bpmMin; bpm <= bpmMax; bpm += 0.1) {
    const v = at(bpm);
    if (v > bestScore) { bestScore = v; best = bpm; }
  }
  // Parabolic refinement around the comb maximum.
  const a0 = at(best - 0.1), a2 = at(best + 0.1), den = a0 - 2 * bestScore + a2;
  return den < 0 ? best + (0.1 * (a0 - a2)) / (2 * den) : best;
}

/** Dynamic-programming beat tracker; returns frame indices. */
export function trackBeats(onset: Float32Array, period: number, tightness = 100): number[] {
  const n = onset.length;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2), hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = 0, arg = -1;
    for (let tau = t - hi; tau <= t - lo; tau++) {
      if (tau < 0) continue;
      const v = score[tau]! - tightness * Math.log((t - tau) / period) ** 2;
      if (arg < 0 || v > best) { best = v; arg = tau; }
    }
    score[t] = onset[t]! + (arg >= 0 ? best : 0);
    back[t] = arg;
  }
  // Start from the best-scoring frame in the last period, then follow the back links.
  let t = n - 1;
  for (let i = Math.max(0, n - Math.ceil(period)); i < n; i++) if (score[i]! > score[t]!) t = i;
  const beats: number[] = [];
  for (; t >= 0; t = back[t]!) beats.push(t);
  return beats.reverse();
}

const near = (x: Float32Array, i: number, r = 2) => {
  let m = 0;
  for (let k = Math.max(0, i - r); k <= Math.min(x.length - 1, i + r); k++) m = Math.max(m, x[k]!);
  return m;
};

function avgVec(vs: Float32Array[], from: number, to: number, dim: number): Float32Array {
  const out = new Float32Array(dim);
  const a = Math.max(0, from), b = Math.min(vs.length, Math.max(a + 1, to));
  for (let i = a; i < b; i++) for (let d = 0; d < dim; d++) out[d] = out[d]! + vs[i]![d]!;
  for (let d = 0; d < dim; d++) out[d] = out[d]! / (b - a);
  return out;
}

/** Downbeat phase (0..3): beats with the strongest bass accents and harmonic changes start the bars. */
function downbeatPhase(f: Frames, beats: number[]): number {
  const scores = [0, 0, 0, 0];
  const counts = [0, 0, 0, 0];
  for (let j = 1; j < beats.length - 1; j++) {
    const before = avgVec(f.chroma, beats[j - 1]!, beats[j]!, 12);
    const after = avgVec(f.chroma, beats[j]!, beats[j + 1]!, 12);
    scores[j % 4]! += near(f.bassFlux, beats[j]!) + 2 * (1 - cosine(before, after));
    counts[j % 4]!++;
  }
  let best = 0;
  for (let k = 1; k < 4; k++) if (scores[k]! / (counts[k] || 1) > scores[best]! / (counts[best] || 1)) best = k;
  return best;
}

/* ---------------- Structure ---------------- */

interface Bar { start: number; end: number; startFrame: number; endFrame: number; chroma: Float32Array; bands: Float32Array; rms: number; centroid: number; bass: number; high: number; onsets: number }

function barFeatures(f: Frames, starts: number[], endFrame: number): Bar[] {
  const toT = (i: number) => i / f.fr + f.offset;
  const bars: Bar[] = [];
  for (let b = 0; b < starts.length; b++) {
    const a = starts[b]!, e = starts[b + 1] ?? endFrame;
    if (e - a < 2) continue;
    let onsets = 0;
    for (let i = a + 1; i < e - 1; i++) if (f.onset[i]! > 1.5 && f.onset[i]! >= f.onset[i - 1]! && f.onset[i]! >= f.onset[i + 1]!) onsets++;
    const sl = (x: Float32Array) => mean(x.subarray(a, e));
    bars.push({ start: toT(a), end: toT(e), startFrame: a, endFrame: e, chroma: avgVec(f.chroma, a, e, 12), bands: avgVec(f.bands, a, e, N_BANDS), rms: sl(f.rms), centroid: sl(f.centroid), bass: sl(f.bass), high: sl(f.high), onsets });
  }
  return bars;
}

/** Bar-to-bar similarity: harmony (chroma) and timbre (z-scored band energies). */
function similarity(bars: Bar[]): number[][] {
  const dims = N_BANDS;
  const mu = new Float64Array(dims), sd = new Float64Array(dims);
  for (const b of bars) for (let d = 0; d < dims; d++) mu[d] = mu[d]! + b.bands[d]! / bars.length;
  for (const b of bars) for (let d = 0; d < dims; d++) sd[d] = sd[d]! + (b.bands[d]! - mu[d]!) ** 2 / bars.length;
  const z = bars.map((b) => Float32Array.from(b.bands, (v, d) => (v - mu[d]!) / (Math.sqrt(sd[d]!) || 1)));
  const maxRms = Math.max(...bars.map((b) => b.rms)) || 1;
  return bars.map((a, i) => bars.map((b, j) => {
    const timbre = (cosine(z[i]!, z[j]!) + 1) / 2;
    const energy = 1 - Math.abs(a.rms - b.rms) / maxRms;
    return 0.4 * cosine(a.chroma, b.chroma) + 0.4 * timbre + 0.2 * energy;
  }));
}

/** Boundaries (bar indices) from checkerboard novelty, snapped to 4-bar phrases, at least 4 bars apart. */
function boundaries(bars: Bar[], S: number[][]): number[] {
  const n = bars.length;
  const R = 4;
  const nov = new Array<number>(n).fill(0);
  for (let b = 1; b < n; b++) {
    let s = 0;
    for (let i = -R; i < R; i++) for (let j = -R; j < R; j++) {
      const x = b + i, y = b + j;
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      const g = Math.exp(-((i + 0.5) ** 2 + (j + 0.5) ** 2) / (2 * (R / 2) ** 2));
      s += (i < 0 === j < 0 ? 1 : -1) * g * S[x]![y]!;
    }
    nov[b] = Math.max(0, s);
  }
  const maxNov = Math.max(...nov) || 1;
  const maxRms = Math.max(...bars.map((b) => b.rms)) || 1;
  const score = nov.map((v, b) => {
    if (b < 2 || b > n - 2) return 0;
    const before = mean(bars.slice(Math.max(0, b - 2), b).map((x) => x.rms));
    const after = mean(bars.slice(b, b + 2).map((x) => x.rms));
    const phrase = b % 4 === 0 ? 0.3 : b % 2 === 0 ? 0.1 : 0;
    return v / maxNov + Math.abs(after - before) / maxRms + phrase;
  });
  const sorted = score.map((s, b) => ({ s, b })).filter((x) => x.s > 0.45).sort((a, b) => b.s - a.s);
  const picked: number[] = [];
  for (const c of sorted) {
    if (c.b < 4 || n - c.b < 2 || picked.some((p) => Math.abs(p - c.b) < 4)) continue;
    picked.push(c.b);
  }
  return picked.sort((a, b) => a - b);
}

/* ---------------- Labels ---------------- */

function label(sections: Omit<SongSection, 'label'>[], vectors: Float32Array[]): SectionLabel[] {
  const n = sections.length;
  const labels: SectionLabel[] = new Array(n).fill('verse');
  const counts = new Map<number, number>();
  for (const s of sections) counts.set(s.cluster, (counts.get(s.cluster) ?? 0) + 1);
  // Chorus: the loudest repeated cluster (or the loudest section when nothing repeats).
  const clusterEnergy = new Map<number, number>();
  for (const s of sections) clusterEnergy.set(s.cluster, Math.max(clusterEnergy.get(s.cluster) ?? 0, s.energy));
  const repeated = [...counts].filter(([, c]) => c > 1).map(([k]) => k);
  const pool = repeated.length ? repeated : [...counts.keys()];
  const chorusCluster = pool.reduce((a, b) => ((clusterEnergy.get(b) ?? 0) > (clusterEnergy.get(a) ?? 0) ? b : a), pool[0]!);
  sections.forEach((s, i) => {
    if (s.cluster === chorusCluster && s.energy >= 0.7) labels[i] = 'chorus';
    else if (s.energy < 0.5 && i > 0 && i < n - 1) labels[i] = 'break';
  });
  // Electronic music: a bass-dominated peak cluster entered from a quiet part is a drop (every occurrence).
  const peaks = sections.filter((_, i) => labels[i] === 'chorus');
  const bassy = peaks.length > 0 && mean(peaks.map((s) => s.bassShare)) >= 0.8;
  const fromQuiet = sections.some((s, i) => labels[i] === 'chorus' && i > 0 && sections[i - 1]!.energy <= 0.55 * s.energy);
  if (bassy && fromQuiet) labels.forEach((l, i) => { if (l === 'chorus') labels[i] = 'drop'; });
  sections.forEach((s, i) => {
    const next = sections[i + 1];
    const peak = next && (labels[i + 1] === 'chorus' || labels[i + 1] === 'drop');
    if (!peak || labels[i] === 'chorus' || labels[i] === 'drop' || s.energy >= next.energy) return;
    // A break leading into a peak is a build-up; a short section between a verse and a peak is a pre-chorus.
    if (labels[i] === 'break') labels[i] = 'build';
    else if (s.end - s.start <= 0.6 * (next.end - next.start) && i > 0) labels[i] = 'prechorus';
  });
  // A section heard once, after the first chorus, that is neither a break nor a peak: bridge.
  const firstChorus = labels.findIndex((l) => l === 'chorus' || l === 'drop');
  sections.forEach((s, i) => {
    if (firstChorus >= 0 && i > firstChorus && labels[i] === 'verse' && counts.get(s.cluster) === 1 && i < n - 1) labels[i] = 'bridge';
  });
  if (n > 1 && sections[0]!.energy < 0.6 && labels[0] !== 'chorus' && labels[0] !== 'drop') labels[0] = 'intro';
  if (n > 2 && sections[n - 1]!.energy < 0.6 * Math.max(...sections.map((s) => s.energy))) labels[n - 1] = 'outro';
  void vectors;
  return labels;
}

/* ---------------- Key ---------------- */

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b);
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += (a[i]! - ma) * (b[i]! - mb);
    aa += (a[i]! - ma) ** 2;
    bb += (b[i]! - mb) ** 2;
  }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

export function detectKey(chroma: ArrayLike<number>): SongAnalysis['key'] {
  const c = Array.from(chroma);
  let best = { tonic: 0, mode: 'major' as 'major' | 'minor', r: -2 }, second = -2;
  for (let t = 0; t < 12; t++) {
    for (const [mode, prof] of [['major', MAJOR], ['minor', MINOR]] as const) {
      const rotated = prof.map((_, i) => prof[(i - t + 12) % 12]!);
      const r = pearson(c, rotated);
      if (r > best.r) { second = best.r; best = { tonic: t, mode, r }; } else if (r > second) second = r;
    }
  }
  return { tonic: best.tonic, mode: best.mode, confidence: Math.max(0, Math.min(1, (best.r - second) * 5)) };
}

/* ---------------- Main ---------------- */

export async function analyzeAudio(samples: Float32Array, sampleRate: number, o: AnalyzeOptions = {}): Promise<SongAnalysis> {
  const f = await extract(samples, sampleRate, o);
  const duration = samples.length / sampleRate;
  const toT = (i: number) => i / f.fr + f.offset;
  const tempo0 = estimateTempo(f.onset, f.fr, o.bpmMin, o.bpmMax);
  const beatFrames = trackBeats(f.onset, (60 * f.fr) / tempo0);
  await o.yieldFn?.();
  o.onProgress?.(0.8);

  // Precise tempo: least-squares slope of beat time against beat index; local tempo per 8 beats for stability.
  const beats = beatFrames.map(toT);
  const idx = beats.map((_, i) => i);
  const mi = mean(idx), mt = mean(beats);
  const slope = beats.reduce((s, t, i) => s + (i - mi) * (t - mt), 0) / (idx.reduce((s, i) => s + (i - mi) ** 2, 0) || 1);
  const bpm = slope > 0 ? 60 / slope : tempo0;
  const local: number[] = [];
  for (let i = 0; i + 8 < beats.length; i += 8) local.push((60 * 8) / (beats[i + 8]! - beats[i]!));
  const tempoStable = local.length < 2 || (Math.max(...local) - Math.min(...local)) / median(local) < 0.03;

  const phase = downbeatPhase(f, beatFrames);
  const downFrames = beatFrames.filter((_, j) => j % 4 === phase);
  const downbeats = downFrames.map(toT);

  // Bars (a leading partial bar is merged into the first one).
  const bars = barFeatures(f, downFrames.length ? [0, ...downFrames.filter((x) => x > 0)] : [0], f.onset.length);
  const S = similarity(bars);
  const cuts = [0, ...boundaries(bars, S), bars.length];
  o.onProgress?.(0.9);

  const maxRms = Math.max(...bars.map((b) => b.rms)) || 1;
  const cMin = Math.min(...bars.map((b) => b.centroid)), cMax = Math.max(...bars.map((b) => b.centroid));
  const raw = cuts.slice(0, -1).map((a, k) => {
    const seg = bars.slice(a, cuts[k + 1]);
    const span = seg[seg.length - 1]!.end - seg[0]!.start;
    const bassE = mean(seg.map((b) => b.bass)), highE = mean(seg.map((b) => b.high));
    return {
      start: k === 0 ? 0 : seg[0]!.start,
      end: k === cuts.length - 2 ? duration : seg[seg.length - 1]!.end,
      cluster: 0,
      energy: mean(seg.map((b) => b.rms)) / maxRms,
      brightness: cMax > cMin ? (mean(seg.map((b) => b.centroid)) - cMin) / (cMax - cMin) : 0.5,
      density: seg.reduce((s, b) => s + b.onsets, 0) / Math.max(0.1, span),
      bassShare: bassE + highE > 0 ? bassE / (bassE + highE) : 0.5,
      vector: Float32Array.from([...avgVec(seg.map((b) => b.chroma), 0, seg.length, 12), ...avgVec(seg.map((b) => b.bands), 0, seg.length, N_BANDS).map((v) => v / 10)]),
    };
  });
  // Repetition clusters on mean-centred vectors (raw spectra all look alike), greedy assignment to a representative.
  // Comparable blocks: unit chroma, z-scored timbre, plus loudness / bass share / density (same chords at different
  // energies are different parts of the song).
  const unit = (v: Float32Array) => { const m = Math.hypot(...v) || 1; return v.map((x) => x / m); };
  const timbre = raw.map((s) => s.vector.subarray(12));
  const tMean = avgVec(timbre, 0, timbre.length, N_BANDS);
  const tSd = Float32Array.from(tMean, (m, d) => Math.sqrt(mean(timbre.map((v) => (v[d]! - m) ** 2))) || 1);
  const full = raw.map((s, i) => Float32Array.from([
    ...unit(s.vector.subarray(0, 12)),
    ...timbre[i]!.map((v, d) => (v - tMean[d]!) / tSd[d]! / Math.sqrt(N_BANDS)),
    s.energy, s.bassShare, Math.min(4, s.density) / 4,
  ]));
  const centre = avgVec(full, 0, full.length, full[0]!.length);
  const centred = full.map((v) => v.map((x, d) => x - centre[d]!));
  const reps: Float32Array[] = [];
  raw.forEach((s, i) => {
    let c = reps.findIndex((r) => cosine(r, centred[i]!) > 0.9);
    if (c < 0) { reps.push(centred[i]!); c = reps.length - 1; }
    s.cluster = c;
  });
  const labels = label(raw, raw.map((s) => s.vector));
  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  const sections: SongSection[] = raw.map((s, i) => ({
    start: s.start, end: s.end, label: labels[i]!, cluster: s.cluster,
    energy: clamp01(s.energy), brightness: clamp01(s.brightness), density: Math.min(50, s.density), bassShare: clamp01(s.bassShare),
  }));

  // Events.
  const events: SongAnalysis['events'] = [];
  const peakRms = Math.max(...f.rms) || 1;
  for (let i = 0, start = -1; i <= f.rms.length; i++) {
    const quiet = i < f.rms.length && f.rms[i]! < 0.02 * peakRms;
    if (quiet && start < 0) start = i;
    if (!quiet && start >= 0) {
      if ((i - start) / f.fr >= 0.5) events.push({ t: toT(start), kind: 'silence', duration: (i - start) / f.fr });
      start = -1;
    }
  }
  // Impacts: strong onsets after which the level stays clearly higher than during the previous 1.5 s.
  const wb = Math.round(f.fr * 1.5), wa = Math.round(f.fr);
  for (let i = wb; i < f.onset.length - wa; i++) {
    if (f.onset[i]! < 4 || f.onset[i]! < near(f.onset, i, 3)) continue;
    const before = mean(f.rms.subarray(i - wb, i)), after = mean(f.rms.subarray(i, i + wa));
    if (after > 1.8 * before && after > 0.3 * peakRms && !events.some((e) => e.kind === 'impact' && Math.abs(e.t - toT(i)) < 2)) events.push({ t: toT(i), kind: 'impact', duration: 0 });
  }
  for (let k = 1; k < cuts.length - 1; k++) {
    const b = cuts[k]!;
    if (sections[k]!.energy <= sections[k - 1]!.energy) continue;
    // Rising high band over the bars before a louder section.
    let len = 0;
    while (b - len - 2 >= cuts[k - 1]! && bars[b - len - 1]!.high > bars[b - len - 2]!.high) len++;
    // At least 2 rising bars and a clear rise (log energy +0.5 ≈ ×1.65).
    if (len >= 2 && bars[b - 1]!.high - bars[b - len - 1]!.high > 0.5) events.push({ t: bars[b - len - 1]!.start, kind: 'riser', duration: bars[b]!.start - bars[b - len - 1]!.start });
  }
  events.sort((a, b) => a.t - b.t);

  const totalChroma = avgVec(f.chroma, 0, f.chroma.length, 12);
  o.onProgress?.(1);
  return {
    version: 1,
    duration,
    bpm: Math.round(bpm * 100) / 100,
    tempoStable,
    beats: beats.map((t) => Math.round(t * 1000) / 1000),
    downbeats: downbeats.map((t) => Math.round(t * 1000) / 1000),
    sections,
    key: detectKey(totalChroma),
    events: events.slice(0, 2000),
  };
}

export const KEY_NAMES = ['Do', 'Do♯', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa♯', 'Sol', 'La♭', 'La', 'Si♭', 'Si'];
export const SECTION_NAMES: Record<SectionLabel, string> = {
  intro: 'Intro', verse: 'Couplet', prechorus: 'Pré-refrain', build: 'Montée', chorus: 'Refrain', drop: 'Drop', break: 'Break', bridge: 'Pont', outro: 'Outro',
};
