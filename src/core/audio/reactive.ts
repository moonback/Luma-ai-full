import type { AudioConfig, FixtureValues } from '../model/schemas';
import { colorToAttributes } from '../fixtures/color';
import type { Engine } from '../engine/Engine';
import type { ProjectIndex } from '../engine/resolve';
import { hexToRgb, lerp } from '../util/math';
import type { AudioFeatures } from './analyzer';
import type { Prediction } from '../music/dropPredictor';

export interface AudioStatus {
  active: boolean;
  source: 'none' | 'live' | 'simulated' | 'track';
  level: number;
  energy: number;
  bpm: number | null;
  bpmConfidence: number;
  lastOnsetAt: number | null;
  lastEnergyRiseAt: number | null;
  tempoLocked: boolean;
  barPosition: number | null;
  prediction: Prediction | null;
  /** Predicted-drop GO armed (one shot) and, when scheduled, ms until it fires. */
  dropArmed: boolean;
  dropFiresInMs: number | null;
}

const STALE_MS = 1000;

/**
 * Applies the user-enabled audio reactions to the engine. Every reaction is opt-in and individually disabled
 * by default; with no fresh features (source stopped) all audio contributions are released.
 */
export class AudioReactive {
  private features: AudioFeatures | null = null;
  private receivedAt = 0;
  private flash = 0;
  private source: AudioStatus['source'] = 'none';
  private lastOnsetAt: number | null = null;
  private lastRiseAt: number | null = null;
  private dropArmed = false;
  private dropAt: number | null = null;
  private movePhase = 0;
  /** Called when the armed drop GO fires (for logging). */
  onDropFired: ((cueListId: string) => void) | null = null;

  constructor(
    private readonly engine: Engine,
    private readonly getIndex: () => ProjectIndex,
    private readonly getConfig: () => AudioConfig,
    private readonly priority: () => number,
    private readonly now: () => number = Date.now,
  ) {
    engine.onBeforeTick((dt) => this.update(dt));
  }

  push(f: AudioFeatures, source: 'live' | 'simulated' | 'track'): void {
    this.features = f;
    this.receivedAt = this.now();
    this.source = source;
    const r = this.getConfig().reactions;
    if (f.onset) {
      this.lastOnsetAt = this.receivedAt;
      this.engine.onBeat();
      if (r.beatFlash.enabled) this.flash = 1;
    }
    if (f.beat && f.barPosition === 0) this.engine.onDownbeat();
    this.scheduleDrop(f);
    if (f.energyRise) {
      this.lastRiseAt = this.receivedAt;
      if (r.energyRiseGo.enabled && r.energyRiseGo.cueListId) this.engine.cueGo(r.energyRiseGo.cueListId);
    }
    if (r.bpmFollow.enabled && f.bpm && f.bpmConfidence >= r.bpmFollow.minConfidence) {
      this.engine.bpm = f.bpm;
      this.engine.bpmSource = 'audio';
    }
  }

  armDrop(on: boolean): void {
    this.dropArmed = on;
    if (!on) this.dropAt = null;
  }

  /** Converts the prediction's time (renderer clock) to this clock and keeps the latest estimate. */
  private scheduleDrop(f: AudioFeatures): void {
    const cfg = this.getConfig().reactions.dropGo;
    const p = f.prediction;
    if (!this.dropArmed || !cfg.enabled || !cfg.cueListId) return;
    if (p && cfg.kinds.includes(p.kind) && p.confidence >= cfg.minConfidence) this.dropAt = this.receivedAt + (p.at - f.t) * 1000;
    else if (this.dropAt !== null && this.dropAt - this.receivedAt > 600) this.dropAt = null; // prediction withdrawn well before the time
  }

