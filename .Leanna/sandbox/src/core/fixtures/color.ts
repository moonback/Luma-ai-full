import type { AttributeValues } from '../model/schemas';
import { clamp01, hexToRgb, type Rgb } from '../util/math';
import { baseAttribute, cellKey, cellOf } from './attributes';
import { coarseChannel, rangeAt, type ResolvedFixture } from './profiles';

export type ColorCapability = 'rgb' | 'rgbw' | 'cmy' | 'wheel' | 'none';

const capabilityOf = (attrs: Set<string>): ColorCapability => {
  if (attrs.has('red') && attrs.has('green') && attrs.has('blue')) return attrs.has('white') ? 'rgbw' : 'rgb';
  if (attrs.has('cyan') && attrs.has('magenta') && attrs.has('yellow')) return 'cmy';
  if (attrs.has('colorWheel')) return 'wheel';
  return 'none';
};

/** Colour groups of a fixture: one per cell carrying colour channels, plus the whole-fixture group (cell undefined). */
export function colorGroups(rf: ResolvedFixture): { cell: number | undefined; cap: ColorCapability }[] {
  const byCell = new Map<number | undefined, Set<string>>();
  for (const key of rf.attributes) {
    const c = cellOf(key);
    const set = byCell.get(c) ?? new Set<string>();
    set.add(baseAttribute(key));
    byCell.set(c, set);
  }
  const groups: { cell: number | undefined; cap: ColorCapability }[] = [];
  for (const [cell, attrs] of byCell) {
    const cap = capabilityOf(attrs);
    if (cap !== 'none') groups.push({ cell, cap });
  }
  return groups.sort((a, b) => (a.cell ?? 0) - (b.cell ?? 0));
}

/** Cells of the fixture that have their own colour (empty for single-cell fixtures). */
export function colorCells(rf: ResolvedFixture): number[] {
  return colorGroups(rf).map((g) => g.cell).filter((c): c is number => c !== undefined);
}

export function colorCapability(rf: ResolvedFixture): ColorCapability {
  const groups = colorGroups(rf);
  return groups.find((g) => g.cell === undefined)?.cap ?? groups[0]?.cap ?? 'none';
}

function groupColor(rf: ResolvedFixture, cap: ColorCapability, cell: number | undefined, rgb: Rgb): AttributeValues {
  const r = clamp01(rgb.r), g = clamp01(rgb.g), b = clamp01(rgb.b);
  const k = (a: string) => cellKey(a, cell);
  switch (cap) {
    case 'rgbw': {
      const w = Math.min(r, g, b);
      return { [k('red')]: r - w, [k('green')]: g - w, [k('blue')]: b - w, [k('white')]: w };
    }
    case 'rgb':
      return { [k('red')]: r, [k('green')]: g, [k('blue')]: b };
    case 'cmy':
      return { [k('cyan')]: 1 - r, [k('magenta')]: 1 - g, [k('yellow')]: 1 - b };
    case 'wheel': {
      const ch = coarseChannel(rf.mode, k('colorWheel'));
      let best: { d: number; v: number } | undefined;
      for (const range of ch?.ranges ?? []) {
        if (range.kind !== 'color' || !range.color) continue;
        const c = hexToRgb(range.color);
        // Compare chromaticity so dim requests still match the right slot.
        const max = Math.max(r, g, b) || 1;
        const d = (c.r - r / max) ** 2 + (c.g - g / max) ** 2 + (c.b - b / max) ** 2;
        if (!best || d < best.d) best = { d, v: Math.round((range.from + range.to) / 2) / 255 };
      }
      return best ? { [k('colorWheel')]: best.v } : {};
    }
    default:
      return {};
  }
}

/**
 * Converts a target RGB colour into the attributes this fixture actually has.
 * Never assumes a channel layout: RGB, RGBW (white extraction), CMY, colour wheels and multi-cell fixtures are
 * handled. `cell` limits the change to one cell; by default every colour group (all cells) receives the colour.
 */
export function colorToAttributes(rf: ResolvedFixture, rgb: Rgb, cell?: number): AttributeValues {
  const out: AttributeValues = {};
  for (const g of colorGroups(rf)) {
    if (cell !== undefined && g.cell !== cell) continue;
    Object.assign(out, groupColor(rf, g.cap, g.cell, rgb));
  }
  return out;
}

const WARM_WHITE: Rgb = { r: 1, g: 0.9, b: 0.75 };

function groupDisplay(rf: ResolvedFixture, cap: ColorCapability, cell: number | undefined, v: AttributeValues): Rgb {
  const g = (a: string) => v[cellKey(a, cell)] ?? 0;
  if (cap === 'rgb' || cap === 'rgbw') {
    const w = g('white'), am = g('amber'), uv = g('uv');
    return { r: clamp01(g('red') + w + am + uv * 0.4), g: clamp01(g('green') + w + am * 0.6), b: clamp01(g('blue') + w + uv * 0.9) };
  }
  if (cap === 'cmy') return { r: 1 - g('cyan'), g: 1 - g('magenta'), b: 1 - g('yellow') };
  if (cap === 'wheel') {
    const ch = coarseChannel(rf.mode, cellKey('colorWheel', cell));
    const range = ch ? rangeAt(ch, Math.round(g('colorWheel') * 255)) : undefined;
    return range?.color ? hexToRgb(range.color) : WARM_WHITE;
  }
  return WARM_WHITE;
}

function fixtureIntensity(rf: ResolvedFixture, v: AttributeValues): number {
  let intensity = v.dimmer ?? 1;
  const shutter = coarseChannel(rf.mode, 'shutter');
  if (shutter && v.shutter !== undefined) {
    const range = rangeAt(shutter, Math.round(v.shutter * 255));
    if (range?.kind === 'closed') intensity = 0;
  }
  return clamp01(intensity);
}

/** Per-cell display colours (already scaled by the fixture intensity). Empty for single-cell fixtures. */
export function cellColors(rf: ResolvedFixture, v: AttributeValues): { cell: number; color: Rgb }[] {
  const k = fixtureIntensity(rf, v);
  return colorGroups(rf)
    .filter((g) => g.cell !== undefined)
    .map((g) => {
      const c = groupDisplay(rf, g.cap, g.cell, v);
      return { cell: g.cell!, color: { r: c.r * k, g: c.g * k, b: c.b * k } };
    });
}

/** Approximate display colour (0..1) and intensity of the whole fixture. Not a photometric model. */
export function displayColor(rf: ResolvedFixture, v: AttributeValues): { color: Rgb; intensity: number } {
  const groups = colorGroups(rf);
  const master = groups.find((g) => g.cell === undefined);
  let color: Rgb;
  if (master || groups.length === 0) color = master ? groupDisplay(rf, master.cap, undefined, v) : WARM_WHITE;
  else {
    // Multi-cell only: average of the cells, brightness kept from the brightest cell.
    const cs = groups.map((g) => groupDisplay(rf, g.cap, g.cell, v));
    color = { r: cs.reduce((s, c) => s + c.r, 0) / cs.length, g: cs.reduce((s, c) => s + c.g, 0) / cs.length, b: cs.reduce((s, c) => s + c.b, 0) / cs.length };
    const peak = Math.max(...cs.map((c) => Math.max(c.r, c.g, c.b)));
    const cur = Math.max(color.r, color.g, color.b);
    if (cur > 0) color = { r: clamp01((color.r * peak) / cur), g: clamp01((color.g * peak) / cur), b: clamp01((color.b * peak) / cur) };
  }
  return { color, intensity: fixtureIntensity(rf, v) };
}
