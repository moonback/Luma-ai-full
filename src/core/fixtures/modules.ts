import type { FixtureModule, FixtureProfile } from '../model/schemas';
import { baseAttribute, cellOf } from './attributes';
import type { ResolvedFixture } from './profiles';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
/** Generic words that designate a module by its geometry, whatever its name in the profile. */
const GEOMETRY_ALIASES: Record<string, FixtureModule['geometry']> = { anneau: 'ring', ring: 'ring', 'tete principale': 'lens', principal: 'lens', main: 'lens' };

/** Module by name (accents/case ignored), or by a generic word such as « anneau » / « tête principale ». */
export function findModule(profile: Pick<FixtureProfile, 'modules'>, name: string): FixtureModule | undefined {
  const n = norm(name);
  const geometry = GEOMETRY_ALIASES[n];
  return profile.modules.find((m) => norm(m.name) === n) ?? (geometry ? profile.modules.find((m) => m.geometry === geometry) : undefined);
}

/** Module owning a cell (undefined = channels without a cell). */
export function moduleOfCell(profile: Pick<FixtureProfile, 'modules'>, cell: number | undefined): FixtureModule | undefined {
  return profile.modules.find((m) => (cell === undefined ? m.cells.length === 0 : m.cells.includes(cell)));
}

/** Value keys of `attr` the fixture really has in `module` (every module when undefined). */
export function moduleKeys(rf: ResolvedFixture, attr: string, module?: FixtureModule): string[] {
  return rf.attributes.filter((k) => {
    if (baseAttribute(k) !== attr) return false;
    if (!module) return true;
    const c = cellOf(k);
    return module.cells.length ? c !== undefined && module.cells.includes(c) : c === undefined;
  });
}

/** Intensity keys for a module; the main head falls back to the virtual dimmer. */
export function moduleDimmerKeys(rf: ResolvedFixture, module?: FixtureModule): string[] {
  const keys = moduleKeys(rf, 'dimmer', module);
  return keys.length || (module && module.cells.length) ? keys : ['dimmer'];
}
