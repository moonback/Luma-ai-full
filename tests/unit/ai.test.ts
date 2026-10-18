import { ProjectIndex } from '../../src/core/engine/resolve';
import { interpretLocally } from '../../src/core/ai/local/interpreter';
import { buildProposal, executeProposal, interpreterContext, liveState, validateActions, type ExecutionContext, type ValidationContext } from '../../src/core/ai/director';
import { describeRig, llmPlanSchema } from '../../src/core/ai/providers/openrouter';
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

describe('interpréteur local : exclusions, faisceau, effets en cours, scènes', () => {
  const run1 = (prompt: string, allowStrobe = false) => interpretLocally(prompt, ctx(allowStrobe).ictx);

  it('« sauf » / « sans toucher » retirent des projecteurs au lieu de les cibler', () => {
    expect(run1('Tout le monde en violet sauf les lyres').actions).toEqual([{ type: 'setColor', target: { fixtureNames: ['PAR 1', 'PAR 2', 'PAR W'] }, color: '#8B00FF', fade: 2 }]);
    expect(run1('Allume les lyres sans toucher aux PAR').actions).toMatchObject([{ type: 'setIntensity', target: { fixtureNames: ['Spot 1', 'Spot 2'] }, level: 1 }]);
    expect(run1('Rouge partout sauf le groupe Pars').actions[0]).toMatchObject({ target: { fixtureNames: ['Spot 1', 'Spot 2'] } });
  });

  it('les mots de lieu ne bougent les lyres que si la demande les concerne', () => {
    expect(run1('La salle en bleu').actions.map((a) => a.type)).toEqual(['setColor']);
    expect(run1('Rouge à gauche, bleu à droite').actions.map((a) => a.type)).toEqual(['setColor']);
    expect(run1('Pointe les lyres vers le public').actions).toMatchObject([{ type: 'setPosition', tilt: 0.7 }]);
    expect(run1('Au centre').actions).toMatchObject([{ type: 'setPosition', pan: 0.5, tilt: 0.5 }]);
  });

  it('arrêts ciblés, « arrête tout », fréquence de strobe et re-timing des effets', () => {
    expect(run1('Coupe le strobe').actions).toEqual([{ type: 'stopEffect', effectType: 'strobe' }]);
    expect(run1('Arrête les effets').actions).toEqual([{ type: 'stopEffect', all: true }]);
    expect(run1('Arrête tout').actions).toEqual([{ type: 'releaseAi' }]);
    expect(run1('Strobe à 5 Hz', true).actions[0]).toMatchObject({ effect: { effectType: 'strobe', speed: 5 } });
    expect(run1('Ralentis le chase').actions).toEqual([{ type: 'adjustEffect', effectType: 'chase', speedFactor: 0.5 }]);
    expect(run1('Accélère un peu').actions).toEqual([{ type: 'adjustEffect', speedFactor: 1.5 }]);
  });

  it('faisceau : gobo, prisme, zoom ; le pourcentage du zoom ne devient pas une intensité', () => {
    expect(run1('Mets le gobo 2 et le prisme sur les lyres').actions).toMatchObject([{ type: 'setBeam', gobo: 2, prism: true }]);
    expect(run1('Enlève le prisme').actions).toMatchObject([{ type: 'setBeam', prism: false, target: { fixtureTypes: ['moving-head-spot', 'moving-head-wash'] } }]);
    expect(run1('Zoom à 30 %').actions).toEqual([{ type: 'setBeam', target: { fixtureTypes: ['moving-head-spot', 'moving-head-wash'] }, zoom: 0.3, fade: 2 }]);
  });

  it('rappelle une scène existante au lieu d’en créer une', () => {
    const withScene = { ...ctx().ictx, scenes: ['Lounge bleu'] };
    expect(interpretLocally('Applique la scène lounge bleu', withScene).actions).toEqual([{ type: 'applyScene', sceneName: 'Lounge bleu', fade: 2 }]);
    const missing = interpretLocally('Applique la scène Finale', withScene);
    expect(missing.recognized).toBe(false);
    expect(missing.notices.join()).toMatch(/Lounge bleu/);
  });
});

