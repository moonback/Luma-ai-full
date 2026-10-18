import { randomUUID } from 'node:crypto';
import { mergeSources } from '../../src/core/engine/merge';
import { computeEffect, effectRate } from '../../src/core/engine/effects';
import { ProjectIndex } from '../../src/core/engine/resolve';
import { finalizeFixture, renderFixture } from '../../src/core/engine/render';
import type { ResolvedFixture } from '../../src/core/fixtures/profiles';
import { effectSchema, type Effect } from '../../src/core/model/schemas';
import { demoProject, makeEngine, run, u1 } from '../helpers';

const fx = (over: Partial<Effect> & Pick<Effect, 'type'>): Effect =>
  effectSchema.parse({ id: randomUUID(), name: 'fx', targets: { fixtureIds: ['par1', 'par2', 'rgbw'], groupIds: [] }, params: {}, ...over });

describe('fusion des sources (politique de priorité)', () => {
  it('HTP pour l’intensité, LTP pour le reste dans une même priorité', () => {
    const r = mergeSources(
      [
        { id: 'a', label: 'A', kind: 'playback', priority: 50, order: 1, values: { f: { dimmer: 0.8, red: 1 } } },
        { id: 'b', label: 'B', kind: 'playback', priority: 50, order: 2, values: { f: { dimmer: 0.3, red: 0.2 } } },
      ], [], {});
    expect(r.values.f).toEqual({ dimmer: 0.8, red: 0.2 });
    expect(r.sources.f).toEqual({ dimmer: 'A', red: 'B' });
  });

  it('une priorité supérieure remplace (y compris l’intensité), le manuel gagne toujours', () => {
    const r = mergeSources(
      [
        { id: 'a', label: 'A', kind: 'playback', priority: 50, order: 5, values: { f: { dimmer: 1 } } },
        { id: 'ai', label: 'IA', kind: 'ai', priority: 60, order: 1, values: { f: { dimmer: 0.2, blue: 1 } } },
      ],
      [{ id: 'e', label: 'FX', priority: 55, order: 1, blend: 'override', values: { f: { blue: 0 }, g: { dimmer: 1 } } }],
      { f: { blue: 0.5 } },
    );
    expect(r.values.f!.dimmer).toBe(0.2); // AI (60) over playback (50)
    expect(r.values.f!.blue).toBe(0.5); // manual over AI and effect
    expect(r.sources.f!.blue).toBe('Manuel');
    expect(r.values.g!.dimmer).toBe(1); // effect alone
  });

  it('effet en mode scale module la valeur sous-jacente', () => {
    const r = mergeSources([{ id: 'a', label: 'A', kind: 'playback', priority: 50, order: 1, values: { f: { dimmer: 0.8 } } }], [{ id: 'e', label: 'S', priority: 50, order: 1, blend: 'scale', values: { f: { dimmer: 0.5 } } }], {});
    expect(r.values.f!.dimmer).toBeCloseTo(0.4);
  });
});

