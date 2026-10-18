import type { FixtureValues, Timeline } from '../model/schemas';
import { attributeClass } from '../fixtures/attributes';
import type { EffectOutput } from './merge';
import { computeEffect, effectRate } from './effects';
import type { ProjectIndex } from './resolve';

export type TransportState = 'stopped' | 'playing' | 'paused';

export interface TimelineStatus {
  timelineId: string | null;
  state: TransportState;
  time: number; // seconds
  duration: number;
}

export interface TimelineDeps {
  cueGoto(cueListId: string, index: number): void;
}

/** Timeline transport. Scene/effect events are evaluated as pure functions of the playhead. */
export class TimelineTransport {
  state: TransportState = 'stopped';
  timeMs = 0;
  timelineId: string | null = null;

  play(id: string): void {
    if (this.timelineId !== id) {
      this.timelineId = id;
      this.timeMs = 0;
    }
    this.state = 'playing';
  }
  pause(): void {
    if (this.state === 'playing') this.state = 'paused';
  }
  stop(): void {
    this.state = 'stopped';
    this.timeMs = 0;
  }
  seek(seconds: number): void {
    this.timeMs = Math.max(0, seconds * 1000);
  }

  tick(dtMs: number, tl: Timeline | undefined, deps: TimelineDeps): void {
    if (!tl) {
      if (this.state !== 'stopped') this.stop();
      return;
    }
    if (this.state !== 'playing') return;
    const prev = this.timeMs;
    let next = prev + dtMs;
    const durMs = tl.duration * 1000;
    const fire = (a: number, b: number) => {
      for (const e of tl.events) {
        const s = e.start * 1000;
        if (e.kind === 'cue' && e.refId && s >= a && s < b) deps.cueGoto(e.refId, e.cueIndex);
      }
    };
    if (next >= durMs) {
      fire(prev, durMs);
      if (tl.loop) {
        next = next % durMs;
        fire(0, next);
      } else {
        this.state = 'stopped';
        this.timeMs = 0;
        return;
      }
    } else {
      fire(prev === 0 ? -1 : prev, next);
    }
    this.timeMs = next;
  }

  /** Values contributed by active scene/effect events at the current playhead. */
  evaluate(tl: Timeline | undefined, index: ProjectIndex, bpm: number, maxStrobeHz: number): { values: FixtureValues; effects: EffectOutput[] } {
    const values: FixtureValues = {};
    const effects: EffectOutput[] = [];
    if (!tl || this.state === 'stopped') return { values, effects };
    const t = this.timeMs / 1000;
    const active = tl.events.filter((e) => e.refId && t >= e.start && t < e.start + e.duration).sort((a, b) => a.lane - b.lane || a.start - b.start);
    for (const e of active) {
      if (e.kind === 'scene') {
        const scene = index.scenes.get(e.refId!);
        if (!scene) continue;
        const out = e.fadeOut ?? e.fade;
        const w = Math.min(1, e.fade > 0 ? (t - e.start) / e.fade : 1, out > 0 ? (e.start + e.duration - t) / out : 1);
        for (const [fid, attrs] of Object.entries(scene.values)) {
          const o = (values[fid] ??= {});
          for (const [attr, v] of Object.entries(attrs)) {
            o[attr] = attributeClass(attr) === 'intensity' ? Math.max(o[attr] ?? 0, v * w) : v;
          }
        }
      } else if (e.kind === 'effect') {
        const def = index.effects.get(e.refId!);
        if (!def) continue;
        const phase = (t - e.start) * effectRate(def, bpm, maxStrobeHz);
        effects.push({
          id: `timeline:${e.id}`,
          label: `Timeline · ${def.name}`,
          priority: def.priority,
          order: 0,
          blend: def.blend,
          values: computeEffect(def, phase, index.resolveTargets(def.targets)),
        });
      }
    }
    return { values, effects };
  }

  status(tl: Timeline | undefined): TimelineStatus {
    return { timelineId: this.timelineId, state: this.state, time: this.timeMs / 1000, duration: tl?.duration ?? 0 };
  }
}
