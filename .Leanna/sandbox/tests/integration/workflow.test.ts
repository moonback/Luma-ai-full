import path from 'node:path';
import { promises as fs } from 'node:fs';
import { vi } from 'vitest';
import { buildVisualModel } from '../../src/core/visualizer/model';
import { ProjectIndex } from '../../src/core/engine/resolve';
import { run, makeService, tempDir } from '../helpers';

vi.mock('../../src/core/ai/providers/openrouter', async (orig) => {
  const mod = await orig<typeof import('../../src/core/ai/providers/openrouter')>();
  return {
    ...mod,
    listOpenRouterModels: vi.fn(async () => []),
    proposeWithOpenRouter: vi.fn(async () => { throw new Error('Connexion impossible (réseau indisponible ?) : getaddrinfo ENOTFOUND openrouter.ai'); }),
  };
});

describe('parcours complet (AppService sans Electron)', () => {
  it('projet → patch → console → scène → cue → transition → sauvegarde → réouverture → IA → sortie virtuelle', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'show.luma.json');
    const { svc } = makeService(dir, { save: file });
    await svc.init();
    const e = svc.engine;

    // 1. Créer un projet
    await svc.execute({ type: 'project.new', name: 'Concert test' });
    expect(svc.projectState().project.meta.name).toBe('Concert test');

    // 2–3. Ajouter des projecteurs sur l'univers 1 (adresses automatiques)
    const { ids: pars } = await svc.execute({ type: 'fixture.add', profileId: 'demo-par-rgbw', mode: '6ch DRGBW+Strobe', universe: 1, address: null, count: 4, namePrefix: 'PAR', tags: ['face'] });
    const { ids: spots } = await svc.execute({ type: 'fixture.add', profileId: 'demo-spot', mode: '13ch étendu', universe: 1, address: 101, count: 2, namePrefix: 'Spot', tags: [] });
    const patch = svc.projectState().project.patch;
    expect(patch.map((f) => f.address)).toEqual([1, 7, 13, 19, 101, 114]);
    expect(svc.projectState().issues).toEqual([]);
    await svc.execute({ type: 'group.upsert', group: { id: 'g1', name: 'Face', color: '#8B5CF6', fixtureIds: pars } });

    // 4. Sortie virtuelle active par défaut
    expect(svc.outputs.status().find((s) => s.kind === 'virtual')?.state).toBe('ready');

    // 5–6. Modifier une valeur dans la console, vérifier les 512 canaux
    await svc.execute({ type: 'programmer.set', fixtureIds: [pars[1]!], values: { dimmer: 1, red: 1 }, confirmSpecial: false });
    e.tick(25);
    let u = (await svc.execute({ type: 'output.universe', universe: 1 })).computed;
    expect(u).toHaveLength(512);
    expect(u.slice(6, 12)).toEqual([255, 255, 0, 0, 0, 0]); // PAR 2 @7..12
    expect(u.filter((v, i) => v !== 0 && !(i >= 6 && i <= 11) && i < 100).length).toBe(0); // no other PAR channel lit
    const virtualFrame = (await svc.execute({ type: 'output.universe', universe: 1 })).transmitted[0]!;
    expect(virtualFrame.data.slice(6, 8)).toEqual([255, 255]);

    // 7. Créer une scène depuis le programmeur
    const { id: sceneId } = await svc.execute({ type: 'scene.record', name: 'Rouge PAR 2' });
    await svc.execute({ type: 'programmer.release' });

    // 8. Enregistrer un cue (3 s de fondu)
    const list = svc.projectState().project.cueLists[0]!;
    await svc.execute({ type: 'cueList.upsert', cueList: { ...list, cues: [{ id: 'c1', number: 1, name: 'Rouge', description: '', sceneId, fade: 3, delay: 0, curve: 'linear', trigger: { type: 'manual' }, effectIds: [] }] } });

    // 9–10. Exécuter la transition, vérifier les valeurs calculées à mi-chemin et à la fin
    expect((await svc.execute({ type: 'cue.go', listId: list.id })).ok).toBe(true);
    run(e, 1500);
    u = (await svc.execute({ type: 'output.universe', universe: 1 })).computed;
    expect(u[6]).toBe(128);
    run(e, 1600);
    u = (await svc.execute({ type: 'output.universe', universe: 1 })).computed;
    expect([u[6], u[7]]).toEqual([255, 255]);

    // 11. Sauvegarder
    expect((await svc.execute({ type: 'project.save' })).path).toBe(file);
    expect(svc.dirty).toBe(false);
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as { version: number };
    expect(saved.version).toBe(3);
    await svc.dispose();

    // 12–13. Fermer et rouvrir : état restauré
    const second = makeService(dir).svc;
    await second.init();
    const { opened } = await second.execute({ type: 'project.open', path: file });
    expect(opened).toBe(true);
    const restored = second.projectState().project;
    expect(restored.meta.name).toBe('Concert test');
    expect(restored.patch.map((f) => f.id)).toEqual([...pars, ...spots]);
    expect(restored.scenes[0]!.values[pars[1]!]).toMatchObject({ dimmer: 1, red: 1 });
    expect(restored.cueLists[0]!.cues[0]!.fade).toBe(3);
    expect(restored.groups[0]!.fixtureIds).toEqual(pars);

    // 14. Générer une scène avec l'assistant IA (mode local)
    const proposal = await second.execute({ type: 'ai.propose', prompt: 'Crée une ambiance lounge violette et bleue sur le groupe Face' });
    expect(proposal.provider).toBe('local');
    expect(proposal.actions[0]!.status).toBe('ok');
    // 15. Valider, prévisualiser (calcul sans sortie), appliquer
    expect(Object.keys(proposal.preview).sort()).toEqual([...pars].sort());
    expect(proposal.preview[pars[0]!]).toMatchObject({ dimmer: 0.55, blue: 1 });
    const report = await second.execute({ type: 'ai.apply', proposalId: proposal.id });
    expect(report.skipped).toEqual([]);
    expect(report.created.scenes).toEqual(['Ambiance lounge']);
    expect(report.verification.checked).toBeGreaterThan(0);
    expect(report.verification.matched).toBe(report.verification.checked);
    run(second.engine, 3200);
    // Outputs are rate-limited on wall-clock time (40 fps): let one real period elapse so the transmitted frame catches up.
    await new Promise((r) => setTimeout(r, 30));
    second.engine.tick(25);
    // 16. Vérifier la sortie virtuelle et le visualiseur
    const view = await second.execute({ type: 'output.universe', universe: 1 });
    const out = view.transmitted.find((t) => t.outputId === 'virtual-1')!.data;
    expect(out[0]).toBe(Math.round(0.55 * 255)); // PAR 1 dimmer
    expect(out[3]).toBe(255); // PAR 1 blue (violet #8B00FF)
    const idx = new ProjectIndex(second.projectState().project);
    const vis = buildVisualModel([...idx.fixtures.values()], second.engine.values);
    expect(vis[0]!.intensity).toBeCloseTo(0.55, 2);
    expect(vis[0]!.color).toBe('#8b00ff');
    expect(vis[1]!.color).toBe('#0040ff');
    await second.dispose();
  });
});

