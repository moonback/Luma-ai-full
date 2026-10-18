import type { Effect, FixtureValues } from '../model/schemas';
import { colorCells, colorToAttributes } from '../fixtures/color';
import type { ResolvedFixture } from '../fixtures/profiles';
import { clamp01, hash01, hexToRgb, hsvToRgb, lerp, type Rgb } from '../util/math';

const TAU = Math.PI * 2;
const DEFAULT_COLORS = ['#FF0040', '#00FF80', '#2060FF'];

/** Cycles per second for an effect, honouring BPM sync and the strobe safety limit. */
export function effectRate(effect: Effect, bpm: number, maxStrobeHz: number): number {
  const p = effect.params;
  let rate = p.bpmSync ? bpm / 60 / p.beatsPerCycle : p.speed;
  if (effect.type === 'strobe') rate = Math.min(rate, maxStrobeHz);
  return rate;
}

function fixturePhase(effect: Effect, phase: number, i: number, n: number): number {
  const { phaseSpread, direction } = effect.params;
  let idx = i;
  if (direction === 'pingpong') {
    const half = Math.ceil(n / 2);
    idx = i < half ? i : n - 1 - i;
  }
  const offset = n > 0 ? (phaseSpread * idx) / n : 0;
  return direction === 'reverse' ? phase + offset : phase - offset;
}

const frac = (x: number) => x - Math.floor(x);
const smooth = (t: number) => t * t * (3 - 2 * t);

function range(effect: Effect): [number, number] {
  const { offset, amplitude } = effect.params;
  return [clamp01(offset - amplitude / 2), clamp01(offset + amplitude / 2)];
}

function colorAt(colors: readonly string[], t: number): Rgb {
  const list = (colors.length ? colors : DEFAULT_COLORS).map(hexToRgb);
  const x = frac(t) * list.length;
  const k = Math.floor(x);
  const a = list[k % list.length]!;
  const b = list[(k + 1) % list.length]!;
  const u = smooth(x - k);
  return { r: lerp(a.r, b.r, u), g: lerp(a.g, b.g, u), b: lerp(a.b, b.b, u) };
}

/**
 * Pure function: effect output for `phase` (cycles elapsed since start). Deterministic for a given input,
 * random effects use a seeded hash so the same seed/phase always yields the same values.
 */
export function computeEffect(effect: Effect, phase: number, targets: readonly ResolvedFixture[]): FixtureValues {
  const out: FixtureValues = {};
  const n = targets.length;
  const [lo, hi] = range(effect);
  const p = effect.params;
  const isReverse = p.direction === 'reverse';

  // Colour effects run per pixel: every cell of a multi-cell fixture is its own element in the phase spread.
  if (effect.type === 'rainbow' || effect.type === 'colorCycle') {
    const elements = targets.flatMap((rf) => {
      const cells = colorCells(rf);
      return cells.length ? cells.map((cell) => ({ rf, cell })) : [{ rf, cell: undefined as number | undefined }];
    });
    elements.forEach(({ rf, cell }, i) => {
      const ph = fixturePhase(effect, phase, i, elements.length);
      const rgb = effect.type === 'rainbow' ? hsvToRgb(frac(ph), 1, 1) : colorAt(p.colors, ph);
      const vals = colorToAttributes(rf, rgb, cell);
      if (Object.keys(vals).length) out[rf.fixture.id] = { ...(out[rf.fixture.id] ?? {}), ...vals };
    });
    return out;
  }

  targets.forEach((rf, i) => {
    const has = (a: string) => rf.attributes.includes(a);
    const ph = fixturePhase(effect, phase, i, n);
    const f = frac(ph);
    const set: Record<string, number> = {};
    switch (effect.type) {
      case 'fade':
        set[p.attribute] = lerp(lo, hi, 0.5 - 0.5 * Math.cos(TAU * f));
        break;
      case 'pulse':
        set[p.attribute] = lerp(lo, hi, Math.exp(-f * 6));
        break;
      case 'dimmerWave':
        set.dimmer = lerp(lo, hi, 0.5 + 0.5 * Math.sin(TAU * ph));
        break;
      case 'wave':
        if (p.attribute === 'dimmer' || has(p.attribute)) set[p.attribute] = lerp(lo, hi, 0.5 + 0.5 * Math.sin(TAU * ph));
        break;
      case 'chase': {
        const step = Math.floor(frac(phase) * n);
        const pos = isReverse ? n - 1 - step : step;
        const d = (((i - pos) % n) + n) % n;
        set[p.attribute] = d < p.width ? hi : lo;
        break;
      }
      case 'strobe':
        set.dimmer = f < p.duty ? hi : lo;
        break;
      case 'rainbow':
        Object.assign(set, colorToAttributes(rf, hsvToRgb(f, 1, 1)));
        break;
      case 'colorCycle':
        Object.assign(set, colorToAttributes(rf, colorAt(p.colors, ph)));
        break;
      case 'panTilt': {
        const a = TAU * ph;
        const half = (hi - lo) / 2, mid = (hi + lo) / 2;
        if (p.shape === 'circle') { set.pan = mid + half * Math.cos(a); set.tilt = mid + half * Math.sin(a); }
        else if (p.shape === 'figure8') { set.pan = mid + half * Math.sin(a); set.tilt = mid + half * Math.sin(2 * a); }
        else if (p.shape === 'pan') set.pan = mid + half * Math.sin(a);
        else set.tilt = mid + half * Math.sin(a);
        break;
      }
      case 'randomMove': {
        const k = Math.floor(ph);
        const u = smooth(frac(ph));
        const pick = (cycle: number, axis: number) => lerp(lo, hi, hash01(p.seed, cycle, i, axis));
        set.pan = lerp(pick(k, 0), pick(k + 1, 0), u);
        set.tilt = lerp(pick(k, 1), pick(k + 1, 1), u);
        break;
      }
    }
    // Only keep attributes this fixture really has (dimmer is always allowed: virtual dimmer).
    const kept: Record<string, number> = {};
    for (const [a, v] of Object.entries(set)) if (a === 'dimmer' || has(a)) kept[a] = clamp01(v);
    if (Object.keys(kept).length) out[rf.fixture.id] = kept;
  });
  return out;
}