  private update(dtMs: number): void {
    const cfgDrop = this.getConfig().reactions.dropGo;
    if (this.dropArmed && this.dropAt !== null && this.now() >= this.dropAt && cfgDrop.cueListId) {
      this.engine.cueGo(cfgDrop.cueListId);
      this.dropArmed = false; // one shot: re-arm explicitly for the next drop
      this.dropAt = null;
      this.onDropFired?.(cfgDrop.cueListId);
    }
    const fresh = this.features && this.now() - this.receivedAt < STALE_MS;
    if (!fresh) {
      this.engine.setExternal('audio', null);
      if (this.engine.bpmSource === 'audio') this.engine.bpmSource = 'manual';
      this.source = this.features ? this.source : 'none';
      return;
    }
    const f = this.features!;
    const cfg = this.getConfig().reactions;
    const index = this.getIndex();
    const prio = this.priority();
    const layer: FixtureValues = {};
    const scale: FixtureValues = {};
    if (cfg.beatFlash.enabled) {
      this.flash *= Math.exp(-dtMs / 1000 / cfg.beatFlash.decay);
      for (const rf of index.resolveTargets(cfg.beatFlash.targets)) (layer[rf.fixture.id] ??= {}).dimmer = this.flash;
    }
    if (cfg.energyToColor.enabled) {
      const lo = hexToRgb(cfg.energyToColor.lowColor), hi = hexToRgb(cfg.energyToColor.highColor);
      const e = Math.min(1, f.energy * 1.5);
      const rgb = { r: lerp(lo.r, hi.r, e), g: lerp(lo.g, hi.g, e), b: lerp(lo.b, hi.b, e) };
      for (const rf of index.resolveTargets(cfg.energyToColor.targets)) Object.assign((layer[rf.fixture.id] ??= {}), colorToAttributes(rf, rgb));
    }
    if (cfg.levelToIntensity.enabled) {
      const k = cfg.levelToIntensity.floor + (1 - cfg.levelToIntensity.floor) * Math.min(1, f.energy * 1.5);
      for (const rf of index.resolveTargets(cfg.levelToIntensity.targets)) scale[rf.fixture.id] = { dimmer: k };
    }
    const fl = cfg.followers;
    if (fl.intensityFromBass.enabled) {
      const k = 1 - fl.intensityFromBass.amount + fl.intensityFromBass.amount * Math.min(1, f.bass * 1.4);
      for (const rf of index.resolveTargets(fl.intensityFromBass.targets)) scale[rf.fixture.id] = { dimmer: (scale[rf.fixture.id]?.dimmer ?? 1) * k };
    }
    if (fl.colorFromBrightness.enabled) {
      const lo = hexToRgb(fl.colorFromBrightness.darkColor), hi = hexToRgb(fl.colorFromBrightness.brightColor);
      const b = Math.min(1, f.brightness * 2);
      const rgb = { r: lerp(lo.r, hi.r, b), g: lerp(lo.g, hi.g, b), b: lerp(lo.b, hi.b, b) };
      for (const rf of index.resolveTargets(fl.colorFromBrightness.targets)) Object.assign((layer[rf.fixture.id] ??= {}), colorToAttributes(rf, rgb));
    }
    if (fl.moveFromOnsets.enabled) {
      // One circle per bar; the radius follows the onset density (busy music = wide movement).
      this.movePhase += (dtMs / 1000) * (this.engine.bpm / 60 / 4) * Math.PI * 2;
      const r = fl.moveFromOnsets.amount * f.onsetDensity * 0.5;
      for (const rf of index.resolveTargets(fl.moveFromOnsets.targets)) {
        if (!rf.attributes.includes('pan') && !rf.attributes.includes('tilt')) continue;
        Object.assign((layer[rf.fixture.id] ??= {}), { pan: 0.5 + r * Math.cos(this.movePhase), tilt: 0.5 + r * Math.sin(this.movePhase) });
      }
    }
    this.engine.setExternal('audio', {
      layer: Object.keys(layer).length ? { id: 'audio', label: 'Audio', kind: 'audio', priority: prio, order: 0, values: layer } : undefined,
      effects: Object.keys(scale).length ? [{ id: 'audio-level', label: 'Audio · niveau', priority: prio, order: 0, blend: 'scale', values: scale }] : [],
    });
  }

  status(): AudioStatus {
    const f = this.features;
    const active = !!f && this.now() - this.receivedAt < STALE_MS;
    return {
      active,
      source: active ? this.source : 'none',
      level: active ? f!.level : 0,
      energy: active ? f!.energy : 0,
      bpm: active ? f!.bpm : null,
      bpmConfidence: active ? f!.bpmConfidence : 0,
      lastOnsetAt: this.lastOnsetAt,
      lastEnergyRiseAt: this.lastRiseAt,
      tempoLocked: active ? f!.tempoLocked : false,
      barPosition: active ? f!.barPosition : null,
      prediction: active ? f!.prediction : null,
      dropArmed: this.dropArmed,
      dropFiresInMs: this.dropAt === null ? null : Math.max(0, this.dropAt - this.now()),
    };
  }
}
