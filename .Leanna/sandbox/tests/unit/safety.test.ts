import { FlashDetector, limitFlashes, SLEW_PER_SECOND, type StageLight } from '../../src/core/safety/flashGuard';
import { Engine } from '../../src/core/engine/Engine';
import { ProjectIndex } from '../../src/core/engine/resolve';
import { defaultSettings } from '../../src/core/settings/settings';
import { effectParamsSchema } from '../../src/core/model/schemas';
import { demoProject, ENGINE_SETTINGS, makeService } from '../helpers';

const light = (luminance: number, extra: Partial<StageLight> = {}): StageLight => ({ luminance, red: 0, strobeShare: 0, strobeHz: 0, ...extra });

/** Square wave of `hz` full flashes per second sampled at 40 Hz for `seconds`. */
function square(d: FlashDetector, hz: number, seconds = 2) {
  let last = d.push(0, light(0));
  for (let i = 1; i <= seconds * 40; i++) {
    const t = i / 40;
    last = d.push(t, light(Math.floor(t * hz * 2) % 2 ? 0.9 : 0));
    if (last.violation) return last;
  }
  return last;
}

describe('garde-fou photosensible', () => {
  it('signale plus de 3 flashs/s, pas 2 flashs/s', () => {
    expect(square(new FlashDetector(), 5).violation).toBe(true);
    expect(square(new FlashDetector(), 2).violation).toBe(false);
  });

  it('ignore les petites variations et le strobe sur une petite part du kit', () => {
    const d = new FlashDetector();
    for (let i = 0; i < 80; i++) expect(d.push(i / 40, light(i % 2 ? 0.05 : 0, { strobeShare: 0.05, strobeHz: 15 })).violation).toBe(false);
    expect(new FlashDetector().push(0, light(0.5, { strobeShare: 0.3, strobeHz: 12 })).violation).toBe(true);
  });

  it('mode limiter : pente d’intensité bornée, strobe rapide ouvert, programmeur intact', () => {
    const index = new ProjectIndex(demoProject());
    const fixtures = [...index.fixtures.values()];
    const next = { par1: { red: 1 }, rgbw: { dimmer: 1, strobe: 1 }, par2: { red: 1 } };
    limitFlashes(fixtures, { par1: { red: 0 }, rgbw: { dimmer: 0 }, par2: { red: 0 } }, next, 25, { par2: { red: 1 } });
    const step = (SLEW_PER_SECOND * 25) / 1000;
    expect(next.par1.red).toBeCloseTo(step);
    expect(next.rgbw.dimmer).toBeCloseTo(step);
    expect(next.rgbw.strobe).toBeLessThan(10 / 255); // range « Pas de strobe »
    expect(next.par2.red).toBe(1);
  });

  it('moteur en mode limiter : un strobe 10 Hz ne produit plus de sauts plein/noir', () => {
    const p = demoProject();
    p.effects = [{ id: 's', name: 'S', type: 'strobe', targets: { fixtureIds: ['par1', 'par2', 'rgbw'], groupIds: [] }, params: effectParamsSchema.parse({ speed: 10 }), priority: 50, blend: 'override', duration: null, trigger: 'manual', origin: 'user' }];
    const engine = new Engine(new ProjectIndex(p), { sendFrames: () => undefined }, { ...ENGINE_SETTINGS, flashGuard: 'limit' });
    engine.tick(25); // running engine: the limiter needs a previous frame
    engine.startEffect('s');
    let prev = engine.values.rgbw!.dimmer!, maxJump = 0;
    for (let i = 0; i < 80; i++) {
      engine.tick(25);
      const v = engine.values.rgbw!.dimmer!;
      maxJump = Math.max(maxJump, Math.abs(v - prev));
      prev = v;
    }
    expect(maxJump).toBeLessThanOrEqual((SLEW_PER_SECOND * 25) / 1000 + 1e-9);
  });

  it('refuse un effet IA qui dépasse la limite de flashs', async () => {
    const { svc } = makeService();
    await svc.init();
    await svc.execute({ type: 'settings.update', settings: { ...defaultSettings(), ai: { ...defaultSettings().ai, allowStrobe: true } } });
    await svc.execute({ type: 'project.new', name: 'T' });
    await svc.execute({ type: 'fixture.add', profileId: 'demo-par-rgbw', mode: '6ch DRGBW+Strobe', universe: 1, address: null, count: 4, namePrefix: 'PAR', tags: [] });
    const base = await svc.execute({ type: 'ai.propose', prompt: 'tout en bleu' });
    const fx = (name: string, effectType: string, speed: number) => ({ type: 'startEffect', effect: { name, effectType, target: { all: true }, speed } });
    const p = await svc.execute({ type: 'ai.revise', proposalId: base.id, actions: [{ type: 'setColor', target: { all: true }, color: '#FFFFFF' }, fx('Flash', 'strobe', 8), fx('Doux', 'pulse', 0.5)] });
    expect(p.actions[1]!.status).toBe('rejected');
    expect(p.actions[1]!.messages.join(' ')).toMatch(/photosensible/);
    expect(p.actions[2]!.status).not.toBe('rejected');
    expect(p.notices.join(' ')).toMatch(/garde-fou/);
    await svc.dispose();
  });
});

