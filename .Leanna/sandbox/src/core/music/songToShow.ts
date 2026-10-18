import { randomUUID } from 'node:crypto';
import type { Effect, FixtureValues, Scene, ShowPlan, ShowSectionPlan, SongAnalysis, Timeline, TimelineEvent } from '../model/schemas';
import { effectParamsSchema, type SectionLabel } from '../model/schemas';
import type { ProjectIndex } from '../engine/resolve';
import type { ResolvedFixture } from '../fixtures/profiles';
import { colorCapability, colorCells, colorToAttributes } from '../fixtures/color';
import { hexToRgb } from '../util/math';
import { COLORS, normalize } from '../ai/local/interpreter';
import { effectFlashViolation } from '../safety/flashGuard';
import { SECTION_NAMES } from './analyze';

/**
 * Song-to-Show: (1) a planner produces a typed show plan per section (energy, palette, layers, movement, effect) from
 * the song structure and the operator's intent — locally by rules, or by an LLM whose output is validated against the
 * same schema; (2) a deterministic compiler turns the plan into scenes, bar-synced effects and a timeline aligned on
 * the analysed downbeats, within the rig's real capabilities and the safety rules (strobe permission, flash guard).
 */

export interface RigInfo {
  wash: number;
  moving: number;
  bars: number;
  allowStrobe: boolean;
}

type Layer = 'wash' | 'moving' | 'bars';
export function fixtureLayer(rf: ResolvedFixture): Layer {
  if (rf.attributes.includes('pan') || rf.attributes.includes('tilt')) return 'moving';
  if (rf.profile.type === 'led-bar' || colorCells(rf).length > 1) return 'bars';
  return 'wash';
}

export function rigInfo(index: ProjectIndex, allowStrobe: boolean): RigInfo {
  const r = { wash: 0, moving: 0, bars: 0, allowStrobe };
  for (const rf of index.fixtures.values()) r[fixtureLayer(rf)]++;
  return r;
}

/* ---------------- Intent ---------------- */

const LABEL_ENERGY: Record<SectionLabel, number> = { intro: 1, verse: 2, prechorus: 3, build: 3, chorus: 4, drop: 5, break: 1, bridge: 2, outro: 1 };
const WARM = ['#FFB000', '#FF4FA0', '#FF7000', '#FF2A00'];
const COLD = ['#2040FF', '#8B00FF', '#00C8FF', '#00E5A0'];

export interface Intent {
  verseShift: number;
  peakShift: number;
  globalShift: number;
  strobe: 'forbid' | 'want' | 'auto';
  noMovement: boolean;
  colors: string[];
  warmth: 'warm' | 'cold' | null;
}

const has = (t: string, re: RegExp) => re.test(t);

export function parseIntent(text: string): Intent {
  const t = normalize(text);
  const calm = /\b(sobre|sobres|calme|calmes|doux|douce|intime|discret|discrete|leger|legere)\b/;
  const big = /\b(explos\w*|energique\w*|puissant\w*|intense\w*|enorme\w*|fort|forte|pechu\w*|massif\w*)\b/;
  const verseCalm = has(t, new RegExp(`couplets?\\b[^,.;]*${calm.source}`)) || has(t, new RegExp(`${calm.source}[^,.;]*couplets?`));
  const peakBig = has(t, new RegExp(`(refrains?|drops?)\\b[^,.;]*${big.source}`)) || has(t, new RegExp(`${big.source}[^,.;]*(refrains?|drops?)`));
  const noStrobe = has(t, /\b(pas de|sans|aucun|no)\s+strobe/);
  const colors: string[] = [];
  for (const c of COLORS) if (c.forms.some((f) => has(t, new RegExp(`\\b${normalize(f)}\\b`)))) colors.push(c.hex);
  return {
    verseShift: verseCalm ? -1 : 0,
    peakShift: peakBig ? 1 : 0,
    globalShift: !verseCalm && !peakBig ? (has(t, calm) ? -1 : has(t, big) ? 1 : 0) : 0,
    strobe: noStrobe ? 'forbid' : has(t, /\bstrobe\b/) ? 'want' : 'auto',
    noMovement: has(t, /\b(sans|pas de|aucun)\s+mouvements?\b|\bfixes?\b/),
    colors,
    warmth: has(t, /\b(chaud|chaude|chaleureu\w*|warm)\b/) ? 'warm' : has(t, /\b(froid|froide|glacial\w*|cold)\b/) ? 'cold' : null,
  };
}

/* ---------------- Local planner ---------------- */

const clampE = (e: number) => Math.max(0, Math.min(5, Math.round(e)));

