import { z } from 'zod';
import type { Channel, ChannelRange, FixtureMode, FixtureProfile, FixtureType } from '../model/schemas';
import { validateProfile } from './profiles';

/**
 * Converter from the Open Fixture Library format (https://open-fixture-library.org, data under MIT licence)
 * to Luma profiles. Covers channels, 16-bit fine aliases, capabilities, colour/gobo wheels and pixel matrices
 * (mapped to cells). Anything that cannot be represented is converted to a generic channel so DMX addresses stay
 * exact, and reported as a warning. Imported profiles must be checked against the fixture manual before a show.
 */

const capSchema = z.looseObject({
  type: z.string(),
  dmxRange: z.tuple([z.number(), z.number()]).optional(),
  color: z.string().optional(),
  colors: z.array(z.string()).optional(),
  shutterEffect: z.string().optional(),
  slotNumber: z.number().optional(),
  wheel: z.union([z.string(), z.array(z.string())]).optional(),
  comment: z.string().optional(),
  hold: z.string().optional(),
});
type OflCap = z.infer<typeof capSchema>;
const chanSchema = z.looseObject({
  capability: capSchema.optional(),
  capabilities: z.array(capSchema).optional(),
  fineChannelAliases: z.array(z.string()).optional(),
  defaultValue: z.union([z.number(), z.string()]).optional(),
  dmxValueResolution: z.enum(['8bit', '16bit', '24bit']).optional(),
});
type OflChan = z.infer<typeof chanSchema>;
const insertSchema = z.looseObject({
  insert: z.literal('matrixChannels'),
  repeatFor: z.union([z.string(), z.array(z.string())]),
  channelOrder: z.enum(['perPixel', 'perChannel']),
  templateChannels: z.array(z.string()),
});
export const oflFixtureSchema = z.looseObject({
  name: z.string().min(1),
  shortName: z.string().optional(),
  categories: z.array(z.string()).default([]),
  physical: z
    .looseObject({
      lens: z.looseObject({ degreesMinMax: z.tuple([z.number(), z.number()]).optional() }).optional(),
      focus: z.looseObject({ panMax: z.union([z.number(), z.string()]).optional(), tiltMax: z.union([z.number(), z.string()]).optional() }).optional(),
    })
    .optional(),
  matrix: z
    .looseObject({
      pixelCount: z.tuple([z.number(), z.number(), z.number()]).optional(),
      pixelKeys: z.array(z.array(z.array(z.string().nullable()))).optional(),
      pixelGroups: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  availableChannels: z.record(z.string(), chanSchema).default({}),
  templateChannels: z.record(z.string(), chanSchema).default({}),
  wheels: z.record(z.string(), z.looseObject({ slots: z.array(z.looseObject({ type: z.string(), name: z.string().optional(), colors: z.array(z.string()).optional() })) })).default({}),
  modes: z.array(z.looseObject({ name: z.string().min(1), shortName: z.string().optional(), channels: z.array(z.union([z.string(), z.null(), insertSchema])) })).min(1),
});
export type OflFixture = z.infer<typeof oflFixtureSchema>;

export interface OflConversion {
  profile: FixtureProfile | null;
  warnings: string[];
  errors: string[];
}

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'ch';
const hex = (c: string | undefined) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c.toUpperCase() : undefined);
const caps = (c: OflChan): OflCap[] => (c.capabilities ?? (c.capability ? [c.capability] : []));

const COLOR_ATTR: Record<string, string> = {
  Red: 'red', Green: 'green', Blue: 'blue', White: 'white', 'Warm White': 'white', 'Cold White': 'white', Amber: 'amber', UV: 'uv',
  Cyan: 'cyan', Magenta: 'magenta', Yellow: 'yellow',
};
const STROBE_EFFECTS = new Set(['Strobe', 'Pulse', 'RampUp', 'RampDown', 'RampUpDown', 'Lightning', 'Spikes', 'Burst']);
const SIMPLE: Record<string, string> = { Intensity: 'dimmer', Pan: 'pan', Tilt: 'tilt', PanTiltSpeed: 'panTiltSpeed', Zoom: 'zoom', Focus: 'focus', Iris: 'iris', Prism: 'prism', Frost: 'frost', ColorTemperature: 'cto', Maintenance: 'control' };

function fixtureType(f: OflFixture): FixtureType {
  const c = new Set(f.categories);
  if (c.has('Moving Head') || c.has('Scanner')) {
    const goboWheel = Object.values(f.wheels).some((w) => w.slots.some((s) => s.type === 'Gobo'));
    return goboWheel ? 'moving-head-spot' : 'moving-head-wash';
  }
  if (c.has('Strobe') || c.has('Blinder')) return 'strobe';
  if (c.has('Pixel Bar') || c.has('Matrix')) return 'led-bar';
  if (c.has('Dimmer')) return 'dimmer';
  if (c.has('Color Changer')) return 'par';
  return 'other';
}

function pixelOrder(f: OflFixture): string[] {
  const m = f.matrix;
  if (!m) return [];
  if (m.pixelKeys) return m.pixelKeys.flat(2).filter((k): k is string => !!k);
  if (m.pixelCount) {
    const [x, y, zc] = m.pixelCount;
    const dims = [x, y, zc].filter((d) => d > 1).length;
    const keys: string[] = [];
    for (let k = 1; k <= zc; k++) for (let j = 1; j <= y; j++) for (let i = 1; i <= x; i++) {
      keys.push(dims <= 1 ? String(keys.length + 1) : zc > 1 ? `(${i}, ${j}, ${k})` : `(${i}, ${j})`);
    }
    return keys;
  }
  return [];
}

interface Resolved { name: string; chan: OflChan | null; fine: number; pixelKey?: string }

function resolveChannel(f: OflFixture, key: string): Resolved {
  const direct = f.availableChannels[key];
  if (direct) return { name: key, chan: direct, fine: 0 };
  for (const [name, ch] of Object.entries(f.availableChannels)) {
    const i = ch.fineChannelAliases?.indexOf(key) ?? -1;
    if (i >= 0) return { name, chan: ch, fine: i + 1 };
  }
  for (const [tName, ch] of Object.entries(f.templateChannels)) {
    const names = [tName, ...(ch.fineChannelAliases ?? [])];
    for (const [i, n] of names.entries()) {
      const re = new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\$pixelKey', '(.+)')}$`);
      const m = re.exec(key);
      if (m) return { name: tName, chan: ch, fine: i, pixelKey: m[1] };
    }
  }
  return { name: key, chan: null, fine: 0 };
}

function expandMode(f: OflFixture, channels: OflFixture['modes'][number]['channels'], warnings: string[]): (string | null)[] {
  const out: (string | null)[] = [];
  const pixels = pixelOrder(f);
  for (const c of channels) {
    if (c === null || typeof c === 'string') {
      out.push(c);
      continue;
    }
    let keys: string[];
    if (Array.isArray(c.repeatFor)) keys = c.repeatFor;
    else if (c.repeatFor === 'eachPixelGroup') keys = Object.keys(f.matrix?.pixelGroups ?? {});
    else if (c.repeatFor === 'eachPixelABC') keys = [...pixels].sort();
    else {
      keys = pixels;
      if (c.repeatFor !== 'eachPixelXYZ') warnings.push(`Ordre de pixels « ${c.repeatFor} » approximé par XYZ`);
    }
    if (c.channelOrder === 'perPixel') for (const p of keys) for (const t of c.templateChannels) out.push(t.replace('$pixelKey', p));
    else for (const t of c.templateChannels) for (const p of keys) out.push(t.replace('$pixelKey', p));
  }
  return out;
}

function capRange(f: OflFixture, chanName: string, cap: OflCap, scale: number): ChannelRange | null {
  if (!cap.dmxRange) return null;
  const from = Math.max(0, Math.min(255, Math.floor(cap.dmxRange[0] / scale)));
  const to = Math.max(from, Math.min(255, Math.floor(cap.dmxRange[1] / scale)));
  let kind: ChannelRange['kind'] = 'other';
  let color: string | undefined;
  let label = cap.comment ?? cap.type;
  let dangerous = false;
  switch (cap.type) {
    case 'NoFunction':
      label = cap.comment ?? 'Aucune fonction';
      break;
    case 'ShutterStrobe':
      kind = cap.shutterEffect === 'Open' ? 'open' : cap.shutterEffect === 'Closed' ? 'closed' : cap.shutterEffect === 'RandomStrobe' ? 'random' : STROBE_EFFECTS.has(cap.shutterEffect ?? '') ? (cap.shutterEffect === 'Pulse' ? 'pulse' : 'strobe') : 'other';
      label = cap.comment ?? cap.shutterEffect ?? 'Shutter';
      break;
    case 'WheelSlot': {
      const wheelName = typeof cap.wheel === 'string' ? cap.wheel : chanName;
      const slot = f.wheels[wheelName]?.slots[Math.floor(cap.slotNumber ?? 1) - 1];
      if (slot?.type === 'Color') { kind = 'color'; color = hex(slot.colors?.[0]); label = cap.comment ?? slot.name ?? 'Couleur'; }
      else if (slot?.type === 'Open') { kind = 'open'; label = cap.comment ?? 'Ouvert'; }
      else if (slot?.type === 'Gobo') { kind = 'gobo'; label = cap.comment ?? slot.name ?? `Gobo ${cap.slotNumber ?? ''}`.trim(); }
      else label = cap.comment ?? slot?.name ?? `Slot ${cap.slotNumber ?? '?'}`;
      break;
    }
    case 'WheelShake':
      kind = 'shake';
      break;
    case 'WheelRotation':
    case 'WheelSlotRotation':
      kind = 'rotation';
      break;
    case 'ColorPreset':
      kind = 'color';
      color = hex(cap.colors?.[0]);
      break;
    case 'Maintenance':
      // Resets, lamp control, calibration…: never emitted without an explicit manual confirmation.
      kind = /reset/i.test(`${cap.comment ?? ''}`) ? 'reset' : /lamp.*off/i.test(`${cap.comment ?? ''}`) ? 'lamp-off' : 'other';
      label = cap.comment ?? 'Maintenance';
      dangerous = true;
      break;
  }
  return { from, to, label: label.slice(0, 64) || cap.type, kind, ...(color ? { color } : {}), dangerous };
}

function attributeFor(f: OflFixture, chanName: string, list: OflCap[]): string | null {
  const types = new Set(list.map((c) => c.type).filter((t) => t !== 'NoFunction'));
  if (types.size === 0) return null;
  const only = types.size === 1 ? [...types][0]! : null;
  if (only === 'ColorIntensity') return COLOR_ATTR[list.find((c) => c.type === 'ColorIntensity')!.color ?? ''] ?? null;
  if (only && SIMPLE[only]) return SIMPLE[only]!;
  if (types.has('ShutterStrobe') && [...types].every((t) => t === 'ShutterStrobe' || t === 'Intensity')) {
    return list.some((c) => c.shutterEffect === 'Open' || c.shutterEffect === 'Closed') ? 'shutter' : 'strobe';
  }
  if ([...types].every((t) => t.startsWith('Wheel'))) {
    const wheelName = list.map((c) => (typeof c.wheel === 'string' ? c.wheel : undefined)).find(Boolean) ?? chanName;
    const slots = f.wheels[wheelName]?.slots ?? [];
    if (types.has('WheelSlot') || types.has('WheelShake')) {
      if (slots.some((s) => s.type === 'Color')) return 'colorWheel';
      if (slots.some((s) => s.type === 'Gobo')) return 'gobo';
    } else if (slots.some((s) => s.type === 'Gobo')) return 'goboRotation';
    return null;
  }
  if (only === 'ColorPreset') return 'colorWheel';
  if (types.has('Maintenance')) return 'control';
  return null;
}

export function convertOflFixture(json: unknown, opts: { manufacturer: string; key: string }): OflConversion {
  const warnings: string[] = [];
  const parsed = oflFixtureSchema.safeParse(json);
  if (!parsed.success) {
    return { profile: null, warnings, errors: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'fixture'} : ${i.message}`) };
  }
  const f = parsed.data;
  const groups = f.matrix?.pixelGroups ?? {};
  const type = fixtureType(f);
  const modes: FixtureMode[] = [];
  const errors: string[] = [];
  for (const m of f.modes) {
    const keys = expandMode(f, m.channels, warnings);
    if (keys.length > 512) {
      warnings.push(`Mode « ${m.name} » ignoré : ${keys.length} canaux (> 512)`);
      continue;
    }
    const cellOfPixel = new Map<string, number>();
    const used = new Set<string>();
    const channels: Channel[] = keys.map((key, idx) => {
      const generic = (name: string): Channel => {
        let attr = `custom:${slug(name)}`;
        for (let n = 2; used.has(attr); n++) attr = `custom:${slug(name).slice(0, 26)}-${n}`;
        used.add(attr);
        return { name: name.slice(0, 48), attribute: attr, fine: false, default: 0, ranges: [] };
      };
      if (key === null) return generic(`inutilisé ${idx + 1}`);
      const r = resolveChannel(f, key);
      if (!r.chan) {
        warnings.push(`${m.name} : canal « ${key} » introuvable, converti en canal générique`);
        return generic(key);
      }
      const scale = r.chan.dmxValueResolution === '16bit' ? 256 : r.chan.dmxValueResolution === '24bit' ? 65536 : 1;
      const list = caps(r.chan);
      let cell: number | undefined;
      if (r.pixelKey !== undefined && groups[r.pixelKey] !== 'all') {
        if (!cellOfPixel.has(r.pixelKey)) cellOfPixel.set(r.pixelKey, cellOfPixel.size + 1);
        cell = cellOfPixel.get(r.pixelKey);
      }
      let attr = attributeFor(f, r.name, list);
      const keyOf = (a: string) => (cell ? `${a}#${cell}` : a);
      if (r.fine > 1) return generic(key); // 24-bit "fine^2" bytes are not modelled
      if (r.fine === 1) {
        if (attr && used.has(`coarse:${keyOf(attr)}`)) return { name: key.slice(0, 48), attribute: attr, fine: true, default: 0, ranges: [], ...(cell ? { cell } : {}) };
        return generic(key);
      }
      if (!attr || used.has(keyOf(attr))) {
        if (attr) warnings.push(`${m.name} : « ${key} » duplique l’attribut ${attr}, converti en canal générique`);
        attr = null;
      }
      const ranges = list.map((c) => capRange(f, r.name, c, scale)).filter((x): x is ChannelRange => !!x);
      let def = typeof r.chan.defaultValue === 'number' ? Math.round(r.chan.defaultValue / scale) : typeof r.chan.defaultValue === 'string' && r.chan.defaultValue.endsWith('%') ? Math.round((parseFloat(r.chan.defaultValue) / 100) * 255) : undefined;
      if (def === undefined && (attr === 'pan' || attr === 'tilt')) def = 128;
      if (def === undefined && attr === 'shutter') {
        const open = ranges.find((x) => x.kind === 'open');
        def = open ? Math.round((open.from + open.to) / 2) : 0;
      }
      if (!attr) {
        const g = generic(key);
        return { ...g, default: Math.max(0, Math.min(255, def ?? 0)), ranges: dedupeRanges(ranges) };
      }
      used.add(keyOf(attr));
      used.add(`coarse:${keyOf(attr)}`);
      return { name: key.slice(0, 48), attribute: attr, fine: false, default: Math.max(0, Math.min(255, def ?? 0)), ranges: dedupeRanges(ranges), ...(cell ? { cell } : {}) };
    });
    modes.push({ name: m.name.slice(0, 48), channels });
  }
  const lens = f.physical?.lens?.degreesMinMax;
  const num = (v: number | string | undefined, d: number) => (typeof v === 'number' ? v : d);
  const moving = type.startsWith('moving');
  const candidate = {
    id: `ofl-${slug(opts.manufacturer)}-${slug(opts.key)}`.slice(0, 64),
    name: f.name.slice(0, 80),
    manufacturer: opts.manufacturer.slice(0, 80),
    type,
    fictional: false,
    physical: {
      panRange: moving ? Math.min(720, num(f.physical?.focus?.panMax, 540)) : 0,
      tiltRange: moving ? Math.min(360, num(f.physical?.focus?.tiltMax, 270)) : 0,
      beamAngle: Math.max(1, Math.min(90, lens ? lens[1] || lens[0] || 25 : 25)),
    },
    modes,
  };
  const v = validateProfile(candidate);
  if (!v.ok) {
    // Keep the valid modes only.
    const good = modes.filter((md) => validateProfile({ ...candidate, modes: [md] }).ok);
    errors.push(...v.errors.slice(0, 5));
    if (!good.length) return { profile: null, warnings, errors };
    const again = validateProfile({ ...candidate, modes: good });
    if (!again.ok) return { profile: null, warnings, errors: [...errors, ...again.errors] };
    warnings.push(`${modes.length - good.length} mode(s) invalide(s) ignoré(s)`);
    return { profile: again.profile!, warnings, errors: [] };
  }
  return { profile: v.profile!, warnings: [...new Set(warnings)], errors };
}

