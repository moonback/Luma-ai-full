import { EventEmitter } from 'node:events';
import type { FixtureValues } from '../model/schemas';
import { coarseChannel, isDangerousValue } from '../fixtures/profiles';
import { CURVES, lerp } from '../util/math';
import { computeEffect, effectRate } from './effects';
import { mergeSources, type EffectOutput, type LayerInput } from './merge';
import { CueListPlayback, type PlaybackStatus } from './playback';
import { finalizeFixture, renderFixture, type BlackoutPolicy } from './render';
import type { ProjectIndex } from './resolve';
import { TimelineTransport, type TimelineStatus } from './timeline';
import { limitFlashes, type FlashGuardMode } from '../safety/flashGuard';

export interface EngineSettings {
  rateHz: number;
  blackoutPolicy: BlackoutPolicy;
  maxStrobeHz: number;
  priorities: { ai: number; timeline: number; audio: number };
  /** Photosensitive guard; "limit" rate-limits intensity/colour and opens fast strobes (programmer excluded). */
  flashGuard?: FlashGuardMode;
}

export interface FrameSink {
  /** Called once per tick with every computed universe (1-based universe -> 512 bytes). */
  sendFrames(frames: ReadonlyMap<number, Uint8Array>): void;
}

export interface EffectInstanceStatus {
  instanceId: string;
  effectId: string;
  name: string;
  owner: string;
  paused: boolean;
  elapsed: number; // seconds
  duration: number | null;
}

export interface EngineMetrics {
  ticks: number;
  rateHz: number; // configured
  measuredHz: number;
  avgTickMs: number;
  maxTickMs: number;
  jitterMs: number;
  overruns: number;
  load: number; // avgTickMs / period
}

export interface EngineSnapshot {
  time: number;
  running: boolean;
  master: number;
  blackout: boolean;
  bpm: number;
  bpmSource: 'manual' | 'audio';
  programmerCount: number;
  playbacks: PlaybackStatus[];
  effects: EffectInstanceStatus[];
  timeline: TimelineStatus;
  aiActive: boolean;
  metrics: EngineMetrics;
}

export interface SetResult {
  applied: number;
  rejected: { fixtureId: string; attribute: string; reason: string }[];
}

interface EffectInstance {
  instanceId: string;
  effectId: string;
  owner: string;
  phase: number;
  elapsedMs: number;
  paused: boolean;
  order: number;
}

/** Layer that crossfades towards a target. Used for AI "live" actions. */
class FadingLayer {
  values: FixtureValues = {};
  private from: FixtureValues = {};
  private to: FixtureValues = {};
  private elapsed = 0;
  private fadeMs = 0;
  order = 0;

  setTarget(patch: FixtureValues, fadeMs: number, order: number): void {
    this.from = structuredClone(this.values);
    const to = structuredClone(this.to);
    for (const [fid, attrs] of Object.entries(patch)) to[fid] = { ...(to[fid] ?? {}), ...attrs };
    this.to = to;
    this.elapsed = 0;
    this.fadeMs = fadeMs;
    this.order = order;
    this.tick(0);
  }

  clear(): void {
    this.values = {};
    this.from = {};
    this.to = {};
  }

  get active(): boolean {
    return Object.keys(this.to).length > 0;
  }

  tick(dt: number): void {
    this.elapsed += dt;
    const p = this.fadeMs > 0 ? Math.min(1, this.elapsed / this.fadeMs) : 1;
    const k = CURVES.easeInOut(p);
    const out: FixtureValues = {};
    for (const [fid, attrs] of Object.entries(this.to)) {
      const f = this.from[fid] ?? {};
      const o: Record<string, number> = (out[fid] = {});
      for (const [a, v] of Object.entries(attrs)) o[a] = p >= 1 ? v : lerp(f[a] ?? (a === 'dimmer' ? 0 : v), v, k);
    }
    this.values = out;
  }
}

export class Engine extends EventEmitter<{ frame: []; error: [Error] }> {
  private index: ProjectIndex;
  private programmer: FixtureValues = {};
  private readonly special = new Set<string>();
  private readonly playbacks = new Map<string, CueListPlayback>();
  private readonly effects = new Map<string, EffectInstance>();
  private readonly ai = new FadingLayer();
  private readonly timeline = new TimelineTransport();
  private readonly external = new Map<string, { layer?: LayerInput; effects?: EffectOutput[] }>();
  private seq = 1;
  private instanceSeq = 1;
  private timeMs = 0;
  private timer: NodeJS.Timeout | NodeJS.Immediate | null = null;
  master = 1;
  blackout = false;
  bpm = 120;
  bpmSource: 'manual' | 'audio' = 'manual';

