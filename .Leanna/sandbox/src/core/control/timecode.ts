import type { Timecode } from './midi';

/** LTC sync word, bits 64–79 in transmission order. */
const SYNC = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1];

/**
 * Linear Timecode (SMPTE 12M) decoder working on raw audio samples. Biphase-mark: every bit cell starts with a
 * transition, a "1" has an extra transition mid-cell. The bit period is tracked adaptively, so 24–30 fps and slight
 * speed variations are accepted. Forward playback only.
 */
export class LtcDecoder {
  private last = 0;
  private sinceEdge = 0;
  private period: number;
  private halfPending = false;
  private readonly bits: number[] = [];

  constructor(private readonly sampleRate: number) {
    this.period = sampleRate / (80 * 27); // start between 24 and 30 fps
  }

  /** Feeds samples; returns the frames completed in this block. */
  push(samples: ArrayLike<number>): Timecode[] {
    const out: Timecode[] = [];
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      this.sinceEdge++;
      // Zero crossing with a small hysteresis against noise.
      const level = s > 0.02 ? 1 : s < -0.02 ? -1 : 0;
      if (level === 0 || level === this.last) continue;
      const wasSet = this.last !== 0;
      this.last = level;
      if (!wasSet) continue;
      const tc = this.edge(this.sinceEdge);
      this.sinceEdge = 0;
      if (tc) out.push(tc);
    }
    return out;
  }

  private edge(interval: number): Timecode | null {
    if (interval < this.period * 0.75) {
      this.period = this.period * 0.95 + interval * 2 * 0.05;
      if (!this.halfPending) {
        this.halfPending = true;
        return null;
      }
      this.halfPending = false;
      return this.bit(1);
    }
    this.period = this.period * 0.95 + interval * 0.05;
    this.halfPending = false;
    return this.bit(0);
  }

  private bit(b: number): Timecode | null {
    this.bits.push(b);
    if (this.bits.length > 80) this.bits.shift();
    if (this.bits.length < 80 || !SYNC.every((v, i) => this.bits[64 + i] === v)) return null;
    const f = this.bits;
    const n = (from: number, count: number) => { let v = 0; for (let i = 0; i < count; i++) v |= f[from + i]! << i; return v; };
    const fps = [24, 25, 30].reduce((best, x) => (Math.abs(this.sampleRate / (80 * this.period) - x) < Math.abs(this.sampleRate / (80 * this.period) - best) ? x : best), 25);
    return {
      frames: n(0, 4) + 10 * n(8, 2),
      seconds: n(16, 4) + 10 * n(24, 3),
      minutes: n(32, 4) + 10 * n(40, 3),
      hours: n(48, 4) + 10 * n(56, 2),
      fps: fps === 30 && f[10] ? 29.97 : fps,
    };
  }
}

/** Test/loopback helper: the 80 bits of one LTC frame, transmission order. */
export function ltcFrameBits(t: Timecode): number[] {
  const bits = new Array<number>(80).fill(0);
  const put = (from: number, count: number, v: number) => { for (let i = 0; i < count; i++) bits[from + i] = (v >> i) & 1; };
  put(0, 4, t.frames % 10); put(8, 2, Math.floor(t.frames / 10));
  put(16, 4, t.seconds % 10); put(24, 3, Math.floor(t.seconds / 10));
  put(32, 4, t.minutes % 10); put(40, 3, Math.floor(t.minutes / 10));
  put(48, 4, t.hours % 10); put(56, 2, Math.floor(t.hours / 10));
  if (t.fps === 29.97) bits[10] = 1;
  SYNC.forEach((v, i) => (bits[64 + i] = v));
  return bits;
}

/** Biphase-mark encodes LTC bits into audio samples (generator for tests and loopback checks). */
export function encodeLtc(bits: readonly number[], sampleRate: number, fps: number, start = 1): { samples: Float32Array; level: number } {
  const per = sampleRate / (80 * fps);
  const samples = new Float32Array(Math.round(bits.length * per));
  let level = start, pos = 0;
  bits.forEach((b, i) => {
    const end = Math.round((i + 1) * per);
    const mid = Math.round((i + 0.5) * per);
    level = -level;
    for (; pos < end; pos++) {
      if (b && pos === mid) level = -level;
      samples[pos] = level * 0.5;
    }
  });
  return { samples, level };
}