function sectionPlan(index: number, energy: number, palette: string[], rig: RigInfo, intent: Intent, variant: number, label: SectionLabel): ShowSectionPlan {
  const peak = label === 'chorus' || label === 'drop';
  const movement = intent.noMovement || energy <= 1 ? 'none' : energy === 2 ? 'slow' : energy === 3 ? 'sweep' : 'fast';
  const alt = (variant + index) % 2 === 0;
  let effect: ShowSectionPlan['effect'] = 'none', effectBeats = 4;
  if (energy === 2) { effect = 'wave'; effectBeats = 8; }
  else if (energy === 3) { effect = alt ? 'pulse' : 'chase'; effectBeats = 2; }
  else if (energy === 4) { effect = alt ? 'chase' : 'pulse'; effectBeats = 1; }
  else if (energy >= 5) { effect = 'chase'; effectBeats = 1; }
  if (label === 'drop' && rig.allowStrobe && intent.strobe === 'want') effect = 'strobe';
  if (label === 'bridge' && energy >= 2) { effect = 'rainbow'; effectBeats = 16; }
  return {
    index, energy,
    palette: peak ? palette.slice(0, 2) : palette.slice(0, energy >= 3 ? 2 : 1),
    layers: { wash: rig.wash > 0 || (rig.bars === 0 && rig.moving === 0), moving: rig.moving > 0 && (energy >= 2 || peak), bars: rig.bars > 0 && energy >= 2 },
    movement, effect, effectBeats, accents: energy >= 4, locked: false, note: '',
  };
}

export function planLocally(analysis: SongAnalysis, intentText: string, rig: RigInfo, variant = 0, previous?: ShowPlan | null): ShowPlan {
  const intent = parseIntent(intentText);
  const base = intent.colors.length ? intent.colors : intent.warmth === 'cold' || (!intent.warmth && analysis.key.mode === 'minor') ? COLD : WARM;
  const accent = (intent.warmth === 'cold' || (!intent.warmth && analysis.key.mode === 'minor') ? WARM : COLD)[variant % 4]!;
  const sections = analysis.sections.map((s, i): ShowSectionPlan => {
    const kept = previous?.sections[i];
    if (kept?.locked && previous!.sections.length === analysis.sections.length) return kept;
    const label = s.label;
    let e = 0.6 * LABEL_ENERGY[label] + 0.4 * s.energy * 5 + intent.globalShift;
    if (label === 'verse' || label === 'intro' || label === 'outro') e += intent.verseShift;
    if (label === 'chorus' || label === 'drop') e += intent.peakShift;
    // Same music (cluster) → same palette, rotated by the variant.
    const rot = (s.cluster + variant) % base.length;
    const palette = [...base.slice(rot), ...base.slice(0, rot)];
    if ((label === 'chorus' || label === 'drop') && !intent.colors.length) palette.splice(1, 0, accent);
    return sectionPlan(i, clampE(e), palette.slice(0, 4), rig, intent, variant, label);
  });
  const peaks = analysis.sections.filter((s) => s.label === 'chorus' || s.label === 'drop').length;
  return {
    intent: intentText.slice(0, 500), provider: 'local', model: null, variant,
    summary: `${sections.length} sections, ${peaks} temps fort(s) ; palette ${intent.colors.length ? 'demandée' : intent.warmth ?? (analysis.key.mode === 'minor' ? 'froide (tonalité mineure)' : 'chaude (tonalité majeure)')}${intent.strobe === 'forbid' ? ', sans strobe' : ''}${intent.noMovement ? ', sans mouvement' : ''}.`,
    sections,
  };
}