  /** Computed state (normalized, after merge/defaults/master/blackout). */
  values: FixtureValues = {};
  sources: Record<string, Record<string, string>> = {};
  /** Computed universes (what the engine asks the outputs to transmit). */
  readonly universes = new Map<number, Uint8Array>();

  private metricsState = { ticks: 0, avgTick: 0, maxTick: 0, jitter: 0, overruns: 0, windowStart: 0, windowTicks: 0, measuredHz: 0 };

  constructor(index: ProjectIndex, private readonly sink: FrameSink, private settings: EngineSettings) {
    super();
    this.index = index;
    this.bpm = index.project.show.bpm;
  }

  updateSettings(s: EngineSettings): void {
    const rateChanged = s.rateHz !== this.settings.rateHz;
    this.settings = s;
    if (rateChanged && this.timer) {
      this.stop();
      this.start();
    }
  }

  setIndex(index: ProjectIndex): void {
    this.index = index;
    for (const fid of Object.keys(this.programmer)) if (!index.fixtures.has(fid)) delete this.programmer[fid];
    for (const [id, inst] of this.effects) if (!index.effects.has(inst.effectId)) this.effects.delete(id);
  }

  get time(): number {
    return this.timeMs;
  }

  private nextOrder = () => this.seq++;

  /* ---------------- Programmer (manual control: always highest priority) ---------------- */

  setProgrammer(fixtureIds: readonly string[], attrs: Record<string, number>, opts: { confirmSpecial?: boolean } = {}): SetResult {
    const res: SetResult = { applied: 0, rejected: [] };
    for (const fid of fixtureIds) {
      const rf = this.index.fixtures.get(fid);
      if (!rf) {
        res.rejected.push({ fixtureId: fid, attribute: '*', reason: 'Projecteur inconnu' });
        continue;
      }
      for (const [attr, raw] of Object.entries(attrs)) {
        if (!Number.isFinite(raw) || raw < 0 || raw > 1) {
          res.rejected.push({ fixtureId: fid, attribute: attr, reason: 'Valeur hors plage (0..1)' });
          continue;
        }
        if (attr !== 'dimmer' && !rf.attributes.includes(attr)) continue; // not a capability of this fixture: skip silently for multi-selection
        const ch = coarseChannel(rf.mode, attr);
        const key = `${fid}|${attr}`;
        if (ch && isDangerousValue(ch, Math.round(raw * 255))) {
          if (!opts.confirmSpecial) {
            res.rejected.push({ fixtureId: fid, attribute: attr, reason: 'Fonction spéciale : confirmation requise' });
            continue;
          }
          this.special.add(key);
        } else {
          this.special.delete(key);
        }
        (this.programmer[fid] ??= {})[attr] = raw;
        res.applied++;
      }
    }
    return res;
  }

  releaseProgrammer(fixtureIds?: readonly string[], attrs?: readonly string[]): void {
    const ids = fixtureIds ?? Object.keys(this.programmer);
    for (const fid of ids) {
      const p = this.programmer[fid];
      if (!p) continue;
      if (attrs) for (const a of attrs) { delete p[a]; this.special.delete(`${fid}|${a}`); }
      else { delete this.programmer[fid]; for (const k of [...this.special]) if (k.startsWith(`${fid}|`)) this.special.delete(k); }
      if (p && Object.keys(p).length === 0) delete this.programmer[fid];
    }
  }

  getProgrammer(): FixtureValues {
    return structuredClone(this.programmer);
  }

  /* ---------------- Cue lists ---------------- */

  private playback(id: string): CueListPlayback {
    let pb = this.playbacks.get(id);
    if (!pb) {
      pb = new CueListPlayback(id, {
        scene: (sid) => this.index.scenes.get(sid),
        stageValue: (fid, a) => this.values[fid]?.[a],
        startCueEffects: (owner, ids) => ids.forEach((eid) => this.startEffect(eid, owner)),
        stopCueEffects: (owner) => this.stopEffectsOwnedBy(owner),
      });
      this.playbacks.set(id, pb);
    }
    return pb;
  }

