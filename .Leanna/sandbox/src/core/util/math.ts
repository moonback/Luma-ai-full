export const clamp = (v: number, min = 0, max = 1): number => (v < min ? min : v > max ? max : v);
export const clamp01 = (v: number): number => (Number.isFinite(v) ? clamp(v, 0, 1) : 0);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export type CurveName = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'snap';
export const CURVES: Record<CurveName, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  snap: (t) => (t > 0 ? 1 : 0),
};

/** Deterministic PRNG (mulberry32). Same seed => same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stateless hash -> [0,1). Used for random effects that must be reproducible for any time t. */
export function hash01(...parts: number[]): number {
  let h = 2166136261;
  for (const p of parts) {
    h ^= Math.floor(p) >>> 0;
    h = Math.imul(h, 16777619);
  }
  return mulberry32(h)();
}

export interface Rgb { r: number; g: number; b: number } // each 0..1

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m || !m[1]) throw new Error(`Couleur invalide: ${hex}`);
  const n = parseInt(m[1], 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const h = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** h in [0,1), s,v in [0,1] */
export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const hh = ((h % 1) + 1) % 1 * 6;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  const table: [number, number, number][] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]];
  const [r, g, b] = table[i % 6] ?? [v, t, p];
  return { r, g, b };
}

export function rgbToHsv({ r, g, b }: Rgb): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
