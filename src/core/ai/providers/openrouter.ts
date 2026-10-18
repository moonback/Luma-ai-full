import { z } from 'zod';
import { EFFECT_TYPES, FIXTURE_TYPES, hexColorSchema, SHOW_BEAMS, SHOW_EFFECTS, SHOW_MOVEMENTS, showSectionPlanSchema, type ShowSectionPlan } from '../../model/schemas';
import { clamp } from '../../util/math';
import { parseIntent } from '../../music/songToShow';
import type { ProjectIndex } from '../../engine/resolve';
import { baseAttribute } from '../../fixtures/attributes';
import { coarseChannel } from '../../fixtures/profiles';
import { BRAND } from '../../../shared/brand';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_OPENROUTER_MODEL = 'openrouter/auto';

/*
 * Loose output schema sent to the model (flat optional fields, no numeric bounds).
 * The model's output is NEVER trusted: every action is re-validated with the strict `aiActionSchema`.
 */
const target = z.object({
  all: z.boolean().optional(),
  groupNames: z.array(z.string()).optional(),
  fixtureNames: z.array(z.string()).optional(),
  fixtureTypes: z.array(z.enum(FIXTURE_TYPES)).optional(),
  limit: z.number().optional(),
  module: z.string().optional(),
});
const look = z.object({ target, level: z.number().optional(), color: z.string().optional(), colors: z.array(z.string()).optional(), pan: z.number().optional(), tilt: z.number().optional() });
const effect = z.object({
  name: z.string(), effectType: z.enum(EFFECT_TYPES), target,
  speed: z.number().optional(), bpmSync: z.boolean().optional(), beatsPerCycle: z.number().optional(), amplitude: z.number().optional(),
  offset: z.number().optional(), phaseSpread: z.number().optional(), colors: z.array(z.string()).optional(),
  shape: z.enum(['circle', 'figure8', 'pan', 'tilt']).optional(),
});
const llmAction = z.object({
  type: z.enum(['setIntensity', 'setColor', 'setPosition', 'setBeam', 'startEffect', 'stopEffect', 'adjustEffect', 'createScene', 'applyScene', 'createCue', 'createSequence', 'setBpm', 'releaseAi']),
  target: target.optional(),
  level: z.number().optional(),
  color: z.string().optional(),
  colors: z.array(z.string()).optional(),
  pan: z.number().optional(),
  tilt: z.number().optional(),
  fade: z.number().optional(),
  effect: effect.optional(),
  effectName: z.string().optional(),
  effectType: z.enum(EFFECT_TYPES).optional(),
  all: z.boolean().optional(),
  name: z.string().optional(),
  look: z.array(look).optional(),
  apply: z.boolean().optional(),
  sceneName: z.string().optional(),
  cueListName: z.string().optional(),
  followAfter: z.number().optional(),
  loop: z.boolean().optional(),
  cues: z.array(z.object({ name: z.string(), look: z.array(look), fade: z.number().optional(), hold: z.number().optional(), effects: z.array(effect).optional() })).optional(),
  bpm: z.number().optional(),
  gobo: z.number().optional(),
  prism: z.boolean().optional(),
  zoom: z.number().optional(),
  focus: z.number().optional(),
  frost: z.number().optional(),
  iris: z.number().optional(),
  speedFactor: z.number().optional(),
});
export const llmPlanSchema = z.object({ understanding: z.string(), actions: z.array(llmAction) });
const PLAN_JSON_SCHEMA = z.toJSONSchema(llmPlanSchema);

const SYSTEM_PROMPT = `You are the lighting director assistant inside a DMX lighting console.
You translate the operator's request into a short list of structured actions. You never output DMX values, code or commands outside the schema.

Rules:
- Answer with ONE JSON object only (no prose, no code fence) matching this JSON Schema:
${JSON.stringify(PLAN_JSON_SCHEMA)}
- Values are normalized 0..1 (level, pan, tilt, amplitude, offset, phaseSpread). Colours are "#RRGGBB". Fades/holds are seconds. speed is cycles per second.
- Target fixtures only by the exact group names, fixture names or fixture types listed in the rig description. {"all": true} targets the whole rig.
- Multi-head fixtures list their "modules" (e.g. main head + LED ring). Add "module": "<module name>" to a target to change only that head's colour/intensity.
- Only use capabilities the fixtures have (see attributes). Movement effects (panTilt, randomMove) need pan/tilt. Colour effects need colour attributes.
- Never touch reset, lamp or other special/control functions; they are not available to you.
- Strobe effects are only allowed when the rig description says strobeAllowed: true.
- setBeam changes beam attributes of fixtures that have them: gobo = slot number on the gobo wheel (0 = open, see "gobos" for the slot count), prism true/false, zoom 0 (narrow) .. 1 (wide), focus/frost/iris 0..1.
- The rig description gives the current look ("now": colour and level of lit fixtures) and "runningAiEffects": use them for relative requests (warmer, dimmer, slower...). adjustEffect re-times running AI effects (speedFactor > 1 faster, < 1 slower; filter with effectType or effectName); stopEffect stops them.
- To recall an existing scene use applyScene with its exact name from "scenes"; do not recreate it.
- Use setIntensity/setColor/setPosition for immediate changes, createScene (apply true to show it) for a reusable look, createSequence for timed or multi-step shows (hold = seconds before auto-advancing, omit for manual GO), startEffect for dynamic effects.
- "understanding" is one or two sentences in French describing what you will do and any limitation (e.g. you cannot hear the music).
- Keep proposals small and focused; at most 20 actions. Omit optional fields you do not need.`;