/** Local edit of one section from a short instruction ("plus chaud", "plus calme", "en rouge", "sans mouvement"…). */
export function adjustSection(s: ShowSectionPlan, instruction: string, rig: RigInfo): ShowSectionPlan {
  const t = normalize(instruction);
  const out: ShowSectionPlan = { ...s, palette: [...s.palette], layers: { ...s.layers }, note: instruction.slice(0, 200) };
  if (has(t, /\bplus (calme|doux|sobre)|moins (fort|energique|intense)/)) out.energy = clampE(s.energy - 1);
  if (has(t, /\bplus (fort|energique|intense|puissant)|moins (calme|sobre)|explos/)) out.energy = clampE(s.energy + 1);
  if (has(t, /\bplus chaud|chaleureu/)) out.palette = WARM.slice(0, Math.max(1, s.palette.length));
  if (has(t, /\bplus froid|glacial/)) out.palette = COLD.slice(0, Math.max(1, s.palette.length));
  const colors = COLORS.filter((c) => c.forms.some((f) => has(t, new RegExp(`\\b${normalize(f)}\\b`)))).map((c) => c.hex);
  if (colors.length) out.palette = colors.slice(0, 4);
  if (has(t, /\b(sans|pas de) mouvement/)) out.movement = 'none';
  else if (has(t, /\bplus de mouvement|bouge/)) out.movement = out.energy >= 4 ? 'fast' : 'sweep';
  if (has(t, /\b(sans|pas de) strobe/) && out.effect === 'strobe') out.effect = 'chase';
  else if (has(t, /\bstrobe\b/) && rig.allowStrobe) out.effect = 'strobe';
  if (out.energy !== s.energy && !colors.length && out.effect !== 'strobe') {
    const fresh = sectionPlan(s.index, out.energy, out.palette, rig, parseIntent(''), 0, out.energy >= 4 ? 'chorus' : 'verse');
    Object.assign(out, { effect: fresh.effect, effectBeats: fresh.effectBeats, accents: fresh.accents, layers: fresh.layers, movement: out.movement === 'none' && s.movement === 'none' ? 'none' : fresh.movement });
  }
  return out;
}

/* ---------------- Compiler ---------------- */

export interface CompileResult {
  scenes: Scene[];
  effects: Effect[];
  timeline: Timeline;
  notices: string[];
}

const LEVEL = [0.12, 0.3, 0.5, 0.7, 0.85, 1];

function sceneValues(index: ProjectIndex, s: ShowSectionPlan): FixtureValues {
  const v: FixtureValues = {};
  let i = 0;
  for (const rf of index.fixtures.values()) {
    const layer = fixtureLayer(rf);
    const on = s.layers[layer];
    const out: Record<string, number> = { dimmer: on ? LEVEL[s.energy]! : 0 };
    if (colorCapability(rf) !== 'none') {
      const cells = colorCells(rf);
      if (cells.length > 1) cells.forEach((c, k) => Object.assign(out, colorToAttributes(rf, hexToRgb(s.palette[(i + k) % s.palette.length]!), c)));
      else Object.assign(out, colorToAttributes(rf, hexToRgb(s.palette[i % s.palette.length]!)));
    }
    if (layer === 'moving') {
      // Static focus spread across the stage; movement effects swing around it.
      if (rf.attributes.includes('pan')) out.pan = 0.5 + ((i % 3) - 1) * 0.12;
      if (rf.attributes.includes('tilt')) out.tilt = 0.62;
    }
    v[rf.fixture.id] = out;
    i++;
  }
  return v;
}

function idsOf(index: ProjectIndex, layers: Layer[]): string[] {
  return [...index.fixtures.values()].filter((rf) => layers.includes(fixtureLayer(rf))).map((rf) => rf.fixture.id);
}

function effectFor(index: ProjectIndex, name: string, s: ShowSectionPlan, maxStrobeHz: number): Effect | null {
  const lights = idsOf(index, (['wash', 'bars'] as Layer[]).filter((l) => s.layers[l]));
  if (!lights.length || s.effect === 'none') return null;
  const base = { id: randomUUID(), name, targets: { fixtureIds: lights, groupIds: [] }, priority: 50, duration: null, trigger: 'manual' as const, origin: 'ai' as const };
  const sync = { bpmSync: true, beatsPerCycle: s.effectBeats, barSync: true };
  switch (s.effect) {
    case 'wave': return { ...base, type: 'dimmerWave', blend: 'scale', params: effectParamsSchema.parse({ ...sync, offset: 0.7, amplitude: 0.6, phaseSpread: 1 }) };
    case 'pulse': return { ...base, type: 'pulse', blend: 'scale', params: effectParamsSchema.parse({ ...sync, offset: 0.65, amplitude: 0.7 }) };
    case 'chase': return { ...base, type: 'chase', blend: 'scale', params: effectParamsSchema.parse({ ...sync, offset: 0.5, amplitude: 1, phaseSpread: 1 }) };
    case 'rainbow': return { ...base, type: 'rainbow', blend: 'override', params: effectParamsSchema.parse({ ...sync, phaseSpread: 1 }) };
    case 'strobe': return { ...base, type: 'strobe', blend: 'scale', params: effectParamsSchema.parse({ speed: Math.min(maxStrobeHz, 8), offset: 0.5, amplitude: 1 }) };
  }
}

