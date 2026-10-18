import { randomUUID } from 'node:crypto';
import type { Effect, FixtureValues, Project } from '../model/schemas';
import { effectParamsSchema } from '../model/schemas';
import { colorCapability, colorToAttributes, displayColor } from '../fixtures/color';
import { findModule, moduleDimmerKeys } from '../fixtures/modules';
import { coarseChannel, type ResolvedFixture } from '../fixtures/profiles';
import type { Engine } from '../engine/Engine';
import type { ProjectIndex } from '../engine/resolve';
import { hexToRgb, rgbToHex } from '../util/math';
import {
  aiActionSchema, MAX_ACTIONS_PER_PROPOSAL,
  type AiAction, type AiEffectSpec, type AiExecutionReport, type AiProposal, type AiTarget, type LookPart, type ValidatedAction,
} from './actions';
import { interpretLocally, normalize, type InterpreterContext } from './local/interpreter';
import { effectFlashViolation } from '../safety/flashGuard';
import type { LiveState } from './providers/openrouter';

/* ------------------------------------------------------------------ */
/* Target resolution & validation                                      */
/* ------------------------------------------------------------------ */

export function resolveAiTarget(index: ProjectIndex, t: AiTarget): { ids: string[]; problems: string[] } {
  const problems: string[] = [];
  const all = [...index.fixtures.values()];
  const explicit = new Set<string>();
  for (const gname of t.groupNames ?? []) {
    const g = [...index.groups.values()].find((x) => normalize(x.name) === normalize(gname));
    if (!g) problems.push(`Groupe inconnu « ${gname} »`);
    else g.fixtureIds.forEach((id) => explicit.add(id));
  }
  for (const fname of t.fixtureNames ?? []) {
    const f = all.find((x) => normalize(x.fixture.name) === normalize(fname));
    if (!f) problems.push(`Projecteur inconnu « ${fname} »`);
    else explicit.add(f.fixture.id);
  }
  let pool: ResolvedFixture[] = explicit.size ? all.filter((r) => explicit.has(r.fixture.id)) : all;
  const hasSelector = explicit.size > 0 || t.all === true;
  if (t.fixtureTypes?.length) pool = pool.filter((r) => t.fixtureTypes!.includes(r.profile.type));
  if (t.tags?.length) pool = pool.filter((r) => r.fixture.tags.some((tag) => t.tags!.map(normalize).includes(normalize(tag))));
  if (t.module) {
    const before = pool.length;
    pool = pool.filter((r) => findModule(r.profile, t.module!));
    if (before && !pool.length) problems.push(`Aucun projecteur ciblé n’a de module « ${t.module} »`);
  }
  if (!hasSelector && !t.fixtureTypes?.length && !t.tags?.length && problems.length) pool = [];
  let ids = pool.map((r) => r.fixture.id);
  if (t.limit) ids = ids.slice(0, t.limit);
  return { ids, problems };
}

const pct = (v: number) => `${Math.round(v * 100)} %`;

export interface ValidationContext {
  index: ProjectIndex;
  allowStrobe: boolean;
  maxStrobeHz: number;
}

function capable(index: ProjectIndex, ids: string[], test: (rf: ResolvedFixture) => boolean): { ok: string[]; skipped: string[] } {
  const ok: string[] = [], skipped: string[] = [];
  for (const id of ids) {
    const rf = index.fixtures.get(id);
    if (rf && test(rf)) ok.push(id);
    else if (rf) skipped.push(rf.fixture.name);
  }
  return { ok, skipped };
}

const hasColor = (rf: ResolvedFixture) => colorCapability(rf) !== 'none';
const hasPosition = (rf: ResolvedFixture) => rf.attributes.includes('pan') || rf.attributes.includes('tilt');

type BeamAction = Extract<AiAction, { type: 'setBeam' }>;
const BEAM_KEYS = ['zoom', 'focus', 'frost', 'iris'] as const;
const midRange = (r: { from: number; to: number }) => Math.round((r.from + r.to) / 2) / 255;

