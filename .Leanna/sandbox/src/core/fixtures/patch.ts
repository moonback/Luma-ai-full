import type { Fixture } from '../model/schemas';
import { channelCount, type ProfileLibrary } from './profiles';

export interface PatchIssue {
  kind: 'overlap' | 'out-of-range' | 'unknown-profile' | 'unknown-mode';
  fixtureIds: string[];
  message: string;
}

export interface Footprint {
  fixtureId: string;
  universe: number;
  start: number; // 1-based
  end: number; // inclusive
}

export function footprint(lib: ProfileLibrary, f: Fixture): Footprint | undefined {
  const profile = lib.get(f.profileId);
  if (!profile) return undefined;
  const count = channelCount(profile, f.mode);
  if (count === 0) return undefined;
  return { fixtureId: f.id, universe: f.universe, start: f.address, end: f.address + count - 1 };
}

/** Detects invalid configurations and address overlaps. O(n log n) per universe. */
export function validatePatch(lib: ProfileLibrary, patch: readonly Fixture[]): PatchIssue[] {
  const issues: PatchIssue[] = [];
  const byUniverse = new Map<number, Footprint[]>();
  for (const f of patch) {
    const profile = lib.get(f.profileId);
    if (!profile) {
      issues.push({ kind: 'unknown-profile', fixtureIds: [f.id], message: `${f.name}: profil « ${f.profileId} » introuvable` });
      continue;
    }
    if (!profile.modes.some((m) => m.name === f.mode)) {
      issues.push({ kind: 'unknown-mode', fixtureIds: [f.id], message: `${f.name}: mode « ${f.mode} » absent du profil` });
      continue;
    }
    const fp = footprint(lib, f);
    if (!fp) continue;
    if (fp.end > 512) {
      issues.push({ kind: 'out-of-range', fixtureIds: [f.id], message: `${f.name}: occupe ${fp.start}-${fp.end}, dépasse le canal 512` });
    }
    const list = byUniverse.get(fp.universe) ?? [];
    list.push(fp);
    byUniverse.set(fp.universe, list);
  }
  const names = new Map(patch.map((f) => [f.id, f.name]));
  for (const [universe, list] of byUniverse) {
    list.sort((a, b) => a.start - b.start);
    // Compare each footprint with the furthest-reaching previous one so nested overlaps are found.
    let reach: Footprint | undefined;
    for (const fp of list) {
      if (reach && fp.start <= reach.end) {
        issues.push({
          kind: 'overlap',
          fixtureIds: [reach.fixtureId, fp.fixtureId],
          message: `Univers ${universe}: ${names.get(reach.fixtureId)} (${reach.start}-${reach.end}) chevauche ${names.get(fp.fixtureId)} (${fp.start}-${fp.end})`,
        });
      }
      if (!reach || fp.end > reach.end) reach = fp;
    }
  }
  return issues;
}

/** First free address in a universe that fits `count` channels, or undefined if none. */
export function findFreeAddress(lib: ProfileLibrary, patch: readonly Fixture[], universe: number, count: number, from = 1): number | undefined {
  const used = patch
    .filter((f) => f.universe === universe)
    .map((f) => footprint(lib, f))
    .filter((x): x is Footprint => !!x)
    .sort((a, b) => a.start - b.start);
  let candidate = Math.max(1, from);
  for (const fp of used) {
    if (candidate + count - 1 < fp.start) break;
    if (fp.end >= candidate) candidate = fp.end + 1;
  }
  return candidate + count - 1 <= 512 ? candidate : undefined;
}
