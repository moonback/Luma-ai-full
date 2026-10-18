import { estimateTempo } from './analyze';

/**
 * Live tempo and beat tracker. The onset strength is resampled on a fixed 50 Hz grid (8 s window); every 0.25 s the
 * tempo is re-estimated with the same autocorrelation comb as the file analysis, restricted to the genre range (no
 * octave errors outside it), and smoothed by a scalar Kalman filter that rejects isolated outliers. The beat phase is
 * the comb phase over the last 4 s, optionally corrected by a tap on the downbeat. Downbeats come from the beat
 * position (mod 4) with the strongest bass accents.
 */
export interface TempoState {
  bpm: number | null;
  confidence: number;
  /** True on the first frame after a beat. */
  beat: boolean;
  nextBeatAt: number | null;
  beatIndex: number;
  /** Position in the bar, 0 = downbeat; null until a tempo is known. */
  barPosition: number | null;
  /** Tempo stable for at least 1 s with good confidence. */
  locked: boolean;
}

const RATE = 50;
const WINDOW = 8 * RATE;
const MIN_DATA = 3 * RATE;

export class TempoTracker {
  private readonly env = new Float32Array(WINDOW);
  /** Bass (kick) novelty: defines the beat when present. */
  private readonly bassEnv = new Float32Array(WINDOW);
  private filled = 0;
  private gridT: number | null = null; // time of the newest grid slot
  private lastEstimate = -Infinity;
  private x: number | null = null; // Kalman state (BPM)
  private p = 100;
  private outliers = 0;
  private candidate = 0;
  private maxBassEnergy = 0;
  private confidence = 0;
  private lastBeat: number | null = null;
  private nextBeat: number | null = null;
  private beatIndex = 0;
  private phaseBias = 0; // seconds added to the comb phase (tap correction)
  private readonly accents = [0, 0, 0, 0];
  private downbeatPhase = 0;
  private lockedSince: number | null = null;
  private pendingAccent = 0;

  constructor(private range: { min: number; max: number } = { min: 70, max: 180 }) {}

  setRange(r: { min: number; max: number }): void {
    this.range = r;
    if (this.x !== null && (this.x < r.min || this.x > r.max)) this.x = null;
  }

  /** `strength`: onset novelty of this frame (≥ 0); `accent`: bass novelty used to find downbeats. */
  push(t: number, strength: number, accent = strength): TempoState {
    this.advanceGrid(t, Math.max(0, strength), Math.max(0, accent));
    this.pendingAccent = Math.max(this.pendingAccent, accent);
    if (this.filled >= MIN_DATA && t - this.lastEstimate >= 0.25) {
      this.lastEstimate = t;
      this.estimate(t);
    }
    let beat = false;
    if (this.nextBeat !== null && this.x !== null && t >= this.nextBeat) {
      beat = true;
      this.beatIndex++;
      const k = this.beatIndex % 4;
      for (let i = 0; i < 4; i++) this.accents[i]! *= 0.97;
      this.accents[k] = this.accents[k]! + this.pendingAccent;
      this.pendingAccent = 0;
      let best = 0;
      for (let i = 1; i < 4; i++) if (this.accents[i]! > this.accents[best]!) best = i;
      this.downbeatPhase = best;
      this.lastBeat = this.nextBeat;
      const period = 60 / this.x;
      this.nextBeat += period;
      if (this.nextBeat < t) this.nextBeat = t + period; // after a stall
    }
    const locked = this.lockedSince !== null && t - this.lockedSince >= 1;
    return {
      bpm: this.x === null ? null : Math.round(this.x * 10) / 10,
      confidence: this.confidence,
      beat,
      nextBeatAt: this.nextBeat,
      beatIndex: this.beatIndex,
      barPosition: this.x === null ? null : (((this.beatIndex - this.downbeatPhase) % 4) + 4) % 4,
      locked,
    };
  }

  /**
   * Tap on a downbeat: the beat grid is shifted so a beat falls at `t` and that beat becomes "1" of the bar.
   * The tempo estimate is kept.
   */
  tap(t: number): void {
    if (this.x === null || this.nextBeat === null) return;
    const period = 60 / this.x;
    let d = (t - this.nextBeat) % period;
    if (d > period / 2) d -= period;
    if (d < -period / 2) d += period;
    this.phaseBias += d;
    this.nextBeat += d;
    if (this.nextBeat <= t) this.nextBeat += period;
    // The beat at `t` was index beatIndex (the next one is beatIndex + 1): make it the downbeat.
    this.downbeatPhase = ((this.beatIndex % 4) + 4) % 4;
    this.accents.fill(0);
    this.accents[this.downbeatPhase] = 10;
  }