/** Beam request -> normalized values for one fixture, using the gobo/prism slots of its profile; unsupported fields are left out. */
export function beamToValues(rf: ResolvedFixture, a: Omit<BeamAction, 'type' | 'target' | 'fade'>): Record<string, number> {
  const v: Record<string, number> = {};
  const gobo = a.gobo !== undefined ? coarseChannel(rf.mode, 'gobo') : undefined;
  if (gobo && a.gobo !== undefined) {
    const r = a.gobo === 0 ? gobo.ranges.find((x) => x.kind === 'open') : gobo.ranges.filter((x) => x.kind === 'gobo')[a.gobo - 1];
    if (r) v.gobo = midRange(r);
    else if (a.gobo === 0) v.gobo = 0;
  }
  const prism = a.prism !== undefined ? coarseChannel(rf.mode, 'prism') : undefined;
  if (prism && a.prism !== undefined) {
    const r = prism.ranges.find((x) => (a.prism ? x.kind !== 'open' && x.kind !== 'closed' : x.kind === 'open'));
    v.prism = r ? midRange(r) : a.prism ? 1 : 0;
  }
  for (const k of BEAM_KEYS) if (a[k] !== undefined && rf.attributes.includes(k)) v[k] = a[k];
  return v;
}

function checkEffect(spec: AiEffectSpec, ctx: ValidationContext, messages: string[]): string[] | null {
  const { ids, problems } = resolveAiTarget(ctx.index, spec.target);
  messages.push(...problems);
  if (spec.target.module) messages.push(`Les effets s’appliquent au projecteur entier, pas seulement au module « ${spec.target.module} »`);
  if (spec.effectType === 'strobe' && !ctx.allowStrobe) {
    messages.push('Strobe interdit par les paramètres de sécurité (Paramètres › Sécurité)');
    return null;
  }
  if (spec.effectType === 'strobe' && (spec.speed ?? 0) > ctx.maxStrobeHz) messages.push(`Fréquence limitée à ${ctx.maxStrobeHz} Hz par la sécurité`);
  let test: ((rf: ResolvedFixture) => boolean) | null = null;
  if (spec.effectType === 'panTilt' || spec.effectType === 'randomMove') test = hasPosition;
  if (spec.effectType === 'rainbow' || spec.effectType === 'colorCycle') test = hasColor;
  const { ok, skipped } = test ? capable(ctx.index, ids, test) : { ok: ids, skipped: [] };
  if (skipped.length) messages.push(`Ignorés (capacité absente) : ${skipped.join(', ')}`);
  if (!ok.length) {
    messages.push('Aucun projecteur compatible avec cet effet');
    return null;
  }
  return ok;
}

function checkLook(look: LookPart[], ctx: ValidationContext, messages: string[]): string[] {
  const all: string[] = [];
  for (const part of look) {
    const { ids, problems } = resolveAiTarget(ctx.index, part.target);
    messages.push(...problems);
    if ((part.color || part.colors) && ids.length) {
      const { skipped } = capable(ctx.index, ids, hasColor);
      if (skipped.length) messages.push(`Sans couleur (ignorée) : ${skipped.join(', ')}`);
    }
    all.push(...ids);
  }
  return [...new Set(all)];
}

