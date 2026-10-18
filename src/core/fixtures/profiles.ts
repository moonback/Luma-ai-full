import { z } from 'zod';
import { profileSchema, type Channel, type ChannelRange, type FixtureMode, type FixtureProfile, type Fixture } from '../model/schemas';
import { BUILTIN_PROFILES } from './builtinProfiles';
import { cellKey } from './attributes';

/** Value key of a channel ("red" or "red#2" for cell 2). */
export const channelKey = (ch: Channel): string => cellKey(ch.attribute, ch.cell);

export interface ProfileValidationResult {
  ok: boolean;
  profile?: FixtureProfile;
  errors: string[];
}

/** Validates untrusted profile data (import, project load). Never throws. */
export function validateProfile(data: unknown): ProfileValidationResult {
  const parsed = profileSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'profil'}: ${i.message}`) };
  }
  const errors: string[] = [];
  const moduleNames = new Set<string>();
  const moduleCells = new Map<number | undefined, string>();
  for (const m of parsed.data.modules) {
    if (moduleNames.has(m.name.toLowerCase())) errors.push(`Module « ${m.name} » déclaré deux fois`);
    moduleNames.add(m.name.toLowerCase());
    for (const c of m.cells.length ? m.cells : [undefined]) {
      const other = moduleCells.get(c);
      if (other) errors.push(`${c === undefined ? 'Tête principale' : `Cellule ${c}`} rattachée à « ${other} » et « ${m.name} »`);
      moduleCells.set(c, m.name);
    }
  }
  for (const mode of parsed.data.modes) {
    for (const ch of mode.channels) {
      const sorted = [...ch.ranges].sort((a, b) => a.from - b.from);
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!;
        const cur = sorted[i]!;
        if (cur.from <= prev.to) errors.push(`${mode.name} / ${ch.name}: plages qui se chevauchent (${prev.label} / ${cur.label})`);
      }
    }
  }
  const modeNames = new Set<string>();
  for (const m of parsed.data.modes) {
    if (modeNames.has(m.name)) errors.push(`Mode « ${m.name} » dupliqué`);
    modeNames.add(m.name);
  }
  return errors.length ? { ok: false, errors } : { ok: true, profile: parsed.data, errors: [] };
}

/** Documented import format: a single profile object or `{ profiles: [...] }` (see docs/PROFILE_FORMAT.md). */
export const profileFileSchema = z.union([z.object({ profiles: z.array(z.unknown()).min(1).max(500) }), z.record(z.string(), z.unknown())]);

export function parseProfileFile(json: unknown): { profiles: FixtureProfile[]; errors: string[] } {
  const outer = profileFileSchema.safeParse(json);
  if (!outer.success) return { profiles: [], errors: ['Fichier de profil illisible : objet JSON attendu'] };
  const items: unknown[] = 'profiles' in outer.data && Array.isArray(outer.data.profiles) ? outer.data.profiles : [outer.data];
  const profiles: FixtureProfile[] = [];
  const errors: string[] = [];
  items.forEach((item, i) => {
    const r = validateProfile(item);
    if (r.ok && r.profile) profiles.push(r.profile);
    else errors.push(...r.errors.map((e) => `Profil #${i + 1}: ${e}`));
  });
  return { profiles, errors };
}

export class ProfileLibrary {
  private readonly byId = new Map<string, FixtureProfile>();

  constructor(custom: readonly FixtureProfile[] = []) {
    for (const p of BUILTIN_PROFILES) this.byId.set(p.id, p);
    for (const p of custom) this.byId.set(p.id, p);
  }

  get(id: string): FixtureProfile | undefined {
    return this.byId.get(id);
  }

  all(): FixtureProfile[] {
    return [...this.byId.values()];
  }

  isBuiltin(id: string): boolean {
    return BUILTIN_PROFILES.some((p) => p.id === id);
  }
}

export function getMode(profile: FixtureProfile, modeName: string): FixtureMode | undefined {
  return profile.modes.find((m) => m.name === modeName);
}

export function channelCount(profile: FixtureProfile, modeName: string): number {
  return getMode(profile, modeName)?.channels.length ?? 0;
}

/** Coarse attribute keys available for a fixture mode, in channel order (cells as "red#2"). */
export function modeAttributes(mode: FixtureMode): string[] {
  return mode.channels.filter((c) => !c.fine).map(channelKey);
}

/** Cell numbers used by the mode, sorted (empty for single-cell fixtures). */
export function modeCells(mode: FixtureMode): number[] {
  return [...new Set(mode.channels.map((c) => c.cell).filter((c): c is number => c !== undefined))].sort((a, b) => a - b);
}

export function hasFine(mode: FixtureMode, key: string): boolean {
  return mode.channels.some((c) => c.fine && channelKey(c) === key);
}

export function coarseChannel(mode: FixtureMode, key: string): Channel | undefined {
  return mode.channels.find((c) => !c.fine && channelKey(c) === key);
}

export function rangeAt(channel: Channel, dmx: number): ChannelRange | undefined {
  return channel.ranges.find((r) => dmx >= r.from && dmx <= r.to);
}

export function isDangerousValue(channel: Channel, dmx: number): boolean {
  return rangeAt(channel, dmx)?.dangerous === true;
}

/** Normalized default value for an attribute (from the profile's coarse channel default). */
export function attributeDefault(mode: FixtureMode, attr: string): number {
  const ch = coarseChannel(mode, attr);
  if (!ch) return 0;
  return ch.default / 255;
}

/** Value (normalized) of the first range of the given kind, e.g. shutter "closed". */
export function rangeValue(channel: Channel, kind: ChannelRange['kind']): number | undefined {
  const r = channel.ranges.find((x) => x.kind === kind);
  return r ? Math.round((r.from + r.to) / 2) / 255 : undefined;
}

export interface ResolvedFixture {
  fixture: Fixture;
  profile: FixtureProfile;
  mode: FixtureMode;
  attributes: string[];
}

export function resolveFixture(lib: ProfileLibrary, fixture: Fixture): ResolvedFixture | undefined {
  const profile = lib.get(fixture.profileId);
  if (!profile) return undefined;
  const mode = getMode(profile, fixture.mode);
  if (!mode) return undefined;
  return { fixture, profile, mode, attributes: modeAttributes(mode) };
}