/** What is on stage right now: display colour/level per fixture id, and the AI effects running. */
export interface LiveState {
  current: Record<string, { color: string; level: number }>;
  aiEffects: { name: string; type: string; speed: number; bpmSync: boolean; beatsPerCycle: number }[];
}

export function describeRig(index: ProjectIndex, allowStrobe: boolean, bpm: number, live?: LiveState): string {
  return JSON.stringify({
    strobeAllowed: allowStrobe,
    bpm,
    fixtures: [...index.fixtures.values()].map((rf) => {
      const now = live?.current[rf.fixture.id];
      const gobos = coarseChannel(rf.mode, 'gobo')?.ranges.filter((r) => r.kind === 'gobo').length;
      return {
        name: rf.fixture.name,
        type: rf.profile.type,
        attributes: [...new Set(rf.attributes.map(baseAttribute))].filter((a) => a !== 'control' && a !== 'macro'),
        ...(rf.profile.modules.length ? { modules: rf.profile.modules.map((m) => m.name) } : {}),
        ...(gobos ? { gobos } : {}),
        ...(now && now.level > 0.01 ? { now: { color: now.color, level: Math.round(now.level * 100) / 100 } } : {}),
      };
    }),
    ...(live ? { runningAiEffects: live.aiEffects } : {}),
    groups: [...index.groups.values()].map((g) => ({ name: g.name, size: g.fixtureIds.length })),
    scenes: [...index.scenes.values()].map((s) => s.name),
    cueLists: [...index.cueLists.values()].map((c) => c.name),
  });
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

const modelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  context_length: z.number().nullable().optional(),
  pricing: z.object({ prompt: z.string().optional(), completion: z.string().optional() }).partial().optional(),
  supported_parameters: z.array(z.string()).optional(),
});
export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength: number | null;
  /** USD per million tokens (null when unknown). */
  promptPrice: number | null;
  completionPrice: number | null;
  structuredOutputs: boolean;
  jsonMode: boolean;
  reasoning: boolean;
}

const perMillion = (s: string | undefined) => (s !== undefined && Number.isFinite(Number(s)) ? Math.round(Number(s) * 1e6 * 1000) / 1000 : null);

export function parseModels(json: unknown): OpenRouterModel[] {
  const data = z.object({ data: z.array(z.unknown()) }).parse(json).data;
  const out: OpenRouterModel[] = [];
  for (const raw of data) {
    const m = modelSchema.safeParse(raw);
    if (!m.success) continue;
    const p = m.data.supported_parameters ?? [];
    out.push({
      id: m.data.id,
      name: m.data.name ?? m.data.id,
      contextLength: m.data.context_length ?? null,
      promptPrice: perMillion(m.data.pricing?.prompt),
      completionPrice: perMillion(m.data.pricing?.completion),
      structuredOutputs: p.includes('structured_outputs'),
      jsonMode: p.includes('response_format'),
      reasoning: p.includes('reasoning'),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export class OpenRouterError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

type FetchLike = typeof fetch;

async function request(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new OpenRouterError('Délai dépassé', null);
    throw new OpenRouterError(`Connexion impossible (réseau indisponible ?) : ${(err as Error).message}`, null);
  } finally {
    clearTimeout(t);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } } | null)?.error?.message ?? text.slice(0, 200);
    const hint = res.status === 401 ? 'Clé API refusée' : res.status === 402 ? 'Crédits OpenRouter insuffisants' : res.status === 429 ? 'Limite de débit atteinte, réessayez plus tard' : res.status === 404 ? 'Modèle introuvable' : `Erreur API ${res.status}`;
    throw new OpenRouterError(`${hint}${msg ? ` : ${msg}` : ''}`, res.status);
  }
  return body;
}

export async function listOpenRouterModels(opts: { timeoutMs: number; fetchImpl?: FetchLike }): Promise<OpenRouterModel[]> {
  const body = await request(opts.fetchImpl ?? fetch, `${OPENROUTER_URL}/models`, { method: 'GET' }, opts.timeoutMs);
  return parseModels(body);
}