function describe(a: AiAction): string {
  switch (a.type) {
    case 'setIntensity': return `Intensité ${pct(a.level)} (fondu ${a.fade} s)`;
    case 'setColor': return `Couleur ${a.color ?? a.colors?.join(' / ')} (fondu ${a.fade} s)`;
    case 'setPosition': return `Position pan ${a.pan !== undefined ? pct(a.pan) : '–'} / tilt ${a.tilt !== undefined ? pct(a.tilt) : '–'}`;
    case 'startEffect': return `Effet ${a.effect.effectType} « ${a.effect.name} »${a.effect.bpmSync ? ' (BPM)' : ''}`;
    case 'setBeam': return `Faisceau ${[a.gobo !== undefined ? (a.gobo ? `gobo ${a.gobo}` : 'gobo ouvert') : '', a.prism !== undefined ? (a.prism ? 'prisme' : 'sans prisme') : '', ...BEAM_KEYS.map((k) => (a[k] !== undefined ? `${k} ${pct(a[k])}` : ''))].filter(Boolean).join(', ')} (fondu ${a.fade} s)`;
    case 'adjustEffect': return `${a.speedFactor >= 1 ? 'Accélérer' : 'Ralentir'} les effets IA${a.effectType ? ` (${a.effectType})` : a.effectName ? ` « ${a.effectName} »` : ''} ×${a.speedFactor}`;
    case 'stopEffect': return `Arrêt d’effets IA${a.effectType ? ` (${a.effectType})` : a.effectName ? ` « ${a.effectName} »` : ''}`;
    case 'createScene': return `Créer la scène « ${a.name} »${a.apply ? ' et l’appliquer' : ''}`;
    case 'applyScene': return `Appliquer la scène « ${a.sceneName} »`;
    case 'createCue': return `Créer le cue « ${a.name} » dans « ${a.cueListName} »`;
    case 'createSequence': return `Créer la séquence « ${a.name} » (${a.cues.length} cues)`;
    case 'setBpm': return `BPM ${a.bpm}`;
    case 'releaseAi': return 'Relâcher la couche IA';
  }
}