  cueGo(listId: string): boolean {
    const list = this.index.cueLists.get(listId);
    return !!list && this.playback(listId).go(list, this.nextOrder());
  }
  cueBack(listId: string): boolean {
    const list = this.index.cueLists.get(listId);
    return !!list && this.playback(listId).back(list, this.nextOrder());
  }
  cueGoto(listId: string, index: number): boolean {
    const list = this.index.cueLists.get(listId);
    return !!list && this.playback(listId).goto(list, index, this.nextOrder());
  }
  cuePause(listId: string): void { this.playbacks.get(listId)?.pause(); }
  cueResume(listId: string): void { this.playbacks.get(listId)?.resume(); }
  cueStop(listId: string): void { this.playbacks.get(listId)?.stop(); }
  stopAllPlaybacks(): void { for (const pb of this.playbacks.values()) pb.stop(); }

  /* ---------------- Effects ---------------- */

  startEffect(effectId: string, owner = 'manual'): string | null {
    if (!this.index.effects.has(effectId)) return null;
    for (const inst of this.effects.values()) if (inst.effectId === effectId && inst.owner === owner) return inst.instanceId;
    const instanceId = `fx${this.instanceSeq++}`;
    this.effects.set(instanceId, { instanceId, effectId, owner, phase: 0, elapsedMs: 0, paused: false, order: this.nextOrder() });
    return instanceId;
  }
  stopEffect(instanceId: string): void { this.effects.delete(instanceId); }
  stopEffectById(effectId: string): void { for (const [k, i] of this.effects) if (i.effectId === effectId) this.effects.delete(k); }
  stopEffectsOwnedBy(owner: string): void { for (const [k, i] of this.effects) if (i.owner === owner) this.effects.delete(k); }
  stopAllEffects(): void { this.effects.clear(); }
  setEffectPaused(instanceId: string, paused: boolean): void {
    const i = this.effects.get(instanceId);
    if (i) i.paused = paused;
  }
  private barCount = 0;
  /**
   * Audio downbeat: BPM-synced effects with `barSync` snap their cycle to the bar/phrase grid
   * (cycle start every beatsPerCycle / 4 bars), rounding the phase so the correction never exceeds half a cycle.
   */
  onDownbeat(): void {
    this.barCount++;
    for (const i of this.effects.values()) {
      const p = this.index.effects.get(i.effectId)?.params;
      if (!p?.barSync || !p.bpmSync) continue;
      const bars = Math.max(1, Math.round(p.beatsPerCycle / 4));
      // A downbeat starts a cycle when the cycle fits in a bar, else only at the start of each phrase.
      if (p.beatsPerCycle <= 4 || this.barCount % bars === 0) i.phase = Math.round(i.phase);
    }
  }

  /** Audio beat: re-phase effects whose trigger is `beat`. */
  onBeat(): void {
    for (const i of this.effects.values()) if (this.index.effects.get(i.effectId)?.trigger === 'beat') i.phase = 0;
  }

  /* ---------------- AI layer / external layers ---------------- */

  setAiValues(values: FixtureValues, fadeSeconds: number): void {
    this.ai.setTarget(values, Math.max(0, fadeSeconds) * 1000, this.nextOrder());
  }
  releaseAi(): void { this.ai.clear(); }

  setExternal(id: string, data: { layer?: LayerInput; effects?: EffectOutput[] } | null): void {
    if (data) this.external.set(id, data);
    else this.external.delete(id);
  }

  /* ---------------- Timeline ---------------- */

  timelinePlay(id: string): boolean {
    if (!this.index.timelines.has(id)) return false;
    this.timeline.play(id);
    return true;
  }
  timelinePause(): void { this.timeline.pause(); }
  timelineStop(): void { this.timeline.stop(); }
  timelineSeek(s: number): void { this.timeline.seek(s); }
  /** Timecode chase: plays `id` and re-seeks when the playhead drifts more than 2 frames (80 ms) from `seconds`. */
  timelineChase(id: string, seconds: number): boolean {
    if (!this.index.timelines.has(id)) return false;
    if (this.timeline.timelineId !== id || this.timeline.state !== 'playing') this.timeline.play(id);
    if (Math.abs(this.timeline.timeMs / 1000 - seconds) > 0.08) this.timeline.seek(seconds);
    return true;
  }

  /* ---------------- Tick ---------------- */

