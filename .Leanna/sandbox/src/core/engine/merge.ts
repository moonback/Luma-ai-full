import type { FixtureValues } from '../model/schemas';
import { attributeClass } from '../fixtures/attributes';

/**
 * PRIORITY / MERGE POLICY (documented in docs/ARCHITECTURE.md)
 *
 * 1. Base layers (cue lists, AI layer, timeline, audio) are grouped by priority.
 *    Inside one priority band: intensity = HTP (highest wins); every other attribute = LTP (latest activation wins).
 *    A higher band replaces the values of lower bands (including intensity).
 * 2. Effects are applied on top, in (priority, activation) order. An effect only touches an attribute whose current
 *    owner has a priority <= the effect priority. `override` replaces, `scale` multiplies the underlying value.
 * 3. The programmer (manual control) always wins, for every attribute. Releasing it hands control back instantly.
 * 4. Attributes nobody controls fall back to the profile default.
 */

export type SourceKind = 'manual' | 'playback' | 'ai' | 'timeline' | 'audio' | 'effect' | 'locate';

export interface LayerInput {
  id: string;
  label: string;
  kind: SourceKind;
  priority: number;
  /** Monotonic activation counter: larger = more recent (LTP). */
  order: number;
  values: FixtureValues;
}

export interface EffectOutput {
  id: string;
  label: string;
  priority: number;
  order: number;
  blend: 'override' | 'scale';
  values: FixtureValues;
}

export interface MergeResult {
  values: FixtureValues;
  sources: Record<string, Record<string, string>>;
}

interface Cell { v: number; src: string; prio: number }

export function mergeSources(layers: readonly LayerInput[], effects: readonly EffectOutput[], programmer: FixtureValues): MergeResult {
  const cells = new Map<string, Map<string, Cell>>();
  const cellsOf = (fid: string) => {
    let m = cells.get(fid);
    if (!m) cells.set(fid, (m = new Map()));
    return m;
  };

  const sorted = [...layers].sort((a, b) => a.priority - b.priority || a.order - b.order);
  let i = 0;
  while (i < sorted.length) {
    const prio = sorted[i]!.priority;
    const band = new Map<string, Map<string, Cell>>();
    for (; i < sorted.length && sorted[i]!.priority === prio; i++) {
      const layer = sorted[i]!;
      for (const [fid, attrs] of Object.entries(layer.values)) {
        let bm = band.get(fid);
        if (!bm) band.set(fid, (bm = new Map()));
        for (const [attr, v] of Object.entries(attrs)) {
          const prev = bm.get(attr);
          if (prev && attributeClass(attr) === 'intensity' && prev.v >= v) continue; // HTP
          bm.set(attr, { v, src: layer.label, prio });
        }
      }
    }
    for (const [fid, bm] of band) {
      const m = cellsOf(fid);
      for (const [attr, c] of bm) m.set(attr, c);
    }
  }

  const fx = [...effects].sort((a, b) => a.priority - b.priority || a.order - b.order);
  for (const e of fx) {
    for (const [fid, attrs] of Object.entries(e.values)) {
      const m = cellsOf(fid);
      for (const [attr, v] of Object.entries(attrs)) {
        const cur = m.get(attr);
        if (cur && cur.prio > e.priority) continue;
        if (e.blend === 'scale') {
          if (!cur) continue;
          m.set(attr, { v: cur.v * v, src: `${cur.src} × ${e.label}`, prio: e.priority });
        } else {
          m.set(attr, { v, src: e.label, prio: e.priority });
        }
      }
    }
  }

  for (const [fid, attrs] of Object.entries(programmer)) {
    const m = cellsOf(fid);
    for (const [attr, v] of Object.entries(attrs)) m.set(attr, { v, src: 'Manuel', prio: Infinity });
  }

  const values: FixtureValues = {};
  const sources: Record<string, Record<string, string>> = {};
  for (const [fid, m] of cells) {
    const vv: Record<string, number> = (values[fid] = {});
    const ss: Record<string, string> = (sources[fid] = {});
    for (const [attr, c] of m) {
      vv[attr] = c.v < 0 ? 0 : c.v > 1 ? 1 : c.v;
      ss[attr] = c.src;
    }
  }
  return { values, sources };
}
