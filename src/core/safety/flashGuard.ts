import type { Effect, FixtureValues } from '../model/schemas';
import type { ProjectIndex } from '../engine/resolve';
import { computeEffect, effectRate } from '../engine/effects';
import { attributeClass, baseAttribute } from '../fixtures/attributes';
import { coarseChannel, rangeValue, type ResolvedFixture } from '../fixtures/profiles';
import { buildVisualModel, strobeFrequency, type VisualFixture } from '../visualizer/model';
import { hexToRgb } from '../util/math';

/**
 * Photosensitive flash guard. Estimates, from the computed state, the stage luminance seen by the audience and counts
 * flashes with the logic of broadcast flash tests (Harding / ITU-R BT.1702): a flash is a pair of opposing luminance
 * transitions; more than 3 flashes in any 1 s window fails. "Stage area" is approximated by the share of the rig that
 * changes, weighted by each fixture's luminance. This is an estimate from an approximate model, not a certification.
 */
export type FlashGuardMode = 'off' | 'warn' | 'limit';

/** Max flashes per second (general and saturated red). */
export const MAX_FLASHES_PER_SECOND = 3;
/** Luminance change (share of the full rig at full white) that counts as a transition. */
export const TRANSITION_DELTA = 0.1;
/** A transition only counts when the darker state is below this level (bright-to-brighter is not a flash). */
const DARK_LEVEL = 0.8;
/** Fixtures strobing faster than this, above the transition area, fail immediately. */
const STROBE_LIMIT_HZ = MAX_FLASHES_PER_SECOND;
/** Rate limit for intensity/colour emitters in "limit" mode (full scale per second): at most 3 full-amplitude flashes/s. */
export const SLEW_PER_SECOND = MAX_FLASHES_PER_SECOND * 2;

export interface StageLight {
  /** Mean relative luminance of the rig, 0..1 (all fixtures full white = 1). */
  luminance: number;
  /** Same, counting only saturated-red light. */
  red: number;
  /** Luminance share of fixtures strobing faster than the limit. */
  strobeShare: number;
  strobeHz: number;
}

const isRed = (r: number, g: number, b: number) => r > 0 && r / (r + g + b) >= 0.8;

export function stageLight(model: readonly VisualFixture[]): StageLight {
  if (!model.length) return { luminance: 0, red: 0, strobeShare: 0, strobeHz: 0 };
  let lum = 0, red = 0, strobe = 0, hz = 0;
  for (const f of model) {
    const { r, g, b } = hexToRgb(f.color);
    const y = (0.2126 * r + 0.7152 * g + 0.0722 * b) * f.intensity;
    lum += y;
    if (isRed(r, g, b)) red += y;
    if (f.strobeHz > STROBE_LIMIT_HZ && y > 0) {
      strobe += y;
      hz = Math.max(hz, f.strobeHz);
    }
  }
  const n = model.length;
  return { luminance: lum / n, red: red / n, strobeShare: strobe / n, strobeHz: hz };
}

export interface FlashStatus {
  flashesPerSecond: number;
  redFlashesPerSecond: number;
  violation: boolean;
  reason: string | null;
}

/** Counts opposing transitions of one luminance series inside a sliding 1 s window. */
class TransitionCounter {
  private extreme: number | null = null;
  private dir = 0;
  private readonly times: number[] = [];

  push(t: number, v: number): number {
    if (this.extreme === null) this.extreme = v;
    const d = v - this.extreme;
    const dir = Math.sign(d);
    if (this.dir !== 0 && dir === this.dir) this.extreme = v; // keep following the current ramp
    else if (Math.abs(d) >= TRANSITION_DELTA && Math.min(v, this.extreme) < DARK_LEVEL) {
      this.times.push(t);
      this.extreme = v;
      this.dir = dir;
    }
    while (this.times.length && t - this.times[0]! > 1) this.times.shift();
    return Math.floor(this.times.length / 2);
  }
}

export class FlashDetector {
  private readonly general = new TransitionCounter();
  private readonly red = new TransitionCounter();