  private collect(aiOverride?: FixtureValues): { layers: LayerInput[]; effects: EffectOutput[] } {
    const layers: LayerInput[] = [];
    const effects: EffectOutput[] = [];
    for (const pb of this.playbacks.values()) {
      if (pb.state === 'idle') continue;
      const list = this.index.cueLists.get(pb.cueListId);
      layers.push({ id: `pb:${pb.cueListId}`, label: list?.name ?? 'Cue list', kind: 'playback', priority: list?.priority ?? 50, order: pb.order, values: pb.current });
    }
    const aiValues = aiOverride ?? this.ai.values;
    if (Object.keys(aiValues).length) layers.push({ id: 'ai', label: 'IA', kind: 'ai', priority: this.settings.priorities.ai, order: aiOverride ? this.seq + 1 : this.ai.order, values: aiValues });
    const tl = this.timeline.timelineId ? this.index.timelines.get(this.timeline.timelineId) : undefined;
    const tv = this.timeline.evaluate(tl, this.index, this.bpm, this.settings.maxStrobeHz);
    if (Object.keys(tv.values).length) layers.push({ id: 'timeline', label: `Timeline · ${tl?.name ?? ''}`, kind: 'timeline', priority: this.settings.priorities.timeline, order: 0, values: tv.values });
    effects.push(...tv.effects);
    for (const inst of this.effects.values()) {
      const def = this.index.effects.get(inst.effectId);
      if (!def) continue;
      effects.push({ id: inst.instanceId, label: def.name, priority: def.priority, order: inst.order, blend: def.blend, values: computeEffect(def, inst.phase, this.index.resolveTargets(def.targets)) });
    }
    for (const ext of this.external.values()) {
      if (ext.layer) layers.push(ext.layer);
      if (ext.effects) effects.push(...ext.effects);
    }
    return { layers, effects };
  }

  /** Pure computation of the final state; `aiOverride` previews an AI proposal without touching outputs. */
  compute(aiOverride?: FixtureValues): { values: FixtureValues; sources: Record<string, Record<string, string>> } {
    const { layers, effects } = this.collect(aiOverride);
    const merged = mergeSources(layers, effects, this.programmer);
    const values: FixtureValues = {};
    const opts = { master: this.master, blackout: this.blackout, policy: this.settings.blackoutPolicy };
    for (const [fid, rf] of this.index.fixtures) values[fid] = finalizeFixture(rf, merged.values[fid], opts);
    return { values, sources: merged.sources };
  }

  renderUniverses(values: FixtureValues, target: Map<number, Uint8Array>): void {
    const count = this.index.project.show.universes;
    for (let u = 1; u <= count; u++) if (!target.has(u)) target.set(u, new Uint8Array(512));
    for (const buf of target.values()) buf.fill(0);
    for (const [fid, rf] of this.index.fixtures) {
      let buf = target.get(rf.fixture.universe);
      if (!buf) target.set(rf.fixture.universe, (buf = new Uint8Array(512)));
      renderFixture(rf, values[fid] ?? {}, buf, (attr) => this.special.has(`${fid}|${attr}`) && this.programmer[fid]?.[attr] !== undefined);
    }
  }

  private readonly tickHooks: ((dtMs: number) => void)[] = [];
  /** Registers a callback run at the start of every tick (audio reactions, etc.). */
  onBeforeTick(fn: (dtMs: number) => void): void {
    this.tickHooks.push(fn);
  }