describe('moteur : rendu DMX', () => {
  it('le programmeur écrit les bons canaux, 16 bits inclus', () => {
    const { engine } = makeEngine();
    engine.setProgrammer(['par2'], { red: 1, green: 0.5 });
    engine.setProgrammer(['spot1'], { pan: 0.75, dimmer: 1 });
    engine.tick(25);
    const u = u1(engine);
    expect([u[3], u[4], u[5]]).toEqual([255, 128, 0]); // PAR 2 at 4..6
    const v16 = Math.round(0.75 * 65535);
    expect(u[19]).toBe(v16 >> 8); // Spot1 pan coarse @20
    expect(u[20]).toBe(v16 & 0xff); // pan fine @21
    expect(u[21]).toBe(128); // tilt default
    expect(u[24]).toBe(255); // dimmer @25
    expect(u[25]).toBe(8); // shutter default "open"
    expect(u.length).toBe(512);
  });

  it('dimmer virtuel pour les PAR sans canal dimmer, master et blackout', () => {
    const { engine } = makeEngine();
    engine.setProgrammer(['par1'], { red: 1, dimmer: 0.5 });
    engine.tick(25);
    expect(u1(engine)[0]).toBe(128);
    engine.master = 0.5;
    engine.tick(25);
    expect(u1(engine)[0]).toBe(64);
    engine.setProgrammer(['spot1'], { dimmer: 1 });
    engine.blackout = true;
    engine.tick(25);
    expect(u1(engine)[0]).toBe(0);
    expect(u1(engine)[24]).toBe(0); // spot dimmer
    expect(u1(engine)[25]).toBe(2); // shutter forced to centre of first "closed" range 0..3 (policy intensity-shutter)
  });

  it('bloque les fonctions spéciales dangereuses sans confirmation', () => {
    const { engine } = makeEngine();
    const r = engine.setProgrammer(['spot1'], { control: 120 / 255 });
    expect(r.rejected[0]?.reason).toMatch(/confirmation/);
    engine.tick(25);
    expect(u1(engine)[31]).toBe(0); // control = 13th channel of Spot 1 (@32)
    engine.setProgrammer(['spot1'], { control: 120 / 255 }, { confirmSpecial: true });
    engine.tick(25);
    expect(u1(engine)[31]).toBe(120);
  });

  it('rejette valeurs hors plage et projecteurs inconnus', () => {
    const { engine } = makeEngine();
    const r = engine.setProgrammer(['par1', 'ghost'], { red: 1.5 });
    expect(r.applied).toBe(0);
    expect(r.rejected.map((x) => x.reason)).toEqual(['Valeur hors plage (0..1)', 'Projecteur inconnu']);
  });

  it('le défaut 16 bits exact est rendu sur les deux octets', () => {
    const rf = {
      fixture: { address: 1 },
      mode: { name: 'M', channels: [
        { name: 'Pan', attribute: 'pan', fine: false, default: 128, default16: 0x7fab, ranges: [] },
        { name: 'Pan fin', attribute: 'pan', fine: true, default: 0, ranges: [] },
      ] },
    } as unknown as ResolvedFixture;
    const values = finalizeFixture(rf, undefined, { master: 1, blackout: false, policy: 'intensity' });
    const u = new Uint8Array(512);
    renderFixture(rf, values, u, () => false);
    expect([u[0], u[1]]).toEqual([0x7f, 0xab]);
  });

  describe('lyre + anneau LED (dimmer de cellule séparé)', () => {
    const ch = (attribute: string, cell?: number, ranges: object[] = []) => ({ name: attribute, attribute, cell, fine: false, default: 0, ranges });
    const rf = {
      mode: {
        name: 'Ring',
        channels: [
          ch('dimmer'), ch('red'), ch('green'), ch('blue'), ch('shutter', 1, [{ from: 0, to: 3, label: 'Fermé', kind: 'closed', dangerous: false }]),
          ch('dimmer', 1), ch('red', 1), ch('green', 1), ch('blue', 1), ch('red', 2),
        ],
      },
    } as unknown as ResolvedFixture;
    const merged = { dimmer: 1, red: 1, 'dimmer#1': 1, 'red#1': 1, 'red#2': 1, 'shutter#1': 1 };

    it('blackout coupe le dimmer global et celui de l’anneau, ferme shutter#n', () => {
      const out = finalizeFixture(rf, merged, { master: 1, blackout: true, policy: 'intensity-shutter' });
      expect(out.dimmer).toBe(0);
      expect(out['dimmer#1']).toBe(0);
      expect(out['shutter#1']).toBe(2 / 255);
      expect(out['red#1']).toBe(1); // driven by dimmer#1, not rescaled
    });

    it('le grand master à 50 % s’applique aux deux dimmers', () => {
      const out = finalizeFixture(rf, merged, { master: 0.5, blackout: false, policy: 'intensity' });
      expect(out.dimmer).toBe(0.5);
      expect(out['dimmer#1']).toBe(0.5);
      expect(out.red).toBe(1);
      expect(out['red#1']).toBe(1);
      expect(out['red#2']).toBe(1); // cell without dimmer follows the global hardware dimmer
    });

    it('sans dimmer global, une cellule sans dimmer suit le dimmer virtuel', () => {
      const noGlobal = { mode: { name: 'Bar', channels: [ch('red', 1), ch('dimmer', 2), ch('red', 2)] } } as unknown as ResolvedFixture;
      const out = finalizeFixture(noGlobal, { dimmer: 0.5, 'red#1': 1, 'dimmer#2': 1, 'red#2': 1 }, { master: 0.5, blackout: false, policy: 'intensity' });
      expect(out['red#1']).toBe(0.25);
      expect(out['red#2']).toBe(1);
      expect(out['dimmer#2']).toBe(0.5);
      const bo = finalizeFixture(noGlobal, { 'red#1': 1, 'dimmer#2': 1, 'red#2': 1 }, { master: 1, blackout: true, policy: 'intensity' });
      expect(bo).toEqual({ 'red#1': 0, 'dimmer#2': 0, 'red#2': 1 });
    });
  });
});