/* ------------------------------------------------------------------ */
/* Completion                                                          */
/* ------------------------------------------------------------------ */

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  effort: 'low' | 'medium' | 'high';
  timeoutMs: number;
  /** Capabilities of the chosen model when known (from the models list). */
  capabilities?: Pick<OpenRouterModel, 'structuredOutputs' | 'jsonMode' | 'reasoning'>;
  fetchImpl?: FetchLike;
}

export interface ProviderResult {
  understanding: string;
  actions: unknown[];
  model: string;
  notices: string[];
}

/** Strips undefined/null fields so the strict schema sees clean objects. */
function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && x !== null).map(([k, x]) => [k, clean(x)]));
  return v;
}

/** Extracts the JSON object from a model answer (tolerates code fences or surrounding prose). */
export function extractJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const a = trimmed.indexOf('{'), b = trimmed.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(trimmed.slice(a, b + 1));
      } catch {
        // fall through
      }
    }
    throw new OpenRouterError('Réponse IA sans objet JSON valide', null);
  }
}

/** One chat completion constrained to a JSON object (as far as the model supports it); returns the parsed object. */
async function completeJson(system: string, user: string, schemaName: string, jsonSchema: unknown, opts: OpenRouterOptions): Promise<{ json: unknown; model: string; notices: string[] }> {
  const caps = opts.capabilities;
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: 8000,
    temperature: 0.3,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  // Constrain the output format only as far as the chosen model supports it; the prompt always carries the schema.
  if (caps?.structuredOutputs) body.response_format = { type: 'json_schema', json_schema: { name: schemaName, strict: false, schema: jsonSchema } };
  else if (caps?.jsonMode) body.response_format = { type: 'json_object' };
  if (caps?.reasoning) body.reasoning = { effort: opts.effort };

  const json = await request(opts.fetchImpl ?? fetch, `${OPENROUTER_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json', 'X-Title': BRAND.productName },
    body: JSON.stringify(body),
  }, opts.timeoutMs);

  const parsed = z
    .object({ model: z.string().optional(), choices: z.array(z.object({ finish_reason: z.string().nullable().optional(), message: z.object({ content: z.string().nullable().optional() }) })).min(1) })
    .safeParse(json);
  if (!parsed.success) {
    const err = (json as { error?: { message?: string } } | null)?.error?.message;
    throw new OpenRouterError(err ? `Erreur du fournisseur : ${err}` : 'Réponse OpenRouter inattendue', null);
  }
  const choice = parsed.data.choices[0]!;
  if (choice.finish_reason === 'length') throw new OpenRouterError('Réponse IA tronquée (limite de longueur)', null);
  if (!choice.message.content) throw new OpenRouterError('Réponse IA vide (refus ou filtre du modèle)', null);
  const model = parsed.data.model ?? opts.model;
  const notices: string[] = [];
  if (opts.model === DEFAULT_OPENROUTER_MODEL || model !== opts.model) notices.push(`Réponse servie par ${model}`);
  if (!caps) notices.push('Capacités du modèle inconnues : format JSON demandé par consigne uniquement.');
  // Many models emit null for optional fields: drop them before validating.
  return { json: clean(extractJson(choice.message.content)), model, notices };
}

export async function proposeWithOpenRouter(prompt: string, rig: string, opts: OpenRouterOptions): Promise<ProviderResult> {
  const r = await completeJson(`${SYSTEM_PROMPT}\n\nRig description:\n${rig}`, prompt, 'lighting_plan', PLAN_JSON_SCHEMA, opts);
  const plan = llmPlanSchema.safeParse(r.json);
  if (!plan.success) throw new OpenRouterError(`Réponse IA non conforme au schéma : ${plan.error.issues[0]?.path.join('.')} ${plan.error.issues[0]?.message}`, null);
  return { understanding: plan.data.understanding, actions: plan.data.actions, model: r.model, notices: r.notices };
}

/* ------------------------------------------------------------------ */
/* Song-to-Show planning                                               */
/* ------------------------------------------------------------------ */

const llmShowSchema = z.object({
  summary: z.string(),
  sections: z.array(z.object({
    index: z.number(),
    energy: z.number(),
    palette: z.array(z.string()),
    layers: z.object({ wash: z.boolean(), moving: z.boolean(), bars: z.boolean() }),
    movement: z.enum(SHOW_MOVEMENTS),
    effect: z.enum(SHOW_EFFECTS),
    beam: z.enum(SHOW_BEAMS),
    effectBeats: z.number(),
    accents: z.boolean(),
  })),
});
/** What is actually parsed: sections are repaired field by field rather than rejected as a whole. */
const looseShowSchema = z.object({ summary: z.string().catch(''), sections: z.array(z.record(z.string(), z.unknown())).min(1) });
const SHOW_JSON_SCHEMA = z.toJSONSchema(llmShowSchema);

const SHOW_SYSTEM = `You are the lighting designer assistant of a DMX console. You plan a light show for one song, section by section.
You only see the song's symbolic structure (sections, durations, measured energy, tempo, key), never the audio.
Answer with ONE JSON object only (no prose, no code fence) matching this JSON Schema:
${JSON.stringify(SHOW_JSON_SCHEMA)}
Rules:
- Exactly one entry per section, same index as given, in order.
- energy: integer 0 (almost dark) to 5 (maximum). Follow the operator's intent first, then the song's dynamics.
- palette: 1 to 4 colours "#RRGGBB". Sections that are repeats of the same music should share a palette.
- layers: which fixture families are lit (only families present in the rig).
- movement: none | slow | sweep | fast (moving heads only). effect: none | wave | pulse | chase | rainbow | strobe.
- beam (moving heads with gobo/prism/frost): open | gobo | prism (gobo + prism, for peaks) | frost (soft, for calm parts).
- effectBeats: effect cycle in beats (0.5 to 16). Use strobe ONLY if strobeAllowed is true AND the operator asked for it.
- accents: flash on detected impacts (true only for high-energy sections).
- "summary": one or two sentences in French describing the show.`;

/**
 * Repairs one LLM section: numbers are rounded/clamped, invalid colours dropped, and every field still missing or
 * invalid is taken from `fallback` (the local plan). Returns the names of the replaced fields.
 */
export function repairShowSection(raw: Record<string, unknown>, fallback: ShowSectionPlan, index: number): { section: ShowSectionPlan; fixed: string[] } {
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  const energy = num(raw.energy), beats = num(raw.effectBeats);
  const candidate: Record<string, unknown> = {
    ...raw, index, locked: false, note: '',
    energy: energy === undefined ? undefined : clamp(Math.round(energy), 0, 5),
    effectBeats: beats === undefined ? undefined : clamp(beats, 0.5, 16),
    palette: Array.isArray(raw.palette) ? raw.palette.filter((c) => hexColorSchema.safeParse(c).success).slice(0, 4) : undefined,
  };
  const section: Record<string, unknown> = { ...fallback, index, locked: false, note: '' };
  const fixed: string[] = [];
  for (const [key, schema] of Object.entries(showSectionPlanSchema.shape)) {
    const r = candidate[key] === undefined ? null : schema.safeParse(candidate[key]);
    if (r?.success) section[key] = r.data;
    else fixed.push(key);
  }
  return { section: section as ShowSectionPlan, fixed };
}

/**
 * Plans a show with an LLM. Sections are repaired one by one against `fallback` (the local plan, one entry per
 * section): missing sections and invalid fields come from it, a strobe the operator did not ask for is removed.
 * Only an unusable answer (no sections at all) throws.
 */
export async function planShowWithOpenRouter(intent: string, structure: string, opts: OpenRouterOptions, fallback: ShowSectionPlan[]): Promise<{ summary: string; sections: ShowSectionPlan[]; model: string; notices: string[] }> {
  const r = await completeJson(SHOW_SYSTEM, `Operator intent: ${intent || '(none)'}\n\n${structure}`, 'show_plan', SHOW_JSON_SCHEMA, opts);
  const loose = looseShowSchema.safeParse(r.json);
  if (!loose.success) throw new OpenRouterError(`Plan IA non conforme : ${loose.error.issues[0]?.path.join('.')} ${loose.error.issues[0]?.message}`, null);
  const notices = [...r.notices];
  const fixedNotes: string[] = [];
  const strobeWanted = parseIntent(intent).strobe === 'want';
  const sections = fallback.map((fb, i) => {
    const raw = loose.data.sections[i];
    if (!raw) return { ...fb, index: i, locked: false, note: '' };
    const { section, fixed } = repairShowSection(raw, fb, i);
    if (section.effect === 'strobe' && !strobeWanted) { section.effect = 'chase'; fixed.push('strobe non demandé → chase'); }
    if (fixed.length) fixedNotes.push(`${i + 1} (${fixed.join(', ')})`);
    return section;
  });
  const missing = fallback.length - Math.min(fallback.length, loose.data.sections.length);
  if (missing) notices.push(`Plan IA incomplet : ${missing} section(s) sur ${fallback.length} complétée(s) par les règles locales`);
  if (loose.data.sections.length > fallback.length) notices.push(`Plan IA : ${loose.data.sections.length - fallback.length} section(s) en trop ignorée(s)`);
  if (fixedNotes.length) notices.push(`Plan IA corrigé (champs invalides repris des règles locales) : section ${fixedNotes.join(' ; ')}`);
  return { summary: loose.data.summary.slice(0, 1000) || 'Plan IA', sections, model: r.model, notices };
}
