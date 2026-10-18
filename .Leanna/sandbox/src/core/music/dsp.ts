/**
 * Signal processing for music analysis: in-place radix-2 FFT and per-frame features (log band energies, spectral
 * flux, chroma, brightness). Pure TypeScript so it runs in the renderer, in tests and later in a worker.
 */

/** In-place iterative radix-2 FFT. `re`/`im` length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export const N_BANDS = 24;
const BAND_LO = 40, BAND_HI = 11000;
export const BASS_MAX_HZ = 150;
export const HIGH_MIN_HZ = 4000;

export interface FrameFeatures {
  rms: number;
  /** log(1 + energy) per log-spaced band (40 Hz – 11 kHz). */
  bands: Float32Array;
  chroma: Float32Array;
  /** Spectral centroid in Hz. */
  centroid: number;
  /** log(1 + energy) below 150 Hz / above 4 kHz. */
  bass: number;
  high: number;
}

/** Precomputed analysis plan for a frame size and sample rate. */
export class Spectrum {
  readonly window: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly bandOf: Int16Array;
  private readonly pitchOf: Int8Array;
  private readonly bassMax: number;
  private readonly highMin: number;

  constructor(readonly size: number, readonly sampleRate: number) {
    this.window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    const half = size / 2;
    const hz = (k: number) => (k * sampleRate) / size;
    this.bandOf = Int16Array.from({ length: half }, (_, k) => {
      const f = hz(k);
      if (f < BAND_LO || f >= BAND_HI) return -1;
      return Math.min(N_BANDS - 1, Math.floor((Math.log(f / BAND_LO) / Math.log(BAND_HI / BAND_LO)) * N_BANDS));
    });
    this.pitchOf = Int8Array.from({ length: half }, (_, k) => {
      const f = hz(k);
      if (f < 55 || f > 5000) return -1;
      return ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12; // 0 = C
    });
    this.bassMax = Math.ceil((BASS_MAX_HZ * size) / sampleRate);
    this.highMin = Math.floor((HIGH_MIN_HZ * size) / sampleRate);
  }

  /** Features of `samples[offset .. offset+size)` (zero-padded past the end). */
  frame(samples: ArrayLike<number>, offset: number): FrameFeatures {
    const { size, re, im } = this;
    let sq = 0;
    for (let i = 0; i < size; i++) {
      const s = samples[offset + i] ?? 0;
      sq += s * s;
      re[i] = s * this.window[i]!;
      im[i] = 0;
    }
    fft(re, im);
    const bands = new Float32Array(N_BANDS);
    const chroma = new Float32Array(12);
    let total = 0, weighted = 0, bass = 0, high = 0;
    for (let k = 1; k < size / 2; k++) {
      const p = re[k]! * re[k]! + im[k]! * im[k]!;
      const mag = Math.sqrt(p);
      total += mag;
      weighted += mag * k;
      const b = this.bandOf[k]!;
      if (b >= 0) bands[b] = bands[b]! + p;
      const c = this.pitchOf[k]!;
      if (c >= 0) chroma[c] = chroma[c]! + mag;
      if (k <= this.bassMax) bass += p;
      if (k >= this.highMin) high += p;
    }
    for (let b = 0; b < N_BANDS; b++) bands[b] = Math.log1p(bands[b]!);
    return {
      rms: Math.sqrt(sq / size),
      bands,
      chroma,
      centroid: total > 0 ? ((weighted / total) * this.sampleRate) / size : 0,
      bass: Math.log1p(bass),
      high: Math.log1p(high),
    };
  }
}

/** Positive spectral flux between two log-band vectors (onset strength). */
export function spectralFlux(prev: Float32Array | null, cur: Float32Array): number {
  if (!prev) return 0;
  let s = 0;
  for (let i = 0; i < cur.length; i++) s += Math.max(0, cur[i]! - prev[i]!);
  return s;
}

export const mean = (xs: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return xs.length ? s / xs.length : 0;
};

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

export function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