function moveFor(index: ProjectIndex, name: string, s: ShowSectionPlan): Effect | null {
  const ids = s.layers.moving ? idsOf(index, ['moving']) : [];
  if (!ids.length || s.movement === 'none') return null;
  const m = { slow: [16, 0.3], sweep: [8, 0.5], fast: [4, 0.7] }[s.movement];
  return {
    id: randomUUID(), name, type: 'panTilt', targets: { fixtureIds: ids, groupIds: [] }, priority: 50, blend: 'override', duration: null, trigger: 'manual', origin: 'ai',
    params: effectParamsSchema.parse({ bpmSync: true, beatsPerCycle: m[0], amplitude: m[1], phaseSpread: 0.5, shape: s.movement === 'fast' ? 'figure8' : 'circle', barSync: true }),
  };
}

export function compileShow(index: ProjectIndex, trackName: string, analysis: SongAnalysis, plan: ShowPlan, opts: { maxStrobeHz: number; allowStrobe: boolean }): CompileResult {
  const scenes: Scene[] = [];
  const effects: Effect[] = [];
  const events: TimelineEvent[] = [];
  const notices: string[] = [];
  const beat = 60 / analysis.bpm;
  const short = trackName.slice(0, 40);
  const ev = (e: Omit<TimelineEvent, 'id' | 'cueIndex' | 'lane'> & { lane?: number }): TimelineEvent => ({ id: randomUUID(), cueIndex: 0, lane: 0, ...e });

  const fades = analysis.sections.map((sec, i) => {
    const p = plan.sections[i]!, prev = plan.sections[i - 1];
    if (!prev) return 0;
    if (sec.label === 'drop') return 0; // hard cut on the drop
    return p.energy > prev.energy ? beat : Math.min(4 * beat * 2, sec.end - sec.start); // rise: 1 beat, fall: 2 bars
  });

  analysis.sections.forEach((sec, i) => {
    const p = plan.sections[i];
    if (!p) return;
    const label = `${String(i + 1).padStart(2, '0')} ${SECTION_NAMES[sec.label]}`;
    const scene: Scene = { id: randomUUID(), name: `${short} · ${label}`.slice(0, 80), notes: plan.intent.slice(0, 500), values: sceneValues(index, p), origin: 'ai' };
    scenes.push(scene);
    const nextFade = fades[i + 1] ?? 0;
    // Overlap with the next section by its fade: this scene holds while the next one fades in (crossfade).
    events.push(ev({ kind: 'scene', refId: scene.id, start: sec.start, duration: sec.end - sec.start + nextFade, fade: fades[i]!, fadeOut: 0, label }));
    let fx = effectFor(index, `${short} · ${label} · effet`.slice(0, 80), p, opts.maxStrobeHz);
    if (fx?.type === 'strobe' && !opts.allowStrobe) {
      notices.push(`${label} : strobe non autorisé (Paramètres › IA) — remplacé par un chase`);
      fx = effectFor(index, fx.name, { ...p, effect: 'chase' }, opts.maxStrobeHz);
    }
    if (fx) {
      const check = effectFlashViolation(index, scene.values, fx, analysis.bpm, opts.maxStrobeHz);
      if (check.violation) {
        notices.push(`${label} : ${check.reason} — effet remplacé par une pulsation lente (garde-fou photosensible)`);
        fx = effectFor(index, fx.name, { ...p, effect: 'pulse', effectBeats: 4 }, opts.maxStrobeHz);
      }
    }
    for (const e of [fx, moveFor(index, `${short} · ${label} · mouvement`.slice(0, 80), p)]) {
      if (!e) continue;
      effects.push(e);
      events.push(ev({ kind: 'effect', refId: e.id, start: sec.start, duration: sec.end - sec.start, fade: 0, label: e.name.slice(-40), lane: 1 }));
    }
  });

  // Accents: a short full-white hit on detected impacts inside accented sections (decays over one beat).
  const impacts = analysis.events.filter((e) => e.kind === 'impact' && analysis.sections.some((s, i) => plan.sections[i]?.accents && e.t >= s.start && e.t < s.end));
  if (impacts.length) {
    const accent: Scene = { id: randomUUID(), name: `${short} · accent`.slice(0, 80), notes: '', values: {}, origin: 'ai' };
    for (const rf of index.fixtures.values()) accent.values[rf.fixture.id] = { dimmer: 1, ...(colorCapability(rf) !== 'none' ? colorToAttributes(rf, { r: 1, g: 1, b: 1 }) : {}) };
    scenes.push(accent);
    for (const e of impacts) events.push(ev({ kind: 'scene', refId: accent.id, start: e.t, duration: beat, fade: 0, fadeOut: beat, label: 'Accent', lane: 2 }));
  }
  const timeline: Timeline = { id: randomUUID(), name: `Show · ${short}`.slice(0, 80), duration: Math.max(1, Math.ceil(analysis.duration)), loop: false, events };
  return { scenes, effects, timeline, notices };
}
