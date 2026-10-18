import { ProjectIndex } from '../../src/core/engine/resolve';
import { interpretLocally } from '../../src/core/ai/local/interpreter';
import { buildProposal, interpreterContext, validateActions } from '../../src/core/ai/director';
import { demoProject, makeEngine } from '../helpers';

function ctx(allowStrobe = false) {
  const { engine, project } = makeEngine();
  engine.tick(25);
  const index = new ProjectIndex(project);
  return { engine, index, ictx: interpreterContext(index, engine, allowStrobe), vctx: { index, allowStrobe, maxStrobeHz: 10 } };
}

describe('interpréteur local déterministe', () => {
  const prompts: [string, string[]][] = [
    ['Crée une ambiance lounge violette et bleue.', ['createScene']],
    ['Fais monter progressivement l’intensité sur huit secondes.', ['setIntensity']],
    ['Crée un chase sur les quatre lyres.', ['startEffect']],
    ['Prépare un drop énergique pour le refrain.', ['createSequence']],
    ['Génère un show de deux minutes pour de la musique électronique.', ['createSequence']],
    ['Fais des mouvements synchronisés au BPM.', ['startEffect']],
  ];
  it.each(prompts)('« %s »', (prompt, types) => {
    const { ictx } = ctx();
    const r = interpretLocally(prompt, ictx);
    expect(r.recognized).toBe(true);
    expect(r.actions.map((a) => a.type)).toEqual(types);
  });

  it('extrait durée, couleurs et cibles', () => {
    const { ictx } = ctx();
    const fade = interpretLocally('Fais monter progressivement l’intensité sur huit secondes.', ictx).actions[0];
    expect(fade).toMatchObject({ type: 'setIntensity', level: 1, fade: 8 });
    const scene = interpretLocally('Crée une ambiance lounge violette et bleue.', ictx).actions[0];
    expect(scene).toMatchObject({ type: 'createScene', apply: true, look: [{ colors: ['#8B00FF', '#0040FF'] }] });
    const chase = interpretLocally('Crée un chase sur les quatre lyres.', ictx).actions[0];
    expect(chase).toMatchObject({ type: 'startEffect', effect: { effectType: 'chase', target: { limit: 4, fixtureTypes: ['moving-head-spot', 'moving-head-wash'] } } });
    const moves = interpretLocally('Fais des mouvements synchronisés au BPM.', ictx).actions[0];
    expect(moves).toMatchObject({ type: 'startEffect', effect: { effectType: 'panTilt', bpmSync: true } });
  });

  it('variantes et ajustements relatifs utilisent l’état courant', () => {
    const { engine, index } = ctx();
    engine.setProgrammer(['par1', 'par2'], { red: 1 });
    engine.tick(25);
    const ictx = interpreterContext(index, engine, false);
    expect(interpretLocally('Crée trois variantes de cette scène.', ictx).actions.filter((a) => a.type === 'createScene')).toHaveLength(3);
    const adj = interpretLocally('Rends l’ambiance plus chaude et moins agressive.', ictx).actions.map((a) => a.type);
    expect(adj).toContain('setColor');
    expect(adj).toContain('setIntensity');
    expect(adj).toContain('stopEffect');
  });

  it('n’invente rien quand la demande n’est pas reconnue', () => {
    const { ictx } = ctx();
    const r = interpretLocally('Quelle heure est-il ?', ictx);
    expect(r.recognized).toBe(false);
    expect(r.actions).toEqual([]);
  });

  it('refuse le strobe quand la sécurité l’interdit', () => {
    const { ictx } = ctx(false);
    const r = interpretLocally('Lance un strobe', ictx);
    expect(r.actions).toEqual([]);
    expect(r.notices.join()).toMatch(/strobe refusé/i);
  });
});

describe('validation des actions IA', () => {
  it('rejette une commande inconnue, des paramètres hors plage et des cibles incompatibles', () => {
    const { vctx } = ctx();
    const v = validateActions([
      { type: 'sendDmx', universe: 1, data: [255] },
      { type: 'setIntensity', target: { all: true }, level: 3 },
      { type: 'setPosition', target: { groupNames: ['Pars'] }, pan: 0.5 },
      { type: 'setColor', target: { fixtureNames: ['Inconnu'] }, color: '#FF0000' },
      { type: 'startEffect', effect: { name: 'x', effectType: 'strobe', target: { all: true }, speed: 20 } },
      { type: 'applyScene', sceneName: 'N’existe pas' },
      { type: 'setColor', target: { groupNames: ['Pars'] }, color: '#FF0000', fade: 2 },
    ], vctx);
    expect(v.map((x) => x.status)).toEqual(['rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'ok']);
    expect(v[0]!.summary).toMatch(/Commande IA inconnue/);
    expect(v[2]!.messages.join()).toMatch(/pan\/tilt/);
    expect(v[4]!.messages.join()).toMatch(/Strobe interdit/);
  });

  it('accepte une scène créée plus tôt dans la même proposition et calcule la prévisualisation', () => {
    const { vctx } = ctx();
    const p = buildProposal({
      prompt: 't', provider: 'local', model: null, understanding: '', notices: [], ctx: vctx,
      rawActions: [
        { type: 'createScene', name: 'Bleu', look: [{ target: { groupNames: ['pars'] }, color: '#0000FF', level: 0.5 }] },
        { type: 'applyScene', sceneName: 'bleu', fade: 1 },
      ],
    });
    expect(p.actions.map((a) => a.status)).toEqual(['ok', 'ok']);
    expect(p.preview.par1).toEqual({ dimmer: 0.5, red: 0, green: 0, blue: 1 });
    expect(p.preview.rgbw).toMatchObject({ blue: 1, white: 0 });
    expect(p.preview.spot1).toBeUndefined();
  });

  it('demoProject reste inchangé par la validation (pas d’effet de bord)', () => {
    const before = JSON.stringify(demoProject().patch);
    const { vctx } = ctx();
    validateActions([{ type: 'releaseAi' }], vctx);
    expect(JSON.stringify(demoProject().patch)).toBe(before);
  });
});