  /** `t` in seconds. */
  push(t: number, s: StageLight): FlashStatus {
    const flashes = this.general.push(t, s.luminance);
    const redFlashes = this.red.push(t, s.red);
    let reason: string | null = null;
    if (s.strobeShare >= TRANSITION_DELTA) reason = `Strobe ${s.strobeHz.toFixed(0)} Hz sur ${Math.round(s.strobeShare * 100)} % de la luminance du kit`;
    else if (flashes > MAX_FLASHES_PER_SECOND) reason = `${flashes} flashs/s (limite ${MAX_FLASHES_PER_SECOND})`;
    else if (redFlashes > MAX_FLASHES_PER_SECOND) reason = `${redFlashes} flashs rouges saturés/s (limite ${MAX_FLASHES_PER_SECOND})`;
    return { flashesPerSecond: flashes, redFlashesPerSecond: redFlashes, violation: reason !== null, reason };
  }
}

/** Runs the detector over computed states `dt` seconds apart; returns the first violation (with its time) or the worst state. */
export function analyzeFrames(fixtures: readonly ResolvedFixture[], frames: Iterable<FixtureValues>, dt: number): FlashStatus & { at: number | null } {
  const d = new FlashDetector();
  let t = 0;
  let worst: FlashStatus = { flashesPerSecond: 0, redFlashesPerSecond: 0, violation: false, reason: null };
  for (const values of frames) {
    const s = d.push(t, stageLight(buildVisualModel(fixtures, values)));
    if (s.violation) return { ...s, at: t };
    if (s.flashesPerSecond > worst.flashesPerSecond) worst = s;
    t += dt;
  }
  return { ...worst, at: null };
}

/**
 * Simulates `def` for 3 s on top of `base` (40 Hz) and returns the flash-guard verdict. `scale` effects multiply the
 * underlying values, `override` effects replace them.
 */
export function effectFlashViolation(index: ProjectIndex, base: FixtureValues, def: Effect, bpm: number, maxStrobeHz: number): FlashStatus & { at: number | null } {
  const dt = 1 / 40;
  const targets = index.resolveTargets(def.targets);
  const rate = effectRate(def, bpm, maxStrobeHz);
  const frames = Array.from({ length: 120 }, (_, i) => {
    const out = structuredClone(base);
    for (const [fid, attrs] of Object.entries(computeEffect(def, i * dt * rate, targets))) {
      const o = (out[fid] ??= {});
      for (const [a, v] of Object.entries(attrs)) o[a] = def.blend === 'scale' ? (o[a] ?? 0) * v : v;
    }
    return out;
  });
  return analyzeFrames([...index.fixtures.values()], frames, dt);
}

/**
 * "limit" mode: rate-limits intensity and colour changes and opens strobing shutters on every attribute the
 * programmer does not hold (manual control always wins). Mutates and returns `next`.
 */
export function limitFlashes(
  fixtures: Iterable<ResolvedFixture>, prev: FixtureValues, next: FixtureValues, dtMs: number, programmer: FixtureValues,
): FixtureValues {
  const maxStep = (SLEW_PER_SECOND * dtMs) / 1000;
  for (const rf of fixtures) {
    const id = rf.fixture.id;
    const v = next[id];
    if (!v) continue;
    const held = programmer[id] ?? {};
    const before = prev[id] ?? {};
    for (const [k, x] of Object.entries(v)) {
      if (k in held) continue;
      const cls = attributeClass(k);
      if (cls === 'intensity' || (cls === 'color' && baseAttribute(k) !== 'colorWheel')) {
        const p = before[k];
        if (p !== undefined && Math.abs(x - p) > maxStep) v[k] = p + Math.sign(x - p) * maxStep;
      }
    }
    for (const a of ['strobe', 'shutter']) {
      const ch = coarseChannel(rf.mode, a);
      if (!ch || a in held || strobeFrequency(ch, v[a]) <= STROBE_LIMIT_HZ) continue;
      v[a] = rangeValue(ch, 'open') ?? ch.default / 255;
    }
  }
  return next;
}
