import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { Channel, ChannelRange, FixtureModule, FixtureMode, FixtureProfile, FixtureType } from '../model/schemas';
import { dedupeRanges, slug } from './ofl';
import { validateProfile } from './profiles';

/**
 * Converter from a grandMA2 fixture export (`<MA><FixtureType>`, one file = one mode) to a Luma profile.
 * Covers modules/instances (instance `patch`, extra instances become cells), coarse/fine channels, holes kept as
 * generic channels so DMX addresses stay exact, ranges per ChannelFunction (24-bit bounds, Hz from physfrom/physto),
 * wheels, maintenance macros and physical data. Never throws: problems come back as `errors` / `warnings`.
 * Imported profiles must be checked against the fixture manual before a show.
 */

export interface Ma2Conversion {
  profile: FixtureProfile | null;
  warnings: string[];
  errors: string[];
}

type Node = Record<string, unknown>;
const ARRAYS = new Set(['FixtureType', 'Module', 'ChannelType', 'ChannelFunction', 'ChannelSet', 'Instance', 'Wheel', 'Slot', 'FixtureMacro', 'FixtureMacroStep', 'PhysicalFeature']);
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseAttributeValue: false, parseTagValue: false, isArray: (name) => ARRAYS.has(name) });

const node = (v: unknown): Node => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Node) : {});
const arr = (n: Node, key: string): Node[] => (Array.isArray(n[key]) ? (n[key] as unknown[]).map(node) : []);
const str = (n: Node, key: string): string | undefined => {
  const v = n[key];
  if (typeof v === 'string') return v.trim() || undefined;
  if (v && typeof v === 'object' && typeof (v as Node)['#text'] === 'string') return ((v as Node)['#text'] as string).trim() || undefined;
  return undefined;
};
const num = (n: Node, key: string): number | undefined => {
  const s = str(n, key);
  const v = s === undefined ? NaN : Number(s);
  return Number.isFinite(v) ? v : undefined;
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** 24-bit DMX bound (min_dmx_24 / max_dmx_24, the only reliable resolution in MA2 files) → 8-bit. */
const dmx8 = (v24: number) => clamp(Math.floor(v24 / 65536), 0, 255);

/** MA2 attribute → Luma attribute (colour mix channels are resolved by name, see lumaAttribute). */
const MA2_ATTR: Record<string, string> = {
  DIM: 'dimmer', PAN: 'pan', TILT: 'tilt', SHUTTER: 'shutter', STROBE: 'strobe', STROBE_RATE: 'strobe', STROBEINTENSITY: 'strobe',
  COLOR1: 'colorWheel', GOBO1: 'gobo', GOBO1_POS: 'goboRotation', GOBO1_ROT: 'goboRotation', GOBO1POSROTATE: 'goboRotation',
  PRISMA1: 'prism', FROST: 'frost', FROST1: 'frost', ZOOM: 'zoom', FOCUS: 'focus', FOCUS1: 'focus', IRIS: 'iris', IRIS1: 'iris',
  CTO: 'cto', COLORTEMPERATURE: 'colorTemperature', COLORSUB_C: 'cyan', COLORSUB_M: 'magenta', COLORSUB_Y: 'yellow',
  POSITIONMODE: 'panTiltMode', POSITIONMSPEED: 'panTiltSpeed', EFFECTMACROS: 'macro', EFFECTMACRORATE: 'macroSpeed', EFFECTWHEEL: 'effectWheel',
  ZOOMMODE: 'zoomMode', COLORMIXMACROFADETIME: 'colorMacroFade', COLORMIXMACRO: 'colorMacro', COLORMACRO1: 'colorMacro',
  FIXTUREGLOBALRESET: 'control', CONTROL: 'control', FAN: 'fan', FOG: 'fog', DIMMERCURVE: 'dimmerCurve', MACROS: 'macro',
  GOBO2: 'gobo2', GOBO2_POS: 'gobo2Rotation', GOBO2_ROT: 'gobo2Rotation', GOBO2POSROTATE: 'gobo2Rotation',
  PRISMA_POS: 'prismIndex', PRISMA1_POS: 'prismIndex', PRISMA_ROT: 'prismRotation', PRISMA1_ROT: 'prismRotation',
};
/** Known MA2 functions Luma has no attribute for (third gobo wheel, second prism…): kept as generic channels. */
const NO_EQUIVALENT = /^(GOBO[3-9]|PRISMA[2-9]|EFFECTWHEEL[2-9])/;
/** Continuous attributes: no generic range, the fader is enough. */
const CONTINUOUS = new Set(['dimmer', 'pan', 'tilt', 'zoom', 'focus', 'iris', 'panTiltSpeed', 'red', 'green', 'blue', 'white', 'amber', 'uv', 'warmWhite', 'coldWhite', 'lime', 'indigo', 'cyan', 'magenta', 'yellow', 'cto', 'colorTemperature']);
const COLOR_BY_NAME: [RegExp, string][] = [
  [/warm/i, 'warmWhite'], [/cold|cool/i, 'coldWhite'], [/^w$|white/i, 'white'], [/^a$|amber/i, 'amber'], [/uv/i, 'uv'],
  [/lime/i, 'lime'], [/indigo/i, 'indigo'], [/^r$|^red$/i, 'red'], [/^g$|^green$/i, 'green'], [/^b$|^blue$/i, 'blue'],
];
/** COLORRGBn slots seen in MA2 exports when the user names are missing. */
const COLOR_BY_INDEX: Record<string, string> = { COLORRGB1: 'red', COLORRGB2: 'green', COLORRGB3: 'blue', COLORRGB5: 'white', COLORRGB6: 'warmWhite' };

function lumaAttribute(ct: Node): string | null {
  const a = (str(ct, 'attribute') ?? '').toUpperCase();
  if (a.startsWith('COLORRGB')) {
    const fn = arr(ct, 'ChannelFunction')[0] ?? {};
    const name = str(fn, 'attribute_user_name') ?? str(fn, 'subattribute_user_name') ?? '';
    return COLOR_BY_NAME.find(([re]) => re.test(name))?.[1] ?? COLOR_BY_INDEX[a] ?? null;
  }
  if (MA2_ATTR[a]) return MA2_ATTR[a]!;
  if (NO_EQUIVALENT.test(a)) return null;
  // Converters (GDTF → MA2) use free attribute names but standard subattributes (GOBO1_ROT…).
  const sub = (str(arr(ct, 'ChannelFunction')[0] ?? {}, 'subattribute') ?? '').toUpperCase();
  if (MA2_ATTR[sub] && !NO_EQUIVALENT.test(sub)) return MA2_ATTR[sub]!;
  return str(ct, 'feature') === 'RESET' || str(ct, 'preset') === 'CONTROL' ? 'control' : null;
}

function fixtureType(cls: string, beam: string, instancesOfMain: number): FixtureType {
  if (/headmover|moving/i.test(cls)) return /spot|beam|profile/i.test(beam) ? 'moving-head-spot' : 'moving-head-wash';
  if (/strobe/i.test(cls)) return 'strobe';
  if (/dimmer|conventional/i.test(cls)) return 'dimmer';
  if (/led|wash|par/i.test(cls)) return instancesOfMain > 1 ? 'led-bar' : 'par';
  return 'other';
}

const MACRO_LABELS: Record<string, string> = { PANRESET: 'Reset pan', TILTRESET: 'Reset tilt', ZOOMRESET: 'Reset zoom', FIXTUREGLOBALRESET: 'Reset total', LAMPOFF: 'Lampe off', LAMPON: 'Lampe on' };

function shutterKind(fn: Node): ChannelRange['kind'] {
  const sub = (str(fn, 'subattribute') ?? '').toUpperCase();
  if (sub.includes('RANDOM')) return 'random';
  if (sub.includes('PULSE')) return 'pulse';
  if (sub.startsWith('STROBE')) return 'strobe';
  const names = arr(fn, 'ChannelSet').map((s) => str(s, 'name') ?? '').join(' ') + ` ${str(fn, 'name') ?? ''}`;
  if (/clos/i.test(names)) return 'closed';
  if (/open/i.test(names)) return 'open';
  return num(fn, 'physfrom') === 0 ? 'closed' : num(fn, 'physfrom') === 1 ? 'open' : 'other';
}

const hex6 = (s: string | undefined) => (s && /^[0-9a-f]{6}$/i.test(s) ? `#${s.toUpperCase()}` : undefined);
/** Slot colour: `color="ff0000"` or, in GDTF-converted files, `r/g/b` attributes. */
function slotColor(slot: Node): string | undefined {
  const rgb = ['r', 'g', 'b'].map((k) => num(slot, k));
  if (rgb.every((v) => v !== undefined)) return `#${rgb.map((v) => clamp(Math.round(v!), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  return hex6(str(slot, 'color'));
}

/** Wheel of a channel: the one declared for the same attribute, else `wheel="n"` (1-based position, or a name). */
function wheelOf(ct: Node, fn: Node, wheels: Node[]): Node | undefined {
  const byAttr = wheels.find((w) => str(w, 'attribute') === str(ct, 'attribute'));
  if (byAttr) return byAttr;
  const ref = str(fn, 'wheel');
  if (ref === undefined) return undefined;
  const n = Number(ref);
  return wheels.find((w) => str(w, 'name') === ref) ?? (Number.isInteger(n) ? wheels[n - 1] : undefined);
}

function setKind(name: string, attr: string | null): ChannelRange['kind'] {
  if (attr === 'control') return /reset/i.test(name) ? 'reset' : /lamp.*off/i.test(name) ? 'lamp-off' : /lamp.*on/i.test(name) ? 'lamp-on' : 'other';
  if (/shake/i.test(name)) return 'shake';
  if (/open|\bout\b/i.test(name) && !/into/i.test(name)) return 'open';
  return attr === 'colorWheel' ? 'color' : attr === 'gobo' || attr === 'gobo2' ? 'gobo' : 'other';
}

/** Ranges from ChannelSets (wheel slots, frost/prism positions, control functions…). */
function setRanges(sets: Node[], attr: string | null, wheel: Node | undefined): ChannelRange[] {
  const slots = wheel ? arr(wheel, 'Slot') : [];
  return sets.flatMap((set): ChannelRange[] => {
    let from = num(set, 'from_dmx'), to = num(set, 'to_dmx');
    if (from === undefined || to === undefined) return [];
    // ChannelSet values are 16-bit on some channels (8-bit ones included): back to 8 bits.
    if (to > 255) { from = Math.floor(from / 256); to = Math.floor(to / 256); }
    const slotIndex = num(set, 'slot_from') ?? num(set, 'slot_index');
    const slot = slotIndex === undefined ? undefined : slots.find((s) => num(s, 'index') === slotIndex);
    const slotName = slot ? str(slot, 'name') ?? str(slot, 'media_name') : undefined;
    const name = (str(set, 'name') ?? slotName ?? 'Fonction').slice(0, 64);
    const kind = setKind(name, attr);
    const color = kind === 'color' && slot ? slotColor(slot) : undefined;
    // A generic set name (« Color 3 ») is less useful than the slot name (« Magenta »).
    const label = slotName && /^(color|gobo|slot)\s*\d+$/i.test(name) ? slotName.slice(0, 64) : name;
    return [{ from: clamp(from, 0, 255), to: clamp(Math.max(from, to), 0, 255), label, kind, ...(color ? { color } : {}), dangerous: attr === 'control' && /reset|lamp/i.test(name) }];
  });
}

/** Ranges of one channel: maintenance macros, one per ChannelFunction, ChannelSets (wheels…), or a single generic range. */
function channelRanges(ct: Node, attr: string | null, ctx: { wheels: Node[]; macros: Node[] }): ChannelRange[] {
  const fns = arr(ct, 'ChannelFunction');
  const ma2Attr = str(ct, 'attribute') ?? '';
  const label = (s: string | undefined, d: string) => (s ?? d).slice(0, 64) || d;
  if (attr === 'control') {
    const macros = ctx.macros.flatMap((m) => {
      const step = arr(m, 'FixtureMacroStep').find((s) => str(s, 'attribute') === ma2Attr && num(s, 'dmx_value') !== undefined);
      if (!step) return [];
      const v = clamp(Math.round(num(step, 'dmx_value')!), 0, 255);
      const feature = str(arr(node(m.PhysicalFeatures), 'PhysicalFeature')[0] ?? {}, 'subattribute') ?? 'RESET';
      const duration = num(step, 'duration');
      return [{ from: v, to: v, label: label(`${MACRO_LABELS[feature] ?? feature}${duration ? ` (${duration} s)` : ''}`, 'Reset'), kind: /RESET/.test(feature) ? 'reset' : 'other', dangerous: true } satisfies ChannelRange];
    });
    if (macros.length) return macros;
    return setRanges(fns.flatMap((f) => arr(f, 'ChannelSet')), attr, undefined);
  }
  if (fns.length > 1) {
    return fns.map((f): ChannelRange => {
      const from = dmx8(num(f, 'min_dmx_24') ?? 0);
      const to = Math.max(from, dmx8(num(f, 'max_dmx_24') ?? 16777215));
      const kind = attr === 'shutter' || attr === 'strobe' ? shutterKind(f) : 'other';
      const pf = num(f, 'physfrom'), pt = num(f, 'physto');
      const hz = (kind === 'strobe' || kind === 'pulse' || kind === 'random') && pf !== undefined && pt !== undefined && pf >= 0 && pt >= 0 && pf <= 100 && pt <= 100;
      const setName = arr(f, 'ChannelSet').map((s) => str(s, 'name')).find(Boolean);
      return {
        from, to, label: label(kind === 'open' || kind === 'closed' ? setName ?? str(f, 'name') : str(f, 'name') ?? setName ?? str(f, 'subattribute_user_name'), 'Fonction'), kind, dangerous: false,
        ...(hz ? { hzFrom: pf, hzTo: pt } : {}),
        ...(!hz && pf !== undefined && pt !== undefined ? { physFrom: pf, physTo: pt } : {}),
      };
    });
  }
  const only = fns[0];
  if (!only) return [];
  const sets = arr(only, 'ChannelSet');
  const wheel = wheelOf(ct, only, ctx.wheels);
  // Point sets (min / center / max of a continuous channel) are not ranges.
  const realRanges = sets.some((s) => (num(s, 'to_dmx') ?? 0) > (num(s, 'from_dmx') ?? 0) || num(s, 'slot_from') !== undefined || num(s, 'slot_index') !== undefined);
  if (sets.length && (realRanges || wheel)) return setRanges(sets, attr, wheel);
  if (!sets.length && !(attr && CONTINUOUS.has(attr))) {
    return [{ from: 0, to: 255, label: label(str(only, 'subattribute_user_name') ?? str(only, 'attribute_user_name'), ma2Attr), kind: 'other', dangerous: false }];
  }
  return [];
}

export function convertMa2Fixture(xml: string): Ma2Conversion {
  const warnings: string[] = [];
  const fail = (msg: string): Ma2Conversion => ({ profile: null, warnings, errors: [msg] });
  const valid = XMLValidator.validate(xml);
  if (valid !== true) return fail(`XML invalide (ligne ${valid.err.line}) : ${valid.err.msg}`);
  let doc: Node;
  try {
    doc = node(parser.parse(xml));
  } catch (err) {
    return fail(`XML illisible : ${(err as Error).message}`);
  }
  const ft = arr(node(doc.MA), 'FixtureType')[0];
  if (!ft) return fail('Ce fichier n’est pas un export de projecteur grandMA2 (<MA><FixtureType> introuvable)');
  const modules = arr(node(ft.Modules), 'Module');
  if (!modules.length) return fail('Aucun module (<Modules><Module>) dans le fichier');
  const declared = arr(node(ft.Instances), 'Instance').sort((a, b) => (num(a, 'index') ?? 0) - (num(b, 'index') ?? 0));
  const instances: Node[] = declared.length ? declared : [{ module_index: '0' }];
  const ctx = { wheels: arr(node(ft.Wheels), 'Wheel'), macros: arr(node(ft.FixtureMacroCollect), 'FixtureMacro') };
  const moduleOf = (mi: number) => modules.find((m) => num(m, 'index') === mi) ?? modules[mi];

  const byAddr = new Map<number, Channel>();
  const used = new Set<string>();
  const generic = (name: string): Channel => {
    let attr = `custom:${slug(name)}`;
    for (let n = 2; used.has(attr); n++) attr = `custom:${slug(name).slice(0, 26)}-${n}`;
    used.add(attr);
    return { name: name.slice(0, 48), attribute: attr, fine: false, default: 0, ranges: [] };
  };
  const place = (addr: number, ch: Channel, what: string) => {
    if (addr < 1 || addr > 512) { warnings.push(`${what} : canal ${addr} hors 1..512, ignoré`); return; }
    if (byAddr.has(addr)) { warnings.push(`${what} : canal ${addr} déjà utilisé, ignoré`); return; }
    byAddr.set(addr, ch);
  };
  const moduleCells = new Map<number, (number | undefined)[]>();
  let next = 1;
  let firstPan: Node | undefined, firstTilt: Node | undefined;

  instances.forEach((inst, i) => {
    const mi = num(inst, 'module_index') ?? 0;
    const mod = moduleOf(mi);
    if (!mod) { warnings.push(`Instance ${i} : module ${mi} introuvable, ignorée`); return; }
    const patch = num(inst, 'patch') ?? next;
    const cell = i === 0 ? undefined : i;
    moduleCells.set(mi, [...(moduleCells.get(mi) ?? []), cell]);
    const keyOf = (a: string) => (cell ? `${a}#${cell}` : a);
    for (const ct of arr(mod, 'ChannelType')) {
      const coarse = num(ct, 'coarse');
      const ma2Attr = str(ct, 'attribute') ?? '?';
      if (coarse === undefined) { warnings.push(`${ma2Attr} : canal sans numéro (coarse), ignoré`); continue; }
      const fine = num(ct, 'fine');
      const ultra = num(ct, 'ultra');
      let attr = lumaAttribute(ct);
      const userName = str(arr(ct, 'ChannelFunction')[0] ?? {}, 'attribute_user_name') ?? ma2Attr;
      const chName = `${cell ? `${str(mod, 'name') ?? 'Module'} ` : ''}${userName}`;
      if (!attr && NO_EQUIVALENT.test(ma2Attr.toUpperCase())) warnings.push(`« ${ma2Attr} » (roue ou fonction secondaire) n’a pas d’équivalent Luma, gardé en canal générique`);
      else if (!attr) warnings.push(`Attribut MA2 « ${ma2Attr} » non reconnu, converti en canal générique`);
      else if (used.has(keyOf(attr))) { warnings.push(`« ${ma2Attr} » duplique l’attribut ${attr}, converti en canal générique`); attr = null; }
      const d = num(ct, 'default');
      const ranges = dedupeRanges(channelRanges(ct, attr, ctx));
      // `default` is in the channel resolution: 16-bit when there is a fine channel, else 8-bit with decimals (254.999).
      const default16 = fine !== undefined && attr && d !== undefined ? clamp(Math.round(d), 0, 65535) : undefined;
      const def = default16 !== undefined ? default16 >> 8 : d !== undefined ? clamp(Math.round(d > 255 ? d / 257 : d), 0, 255) : 0;
      const color = str(ct, 'color');
      const base: Channel = attr
        ? { name: chName.slice(0, 48), attribute: attr, fine: false, default: def, ...(default16 !== undefined ? { default16 } : {}), ...(color && /^[0-9a-f]{6}$/i.test(color) ? { emitterColor: `#${color.toUpperCase()}` } : {}), ranges, ...(cell ? { cell } : {}) }
        : { ...generic(chName), default: def, ranges };
      if (attr) used.add(keyOf(attr));
      place(patch + coarse - 1, base, ma2Attr);
      if (fine !== undefined) place(patch + fine - 1, attr ? { name: `${chName} fin`.slice(0, 48), attribute: attr, fine: true, default: (default16 ?? 0) & 0xff, ranges: [], ...(cell ? { cell } : {}) } : generic(`${chName} fin`), ma2Attr);
      if (ultra !== undefined) place(patch + ultra - 1, generic(`${chName} ultra`), ma2Attr); // 24-bit third byte is not modelled
      next = Math.max(next, patch + Math.max(coarse, fine ?? 0, ultra ?? 0));
      if (i === 0 && attr === 'pan') firstPan = arr(ct, 'ChannelFunction')[0];
      if (i === 0 && attr === 'tilt') firstTilt = arr(ct, 'ChannelFunction')[0];
    }
  });

  if (!byAddr.size) return fail('Aucun canal exploitable dans le fichier');
  const count = Math.max(...byAddr.keys());
  const channels: Channel[] = [];
  for (let a = 1; a <= count; a++) channels.push(byAddr.get(a) ?? generic(`inutilisé ${a}`));
  const mode: FixtureMode = { name: (str(ft, 'mode') ?? `${count} canaux`).slice(0, 48), channels };

  const mainIndex = num(instances[0]!, 'module_index') ?? 0;
  const main = moduleOf(mainIndex) ?? modules[0]!;
  const type = fixtureType(str(main, 'class') ?? '', str(main, 'beamtype') ?? '', moduleCells.get(mainIndex)?.length ?? 1);
  const span = (fn: Node | undefined): [number, number] | undefined => {
    const a = fn ? num(fn, 'physfrom') : undefined, b = fn ? num(fn, 'physto') : undefined;
    return a !== undefined && b !== undefined ? [a, b] : undefined;
  };
  const pan = span(firstPan), tilt = span(firstTilt);
  const panRange = pan ? clamp(Math.abs(pan[1] - pan[0]), 0, 720) : type.startsWith('moving') ? 540 : 0;
  const phystime = firstPan ? num(firstPan, 'phystime') : undefined;
  const size = node(node(main.Body).Size);
  const dims = [num(size, 'x'), num(size, 'y'), num(size, 'z')];
  const beamAngle = num(main, 'beam_angle');

  const lumaModules: FixtureModule[] = [];
  if (instances.length > 1) {
    for (const [mi, cells] of moduleCells) {
      const m = moduleOf(mi)!;
      const name = (str(m, 'name') ?? `Module ${mi}`).slice(0, 48);
      const angle = num(m, 'beam_angle');
      const bt = str(m, 'beamtype') ?? '';
      const beam: FixtureModule['beam'] = /spot/i.test(bt) ? 'spot' : /beam/i.test(bt) ? 'beam' : /led/i.test(str(m, 'class') ?? '') ? 'led' : 'wash';
      const extra = cells.filter((c): c is number => c !== undefined);
      const common = { beam, ...(angle !== undefined && angle > 1 ? { angle: clamp(angle, 1, 90) } : {}) };
      if (cells.includes(undefined)) lumaModules.push({ name, cells: [], geometry: 'lens', ...common });
      if (extra.length) {
        lumaModules.push({ name: cells.includes(undefined) ? `${name} (pixels)`.slice(0, 48) : name, cells: extra, geometry: /ring/i.test(name) ? 'ring' : extra.length > 1 ? 'pixel' : 'lens', ...common });
      }
    }
  }

  const manufacturer = (str(ft, 'manufacturer') ?? 'Inconnu').slice(0, 80);
  const shortName = str(ft, 'short_name') ?? str(ft, 'name') ?? 'fixture';
  const candidate = {
    id: `ma2-${slug(manufacturer)}-${slug(shortName)}`.slice(0, 64),
    name: (str(ft, 'name') ?? shortName).slice(0, 80),
    manufacturer,
    type,
    fictional: false,
    physical: {
      panRange,
      tiltRange: tilt ? clamp(Math.abs(tilt[1] - tilt[0]), 0, 360) : type.startsWith('moving') ? 270 : 0,
      // MA2 importers often leave beam_angle at 1: treated as unknown.
      beamAngle: beamAngle !== undefined && beamAngle > 1 ? clamp(beamAngle, 1, 90) : 25,
      // physfrom = angle at DMX 0: kept as is, so an inverted tilt (140 → −140) stays inverted.
      ...(tilt ? { tiltMin: clamp(tilt[0], -360, 360), tiltMax: clamp(tilt[1], -360, 360) } : {}),
      ...(phystime && phystime > 0 && panRange > 0 ? { panTiltTime: clamp((phystime * 540) / panRange, 0.01, 60) } : {}),
      ...(dims.every((v) => v !== undefined && v > 0 && v <= 10) ? { dimensions: { width: dims[0]!, height: dims[1]!, depth: dims[2]! } } : {}),
    },
    modes: [mode],
    modules: lumaModules,
  };
  const v = validateProfile(candidate);
  if (!v.ok) return { profile: null, warnings, errors: v.errors.slice(0, 5) };
  return { profile: v.profile!, warnings: [...new Set(warnings)], errors: [] };
}

/** Adds the modes of `incoming` (same fixture, other MA2 file) to `existing`; a mode with the same name is replaced. */
export function mergeProfileModes(existing: FixtureProfile, incoming: FixtureProfile): FixtureProfile {
  const names = new Set(incoming.modes.map((m) => m.name));
  const modules = [...existing.modules, ...incoming.modules.filter((m) => !existing.modules.some((x) => x.name === m.name))];
  const merged = { ...existing, modes: [...existing.modes.filter((m) => !names.has(m.name)), ...incoming.modes], modules };
  // Modules declared per mode may collide (same cell in two modules): keep the existing ones then.
  return validateProfile(merged).ok ? merged : { ...merged, modules: existing.modules };
}
