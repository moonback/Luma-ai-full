import { TempoTracker } from '../music/tempoTracker';
import { DropPredictor, type Prediction } from '../music/dropPredictor';

/**
 * Audio feature extraction from per-hop measurements (RMS + low/high band energy).
 * Pure and deterministic: the renderer feeds frames from the Web Audio API, tests feed synthetic frames.
 * Tempo and beats come from the autocorrelation tracker (TempoTracker); "energy rise" is an energy ratio. All are
 * ESTIMATES from the live signal.
 */

export interface AudioFrame {
  /** seconds */
  t: number;
  /** RMS of the time-domain block, 0..1 */
  rms: number;
  /** mean low-band (≈ <150 Hz) magnitude, 0..1 */
  bass: number;
  /** mean high-band (≈ >4 kHz) magnitude, 0..1 (optional for older callers) */
  high?: number;
}

export interface AudioFeatures {
  t: number;
  level: number; // 0..1 after sensitivity
  levelDb: number;
  energy: number; // smoothed 0..1
  onset: boolean;
  onsetStrength: number;
  bpm: number | null;
  bpmConfidence: number; // 0..1
  energyRise: boolean;
  /** True on the frame following a tracked beat. */
  beat: boolean;
  /** 0 = downbeat … 3; null while no tempo is tracked. */
  barPosition: number | null;
  tempoLocked: boolean;
  /** Smoothed band levels 0..1 and onset density (0..1 ≈ 0..8 onsets/s) for the band followers. */
  bass: number;
  brightness: number;
  onsetDensity: number;
  /** Predicted drop / chorus (estimate), or null. */
  prediction: Prediction | null;
}

export interface AnalyzerOptions {
  sensitivity: number;
  smoothing: number; // 0..1
  onsetThreshold: number; // multiple of the adaptive mean
  riseRatio: number;
  bpmRange?: { min: number; max: number };
}

export class AudioAnalyzer {
  private prevBass = 0;
  private novelty: { t: number; v: number }[] = [];
  private onsets: number[] = [];
  private lastOnset = -Infinity;
  private energy = 0;
  private shortE = 0;
  private longE = 0;
  private riseArmed = true;
  private lastT: number | null = null;
  private prevHigh = 0;
  private bassS = 0;
  private brightS = 0;
  private highS = 0;
  readonly tempo: TempoTracker;
  readonly predictor = new DropPredictor();

  constructor(public opts: AnalyzerOptions) {
    this.tempo = new TempoTracker(opts.bpmRange);
  }

  configure(opts: AnalyzerOptions): void {
    this.opts = opts;
    if (opts.bpmRange) this.tempo.setRange(opts.bpmRange);
  }

  push(f: AudioFrame): AudioFeatures {
    const dt = this.lastT === null ? 1 / 60 : Math.max(1e-3, f.t - this.lastT);
    this.lastT = f.t;
    const level = Math.min(1, f.rms * this.opts.sensitivity * 2);
    const levelDb = f.rms > 0 ? 20 * Math.log10(f.rms) : -120;
    const a = Math.min(0.99, Math.max(0, this.opts.smoothing));
    this.energy = this.energy * a + level * (1 - a);

    // Onset detection: positive low-band flux above an adaptive (1 s) mean.
    const nov = Math.max(0, f.bass - this.prevBass);
    this.prevBass = f.bass;
    const high = f.high ?? 0;
    const highNov = Math.max(0, high - this.prevHigh);
    this.prevHigh = high;
    const tempo = this.tempo.push(f.t, nov + 0.5 * highNov, nov);
    const k = Math.min(1, dt / 0.15);
    this.bassS += (f.bass - this.bassS) * k;
    this.highS += (high - this.highS) * k;
    if (tempo.beat && tempo.bpm) this.predictor.onBeat({ t: f.t, bass: this.bassS, high: this.highS, level }, 60 / tempo.bpm);
    this.brightS += ((f.bass + high > 0.01 ? high / (f.bass + high) : this.brightS) - this.brightS) * Math.min(1, dt / 0.5);
    this.novelty.push({ t: f.t, v: nov });
    while (this.novelty.length && this.novelty[0]!.t < f.t - 1) this.novelty.shift();
    const mean = this.novelty.reduce((s, x) => s + x.v, 0) / this.novelty.length;
    const threshold = mean * this.opts.onsetThreshold + 0.01 / this.opts.sensitivity;
    const onset = nov > threshold && f.t - this.lastOnset > 0.1;
    if (onset) {
      this.lastOnset = f.t;
      this.onsets.push(f.t);
    }
    while (this.onsets.length && this.onsets[0]! < f.t - 8) this.onsets.shift();

    // Energy rise: short (0.5 s) vs long (8 s) energy, with hysteresis.
    this.shortE += (level - this.shortE) * Math.min(1, dt / 0.5);
    this.longE += (level - this.longE) * Math.min(1, dt / 8);
    const ratio = this.longE > 0.01 ? this.shortE / this.longE : 0;
    let energyRise = false;
    if (this.riseArmed && ratio > this.opts.riseRatio && this.shortE > 0.1) {
      energyRise = true;
      this.riseArmed = false;
    } else if (ratio < 1.1) this.riseArmed = true;

    const recent = this.onsets.filter((x) => x > f.t - 4).length;
    return {
      t: f.t, level, levelDb, energy: this.energy, onset, onsetStrength: threshold > 0 ? nov / threshold : 0,
      bpm: tempo.bpm, bpmConfidence: tempo.confidence, energyRise,
      beat: tempo.beat, barPosition: tempo.barPosition, tempoLocked: tempo.locked,
      bass: Math.min(1, this.bassS), brightness: Math.min(1, this.brightS), onsetDensity: Math.min(1, recent / 4 / 8),
      prediction: this.predictor.at(f.t),
    };
  }
}

/** Synthetic kick-drum track for tests and the "simulated source" mode. */
export function simulateFrames(opts: { bpm: number; seconds: number; fps?: number; seed?: number; level?: number; hats?: boolean; offbeatAccent?: boolean }): AudioFrame[] {
  const fps = opts.fps ?? 60;
  const frames: AudioFrame[] = [];
  const beat = 60 / opts.bpm;
  let s = opts.seed ?? 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const lvl = opts.level ?? 0.5;
  for (let i = 0; i < opts.seconds * fps; i++) {
    const t = i / fps;
    const sinceBeat = t % beat;
    const kick = Math.exp(-sinceBeat * 18);
    const offbeat = opts.offbeatAccent ? Math.exp(-((t + beat / 2) % beat) * 18) : 0;
    const hat = opts.hats ? Math.exp(-((t * 2) % beat) * 40) * 0.5 : 0;
    frames.push({
      t,
      rms: lvl * (0.35 + 0.65 * kick) + rnd() * 0.02,
      bass: Math.min(1, (opts.offbeatAccent ? 0.3 : 0.9) * kick + 0.9 * offbeat + rnd() * 0.03),
      high: Math.min(1, hat + rnd() * 0.02),
    });
  }
  return frames;
}
