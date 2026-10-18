/**
 * Minimal image processing for fixture detection: grayscale frames (0..1), difference against the dark reference,
 * 3×3 box blur, thresholding, 4-connected components with intensity-weighted centroids.
 */
export interface Gray {
  width: number;
  height: number;
  data: Float32Array;
}

export interface Blob {
  x: number;
  y: number;
  area: number;
  peak: number;
  /** Pixel indices of the component (used to measure the blob in every frame). */
  pixels: Int32Array;
}

export const gray = (width: number, height: number, data = new Float32Array(width * height)): Gray => ({ width, height, data });

/** RGBA bytes (canvas ImageData) → grayscale luminance 0..1. */
export function fromRgba(rgba: ArrayLike<number>, width: number, height: number): Gray {
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = (0.2126 * rgba[i * 4]! + 0.7152 * rgba[i * 4 + 1]! + 0.0722 * rgba[i * 4 + 2]!) / 255;
  return gray(width, height, data);
}

/** Mean of several frames (camera noise). */
export function average(frames: Gray[]): Gray {
  const out = gray(frames[0]!.width, frames[0]!.height);
  for (const f of frames) for (let i = 0; i < out.data.length; i++) out.data[i] = out.data[i]! + f.data[i]! / frames.length;
  return out;
}

/** max(0, a − b). */
export function difference(a: Gray, b: Gray): Gray {
  const out = gray(a.width, a.height);
  for (let i = 0; i < out.data.length; i++) out.data[i] = Math.max(0, a.data[i]! - b.data[i]!);
  return out;
}

export function blur3(img: Gray): Gray {
  const { width: w, height: h, data } = img;
  const out = gray(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        s += data[yy * w + xx]!;
        n++;
      }
      out.data[y * w + x] = s / n;
    }
  }
  return out;
}

/**
 * Bright blobs of `img` above `threshold` (absolute, 0..1). Components smaller than `minArea` or larger than
 * `maxArea` pixels are ignored (noise, reflections of a whole wall).
 */
export function detectBlobs(img: Gray, threshold: number, minArea = 3, maxArea = Infinity): Blob[] {
  const { width: w, height: h, data } = img;
  const seen = new Uint8Array(w * h);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  for (let start = 0; start < data.length; start++) {
    if (seen[start] || data[start]! < threshold) continue;
    const pixels: number[] = [];
    let sx = 0, sy = 0, sw = 0, peak = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      pixels.push(i);
      const v = data[i]!, x = i % w, y = (i / w) | 0;
      sx += x * v; sy += y * v; sw += v;
      if (v > peak) peak = v;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !seen[j] && data[j]! >= threshold) { seen[j] = 1; stack.push(j); }
      }
    }
    if (pixels.length >= minArea && pixels.length <= maxArea) blobs.push({ x: sx / sw, y: sy / sw, area: pixels.length, peak, pixels: Int32Array.from(pixels) });
  }
  return blobs;
}

/** Mean value of `img` over a blob's pixels. */
export function blobMean(img: Gray, blob: Blob): number {
  let s = 0;
  for (const i of blob.pixels) s += img.data[i]!;
  return s / blob.pixels.length;
}

/**
 * Automatic threshold from the noise of a difference image: median + 8 × robust σ (MAD), at least `floor`, at most
 * half the brightest value (so dim, distant fixtures are not lost next to a bright close one).
 */
export function autoThreshold(img: Gray, floor = 0.04): number {
  const n = img.data.length;
  const step = Math.max(1, Math.floor(n / 20000));
  const sample: number[] = [];
  let max = 0;
  for (let i = 0; i < n; i++) {
    const v = img.data[i]!;
    if (v > max) max = v;
    if (i % step === 0) sample.push(v);
  }
  sample.sort((a, b) => a - b);
  const med = sample[sample.length >> 1]!;
  const mad = sample.map((v) => Math.abs(v - med)).sort((a, b) => a - b)[sample.length >> 1]!;
  return Math.min(Math.max(floor, med + 8 * 1.4826 * mad), Math.max(floor, max / 2));
}