export function validateActions(raws: readonly unknown[], ctx: ValidationContext): ValidatedAction[] {
  const pendingScenes = new Set<string>();
  const sceneExists = (name: string) => pendingScenes.has(normalize(name)) || [...ctx.index.scenes.values()].some((s) => normalize(s.name) === normalize(name));
  return raws.slice(0, MAX_ACTIONS_PER_PROPOSAL).map((raw, index): ValidatedAction => {
    const parsed = aiActionSchema.safeParse(raw);
    if (!parsed.success) {
      const type = typeof raw === 'object' && raw && 'type' in raw ? String((raw as { type: unknown }).type) : '?';
      const known = aiActionSchema.options.some((o) => o.shape.type.value === type);
      return {
        index, status: 'rejected', action: null, raw, fixtureIds: [],
        summary: known ? `Action « ${type} » invalide` : `Commande IA inconnue « ${type} »`,
        messages: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'action'} : ${i.message}`),
      };
    }
    const a = parsed.data;
    const messages: string[] = [];
    let ids: string[] = [];
    let rejected = false;
    switch (a.type) {
      case 'setIntensity': {
        const r = resolveAiTarget(ctx.index, a.target);
        messages.push(...r.problems);
        ids = r.ids;
        break;
      }
      case 'setColor': {
        const r = resolveAiTarget(ctx.index, a.target);
        messages.push(...r.problems);
        const c = capable(ctx.index, r.ids, hasColor);
        if (c.skipped.length) messages.push(`Sans capacité couleur (ignorés) : ${c.skipped.join(', ')}`);
        ids = c.ok;
        break;
      }
      case 'setPosition': {
        const r = resolveAiTarget(ctx.index, a.target);
        messages.push(...r.problems);
        if (a.pan === undefined && a.tilt === undefined) { messages.push('Ni pan ni tilt fourni'); rejected = true; }
        const c = capable(ctx.index, r.ids, hasPosition);
        if (c.skipped.length) messages.push(`Sans pan/tilt (ignorés) : ${c.skipped.join(', ')}`);
        ids = c.ok;
        break;
      }
      case 'setBeam': {
        const r = resolveAiTarget(ctx.index, a.target);
        messages.push(...r.problems);
        const { type: _t, target: _g, fade: _f, ...fields } = a;
        if (!Object.keys(fields).length) { messages.push('Aucun paramètre de faisceau fourni'); rejected = true; }
        const c = capable(ctx.index, r.ids, (rf) => Object.keys(beamToValues(rf, fields)).length > 0);
        if (c.skipped.length) messages.push(`Sans ce réglage de faisceau (ignorés) : ${c.skipped.join(', ')}`);
        if (a.gobo) {
          const missing = r.ids.map((id) => ctx.index.fixtures.get(id)!).filter((rf) => rf.attributes.includes('gobo') && beamToValues(rf, { gobo: a.gobo }).gobo === undefined);
          if (missing.length) messages.push(`Gobo ${a.gobo} absent de la roue : ${missing.map((rf) => rf.fixture.name).join(', ')}`);
        }
        ids = c.ok;
        break;
      }
      case 'startEffect': {
        const ok = checkEffect(a.effect, ctx, messages);
        if (!ok) rejected = true;
        else ids = ok;
        break;
      }
      case 'createScene':
        ids = checkLook(a.look, ctx, messages);
        pendingScenes.add(normalize(a.name));
        break;
      case 'applyScene':
      case 'createCue':
        if (!sceneExists(a.sceneName)) { messages.push(`Scène « ${a.sceneName} » introuvable`); rejected = true; }
        break;
      case 'createSequence':
        for (const cue of a.cues) {
          ids.push(...checkLook(cue.look, ctx, messages));
          for (const fx of cue.effects) if (!checkEffect(fx, ctx, messages)) messages.push(`Effet « ${fx.name} » retiré du cue « ${cue.name} »`);
        }
        ids = [...new Set(ids)];
        break;
      default:
        break;
    }
    const needsFixtures = !['stopEffect', 'adjustEffect', 'applyScene', 'createCue', 'setBpm', 'releaseAi'].includes(a.type);
    if (needsFixtures && !rejected && ids.length === 0) {
      messages.push('Aucun projecteur ciblé ne prend en charge cette action');
      rejected = true;
    }
    return { index, status: rejected ? 'rejected' : messages.length ? 'warning' : 'ok', action: a, raw, summary: describe(a), messages, fixtureIds: ids };
  });
}

/* ------------------------------------------------------------------ */
/* Look -> values                                                      */
/* ------------------------------------------------------------------ */

export function lookToValues(index: ProjectIndex, look: readonly LookPart[]): FixtureValues {
  const out: FixtureValues = {};
  for (const part of look) {
    const { ids } = resolveAiTarget(index, part.target);
    const colors = part.colors ?? (part.color ? [part.color] : []);
    ids.forEach((id, i) => {
      const rf = index.fixtures.get(id);
      if (!rf) return;
      const v = (out[id] ??= {});
      const mod = part.target.module ? findModule(rf.profile, part.target.module) : undefined;
      if (part.level !== undefined) for (const k of mod ? moduleDimmerKeys(rf, mod) : ['dimmer']) v[k] = part.level;
      const c = colors[i % Math.max(1, colors.length)];
      if (c) Object.assign(v, colorToAttributes(rf, hexToRgb(c), undefined, mod));
      if (part.pan !== undefined && rf.attributes.includes('pan')) v.pan = part.pan;
      if (part.tilt !== undefined && rf.attributes.includes('tilt')) v.tilt = part.tilt;
    });
  }
  return out;
}

function mergeInto(target: FixtureValues, src: FixtureValues): void {
  for (const [fid, attrs] of Object.entries(src)) target[fid] = { ...(target[fid] ?? {}), ...attrs };
}

function immediateValues(index: ProjectIndex, a: AiAction, ids: string[], pendingScenes: Map<string, FixtureValues>): FixtureValues | null {
  const allowed = new Set(ids);
  switch (a.type) {
    case 'setIntensity':
      return filterIds(lookToValues(index, [{ target: a.target, level: a.level }]), allowed);
    case 'setColor':
      return filterIds(lookToValues(index, [{ target: a.target, ...(a.color ? { color: a.color } : {}), ...(a.colors ? { colors: a.colors } : {}) }]), allowed);
    case 'setPosition':
      return filterIds(lookToValues(index, [{ target: a.target, ...(a.pan !== undefined ? { pan: a.pan } : {}), ...(a.tilt !== undefined ? { tilt: a.tilt } : {}) }]), allowed);
    case 'createScene': {
      const v = lookToValues(index, a.look);
      pendingScenes.set(normalize(a.name), v);
      return a.apply ? v : null;
    }
    case 'setBeam': {
      const { type: _t, target: _g, fade: _f, ...fields } = a;
      return Object.fromEntries(ids.flatMap((id) => {
        const rf = index.fixtures.get(id);
        const v = rf ? beamToValues(rf, fields) : {};
        return Object.keys(v).length ? [[id, v]] : [];
      }));
    }
    case 'applyScene': {
      const pending = pendingScenes.get(normalize(a.sceneName));
      if (pending) return pending;
      const s = [...index.scenes.values()].find((x) => normalize(x.name) === normalize(a.sceneName));
      return s ? structuredClone(s.values) : null;
    }
    default:
      return null;
  }
}

function filterIds(v: FixtureValues, allowed: Set<string>): FixtureValues {
  return Object.fromEntries(Object.entries(v).filter(([id]) => allowed.has(id)));
}

export function previewValues(index: ProjectIndex, validated: readonly ValidatedAction[]): FixtureValues {
  const out: FixtureValues = {};
  const pending = new Map<string, FixtureValues>();
  for (const v of validated) {
    if (v.status === 'rejected' || !v.action) continue;
    const vals = immediateValues(index, v.action, v.fixtureIds, pending);
    if (vals) mergeInto(out, vals);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Proposal creation                                                   */
/* ------------------------------------------------------------------ */

export function interpreterContext(index: ProjectIndex, engine: Engine, allowStrobe: boolean): InterpreterContext {
  const current: InterpreterContext['current'] = {};
  for (const [id, rf] of index.fixtures) {
    const d = displayColor(rf, engine.values[id] ?? {});
    current[id] = { color: rgbToHex(d.color), level: d.intensity };
  }
  return {
    fixtures: [...index.fixtures.values()].map((rf) => ({ id: rf.fixture.id, name: rf.fixture.name, type: rf.profile.type, attributes: rf.attributes, modules: rf.profile.modules.map((m) => m.name) })),
    groups: [...index.groups.values()].map((g) => ({ name: g.name, members: g.fixtureIds.map((id) => index.fixtures.get(id)?.fixture.name).filter((n): n is string => !!n) })),
    scenes: [...index.scenes.values()].map((s) => s.name),
    current,
    allowStrobe,
  };
}

/** Current look and running AI effects, given to a remote model so relative requests (« plus chaud », « ralentis ») work. */
export function liveState(index: ProjectIndex, engine: Engine): LiveState {
  const aiEffects = engine.snapshot().effects.filter((e) => e.owner === 'ai').flatMap((e) => {
    const d = index.effects.get(e.effectId);
    return d ? [{ name: d.name, type: d.type, speed: d.params.speed, bpmSync: d.params.bpmSync, beatsPerCycle: d.params.beatsPerCycle }] : [];
  });
  return { current: interpreterContext(index, engine, false).current, aiEffects };
}

export function buildProposal(args: {
  prompt: string; provider: AiProposal['provider']; model: string | null; understanding: string; notices: string[]; rawActions: unknown[]; ctx: ValidationContext;
}): AiProposal {
  const actions = validateActions(args.rawActions, args.ctx);
  const notices = [...args.notices];
  if (args.rawActions.length > MAX_ACTIONS_PER_PROPOSAL) notices.push(`Proposition tronquée à ${MAX_ACTIONS_PER_PROPOSAL} actions`);
  return {
    id: randomUUID(),
    prompt: args.prompt,
    provider: args.provider,
    model: args.model,
    understanding: args.understanding,
    notices,
    actions,
    preview: previewValues(args.ctx.index, actions),
    createdAt: new Date().toISOString(),
  };
}

export function proposeLocally(prompt: string, ctx: ValidationContext, engine: Engine): AiProposal {
  const r = interpretLocally(prompt, interpreterContext(ctx.index, engine, ctx.allowStrobe));
  return buildProposal({ prompt, provider: 'local', model: null, understanding: r.understanding, notices: r.notices, rawActions: r.actions, ctx });
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

export interface ExecutionContext {
  index(): ProjectIndex;
  /** Applies a validated mutation to the project and refreshes the engine index synchronously. */
  mutate(fn: (draft: Project) => void): void;
  engine: Engine;
  maxStrobeHz: number;
}

function uniqueName(existing: Iterable<string>, name: string): string {
  const set = new Set([...existing].map(normalize));
  if (!set.has(normalize(name))) return name;
  for (let i = 2; ; i++) if (!set.has(normalize(`${name} (${i})`))) return `${name} (${i})`;
}

function effectFromSpec(index: ProjectIndex, spec: AiEffectSpec, trigger: Effect['trigger'], maxStrobeHz: number): Effect {
  const { ids } = resolveAiTarget(index, spec.target);
  const params = effectParamsSchema.parse({
    ...(spec.speed !== undefined ? { speed: spec.effectType === 'strobe' ? Math.min(spec.speed, maxStrobeHz) : spec.speed } : {}),
    ...(spec.bpmSync !== undefined ? { bpmSync: spec.bpmSync } : {}),
    ...(spec.beatsPerCycle !== undefined ? { beatsPerCycle: spec.beatsPerCycle } : {}),
    ...(spec.amplitude !== undefined ? { amplitude: spec.amplitude } : {}),
    ...(spec.offset !== undefined ? { offset: spec.offset } : {}),
    ...(spec.phaseSpread !== undefined ? { phaseSpread: spec.phaseSpread } : spec.effectType === 'chase' || spec.effectType === 'rainbow' ? { phaseSpread: 1 } : {}),
    ...(spec.shape !== undefined ? { shape: spec.shape } : {}),
    ...(spec.colors ? { colors: spec.colors } : {}),
  });
  return {
    id: randomUUID(), name: spec.name, type: spec.effectType, targets: { fixtureIds: ids, groupIds: [] }, params,
    priority: 50, blend: 'override', duration: spec.duration ?? null, trigger, origin: 'ai',
  };
}

/**
 * Flash guard for AI proposals: every effect the proposal starts immediately is simulated for 3 s on top of the
 * previewed state; effects that would exceed the photosensitive flash limit are rejected (mutates the proposal).
 */
export function guardProposalFlashes(proposal: AiProposal, index: ProjectIndex, engine: Engine, maxStrobeHz: number): number {
  const base = engine.compute(proposal.preview).values;
  let rejected = 0;
  for (const v of proposal.actions) {
    if (v.status === 'rejected' || v.action?.type !== 'startEffect') continue;
    const r = effectFlashViolation(index, base, effectFromSpec(index, v.action.effect, 'manual', maxStrobeHz), engine.bpm, maxStrobeHz);
    if (!r.violation) continue;
    v.status = 'rejected';
    v.messages.push(`Garde-fou photosensible : ${r.reason} — effet refusé`);
    rejected++;
  }
  return rejected;
}

function effectMatches(def: Effect, a: { effectType?: string; effectName?: string }): boolean {
  if (a.effectType) return def.type === a.effectType;
  if (a.effectName) return normalize(def.name) === normalize(a.effectName);
  return true;
}

export function executeProposal(proposal: AiProposal, ctx: ExecutionContext): AiExecutionReport {
  const report: AiExecutionReport = {
    proposalId: proposal.id, executed: [], skipped: [],
    verification: { checked: 0, matched: 0, overriddenByManual: 0, mismatches: [] },
    created: { scenes: [], cueLists: [], effects: [] },
  };
  const aiValues: FixtureValues = {};
  let fade = 0;
  const pending = new Map<string, FixtureValues>();
  const { engine } = ctx;

  for (const v of proposal.actions) {
    if (v.status === 'rejected' || !v.action) {
      report.skipped.push({ index: v.index, summary: v.summary, reason: v.messages.join(' ; ') || 'Action invalide' });
      continue;
    }
    const a = v.action;
    const index = ctx.index();
    try {
      switch (a.type) {
        case 'setIntensity':
        case 'setColor':
        case 'setPosition':
        case 'setBeam':
        case 'applyScene': {
          const vals = immediateValues(index, a, v.fixtureIds, pending);
          if (!vals) throw new Error('Rien à appliquer');
          mergeInto(aiValues, vals);
          fade = Math.max(fade, a.fade);
          report.executed.push({ index: v.index, summary: v.summary, detail: `${Object.keys(vals).length} projecteur(s) dans la couche IA` });
          break;
        }
        case 'createScene': {
          const values = lookToValues(index, a.look);
          const name = uniqueName([...index.scenes.values()].map((s) => s.name), a.name);
          ctx.mutate((d) => { d.scenes.push({ id: randomUUID(), name, notes: `Créée par l’IA : ${proposal.prompt}`.slice(0, 500), values, origin: 'ai' }); });
          pending.set(normalize(a.name), values);
          report.created.scenes.push(name);
          if (a.apply) { mergeInto(aiValues, values); fade = Math.max(fade, a.fade); }
          report.executed.push({ index: v.index, summary: v.summary, detail: `Scène « ${name} » (${Object.keys(values).length} projecteurs)` });
          break;
        }
        case 'startEffect': {
          const def = effectFromSpec(index, a.effect, 'manual', ctx.maxStrobeHz);
          ctx.mutate((d) => { d.effects.push(def); });
          const inst = engine.startEffect(def.id, 'ai');
          if (!inst) throw new Error('Le moteur a refusé l’effet');
          report.created.effects.push(def.name);
          report.executed.push({ index: v.index, summary: v.summary, detail: `Effet démarré sur ${def.targets.fixtureIds.length} projecteur(s)` });
          break;
        }
        case 'stopEffect': {
          let n = 0;
          for (const e of engine.snapshot().effects) {
            if (e.owner !== 'ai') continue;
            const def = index.effects.get(e.effectId);
            if (a.all || (def && effectMatches(def, a))) { engine.stopEffect(e.instanceId); n++; }
          }
          report.executed.push({ index: v.index, summary: v.summary, detail: `${n} effet(s) arrêté(s)` });
          break;
        }
        case 'adjustEffect': {
          const running = new Set(engine.snapshot().effects.filter((e) => e.owner === 'ai').map((e) => e.effectId));
          const defs = [...index.effects.values()].filter((d) => running.has(d.id) && effectMatches(d, a));
          if (!defs.length) throw new Error('Aucun effet IA correspondant en cours');
          ctx.mutate((d) => {
            for (const e of d.effects) {
              if (!defs.some((x) => x.id === e.id)) continue;
              // BPM-synced effects are timed in beats: fewer beats per cycle = faster.
              if (e.params.bpmSync) e.params.beatsPerCycle = Math.min(64, Math.max(0.25, e.params.beatsPerCycle / a.speedFactor));
              else e.params.speed = Math.min(e.type === 'strobe' ? ctx.maxStrobeHz : 30, Math.max(0.01, e.params.speed * a.speedFactor));
            }
          });
          report.executed.push({ index: v.index, summary: v.summary, detail: `${defs.length} effet(s) ajusté(s)` });
          break;
        }
        case 'createCue': {
          const scene = [...index.scenes.values()].find((s) => normalize(s.name) === normalize(a.sceneName));
          if (!scene) throw new Error(`Scène « ${a.sceneName} » introuvable`);
          ctx.mutate((d) => {
            let list = d.cueLists.find((l) => normalize(l.name) === normalize(a.cueListName));
            if (!list) {
              list = { id: randomUUID(), name: a.cueListName, priority: 50, loop: false, cues: [] };
              d.cueLists.push(list);
              report.created.cueLists.push(list.name);
            }
            const number = (list.cues.at(-1)?.number ?? 0) + 1;
            list.cues.push({
              id: randomUUID(), number, name: a.name, description: 'Créé par l’IA', sceneId: scene.id, fade: a.fade, delay: 0, curve: 'linear',
              trigger: a.followAfter !== null ? { type: 'follow', wait: a.followAfter } : { type: 'manual' }, effectIds: [],
            });
          });
          report.executed.push({ index: v.index, summary: v.summary, detail: 'Cue ajouté' });
          break;
        }
        case 'createSequence': {
          const listName = uniqueName([...index.cueLists.values()].map((l) => l.name), a.name);
          ctx.mutate((d) => {
            const listId = randomUUID();
            const cues = a.cues.map((c, i) => {
              const sceneId = randomUUID();
              d.scenes.push({ id: sceneId, name: uniqueName(d.scenes.map((s) => s.name), `${listName} · ${c.name}`), notes: 'Créée par l’IA', values: lookToValues(index, c.look), origin: 'ai' });
              const effectIds = c.effects
                .filter((fx) => fx.effectType !== 'strobe' || ctx.maxStrobeHz > 0)
                .map((fx) => {
                  const def = effectFromSpec(index, fx, 'cue', ctx.maxStrobeHz);
                  if (!def.targets.fixtureIds.length) return null;
                  d.effects.push(def);
                  report.created.effects.push(def.name);
                  return def.id;
                })
                .filter((x): x is string => !!x);
              const prev = a.cues[i - 1];
              return {
                id: randomUUID(), number: i + 1, name: c.name, description: 'Créé par l’IA', sceneId, fade: c.fade, delay: 0, curve: 'easeInOut' as const,
                trigger: prev && prev.hold !== null ? { type: 'follow' as const, wait: prev.hold } : { type: 'manual' as const },
                effectIds,
              };
            });
            d.cueLists.push({ id: listId, name: listName, priority: 50, loop: a.loop, cues });
          });
          report.created.cueLists.push(listName);
          report.executed.push({ index: v.index, summary: v.summary, detail: `Liste « ${listName} » créée — lancez-la avec GO depuis Cues & Sequences` });
          break;
        }
        case 'setBpm':
          engine.bpm = a.bpm;
          engine.bpmSource = 'manual';
          ctx.mutate((d) => { d.show.bpm = a.bpm; });
          report.executed.push({ index: v.index, summary: v.summary, detail: `BPM = ${a.bpm}` });
          break;
        case 'releaseAi':
          engine.releaseAi();
          for (const e of engine.snapshot().effects) if (e.owner === 'ai') engine.stopEffect(e.instanceId);
          report.executed.push({ index: v.index, summary: v.summary, detail: 'Couche IA et effets IA relâchés' });
          break;
      }
    } catch (err) {
      report.skipped.push({ index: v.index, summary: v.summary, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  if (Object.keys(aiValues).length) {
    engine.setAiValues(aiValues, fade);
    // Verify against the engine's merge: does the AI layer actually own each requested attribute?
    const { sources } = engine.compute(aiValues);
    for (const [fid, attrs] of Object.entries(aiValues)) {
      for (const attr of Object.keys(attrs)) {
        report.verification.checked++;
        const src = sources[fid]?.[attr];
        const name = ctx.index().fixtures.get(fid)?.fixture.name ?? fid;
        if (src === 'IA') report.verification.matched++;
        else if (src === 'Manuel') report.verification.overriddenByManual++;
        else report.verification.mismatches.push(`${name}.${attr} contrôlé par « ${src ?? 'aucune source'} »`);
      }
    }
  }
  return report;
}