describe('moteur : cues et transitions', () => {
  function withCues() {
    const p = demoProject();
    p.scenes = [
      { id: 'sA', name: 'A', notes: '', origin: 'user', values: { par1: { red: 1, dimmer: 1 } } },
      { id: 'sB', name: 'B', notes: '', origin: 'user', values: { par1: { blue: 1, dimmer: 0.5 } } },
    ];
    p.cueLists = [{ id: 'L', name: 'Liste', priority: 50, loop: false, cues: [
      { id: 'c1', number: 1, name: 'A', description: '', sceneId: 'sA', fade: 2, delay: 0, curve: 'linear', trigger: { type: 'manual' }, effectIds: [] },
      { id: 'c2', number: 2, name: 'B', description: '', sceneId: 'sB', fade: 1, delay: 0.5, curve: 'linear', trigger: { type: 'follow', wait: 1 }, effectIds: [] },
    ] }];
    return makeEngine(p);
  }

  it('GO calcule un fondu linéaire, puis suit automatiquement le cue suivant', () => {
    const { engine } = withCues();
    expect(engine.cueGo('L')).toBe(true);
    run(engine, 1000);
    expect(u1(engine)[0]).toBe(128); // red 0→1 halfway (virtual dimmer 1)
    const st = engine.snapshot().playbacks[0]!;
    expect(st.state).toBe('fading');
    expect(st.remaining).toBeCloseTo(1, 1);
    run(engine, 1000);
    expect(engine.snapshot().playbacks[0]!.state).toBe('holding');
    expect(u1(engine)[0]).toBe(255);
    run(engine, 1000); // follow wait 1 s → cue 2 starts (delay 0.5 s)
    expect(engine.snapshot().playbacks[0]!.index).toBe(1);
    run(engine, 1600);
    // Tracking: red is absent from cue B so it holds (1); blue fades in; virtual dimmer 0.5 scales both
    expect([u1(engine)[0], u1(engine)[2]]).toEqual([128, 128]);
  });

  it('BACK, PAUSE/REPRISE et STOP gardent un état cohérent', () => {
    const { engine } = withCues();
    engine.cueGo('L');
    run(engine, 500);
    engine.cuePause('L');
    const before = u1(engine)[0];
    run(engine, 1000);
    expect(u1(engine)[0]).toBe(before);
    expect(engine.snapshot().playbacks[0]!.state).toBe('paused');
    engine.cueResume('L');
    run(engine, 2000);
    expect(engine.cueGoto('L', 1)).toBe(true);
    expect(engine.cueBack('L')).toBe(true);
    expect(engine.snapshot().playbacks[0]!.index).toBe(0);
    engine.cueStop('L');
    engine.tick(25);
    expect(u1(engine)[0]).toBe(0);
    expect(engine.snapshot().playbacks[0]!.state).toBe('idle');
  });

  it('le contrôle manuel reprend immédiatement la priorité puis rend la main', () => {
    const { engine } = withCues();
    engine.cueGo('L');
    run(engine, 2100);
    engine.setProgrammer(['par1'], { red: 0 });
    engine.tick(25);
    expect(u1(engine)[0]).toBe(0);
    expect(engine.sources.par1!.red).toBe('Manuel');
    engine.releaseProgrammer(['par1']);
    engine.tick(25);
    expect(u1(engine)[0]).toBe(255);
  });

  it('sans scène suivante en boucle, GO à la fin est refusé', () => {
    const { engine } = withCues();
    engine.cueGoto('L', 1);
    expect(engine.cueGo('L')).toBe(false);
  });
});

