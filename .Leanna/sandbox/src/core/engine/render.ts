import type { AttributeValues } from '../model/schemas';
import { baseAttribute, EMITTER_ATTRIBUTES } from '../fixtures/attributes';
import { channelKey, coarseChannel, isDangerousValue, rangeValue, type ResolvedFixture } from '../fixtures/profiles';

const isEmitter = (key: string) => (EMITTER_ATTRIBUTES as readonly string[]).includes(baseAttribute(key));

export type BlackoutPolicy = 'intensity' | 'intensity-shutter' | 'all-zero';

export interface OutputStageOptions {
  master: number;
  blackout: boolean;
  policy: BlackoutPolicy;
}

/**
 * Completes merged values with profile defaults, then applies the virtual dimmer, grand master and blackout.
 * The result is the "computed" state of a fixture (normalized), used both for DMX rendering and the visualizer.
 */
export function finalizeFixture(rf: ResolvedFixture, merged: AttributeValues | undefined, opts: OutputStageOptions): AttributeValues {
  const out: AttributeValues = {};
  for (const ch of rf.mode.channels) {
    if (ch.fine) continue;
    const key = channelKey(ch);
    out[key] = merged?.[key] ?? ch.default / 255;
  }
  const hasDimmer = 'dimmer' in out;
  if (hasDimmer) {
    out.dimmer = (out.dimmer ?? 0) * opts.master;
  } else {
    // Virtual dimmer: fixtures without a dimmer channel scale their emitters.
    const vd = (merged?.dimmer ?? 1) * opts.master;
    for (const k of Object.keys(out)) if (isEmitter(k)) out[k] = (out[k] ?? 0) * vd;
  }
  if (opts.blackout) {
    if (opts.policy === 'all-zero') {
      for (const k of Object.keys(out)) out[k] = 0;
    } else {
      if (hasDimmer) out.dimmer = 0;
      else for (const k of Object.keys(out)) if (isEmitter(k)) out[k] = 0;
      if (opts.policy === 'intensity-shutter') {
        const sh = coarseChannel(rf.mode, 'shutter');
        const closed = sh ? rangeValue(sh, 'closed') : undefined;
        if (closed !== undefined) out.shutter = closed;
      }
    }
  }
  return out;
}

/**
 * Writes a fixture's final values into a 512-byte universe buffer.
 * 16-bit attributes are split into coarse/fine bytes. Values in ranges flagged `dangerous` (reset, lamp off…)
 * are replaced by the channel default unless `allowDangerous(attr)` is true (explicit manual confirmation).
 */
export function renderFixture(rf: ResolvedFixture, values: AttributeValues, out: Uint8Array, allowDangerous: (attr: string) => boolean): void {
  const base = rf.fixture.address - 1;
  const fineAttrs = new Set(rf.mode.channels.filter((c) => c.fine).map(channelKey));
  rf.mode.channels.forEach((ch, i) => {
    const addr = base + i;
    if (addr < 0 || addr >= 512) return;
    const key = channelKey(ch);
    const v = values[key];
    if (v === undefined) {
      out[addr] = ch.default;
      return;
    }
    const clamped = v < 0 ? 0 : v > 1 ? 1 : v;
    let dmx: number;
    if (fineAttrs.has(key)) {
      const v16 = Math.round(clamped * 65535);
      dmx = ch.fine ? v16 & 0xff : v16 >> 8;
    } else {
      dmx = Math.round(clamped * 255);
    }
    if (!ch.fine && ch.ranges.length && isDangerousValue(ch, dmx) && !allowDangerous(key)) {
      dmx = isDangerousValue(ch, ch.default) ? 0 : ch.default;
    }
    out[addr] = dmx;
  });
}
