import type { FixtureType } from '../../model/schemas';
import { hexToRgb, hsvToRgb, rgbToHex, rgbToHsv } from '../../util/math';
import type { AiAction, AiEffectSpec, AiTarget, LookPart } from '../actions';

/**
 * Deterministic, rule-based command interpreter (French + basic English). Works offline, without any model.
 * It recognises a documented set of intents and templates; it does NOT pretend to be a language model:
 * anything it does not recognise is reported as such.
 */

export interface InterpreterContext {
  fixtures: { id: string; name: string; type: FixtureType; attributes: string[]; modules?: string[] }[];
  groups: { name: string; members?: string[] }[];
  /** Names of the project's scenes, so « applique la scène X » recalls it instead of creating a new one. */
  scenes?: string[];
  /** Current computed look per fixture (display colour + intensity). */
  current: Record<string, { color: string; level: number }>;
  allowStrobe: boolean;
}

export interface InterpretResult {
  understanding: string;
  actions: AiAction[];
  notices: string[];
  recognized: boolean;
}

export const normalize = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, ' ');

const NUMBER_WORDS: Record<string, number> = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  onze: 11, douze: 12, quinze: 15, vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60,
  one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20, thirty: 30,
};
const NUM = `(\\d+(?:[.,]\\d+)?|${Object.keys(NUMBER_WORDS).join('|')})`;
const toNumber = (tok: string): number => NUMBER_WORDS[tok] ?? parseFloat(tok.replace(',', '.'));

export const COLORS: { forms: string[]; hex: string; label: string }[] = [
  { forms: ['violet', 'violette', 'violets', 'violettes', 'mauve', 'purple', 'pourpre'], hex: '#8B00FF', label: 'violet' },
  { forms: ['bleu', 'bleue', 'bleus', 'bleues', 'blue'], hex: '#0040FF', label: 'bleu' },
  { forms: ['rouge', 'rouges', 'red'], hex: '#FF0000', label: 'rouge' },
  { forms: ['vert', 'verte', 'verts', 'vertes', 'green'], hex: '#00FF40', label: 'vert' },
  { forms: ['jaune', 'jaunes', 'yellow'], hex: '#FFD000', label: 'jaune' },
  { forms: ['orange', 'oranges'], hex: '#FF7000', label: 'orange' },
  { forms: ['rose', 'roses', 'pink'], hex: '#FF4FA0', label: 'rose' },
  { forms: ['magenta', 'fuchsia'], hex: '#FF00C8', label: 'magenta' },
  { forms: ['cyan', 'turquoise'], hex: '#00E5FF', label: 'cyan' },
  { forms: ['blanc', 'blanche', 'blancs', 'blanches', 'white'], hex: '#FFFFFF', label: 'blanc' },
  { forms: ['ambre', 'amber'], hex: '#FFB000', label: 'ambre' },
];

const has = (text: string, re: RegExp) => re.test(text);

function findColors(text: string): { hex: string; label: string }[] {
  const tokens = text.split(/[^a-z0-9]+/);
  const found: { idx: number; hex: string; label: string }[] = [];
  for (const c of COLORS) {
    const idx = tokens.findIndex((t) => c.forms.includes(t));
    if (idx >= 0) found.push({ idx, hex: c.hex, label: c.label });
  }
  return found.sort((a, b) => a.idx - b.idx);
}

function findDuration(text: string): number | null {
  const m = new RegExp(`${NUM}\\s*(secondes?|secs?|s|minutes?|mins?|mn)\\b`).exec(text);
  if (!m || !m[1] || !m[2]) return null;
  const n = toNumber(m[1]);
  return m[2].startsWith('m') ? n * 60 : n;
}

function findPercent(text: string): number | null {
  const m = /(\d{1,3})\s*(%|pour ?cent|percent)/.exec(text);
  return m?.[1] ? Math.min(100, parseInt(m[1], 10)) / 100 : null;
}

const MOVING: FixtureType[] = ['moving-head-spot', 'moving-head-wash'];

