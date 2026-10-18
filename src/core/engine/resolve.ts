import type { CueList, Effect, Group, Project, Scene, Target, Timeline } from '../model/schemas';
import { ProfileLibrary, resolveFixture, type ResolvedFixture } from '../fixtures/profiles';

/** Read-only lookup tables built from a project revision. Rebuilt whenever the project changes. */
export class ProjectIndex {
  readonly lib: ProfileLibrary;
  readonly fixtures = new Map<string, ResolvedFixture>();
  readonly fixtureOrder: string[] = [];
  readonly groups = new Map<string, Group>();
  readonly scenes = new Map<string, Scene>();
  readonly cueLists = new Map<string, CueList>();
  readonly effects = new Map<string, Effect>();
  readonly timelines = new Map<string, Timeline>();

  constructor(readonly project: Project) {
    this.lib = new ProfileLibrary(project.profiles);
    for (const f of project.patch) {
      const rf = resolveFixture(this.lib, f);
      if (rf) {
        this.fixtures.set(f.id, rf);
        this.fixtureOrder.push(f.id);
      }
    }
    for (const g of project.groups) this.groups.set(g.id, g);
    for (const s of project.scenes) this.scenes.set(s.id, s);
    for (const c of project.cueLists) this.cueLists.set(c.id, c);
    for (const e of project.effects) this.effects.set(e.id, e);
    for (const t of project.timelines) this.timelines.set(t.id, t);
  }

  /** Ordered, de-duplicated fixtures for a target (groups keep their own order). Unknown ids are ignored. */
  resolveTargets(target: Target): ResolvedFixture[] {
    const seen = new Set<string>();
    const out: ResolvedFixture[] = [];
    const add = (id: string) => {
      if (seen.has(id)) return;
      const rf = this.fixtures.get(id);
      if (rf) {
        seen.add(id);
        out.push(rf);
      }
    };
    for (const gid of target.groupIds) for (const id of this.groups.get(gid)?.fixtureIds ?? []) add(id);
    for (const id of target.fixtureIds) add(id);
    return out;
  }
}