/** OFL ranges never overlap in valid files; if they do, keep the first to stay valid. */
function dedupeRanges(r: ChannelRange[]): ChannelRange[] {
  const out: ChannelRange[] = [];
  for (const x of [...r].sort((a, b) => a.from - b.from)) if (!out.length || x.from > out[out.length - 1]!.to) out.push(x);
  return out;
}

/* ------------------------------------------------------------------ */
/* Online catalogue (GitHub raw files of the OFL repository)           */
/* ------------------------------------------------------------------ */

const RAW = 'https://raw.githubusercontent.com/OpenLightingProject/open-fixture-library/master/fixtures';
const API = 'https://api.github.com/repos/OpenLightingProject/open-fixture-library/contents/fixtures';
const KEY_RE = /^[a-z0-9-]+$/;

async function getJson(url: string, fetchImpl: typeof fetch, timeoutMs = 15000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(res.status === 404 ? 'Introuvable dans Open Fixture Library' : res.status === 403 ? 'Limite de requêtes GitHub atteinte, réessayez plus tard' : `Erreur HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error('Délai dépassé');
    throw err;
  } finally {
    clearTimeout(t);
  }
}

export async function oflManufacturers(fetchImpl: typeof fetch = fetch): Promise<{ key: string; name: string }[]> {
  const json = z.record(z.string(), z.unknown()).parse(await getJson(`${RAW}/manufacturers.json`, fetchImpl));
  return Object.entries(json)
    .filter(([k, v]) => KEY_RE.test(k) && typeof v === 'object' && v !== null)
    .map(([key, v]) => ({ key, name: String((v as { name?: unknown }).name ?? key) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function oflFixtureKeys(manufacturer: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  if (!KEY_RE.test(manufacturer)) throw new Error('Clé fabricant invalide');
  const list = z.array(z.object({ name: z.string(), type: z.string() })).parse(await getJson(`${API}/${manufacturer}`, fetchImpl));
  return list.filter((x) => x.type === 'file' && x.name.endsWith('.json')).map((x) => x.name.slice(0, -5)).sort();
}

export async function oflFetchFixture(manufacturer: string, key: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  if (!KEY_RE.test(manufacturer) || !KEY_RE.test(key)) throw new Error('Clé invalide (minuscules, chiffres et tirets)');
  return getJson(`${RAW}/${manufacturer}/${key}.json`, fetchImpl);
}