function findTarget(text: string, ctx: InterpreterContext): { target: AiTarget; label: string } {
  const groupNames = ctx.groups.filter((g) => g.name.length > 1 && new RegExp(`\\b${escapeRe(normalize(g.name))}\\b`).test(text)).map((g) => g.name);
  const fixtureNames = ctx.fixtures.filter((f) => new RegExp(`\\b${escapeRe(normalize(f.name))}\\b`).test(text)).map((f) => f.name);
  const limitMatch = new RegExp(`\\b${NUM}\\s+(premieres?\\s+)?(lyres?|moving|spots?|wash|pars?|projecteurs?|strobes?|stroboscopes?)\\b`).exec(text);
  const limit = limitMatch?.[1] ? toNumber(limitMatch[1]) : undefined;
  const types: FixtureType[] = [];
  if (has(text, /\b(lyres?|moving ?heads?|tetes? mobiles?|asservis?)\b/)) types.push(...MOVING);
  if (has(text, /\bspots?\b/) && !types.length) types.push('moving-head-spot');
  if (has(text, /\bwash\b/) && !types.includes('moving-head-wash')) types.push('moving-head-wash');
  if (has(text, /\bpars?\b|\bpar ?leds?\b/)) types.push('par');
  if (has(text, /\b(stroboscopes?|les strobes|des strobes)\b/)) types.push('strobe');
  // A head of multi-head fixtures: generic words first, then the module names of the rig.
  const module = has(text, /\b(anneaux?|rings?)\b/) ? 'anneau' : has(text, /\btetes? principales?\b/) ? 'tête principale'
    : [...new Set(ctx.fixtures.flatMap((f) => f.modules ?? []))].find((m) => new RegExp(`\\b${escapeRe(normalize(m))}\\b`).test(text));
  const parts: string[] = [];
  const target: AiTarget = {};
  if (groupNames.length) { target.groupNames = groupNames; parts.push(`groupe(s) ${groupNames.join(', ')}`); }
  if (fixtureNames.length) { target.fixtureNames = fixtureNames; parts.push(fixtureNames.join(', ')); }
  if (types.length) { target.fixtureTypes = [...new Set(types)]; parts.push(typeLabel(types)); }
  if (limit && Number.isFinite(limit)) { target.limit = limit; parts.unshift(`${limit} premier(s)`); }
  if (!parts.length) { target.all = true; parts.push('tous les projecteurs'); }
  if (module) { target.module = module; parts.unshift(`${module} de`); }
  return { target, label: parts.join(' ') };
}

function typeLabel(types: FixtureType[]): string {
  const l: string[] = [];
  if (types.some((t) => MOVING.includes(t))) l.push('lyres');
  if (types.includes('par')) l.push('PAR');
  if (types.includes('strobe')) l.push('stroboscopes');
  return l.join(' + ');
}

/** Fixture names a target designates in the interpreter's view of the rig (groups need their members). */
function namesOf(t: AiTarget, ctx: InterpreterContext): string[] {
  const explicit = new Set([...(t.fixtureNames ?? []), ...ctx.groups.filter((g) => t.groupNames?.includes(g.name)).flatMap((g) => g.members ?? [])]);
  let pool = ctx.fixtures.filter((f) => !explicit.size || explicit.has(f.name));
  if (t.fixtureTypes?.length) pool = pool.filter((f) => t.fixtureTypes!.includes(f.type));
  if (t.module) pool = pool.filter((f) => f.modules?.some((m) => normalize(m) === normalize(t.module!)));
  return pool.slice(0, t.limit ?? pool.length).map((f) => f.name);
}

/** « … sauf les lyres » / « sans toucher aux PAR » : splits off the exclusion clause so it never becomes the target. */
const EXCLUDE_RE = /\b(sauf|excepte|hormis|a part|sans toucher(?: aux?| a la| a l| les?)?|except|but not)\b(.*)$/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MOVING_TARGET: AiTarget = { fixtureTypes: MOVING };

/** Words naming an effect family -> effect types it covers, for « coupe le strobe » or « ralentis le chase ». */
const EFFECT_WORDS: [RegExp, AiEffectSpec['effectType'][], string][] = [
  [/\b(chase\w*|chenillard\w*)\b/, ['chase'], 'chase'],
  [/\b(strobe\w*|stroboscopique\w*|flash)\b/, ['strobe'], 'strobe'],
  [/\b(mouvements?|movements?)\b/, ['panTilt', 'randomMove'], 'mouvement'],
  [/\b(vagues?|wave|ondulation)\b/, ['dimmerWave'], 'vague'],
  [/\b(arc[ -]en[ -]ciel|rainbow)\b/, ['rainbow'], 'arc-en-ciel'],
  [/\b(pulse|pulsation\w*)\b/, ['pulse'], 'pulse'],
  [/\b(cycle de couleurs?|color ?cycle)\b/, ['colorCycle'], 'cycle de couleurs'],
];

