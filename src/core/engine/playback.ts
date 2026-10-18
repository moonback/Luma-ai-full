import type { Cue, CueList, FixtureValues, Scene } from '../model/schemas';
import { attributeClass } from '../fixtures/attributes';
import { CURVES, lerp } from '../util/math';

export type PlaybackState = 'idle' | 'delay' | 'fading' | 'holding' | 'paused';

export interface PlaybackDeps {
  scene(id: string): Scene | undefined;
  /** Current computed value on stage, used as fade start for attributes this list did not control yet. */
  stageValue(fixtureId: string, attr: string): number | undefined;
  startCueEffects(ownerKey: string, effectIds: readonly string[]): void;
  stopCueEffects(ownerKey: string): void;
}

export interface PlaybackStatus {
  cueListId: string;
  state: PlaybackState;
  index: number;
  cueId: string | null;
  cueName: string | null;
  nextIndex: number | null;
  progress: number;
  remaining: number; // seconds
}

const clone = (v: FixtureValues): FixtureValues => {
  const o: FixtureValues = {};
  for (const [k, a] of Object.entries(v)) o[k] = { ...a };
  return o;
};

/**
 * Runtime of one cue list. Driven exclusively by the engine tick (no timers), so behaviour is deterministic.
 * Non-tracking crossfade: intensities absent from the next cue fade to 0, other attributes hold their value.
 */
export class CueListPlayback {
  state: PlaybackState = 'idle';
  index = -1;
  order = 0;
  current: FixtureValues = {};
  private from: FixtureValues = {};
  private to: FixtureValues = {};
  private elapsed = 0;
  private delayMs = 0;
  private fadeMs = 0;
  private curve: (t: number) => number = CURVES.linear;
  private followElapsed = 0;
  private resumeState: PlaybackState = 'idle';

  constructor(readonly cueListId: string, private readonly deps: PlaybackDeps) {}

  private get ownerKey() {
    return `cuelist:${this.cueListId}`;
  }

  goto(list: CueList, index: number, order: number): boolean {
    const cue = list.cues[index];
    if (!cue) return false;
    this.order = order;
    this.index = index;
    const target = cue.sceneId ? this.deps.scene(cue.sceneId)?.values ?? {} : {};
    const from = clone(this.current);
    const to = clone(target);
    for (const [fid, attrs] of Object.entries(from)) {
      const t = (to[fid] ??= {});
      for (const [attr, v] of Object.entries(attrs)) {
        if (t[attr] === undefined) t[attr] = attributeClass(attr) === 'intensity' ? 0 : v;
      }
    }
    for (const [fid, attrs] of Object.entries(to)) {
      const f = (from[fid] ??= {});
      for (const [attr, v] of Object.entries(attrs)) {
        if (f[attr] === undefined) f[attr] = attributeClass(attr) === 'intensity' ? 0 : this.deps.stageValue(fid, attr) ?? v;
      }
    }
    this.from = from;
    this.to = to;
    this.current = clone(from);
    this.elapsed = 0;
    this.followElapsed = 0;
    this.delayMs = cue.delay * 1000;
    this.fadeMs = cue.fade * 1000;
    this.curve = CURVES[cue.curve];
    this.state = this.delayMs > 0 ? 'delay' : 'fading';
    this.deps.stopCueEffects(this.ownerKey);
    if (cue.effectIds.length) this.deps.startCueEffects(this.ownerKey, cue.effectIds);
    this.apply();
    return true;
  }

  nextIndex(list: CueList): number | null {
    const n = this.index + 1;
    if (n < list.cues.length) return n;
    return list.loop && list.cues.length ? 0 : null;
  }

  go(list: CueList, order: number): boolean {
    const next = this.state === 'idle' ? 0 : this.nextIndex(list);
    return next === null ? false : this.goto(list, next, order);
  }

  back(list: CueList, order: number): boolean {
    return this.index > 0 ? this.goto(list, this.index - 1, order) : false;
  }

  pause(): void {
    if (this.state === 'idle' || this.state === 'paused') return;
    this.resumeState = this.state;
    this.state = 'paused';
  }

  resume(): void {
    if (this.state === 'paused') this.state = this.resumeState;
  }

  stop(): void {
    this.state = 'idle';
    this.index = -1;
    this.current = {};
    this.from = {};
    this.to = {};
    this.deps.stopCueEffects(this.ownerKey);
  }

  /** Advances time. At most one automatic follow per tick (loop protection). */
  tick(dtMs: number, list: CueList | undefined, nextOrder: () => number): void {
    if (!list) {
      this.stop();
      return;
    }
    if (this.state === 'idle' || this.state === 'paused') return;
    if (this.state === 'holding') {
      const next = this.nextIndex(list);
      const cue: Cue | undefined = next === null ? undefined : list.cues[next];
      if (cue?.trigger.type === 'follow') {
        this.followElapsed += dtMs;
        if (this.followElapsed >= cue.trigger.wait * 1000 && next !== null) this.goto(list, next, nextOrder());
      }
      return;
    }
    this.elapsed += dtMs;
    this.apply();
  }

  private apply(): void {
    if (this.elapsed < this.delayMs) {
      this.state = 'delay';
      return;
    }
    const p = this.fadeMs > 0 ? (this.elapsed - this.delayMs) / this.fadeMs : 1;
    if (p >= 1) {
      this.current = clone(this.to);
      this.state = 'holding';
      return;
    }
    this.state = 'fading';
    const k = this.curve(p);
    const cur: FixtureValues = {};
    for (const [fid, attrs] of Object.entries(this.to)) {
      const f = this.from[fid] ?? {};
      const c: Record<string, number> = (cur[fid] = {});
      for (const [attr, tv] of Object.entries(attrs)) c[attr] = lerp(f[attr] ?? tv, tv, k);
    }
    this.current = cur;
  }

  status(list: CueList | undefined): PlaybackStatus {
    const cue = list?.cues[this.index];
    const total = this.delayMs + this.fadeMs;
    const done = this.state === 'holding' || total === 0;
    return {
      cueListId: this.cueListId,
      state: this.state,
      index: this.index,
      cueId: cue?.id ?? null,
      cueName: cue?.name ?? null,
      nextIndex: list && this.state !== 'idle' ? this.nextIndex(list) : list?.cues.length ? 0 : null,
      progress: this.state === 'idle' ? 0 : done ? 1 : Math.min(1, this.elapsed / total),
      remaining: this.state === 'idle' || done ? 0 : Math.max(0, (total - this.elapsed) / 1000),
    };
  }
}