describe('effets', () => {
  const index = new ProjectIndex(demoProject());
  const targets = index.resolveTargets({ fixtureIds: ['par1', 'par2', 'rgbw'], groupIds: [] });

  it('sont déterministes pour une phase donnée', () => {
    for (const type of ['fade', 'pulse', 'chase', 'wave', 'rainbow', 'strobe', 'dimmerWave', 'colorCycle'] as const) {
      const e = fx({ type, params: { phaseSpread: 0.5 } as never });
      expect(computeEffect(e, 1.37, targets)).toEqual(computeEffect(e, 1.37, targets));
    }
  });

  it('chase allume un seul projecteur à la fois', () => {
    const e = fx({ type: 'chase', params: { offset: 0.5, amplitude: 1 } as never });
    const at = (ph: number) => targets.map((t) => computeEffect(e, ph, targets)[t.fixture.id]!.dimmer);
    expect(at(0.1)).toEqual([1, 0, 0]);
    expect(at(0.4)).toEqual([0, 1, 0]);
    expect(at(0.8)).toEqual([0, 0, 1]);
  });

  it('mouvement aléatoire reproductible avec la même graine, différent avec une autre', () => {
    const spots = index.resolveTargets({ fixtureIds: ['spot1', 'spot2'], groupIds: [] });
    const a = fx({ type: 'randomMove', targets: { fixtureIds: ['spot1', 'spot2'], groupIds: [] }, params: { seed: 42 } as never });
    const b = fx({ type: 'randomMove', targets: { fixtureIds: ['spot1', 'spot2'], groupIds: [] }, params: { seed: 7 } as never });
    expect(computeEffect(a, 3.3, spots)).toEqual(computeEffect(a, 3.3, spots));
    expect(computeEffect(a, 3.3, spots)).not.toEqual(computeEffect(b, 3.3, spots));
    expect(computeEffect(a, 3.3, targets)).toEqual({}); // PARs have no pan/tilt
  });

  it('vitesse synchronisée au BPM et strobe plafonné par la sécurité', () => {
    expect(effectRate(fx({ type: 'pulse', params: { bpmSync: true, beatsPerCycle: 1 } as never }), 120, 10)).toBe(2);
    expect(effectRate(fx({ type: 'strobe', params: { speed: 25 } as never }), 120, 10)).toBe(10);
  });

  it('démarrent, se mettent en pause, s’arrêtent et respectent leur durée', () => {
    const p = demoProject();
    p.effects = [fx({ id: 'chase', type: 'chase' }), fx({ id: 'short', type: 'pulse', duration: 1 })];
    const { engine } = makeEngine(p);
    const i1 = engine.startEffect('chase')!;
    engine.startEffect('short');
    run(engine, 500);
    expect(engine.snapshot().effects).toHaveLength(2);
    run(engine, 600);
    expect(engine.snapshot().effects.map((e) => e.effectId)).toEqual(['chase']);
    engine.setEffectPaused(i1, true);
    const frozen = structuredClone(engine.values);
    run(engine, 300);
    expect(engine.values).toEqual(frozen);
    engine.stopEffect(i1);
    engine.tick(25);
    expect(u1(engine)[0]).toBe(0);
    expect(engine.startEffect('unknown')).toBeNull();
  });
});

describe('timeline', () => {
  it('déclenche les cues au passage de la tête de lecture et applique les scènes actives', () => {
    const p = demoProject();
    p.scenes = [{ id: 's', name: 'S', notes: '', origin: 'user', values: { par2: { green: 1 } } }];
    p.cueLists = [{ id: 'L', name: 'L', priority: 50, loop: false, cues: [{ id: 'c', number: 1, name: 'c', description: '', sceneId: 's', fade: 0, delay: 0, curve: 'linear', trigger: { type: 'manual' }, effectIds: [] }] }];
    p.timelines = [{ id: 'T', name: 'T', duration: 10, loop: false, events: [
      { id: 'e1', kind: 'scene', start: 1, duration: 2, refId: 's', cueIndex: 0, fade: 0, label: '', lane: 0 },
      { id: 'e2', kind: 'cue', start: 5, duration: 0, refId: 'L', cueIndex: 0, fade: 0, label: '', lane: 1 },
    ] }];
    const { engine } = makeEngine(p);
    engine.timelinePlay('T');
    run(engine, 1500);
    expect(u1(engine)[4]).toBe(255); // scene event active at t=1.5
    run(engine, 2000);
    expect(u1(engine)[4]).toBe(0); // ended at t=3
    run(engine, 2000);
    expect(engine.snapshot().playbacks[0]?.state).toBe('holding'); // cue fired at t=5
    run(engine, 6000);
    expect(engine.snapshot().timeline.state).toBe('stopped');
  });
});