describe('actions setBeam et adjustEffect', () => {
  const propose = (rawActions: unknown[], vctx: ValidationContext) => buildProposal({ prompt: 't', provider: 'local', model: null, understanding: '', notices: [], ctx: vctx, rawActions });

  it('setBeam utilise les plages gobo/prisme du profil et ignore les projecteurs sans faisceau', () => {
    const p = propose([
      { type: 'setBeam', target: { all: true }, gobo: 1, prism: true, focus: 0.4 },
      { type: 'setBeam', target: { fixtureNames: ['Spot 1'] }, gobo: 9 },
      { type: 'setBeam', target: { groupNames: ['Pars'] }, zoom: 1 },
      { type: 'setBeam', target: { all: true } },
    ], ctx().vctx);
    expect(p.actions.map((a) => a.status)).toEqual(['warning', 'rejected', 'rejected', 'rejected']);
    expect(p.actions[0]!.fixtureIds).toEqual(['spot1', 'spot2']);
    expect(p.actions[1]!.messages.join()).toMatch(/Gobo 9 absent/);
    expect(p.preview.spot1).toEqual({ gobo: 15 / 255, prism: 192 / 255, focus: 0.4 });
  });

  it('adjustEffect ralentit les effets IA en cours (vitesse ou temps BPM)', () => {
    const project = demoProject();
    const { engine } = makeEngine(project);
    let index = new ProjectIndex(project);
    const ectx: ExecutionContext = { index: () => index, mutate: (fn) => { fn(project); index = new ProjectIndex(project); engine.setIndex(index); }, engine, maxStrobeHz: 10 };
    const vctx = () => ({ index, allowStrobe: false, maxStrobeHz: 10 });
    executeProposal(propose([
      { type: 'startEffect', effect: { name: 'c', effectType: 'chase', target: { all: true }, speed: 2 } },
      { type: 'startEffect', effect: { name: 'p', effectType: 'pulse', target: { all: true }, bpmSync: true, beatsPerCycle: 1 } },
    ], vctx()), ectx);
    const rep = executeProposal(propose([{ type: 'adjustEffect', effectType: 'chase', speedFactor: 0.5 }, { type: 'adjustEffect', speedFactor: 0.5 }], vctx()), ectx);
    expect(rep.executed.map((e) => e.detail)).toEqual(['1 effet(s) ajusté(s)', '2 effet(s) ajusté(s)']);
    const params = (n: string) => project.effects.find((e) => e.name === n)!.params;
    expect(params('c').speed).toBe(0.5);
    expect(params('p').beatsPerCycle).toBe(2);
    const none = executeProposal(propose([{ type: 'adjustEffect', effectType: 'strobe', speedFactor: 2 }], vctx()), ectx);
    expect(none.skipped[0]!.reason).toMatch(/Aucun effet IA/);
  });

  it('OpenRouter reçoit l’état courant, les effets IA et le nombre de gobos', () => {
    const { engine, index } = ctx();
    engine.setProgrammer(['par1'], { red: 1 });
    engine.tick(25);
    const rig = JSON.parse(describeRig(index, false, 120, liveState(index, engine)));
    const fx = (name: string) => rig.fixtures.find((f: { name: string }) => f.name === name);
    expect(fx('PAR 1').now.color).toMatch(/^#ff0000$/i);
    expect(fx('Spot 1').gobos).toBe(4);
    expect(rig.runningAiEffects).toEqual([]);
    expect(llmPlanSchema.safeParse({ understanding: '', actions: [{ type: 'setBeam', gobo: 2 }, { type: 'adjustEffect', speedFactor: 0.5 }] }).success).toBe(true);
  });
});
