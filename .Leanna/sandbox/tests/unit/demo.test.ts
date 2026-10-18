import { DEMOS } from '../../src/core/demo/catalog';
import { buildDemo } from '../../src/core/demo/projects';
import { validatePatch } from '../../src/core/fixtures/patch';
import { ProjectIndex } from '../../src/core/engine/resolve';
import { makeService } from '../helpers';

describe('projets de démonstration', () => {
  it('10 projets aux identifiants uniques', () => {
    expect(DEMOS).toHaveLength(10);
    expect(new Set(DEMOS.map((d) => d.id)).size).toBe(10);
  });

  it.each(DEMOS.map((d) => [d.id]))('%s : projet valide et cohérent', (id) => {
    const p = buildDemo(id);
    const index = new ProjectIndex(p);
    expect(validatePatch(index.lib, p.patch)).toEqual([]);
    expect(p.patch.length).toBeGreaterThan(0);
    const fixtures = new Set(p.patch.map((f) => f.id));
    for (const s of p.scenes) for (const fid of Object.keys(s.values)) expect(fixtures.has(fid)).toBe(true);
    const scenes = new Set(p.scenes.map((s) => s.id)), effects = new Set(p.effects.map((e) => e.id)), groups = new Set(p.groups.map((g) => g.id));
    for (const e of p.effects) for (const g of e.targets.groupIds) expect(groups.has(g)).toBe(true);
    for (const l of p.cueLists) for (const c of l.cues) {
      if (c.sceneId) expect(scenes.has(c.sceneId)).toBe(true);
      for (const e of c.effectIds) expect(effects.has(e)).toBe(true);
    }
    for (const t of p.timelines) for (const e of t.events) expect(e.kind === 'scene' ? scenes.has(e.refId!) : effects.has(e.refId!)).toBe(true);
    // Deterministic: the same demo always yields the same patch.
    expect(buildDemo(id).patch).toEqual(p.patch);
  });

  it('le festival utilise 2 univers', () => {
    const p = buildDemo('festival');
    expect(p.show.universes).toBe(2);
    expect(new Set(p.patch.map((f) => f.universe))).toEqual(new Set([1, 2]));
  });

  it('ouverture depuis l’application et GO sur le premier cue', async () => {
    const { svc } = makeService();
    await svc.init();
    await svc.execute({ type: 'project.openDemo', id: 'concert-pop' });
    const st = svc.projectState();
    expect(st.project.meta.name).toContain('Aurore');
    expect(st.path).toBeNull();
    expect(st.dirty).toBe(true);
    const list = st.project.cueLists[0]!;
    await svc.execute({ type: 'cue.go', listId: list.id });
    for (let i = 0; i < 200; i++) svc.engine.tick(25); // 5 s: the 4 s intro fade is complete
    const lit = Object.values(svc.engine.values).filter((v) => (v.dimmer ?? 0) > 0.3).length;
    expect(lit).toBeGreaterThan(0);
    await expect(svc.execute({ type: 'project.openDemo', id: 'inconnu' })).rejects.toThrow(/inconnu/);
    await svc.dispose();
  });

  it('état d’onboarding persisté', async () => {
    const { svc } = makeService();
    await svc.init();
    expect(svc.getSettings().onboarding).toEqual({ completed: false, checklistHidden: false });
    await svc.execute({ type: 'onboarding.update', completed: true });
    expect(svc.getSettings().onboarding).toEqual({ completed: true, checklistHidden: false });
    await svc.dispose();
  });
});