describe('sécurité et cas d’erreur', () => {
  async function ready() {
    const { svc, dataDir } = makeService();
    await svc.init();
    await svc.execute({ type: 'fixture.add', profileId: 'demo-spot', mode: '13ch étendu', universe: 1, address: 1, count: 1, namePrefix: 'Spot', tags: [] });
    return { svc, dataDir, id: svc.projectState().project.patch[0]!.id };
  }

  it('refuse une adresse invalide ou en conflit', async () => {
    const { svc, id } = await ready();
    await expect(svc.execute({ type: 'fixture.update', id, patch: { address: 505 } })).rejects.toThrow(/dépasse le canal 512/);
    await expect(svc.execute({ type: 'fixture.add', profileId: 'demo-par-rgb', mode: '3ch RGB', universe: 1, address: 5, count: 1, namePrefix: 'P', tags: [] })).rejects.toThrow(/chevauche/);
    expect(svc.projectState().project.patch).toHaveLength(1); // rejected mutations leave the project untouched
    await svc.dispose();
  });

  it('fonction spéciale : refusée sans confirmation, acceptée avec', async () => {
    const { svc, id } = await ready();
    const r = await svc.execute({ type: 'programmer.set', fixtureIds: [id], values: { control: 0.5 }, confirmSpecial: false });
    expect(r.rejected[0]!.reason).toMatch(/confirmation/);
    const ok = await svc.execute({ type: 'programmer.set', fixtureIds: [id], values: { control: 0.5 }, confirmSpecial: true });
    expect(ok.applied).toBe(1);
    await svc.dispose();
  });

  it('une sortie réelle ne s’arme jamais sans action explicite ; perte de connexion signalée', async () => {
    const { svc } = await ready();
    await svc.execute({ type: 'output.configure', outputs: [
      { id: 'virtual-1', name: 'Virtuelle', kind: 'virtual', enabled: true, maxFps: 40, universes: [1] },
      { id: 'art', name: 'Art-Net', kind: 'artnet', enabled: true, maxFps: 40, host: '127.0.0.1', bindAddress: '', broadcast: false, universeMap: [{ local: 1, remote: 0 }] },
    ] });
    expect(svc.runtimeState().liveMode).toBe(false);
    expect(svc.outputs.status().find((s) => s.id === 'art')!.state).toBe('disarmed');
    await svc.execute({ type: 'output.inject', injection: { type: 'disconnect' } });
    expect(svc.outputs.status().find((s) => s.id === 'virtual-1')!.state).toBe('error');
    expect(svc.runtimeState().alerts.some((a) => /déconnectée/.test(a.message))).toBe(true);
    await svc.execute({ type: 'output.inject', injection: { type: 'reconnect' } });
    expect(svc.outputs.status().find((s) => s.id === 'virtual-1')!.state).toBe('ready');
    await svc.dispose();
  });

  it('fournisseur IA indisponible : repli sur le mode local, moteur manuel intact', async () => {
    const { svc, id } = await ready();
    const s = svc.getSettings();
    s.ai.provider = 'openrouter';
    await svc.execute({ type: 'settings.update', settings: s });
    await svc.execute({ type: 'ai.setKey', key: 'sk-or-v1-test-0000000000' });
    const p = await svc.execute({ type: 'ai.propose', prompt: 'monte l’intensité à 50 %' });
    expect(p.provider).toBe('local');
    expect(p.notices[0]).toMatch(/indisponible/);
    expect(svc.runtimeState().ai.lastError).toMatch(/ENOTFOUND/);
    await svc.execute({ type: 'programmer.set', fixtureIds: [id], values: { dimmer: 1 }, confirmSpecial: false });
    svc.engine.tick(25);
    expect(svc.engine.universes.get(1)![5]).toBe(255);
    // the key never leaves the main process / project
    expect(JSON.stringify(svc.projectState())).not.toContain('sk-or-v1');
    expect(JSON.stringify(svc.runtimeState())).not.toContain('sk-or-v1');
    await svc.dispose();
  });

  it('une proposition IA ne s’applique qu’une fois et le manuel garde la priorité sur l’IA', async () => {
    const { svc, id } = await ready();
    await svc.execute({ type: 'programmer.set', fixtureIds: [id], values: { dimmer: 0.2 }, confirmSpecial: false });
    const p = await svc.execute({ type: 'ai.propose', prompt: 'plein feu' });
    const rep = await svc.execute({ type: 'ai.apply', proposalId: p.id });
    expect(rep.verification.overriddenByManual).toBe(1);
    await expect(svc.execute({ type: 'ai.apply', proposalId: p.id })).rejects.toThrow(/expirée/);
    svc.engine.tick(25);
    expect(svc.engine.universes.get(1)![5]).toBe(51);
    await svc.execute({ type: 'programmer.release' });
    run(svc.engine, 2100);
    expect(svc.engine.universes.get(1)![5]).toBe(255);
    await svc.dispose();
  });

  it('fermeture pendant une séquence : arrêt propre sans erreur', async () => {
    const { svc } = await ready();
    const p = await svc.execute({ type: 'ai.propose', prompt: 'Génère un show de deux minutes pour de la musique électronique' });
    await svc.execute({ type: 'ai.apply', proposalId: p.id });
    const list = svc.projectState().project.cueLists.find((l) => l.name.startsWith('Show'))!;
    await svc.execute({ type: 'cue.go', listId: list.id });
    run(svc.engine, 30000);
    expect(svc.engine.snapshot().playbacks.find((pb) => pb.cueListId === list.id)!.index).toBeGreaterThan(0); // followed automatically
    await expect(svc.dispose()).resolves.toBeUndefined();
  });

  it('fichier projet corrompu : erreur explicite et copie de secours listée', async () => {
    const { svc, dataDir } = await ready();
    const file = path.join(dataDir, 'p.luma.json');
    await svc.execute({ type: 'project.saveAs', path: file });
    await svc.execute({ type: 'project.save' }); // creates .bak
    await fs.writeFile(file, '{ broken', 'utf8');
    await expect(svc.execute({ type: 'project.open', path: file })).rejects.toThrow(/corrompu/);
    const rec = await svc.execute({ type: 'project.listRecovery' });
    expect(rec.some((r) => r.kind === 'backup')).toBe(true);
    const { opened } = await svc.execute({ type: 'project.openRecovery', file: rec.find((r) => r.kind === 'backup')!.file });
    expect(opened).toBe(true);
    await svc.dispose();
  });
});