function effectSpec(name: string, effectType: AiEffectSpec['effectType'], target: AiTarget, extra: Partial<AiEffectSpec> = {}): AiEffectSpec {
  return { name, effectType, target, ...extra };
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

interface Section { name: string; share: number; colors: string[]; level: number; effects: (allowStrobe: boolean) => AiEffectSpec[] }
const ALL: AiTarget = { all: true };

const ELECTRO_SECTIONS: Section[] = [
  { name: 'Intro', share: 0.15, colors: ['#0040FF', '#8B00FF'], level: 0.4, effects: () => [effectSpec('Intro · vague douce', 'dimmerWave', ALL, { speed: 0.1, phaseSpread: 0.6, offset: 0.55, amplitude: 0.5 })] },
  { name: 'Montée', share: 0.15, colors: ['#8B00FF', '#FF00C8'], level: 0.7, effects: () => [effectSpec('Montée · pulse', 'pulse', ALL, { bpmSync: true, beatsPerCycle: 1, offset: 0.6, amplitude: 0.8 }), effectSpec('Montée · cercle', 'panTilt', MOVING_TARGET, { bpmSync: true, beatsPerCycle: 8, amplitude: 0.4 })] },
  { name: 'Drop 1', share: 0.2, colors: ['#00E5FF', '#FFFFFF'], level: 1, effects: (s) => [effectSpec('Drop · chase', 'chase', ALL, { bpmSync: true, beatsPerCycle: 1, offset: 0.5, amplitude: 1 }), effectSpec('Drop · mouvement', 'panTilt', MOVING_TARGET, { bpmSync: true, beatsPerCycle: 4, amplitude: 0.6 }), ...(s ? [effectSpec('Drop · strobe', 'strobe', { fixtureTypes: ['strobe'] }, { speed: 8 })] : [])] },
  { name: 'Break', share: 0.15, colors: ['#0040FF'], level: 0.35, effects: () => [effectSpec('Break · respiration', 'fade', ALL, { speed: 0.125, offset: 0.4, amplitude: 0.5 })] },
  { name: 'Montée 2', share: 0.1, colors: ['#FF00C8', '#FF7000'], level: 0.75, effects: () => [effectSpec('Montée 2 · pulse', 'pulse', ALL, { bpmSync: true, beatsPerCycle: 0.5, offset: 0.6, amplitude: 0.8 })] },
  { name: 'Drop 2', share: 0.2, colors: ['#FF0000', '#FFFFFF'], level: 1, effects: (s) => [effectSpec('Drop 2 · arc-en-ciel', 'rainbow', ALL, { bpmSync: true, beatsPerCycle: 8, phaseSpread: 1 }), effectSpec('Drop 2 · mouvement aléatoire', 'randomMove', MOVING_TARGET, { bpmSync: true, beatsPerCycle: 2, amplitude: 0.7 }), ...(s ? [effectSpec('Drop 2 · strobe', 'strobe', { fixtureTypes: ['strobe'] }, { speed: 10 })] : [])] },
  { name: 'Outro', share: 0.05, colors: ['#8B00FF'], level: 0.2, effects: () => [] },
];

const SOFT_SECTIONS: Section[] = [
  { name: 'Ouverture', share: 0.25, colors: ['#8B00FF', '#0040FF'], level: 0.45, effects: () => [effectSpec('Ouverture · vague', 'dimmerWave', ALL, { speed: 0.08, phaseSpread: 0.8, offset: 0.5, amplitude: 0.4 })] },
  { name: 'Cœur', share: 0.35, colors: ['#FFB000', '#FF4FA0'], level: 0.6, effects: () => [effectSpec('Cœur · cycle couleurs', 'colorCycle', ALL, { speed: 0.03, colors: ['#FFB000', '#FF4FA0', '#8B00FF'], phaseSpread: 0.5 })] },
  { name: 'Envolée', share: 0.25, colors: ['#00E5FF', '#8B00FF'], level: 0.75, effects: () => [effectSpec('Envolée · balayage', 'panTilt', MOVING_TARGET, { speed: 0.05, shape: 'pan', amplitude: 0.5 })] },
  { name: 'Final', share: 0.15, colors: ['#FFB000'], level: 0.3, effects: () => [] },
];

function lookFromColors(colors: string[], level: number, target: AiTarget = ALL): LookPart[] {
  return [{ target, colors, level }];
}

/* ------------------------------------------------------------------ */
/* Modifiers relative to the current look                              */
/* ------------------------------------------------------------------ */

function shiftCurrent(ctx: InterpreterContext, fn: (hex: string) => string): AiAction[] {
  const byColor = new Map<string, string[]>();
  for (const f of ctx.fixtures) {
    const cur = ctx.current[f.id];
    if (!cur || cur.level <= 0.01) continue;
    if (!f.attributes.some((a) => ['red', 'colorWheel', 'cyan'].includes(a.split('#')[0]!))) continue;
    const next = fn(cur.color);
    const list = byColor.get(next) ?? [];
    list.push(f.name);
    byColor.set(next, list);
  }
  return [...byColor].map(([color, names]) => ({ type: 'setColor' as const, target: { fixtureNames: names }, color, fade: 3 }));
}

const warmer = (hex: string) => {
  const hsv = rgbToHsv(hexToRgb(hex));
  const target = 0.08; // orange
  let d = target - hsv.h;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return rgbToHex(hsvToRgb(hsv.h + d * 0.4, Math.max(0.5, hsv.s), Math.max(0.6, hsv.v)));
};
const cooler = (hex: string) => {
  const hsv = rgbToHsv(hexToRgb(hex));
  let d = 0.6 - hsv.h;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return rgbToHex(hsvToRgb(hsv.h + d * 0.4, Math.max(0.5, hsv.s), Math.max(0.6, hsv.v)));
};

function averageLevel(ctx: InterpreterContext): number {
  const lv = Object.values(ctx.current).map((c) => c.level).filter((l) => l > 0.01);
  return lv.length ? lv.reduce((a, b) => a + b, 0) / lv.length : 0;
}

/* ------------------------------------------------------------------ */
/* Main entry                                                          */
/* ------------------------------------------------------------------ */

export function interpretLocally(prompt: string, ctx: InterpreterContext): InterpretResult {
  const full = normalize(prompt.trim());
  const exclusion = EXCLUDE_RE.exec(full);
  // Everything below reads `text`; the excluded fixtures are removed from the target afterwards.
  const text = exclusion ? full.slice(0, exclusion.index) : full;
  const actions: AiAction[] = [];
  const notices: string[] = [];
  const said: string[] = [];
  const duration = findDuration(text);
  const percent = findPercent(text);
  const colors = findColors(text);
  let { target, label: targetLabel } = findTarget(text, ctx);
  if (exclusion?.[2]) {
    const ex = findTarget(exclusion[2], ctx);
    if (!ex.target.all) {
      const excluded = new Set(namesOf(ex.target, ctx));
      const kept = namesOf(target, ctx).filter((n) => !excluded.has(n));
      if (!kept.length) return { understanding: `Rien à faire : une fois ${ex.label} exclu(s), il ne reste aucun projecteur.`, actions, notices, recognized: true };
      target = { fixtureNames: kept, ...(target.module ? { module: target.module } : {}) };
      targetLabel = `${targetLabel} sauf ${ex.label}`;
    }
  }
  const bpmSync = has(text, /\b(bpm|tempo|synchro\w*|au rythme|sur le rythme|beat)\b/);
  const fade = duration ?? (has(text, /\b(progressiv\w*|doucement|lentement)\b/) ? 5 : 2);
  const wantsCreate = has(text, /\b(cree|creer|creez|create|enregistre\w*|sauvegarde\w*|prepare\w*)\b/);

  // 1. Release AI
  if (has(text, /\b(relache\w*|release|rends? la main|annule\w*|reprends? la main|(arrete|stoppe?) tout|stop (all|everything))\b/)) {
    actions.push({ type: 'releaseAi' });
    return { understanding: 'Relâcher la couche IA : le contrôle revient aux playbacks et au manuel.', actions, notices, recognized: true };
  }

  // 1b. Recall an existing scene
  const recall = has(text, /\b(applique\w*|rappel\w*|recall|apply)\b/);
  const sceneVerb = recall || has(text, /\b(charge\w*|remets?|mets|lance\w*|joue\w*|load)\b/);
  const scene = [...(ctx.scenes ?? [])].sort((a, b) => b.length - a.length).find((n) => normalize(n).trim() && new RegExp(`\\b${escapeRe(normalize(n).trim())}\\b`).test(text));
  if (scene && (sceneVerb || has(text, /\bscene\b/))) {
    actions.push({ type: 'applyScene', sceneName: scene, fade });
    return { understanding: `Appliquer la scène existante « ${scene} » en ${fade} s.`, actions, notices, recognized: true };
  }
  if (recall && has(text, /\bscene\b/)) {
    const known = ctx.scenes ?? [];
    return {
      understanding: 'Appliquer une scène existante.', actions,
      notices: [known.length ? `Scène introuvable. Scènes du projet : ${known.slice(0, 15).join(', ')}${known.length > 15 ? '…' : ''}.` : 'Le projet ne contient encore aucune scène.'],
      recognized: false,
    };
  }

  // 2. Show generation
  if (has(text, /\bshow\b/) && (duration !== null || has(text, /\b(genere\w*|cree\w*|fais|fait|make|generate)\b/))) {
    const total = Math.min(3600, duration ?? 120);
    const soft = has(text, /\b(lounge|chill|jazz|calme|acoustique|doux|douce|ambient)\b/);
    const sections = soft ? SOFT_SECTIONS : ELECTRO_SECTIONS;
    const style = soft ? 'calme' : 'électronique';
    const cues = sections.map((s, i) => {
      const secs = Math.max(4, Math.round(total * s.share));
      const cueFade = Math.min(4, secs / 4);
      return {
        name: s.name,
        look: lookFromColors(s.colors, s.level),
        fade: cueFade,
        hold: i < sections.length - 1 ? Math.max(0, secs - cueFade) : null,
        effects: s.effects(ctx.allowStrobe),
      };
    });
    actions.push({ type: 'createSequence', name: `Show ${style} ${Math.round(total)} s`, loop: false, cues });
    if (!ctx.allowStrobe && !soft) notices.push('Strobe désactivé dans les paramètres de sécurité : les sections « drop » n’utilisent pas de stroboscope.');
    notices.push('Les sections sont réparties sur une durée fixe : le mode local n’analyse pas la structure du morceau.');
    return {
      understanding: `Générer une séquence de ${cues.length} cues (${style}) d’environ ${Math.round(total)} s, enchaînées automatiquement après le premier GO.`,
      actions, notices, recognized: true,
    };
  }

  // 3. Drop
  if (has(text, /\b(drop|refrain|chorus|explosion|energique|energetic)\b/)) {
    const strobe = ctx.allowStrobe ? [effectSpec('Drop · strobe', 'strobe', { fixtureTypes: ['strobe'] }, { speed: 10 })] : [];
    actions.push({
      type: 'createSequence', name: 'Drop', loop: false,
      cues: [
        { name: 'Montée', look: lookFromColors(['#8B00FF', '#FF00C8'], 0.6), fade: 1, hold: null, effects: [effectSpec('Montée · pulse', 'pulse', ALL, { bpmSync: true, beatsPerCycle: 0.5, offset: 0.6, amplitude: 0.8 })] },
        { name: 'Drop', look: lookFromColors(['#FFFFFF', '#00E5FF'], 1), fade: 0, hold: null, effects: [effectSpec('Drop · chase', 'chase', ALL, { bpmSync: true, beatsPerCycle: 1, amplitude: 1 }), effectSpec('Drop · mouvement', 'panTilt', MOVING_TARGET, { bpmSync: true, beatsPerCycle: 4, amplitude: 0.6 }), ...strobe] },
        { name: 'Après drop', look: lookFromColors(['#FF00C8', '#0040FF'], 0.7), fade: 2, hold: null, effects: [] },
      ],
    });
    if (!ctx.allowStrobe) notices.push('Strobe désactivé dans les paramètres de sécurité : le drop utilise un chase à la place.');
    notices.push('Déclenchement manuel (GO) : le mode local ne détecte pas automatiquement le refrain.');
    return { understanding: 'Préparer une liste de cues « Drop » : montée, impact plein feu avec chase synchronisé au BPM, retombée.', actions, notices, recognized: true };
  }

  // 4. Variants of the current look
  const variants = new RegExp(`${NUM}\\s+variantes?`).exec(text);
  if (variants?.[1] || has(text, /\bvariantes?\b/)) {
    const n = Math.min(8, Math.max(1, variants?.[1] ? toNumber(variants[1]) : 3));
    const lit = ctx.fixtures.filter((f) => (ctx.current[f.id]?.level ?? 0) > 0.01);
    if (!lit.length) {
      return { understanding: 'Créer des variantes de la scène actuelle.', actions, notices: ['Aucun projecteur allumé : rien à décliner. Créez ou appliquez d’abord une scène.'], recognized: true };
    }
    for (let k = 1; k <= n; k++) {
      const byColor = new Map<string, { names: string[]; level: number }>();
      for (const f of lit) {
        const cur = ctx.current[f.id]!;
        const hsv = rgbToHsv(hexToRgb(cur.color));
        const hex = rgbToHex(hsvToRgb(hsv.h + k / (n + 1), Math.max(0.6, hsv.s), 1));
        const key = `${hex}|${cur.level.toFixed(2)}`;
        const e = byColor.get(key) ?? { names: [], level: cur.level };
        e.names.push(f.name);
        byColor.set(key, e);
      }
      actions.push({ type: 'createScene', name: `Variante ${k}`, apply: false, fade: 0, look: [...byColor].slice(0, 64).map(([key, e]) => ({ target: { fixtureNames: e.names }, color: key.split('|')[0]!, level: e.level })) });
    }
    return { understanding: `Créer ${n} variantes de l’état actuel par rotation de teinte (intensités conservées). Elles sont enregistrées sans être appliquées.`, actions, notices, recognized: true };
  }

  // 5. Relative modifiers
  const warm = has(text, /\bplus (chaud|chaude|chaleureu\w*)\b|\bwarmer\b/);
  const cold = has(text, /\bplus (froid|froide)\b|\bcooler\b/);
  const softer = has(text, /\b(moins agressi\w*|plus dou\w*|moins fort\w*|plus calme|moins intense|softer)\b/);
  const stronger = has(text, /\b(plus (fort|intense|lumineu\w*)|brighter)\b/);
  if (warm || cold || softer || stronger) {
    if (warm) { actions.push(...shiftCurrent(ctx, warmer)); said.push('teintes décalées vers le chaud'); }
    if (cold) { actions.push(...shiftCurrent(ctx, cooler)); said.push('teintes décalées vers le froid'); }
    const avg = averageLevel(ctx);
    if (softer) {
      actions.push({ type: 'setIntensity', target: { all: true }, level: Math.round(Math.max(0.1, avg * 0.7) * 100) / 100, fade: 3 });
      actions.push({ type: 'stopEffect', effectType: 'strobe' }, { type: 'stopEffect', effectType: 'chase' });
      said.push('intensité réduite de 30 %, effets strobe/chase de l’IA arrêtés');
    }
    if (stronger) {
      actions.push({ type: 'setIntensity', target: { all: true }, level: Math.round(Math.min(1, Math.max(0.3, avg * 1.3)) * 100) / 100, fade: 2 });
      said.push('intensité augmentée de 30 %');
    }
    if (!actions.length) notices.push('Aucun projecteur allumé avec une couleur modifiable.');
    return { understanding: `Ajuster l’état actuel : ${said.join(', ')}.`, actions, notices, recognized: true };
  }

  // 6. Stop or re-time running AI effects
  const fxWords = EFFECT_WORDS.filter(([re]) => re.test(text));
  const fxLabel = fxWords.length ? `les effets IA de type ${fxWords.map(([, , l]) => l).join(', ')}` : 'tous les effets IA en cours';
  if (has(text, /\b(arrete\w*|stoppe?\w*|coupe\w*|enleve\w*|retire\w*)\b/) && (fxWords.length || has(text, /\beffets?\b/))) {
    if (fxWords.length) actions.push(...fxWords.flatMap(([, types]) => types.map((effectType) => ({ type: 'stopEffect' as const, effectType }))));
    else actions.push({ type: 'stopEffect', all: true });
    return { understanding: `Arrêter ${fxLabel}.`, actions, notices, recognized: true };
  }
  const slower = has(text, /\b(ralenti\w*|plus lent\w*|moins vite|moins rapide|slower|slow down)\b/);
  const faster = has(text, /\b(accelere\w*|plus vite|plus rapide|speed up|faster)\b/);
  if (slower || faster) {
    const speedFactor = (has(text, /\bun peu\b/) ? 1.5 : 2) ** (slower ? -1 : 1);
    const rounded = Math.round(speedFactor * 100) / 100;
    if (fxWords.length) actions.push(...fxWords.flatMap(([, types]) => types.map((effectType) => ({ type: 'adjustEffect' as const, effectType, speedFactor: rounded }))));
    else actions.push({ type: 'adjustEffect', speedFactor: rounded });
    return { understanding: `${slower ? 'Ralentir' : 'Accélérer'} ${fxLabel} (vitesse ×${rounded}).`, actions, notices, recognized: true };
  }

  // 7. Blackout-like
  if (has(text, /\b(eteins?|eteint|eteindre|noir|blackout|off|extinction|coupe (tout|la lumiere))\b/)) {
    actions.push({ type: 'setIntensity', target, level: 0, fade: duration ?? 1 });
    return { understanding: `Éteindre ${targetLabel} en ${duration ?? 1} s (couche IA, le blackout général reste disponible dans la barre supérieure).`, actions, notices, recognized: true };
  }

  // 8. Effects
  const fxTarget = (fallback: AiTarget): AiTarget => (target.all ? fallback : target);
  const bpmExtra = bpmSync ? { bpmSync: true, beatsPerCycle: 1 } : {};
  if (has(text, /\bchase\w*|chenillard\b/)) { actions.push({ type: 'startEffect', effect: effectSpec('IA · chase', 'chase', fxTarget(ALL), { speed: 2, ...bpmExtra }) }); said.push('chase'); }
  if (has(text, /\b(arc[ -]en[ -]ciel|rainbow)\b/)) { actions.push({ type: 'startEffect', effect: effectSpec('IA · arc-en-ciel', 'rainbow', fxTarget(ALL), { speed: 0.1, phaseSpread: 1, ...(bpmSync ? { bpmSync: true, beatsPerCycle: 8 } : {}) }) }); said.push('arc-en-ciel'); }
  if (has(text, /\b(vagues?|wave|ondulation)\b/)) { actions.push({ type: 'startEffect', effect: effectSpec('IA · vague', 'dimmerWave', fxTarget(ALL), { speed: 0.25, phaseSpread: 1, ...(bpmSync ? { bpmSync: true, beatsPerCycle: 4 } : {}) }) }); said.push('vague d’intensité'); }
  if (has(text, /\b(pulse|pulsation\w*|battement\w*|pulsant\w*)\b/)) { actions.push({ type: 'startEffect', effect: effectSpec('IA · pulse', 'pulse', fxTarget(ALL), { speed: 2, ...bpmExtra }) }); said.push('pulse'); }
  if (has(text, /\b(cycle de couleurs?|color ?cycle|change\w* de couleur)\b/)) { actions.push({ type: 'startEffect', effect: effectSpec('IA · cycle couleurs', 'colorCycle', fxTarget(ALL), { speed: 0.1, colors: colors.length ? colors.map((c) => c.hex) : undefined, ...(bpmSync ? { bpmSync: true, beatsPerCycle: 4 } : {}) }) }); said.push('cycle de couleurs'); }
  if (has(text, /\b(strobe|stroboscopique|flash)\b/) && !has(text, /\bstroboscopes\b/)) {
    const hz = /(\d+(?:[.,]\d+)?)\s*hz\b/.exec(text);
    const speed = hz?.[1] ? Math.min(30, Math.max(0.5, toNumber(hz[1]))) : 6;
    if (ctx.allowStrobe) { actions.push({ type: 'startEffect', effect: effectSpec('IA · strobe', 'strobe', fxTarget(ALL), { speed }) }); said.push(`strobe ${speed} Hz`); }
    else notices.push('Effet strobe refusé : il est désactivé dans Paramètres › Sécurité (protection photosensible).');
  }
  if (has(text, /\b(mouvements?|bouge\w*|balaya\w*|movement|cercles?|en huit|aleatoire\w*|random)\b/)) {
    const random = has(text, /\b(aleatoire\w*|random)\b/);
    const shape = has(text, /\ben huit\b/) ? 'figure8' : 'circle';
    actions.push({ type: 'startEffect', effect: effectSpec(random ? 'IA · mouvement aléatoire' : 'IA · mouvement', random ? 'randomMove' : 'panTilt', target.all ? MOVING_TARGET : target, { speed: 0.2, amplitude: 0.5, ...(bpmSync ? { bpmSync: true, beatsPerCycle: random ? 2 : 8 } : {}), ...(random ? {} : { shape }) }) });
    said.push(random ? 'mouvement aléatoire' : 'mouvement en cercle');
  }
  if (said.length && bpmSync) said.push('synchronisé(s) au BPM');

  // 8b. Beam: gobo, prism, zoom, frost, focus, iris
  let percentUsed = false;
  const beam: { gobo?: number; prism?: boolean; zoom?: number; frost?: number; focus?: number; iris?: number } = {};
  const removal = /\b(sans|enleve\w*|retire\w*|ote\w*)\b/;
  const goboMatch = new RegExp(`\\bgobos?(?:\\s+(?:n|numero))?(?:\\s+${NUM})?\\b`).exec(text);
  if (goboMatch) beam.gobo = has(text, removal) || has(text, /\bgobo ouvert\b/) ? 0 : goboMatch[1] ? Math.min(32, Math.max(1, Math.round(toNumber(goboMatch[1])))) : 1;
  if (has(text, /\bprism\w*/)) beam.prism = !has(text, removal);
  if (has(text, /\b(zoom|faisceau)\b/)) {
    const z = has(text, /\b(large|ouvert|ouvre|wide|out)\b/) ? 1 : has(text, /\b(serre\w*|etroit\w*|ferme\w*|narrow|in|fin|fine)\b/) ? 0 : percent;
    if (z !== null) { beam.zoom = z; percentUsed ||= z === percent; }
  }
  if (has(text, /\b(frost|diffus\w*|flou)\b/)) { beam.frost = has(text, removal) ? 0 : percent ?? 1; percentUsed ||= percent !== null; }
  for (const k of ['focus', 'iris'] as const) if (percent !== null && has(text, new RegExp(`\\b${k}\\b`))) { beam[k] = percent; percentUsed = true; }
  if (Object.keys(beam).length) {
    actions.push({ type: 'setBeam', target: target.all ? MOVING_TARGET : target, ...beam, fade });
    said.push(`faisceau (${Object.entries(beam).map(([k, v]) => (typeof v === 'boolean' ? (v ? 'prisme' : 'sans prisme') : k === 'gobo' ? (v ? `gobo ${v}` : 'gobo ouvert') : `${k} ${Math.round(v * 100)} %`)).join(', ')})`);
  }

  // 9. Look: templates and colours
  const lounge = has(text, /\b(lounge|chill|cosy|cozy|tamise\w*)\b/);
  const party = has(text, /\b(club|fete|party|dancefloor|boite)\b/);
  const romantic = has(text, /\b(romanti\w*|diner|intime)\b/);
  let lookColors = colors.map((c) => c.hex);
  let level: number | null = percentUsed ? null : percent;
  const template = lounge ? 'lounge' : party ? 'club' : romantic ? 'intime' : null;
  if (!lookColors.length && template) lookColors = lounge ? ['#8B00FF', '#0040FF'] : party ? ['#FF00C8', '#00E5FF'] : ['#FFB000', '#FF4FA0'];
  if (!lookColors.length && has(text, /\b(chaud|chaude|warm)\b/)) lookColors = ['#FF9A3C'];
  if (!lookColors.length && has(text, /\b(froid|froide|cold)\b/)) lookColors = ['#9FD8FF'];
  if (level === null && has(text, /\b(plein feu|full|max\w*|a fond)\b/)) level = 1;
  if (level === null && has(text, /\b(monte\w*|augmente\w*|fade ?in|allume\w*)\b/)) level = 1;
  if (level === null && has(text, /\b(baisse\w*|diminue\w*)\b/)) level = Math.round(averageLevel(ctx) * 50) / 100;
  if (level === null && template) level = lounge ? 0.55 : party ? 0.9 : 0.5;

  const hasLook = lookColors.length > 0 || level !== null;
  if (hasLook && (wantsCreate || template) && has(text, /\b(scene|ambiance|look|atmosphere|etat)\b/)) {
    const name = template ? `Ambiance ${template}` : `Scène IA ${colors.map((c) => c.label).join(' ')}`.trim();
    const part: LookPart = { target, level: level ?? 0.8 };
    if (lookColors.length === 1) part.color = lookColors[0]!;
    else if (lookColors.length > 1) part.colors = lookColors;
    actions.unshift({ type: 'createScene', name, look: [part], apply: true, fade });
    said.unshift(`scène « ${name} » (${lookColors.length ? colors.map((c) => c.label).join(', ') || 'couleurs du modèle' : 'sans couleur'}, ${Math.round((level ?? 0.8) * 100)} %) sur ${targetLabel}, appliquée en ${fade} s`);
  } else {
    if (lookColors.length) {
      actions.unshift(lookColors.length === 1 ? { type: 'setColor', target, color: lookColors[0]!, fade } : { type: 'setColor', target, colors: lookColors, fade });
      said.unshift(`couleur ${colors.map((c) => c.label).join(' / ') || (template ?? 'modèle')} sur ${targetLabel}`);
    }
    if (level !== null) {
      actions.unshift({ type: 'setIntensity', target, level, fade });
      said.unshift(`intensité ${Math.round(level * 100)} % sur ${targetLabel} en ${fade} s`);
    }
  }

  // 10. Position words for moving heads
  // Position words only steer the heads when the request is about them (« la salle en bleu » is a colour request).
  const namesHeads = !target.all && namesOf(target, ctx).some((n) => MOVING.includes(ctx.fixtures.find((f) => f.name === n)!.type));
  const aboutHeads = namesHeads || !actions.length || has(text, /\b(pointe\w*|vise\w*|oriente\w*|dirige\w*|braque\w*|tourne\w*|aim|point)\b/);
  if (aboutHeads && !actions.some((a) => a.type === 'startEffect' && ['panTilt', 'randomMove'].includes(a.effect.effectType))) {
    let pan: number | undefined, tilt: number | undefined;
    if (has(text, /\b(centre|center|milieu)\b/)) { pan = 0.5; tilt = 0.5; }
    if (has(text, /\b(public|audience|salle)\b/)) tilt = 0.7;
    if (has(text, /\b(sol|bas|floor)\b/)) tilt = 0.85;
    if (has(text, /\b(plafond|ciel|haut|ceiling)\b/)) tilt = 0.15;
    if (has(text, /\bgauche\b|\bleft\b/)) pan = 0.35;
    if (has(text, /\bdroite\b|\bright\b/)) pan = 0.65;
    if (pan !== undefined || tilt !== undefined) {
      actions.push({ type: 'setPosition', target: target.all ? MOVING_TARGET : target, ...(pan !== undefined ? { pan } : {}), ...(tilt !== undefined ? { tilt } : {}), fade });
      said.push('position des lyres');
    }
  }

  // 11. Explicit BPM
  const bpm = /\b(\d{2,3})\s*bpm\b/.exec(text);
  if (bpm?.[1]) {
    actions.push({ type: 'setBpm', bpm: Math.min(300, Math.max(20, parseInt(bpm[1], 10))) });
    said.push(`BPM fixé à ${bpm[1]}`);
  }

  if (!actions.length) {
    return {
      understanding: 'Demande non reconnue par le mode local déterministe.',
      actions,
      notices: [
        ...notices,
        'Exemples compris : « ambiance lounge violette et bleue », « monte l’intensité sur 8 secondes », « chase sur les quatre lyres », « mouvements synchronisés au BPM », « prépare un drop », « show de 2 minutes électro », « 3 variantes », « plus chaud et moins agressif », « violet partout sauf les lyres », « gobo 2 et prisme sur les lyres », « zoom large », « ralentis le chase », « coupe le strobe », « applique la scène <nom> », « relâche ».',
      ],
      recognized: false,
    };
  }
  return { understanding: said.length ? `${said.join(' ; ')}.` : 'Actions reconnues.', actions, notices, recognized: true };
}