  private advanceGrid(t: number, v: number, bass: number): void {
    if (this.gridT === null) this.gridT = t;
    const steps = Math.min(WINDOW, Math.floor((t - this.gridT) * RATE));
    if (steps > 0) {
      for (const e of [this.env, this.bassEnv]) {
        e.copyWithin(0, steps);
        e.fill(0, WINDOW - steps);
      }
      this.gridT += steps / RATE;
      this.filled = Math.min(WINDOW, this.filled + steps);
    }
    this.env[WINDOW - 1] = Math.max(this.env[WINDOW - 1]!, v);
    this.bassEnv[WINDOW - 1] = Math.max(this.bassEnv[WINDOW - 1]!, bass);
  }

  private estimate(t: number): void {
    // Remove the mean so silence-to-sound transitions do not dominate the autocorrelation.
    const prep = (src: Float32Array) => {
      const d = src.subarray(WINDOW - this.filled);
      const m = d.reduce((s, x) => s + x, 0) / d.length;
      // Light [¼ ½ ¼] blur: frames arrive at the display rate, not on the grid, so single-slot peaks jitter.
      return d.map((x, i) => Math.max(0, 0.5 * x + 0.25 * (d[i - 1] ?? x) + 0.25 * (d[i + 1] ?? x) - m));
    };
    const all = prep(this.env), bass = prep(this.bassEnv);
    const energy = (e: Float32Array) => e.reduce((s, x) => s + x * x, 0);
    // The kick defines the beat when there is one (a real kick, not residual noise: at least a quarter of the recent
    // maximum); the full-band envelope covers breakdowns without bass.
    const eb = energy(bass);
    this.maxBassEnergy = Math.max(eb, this.maxBassEnergy * 0.995);
    const useBass = eb > 0.25 * this.maxBassEnergy && eb > 0.2 * energy(all);
    const env = useBass ? bass : all;
    const z = estimateTempo(env, RATE, this.range.min, this.range.max, useBass);
    this.confidence = combConfidence(env, z);
    if (this.confidence < 0.15) return;
    if (!useBass && this.x !== null) return; // no kick (breakdown): keep the tempo and the grid running
    // Kalman update with outlier rejection (a tempo change must be confirmed 3 times in a row).
    if (this.x === null) {
      this.x = z;
      this.p = 4;
    } else if (Math.abs(z - this.x) / this.x > 0.06) {
      // A tempo change must be confirmed by 3 estimates that agree with each other (not just 3 random outliers,
      // as happens in a breakdown without rhythm).
      if (this.outliers > 0 && Math.abs(z - this.candidate) / this.candidate > 0.04) this.outliers = 0;
      this.candidate = z;
      if (++this.outliers >= 3) {
        this.x = z;
        this.p = 4;
        this.outliers = 0;
        this.lockedSince = null;
      }
      return;
    } else {
      this.outliers = 0;
      this.p += 0.05;
      const r = 0.5 + (1 - this.confidence) * 8;
      const k = this.p / (this.p + r);
      this.x += k * (z - this.x);
      this.p *= 1 - k;
    }
    if (this.confidence >= 0.4) this.lockedSince ??= t;
    else this.lockedSince = null;
    // Re-phase only on a clear kick pulse; in breakdowns the grid keeps running on its own (flywheel).
    if (this.nextBeat !== null && (!useBass || this.confidence < 0.4)) return;
    // Phase: comb over the last 4 s, newest beats weighted more.
    const period = (60 / this.x) * RATE;
    const span = Math.min(env.length, 4 * RATE);
    let best = 0, bestScore = -1;
    for (let ph = 0; ph < period; ph += 0.5) {
      let s = 0;
      for (let pos = env.length - 1 - ph, w = 1; pos >= env.length - span; pos -= period, w *= 0.9) s += w * (env[Math.round(pos)] ?? 0);
      if (s > bestScore) { bestScore = s; best = ph; }
    }
    const lastBeatT = this.gridT! - best / RATE + this.phaseBias;
    const periodS = 60 / this.x;
    let next = lastBeatT;
    while (next <= t) next += periodS;
    if (this.nextBeat === null) {
      this.nextBeat = next;
      return;
    }
    // Gradual phase correction (half the error per update): beats are never skipped or doubled.
    const err = ((next - this.nextBeat + periodS * 1.5) % periodS) - periodS / 2;
    if (Math.abs(err) > 0.03 * periodS) this.nextBeat += err / 2;
  }
}

/** Peak-to-mean ratio of the comb at the chosen tempo, mapped to 0..1. */
function combConfidence(env: Float32Array, bpm: number): number {
  const lag = (60 * RATE) / bpm;
  const ac = (l: number) => {
    let s = 0;
    const L = Math.round(l);
    for (let i = L; i < env.length; i++) s += env[i]! * env[i - L]!;
    return s / Math.max(1, env.length - L);
  };
  const peak = ac(lag);
  let base = 0;
  for (const f of [0.37, 0.63, 1.37, 1.63]) base += ac(lag * f) / 4;
  const e0 = ac(0.0001) || 1;
  return Math.max(0, Math.min(1, ((peak - base) / e0) * 2));
}