  tick(dtMs: number): void {
    const t0 = performance.now();
    try {
      this.timeMs += dtMs;
      for (const h of this.tickHooks) h(dtMs);
      for (const pb of this.playbacks.values()) pb.tick(dtMs, this.index.cueLists.get(pb.cueListId), this.nextOrder);
      for (const [k, inst] of this.effects) {
        if (inst.paused) continue;
        const def = this.index.effects.get(inst.effectId);
        if (!def) { this.effects.delete(k); continue; }
        inst.elapsedMs += dtMs;
        inst.phase += (dtMs / 1000) * effectRate(def, this.bpm, this.settings.maxStrobeHz);
        if (def.duration !== null && inst.elapsedMs >= def.duration * 1000) this.effects.delete(k);
      }
      this.timeline.tick(dtMs, this.timeline.timelineId ? this.index.timelines.get(this.timeline.timelineId) : undefined, {
        cueGoto: (listId, i) => void this.cueGoto(listId, i),
      });
      this.ai.tick(dtMs);
      const { values, sources } = this.compute();
      if (this.settings.flashGuard === 'limit' && !this.blackout) limitFlashes(this.index.fixtures.values(), this.values, values, dtMs, this.programmer);
      this.values = values;
      this.sources = sources;
      this.renderUniverses(values, this.universes);
      this.sink.sendFrames(this.universes);
      this.emit('frame');
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
    this.recordTick(performance.now() - t0, dtMs);
  }

  private recordTick(ms: number, dtMs: number): void {
    const m = this.metricsState;
    const period = 1000 / this.settings.rateHz;
    m.ticks++;
    m.avgTick = m.avgTick === 0 ? ms : m.avgTick * 0.95 + ms * 0.05;
    m.maxTick = Math.max(m.maxTick, ms);
    if (this.timer) {
      m.jitter = m.jitter * 0.9 + Math.abs(dtMs - period) * 0.1;
      if (ms > period) m.overruns++;
    }
    const now = performance.now();
    if (m.windowStart === 0) m.windowStart = now;
    m.windowTicks++;
    if (now - m.windowStart >= 1000) {
      m.measuredHz = (m.windowTicks * 1000) / (now - m.windowStart);
      m.windowStart = now;
      m.windowTicks = 0;
      m.maxTick = ms;
    }
  }

  /**
   * Deadline scheduler: sleeps with setTimeout, waking early by the timer overshoot measured on this machine
   * (≈1 ms in Electron, up to ≈16 ms with coarse Windows timers), then yields with setImmediate (I/O and IPC still
   * run between iterations) until the deadline. Small lateness is absorbed by keeping the deadline grid; only a delay
   * longer than one period resynchronises (no burst of catch-up ticks after a stall).
   */
  start(): void {
    if (this.timer) return;
    let last = performance.now();
    let next = last;
    // Timer overshoot = max lateness of the last 64 wakes (starts pessimistic: coarse Windows timers ≈ 16 ms).
    const lates = new Array<number>(64).fill(16);
    let lateIdx = 0;
    let overshoot = 16;
    let sleptUntil = 0;
    const loop = () => {
      if (!this.timer) return; // stopped (possibly from inside a tick)
      const now = performance.now();
      if (sleptUntil) {
        lates[lateIdx] = Math.min(20, now - sleptUntil);
        lateIdx = (lateIdx + 1) % lates.length;
        overshoot = Math.max(...lates);
        sleptUntil = 0;
      }
      const wait = next - now;
      if (wait > 0.05) {
        const sleep = wait - overshoot - 0.5;
        if (sleep >= 1) {
          sleptUntil = now + sleep;
          this.timer = setTimeout(loop, sleep);
        } else this.timer = setImmediate(loop);
        return;
      }
      const dt = Math.min(250, now - last); // clamp after sleep/suspend to avoid jumps
      last = now;
      this.tick(dt);
      const period = 1000 / this.settings.rateHz;
      next += period;
      if (now - next > period) next = now + period;
      loop();
    };
    this.timer = setTimeout(loop, 0);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer as NodeJS.Timeout);
      clearImmediate(this.timer as NodeJS.Immediate);
    }
    this.timer = null;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  metrics(): EngineMetrics {
    const m = this.metricsState;
    const period = 1000 / this.settings.rateHz;
    return {
      ticks: m.ticks,
      rateHz: this.settings.rateHz,
      measuredHz: Math.round(m.measuredHz * 10) / 10,
      avgTickMs: Math.round(m.avgTick * 1000) / 1000,
      maxTickMs: Math.round(m.maxTick * 1000) / 1000,
      jitterMs: Math.round(m.jitter * 100) / 100,
      overruns: m.overruns,
      load: Math.round((m.avgTick / period) * 1000) / 1000,
    };
  }

  snapshot(): EngineSnapshot {
    const tl = this.timeline.timelineId ? this.index.timelines.get(this.timeline.timelineId) : undefined;
    return {
      time: this.timeMs / 1000,
      running: this.running,
      master: this.master,
      blackout: this.blackout,
      bpm: this.bpm,
      bpmSource: this.bpmSource,
      programmerCount: Object.keys(this.programmer).length,
      playbacks: [...this.playbacks.values()].map((pb) => pb.status(this.index.cueLists.get(pb.cueListId))),
      effects: [...this.effects.values()].map((i) => {
        const def = this.index.effects.get(i.effectId);
        return { instanceId: i.instanceId, effectId: i.effectId, name: def?.name ?? '?', owner: i.owner, paused: i.paused, elapsed: i.elapsedMs / 1000, duration: def?.duration ?? null };
      }),
      timeline: this.timeline.status(tl),
      aiActive: this.ai.active,
      metrics: this.metrics(),
    };
  }
}
