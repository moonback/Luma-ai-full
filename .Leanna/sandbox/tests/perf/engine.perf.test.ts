import { randomUUID } from 'node:crypto';
import { effectSchema, type Effect } from '../../src/core/model/schemas';
import { demoProject, ENGINE_SETTINGS, makeEngine, run } from '../helpers';

/**
 * Real-time measurements. Run alone (`npm run test:perf`, no file parallelism): other test workers competing for
 * the CPU make timings meaningless.
 */
const fx = (over: Partial<Effect> & Pick<Effect, 'type'>): Effect =>
  effectSchema.parse({ id: randomUUID(), name: 'fx', targets: { fixtureIds: ['par1', 'par2', 'rgbw'], groupIds: [] }, params: {}, ...over });

describe('ordonnanceur temps réel', () => {
  it.each([40, 44])('tient %i Hz en moyenne avec une gigue faible', async (rateHz) => {
    const { engine } = makeEngine();
    engine.updateSettings({ ...ENGINE_SETTINGS, rateHz });
    const stamps: number[] = [];
    engine.on('frame', () => stamps.push(performance.now()));
    engine.start();
    await new Promise((r) => setTimeout(r, 2000));
    engine.stop();
    const stopped = stamps.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(stamps.length).toBe(stopped); // no tick after stop()
    stamps.splice(0, 10); // warm-up (JIT, first timer calibration)
    const n = stamps.length;
    const hz = ((n - 1) * 1000) / (stamps[n - 1]! - stamps[0]!);
    const period = 1000 / rateHz;
    const jitter = stamps.slice(1).map((t, i) => Math.abs(t - stamps[i]! - period)).sort((a, b) => a - b);
    const p95 = jitter[Math.floor(jitter.length * 0.95)]!;
    console.info(`[ordonnanceur] ${rateHz} Hz : mesuré ${hz.toFixed(2)} Hz, gigue p95 ${p95.toFixed(2)} ms, max ${jitter.at(-1)!.toFixed(2)} ms`);
    expect(hz).toBeGreaterThan(rateHz - 0.5);
    expect(hz).toBeLessThan(rateHz + 0.5);
    expect(p95).toBeLessThan(2);
  });
});

describe('charge', () => {
  it('1000 projecteurs, 12 univers et 3 effets : un tick reste sous la période de 25 ms', () => {
    const p = demoProject();
    p.patch = [];
    for (let i = 0; i < 1000; i++) {
      p.patch.push({ id: `f${i}`, name: `F${i}`, profileId: 'demo-par-rgbw', mode: '6ch DRGBW+Strobe', universe: 1 + Math.floor(i / 85), address: 1 + (i % 85) * 6, tags: [], position: { x: 0, y: 0 }, rotation: 0, height: 4, notes: '' });
    }
    p.show.universes = 12;
    p.groups = [{ id: 'all', name: 'All', color: '#ffffff', fixtureIds: p.patch.map((f) => f.id) }];
    const all = { fixtureIds: [], groupIds: ['all'] };
    p.effects = [fx({ id: 'a', type: 'rainbow', targets: all }), fx({ id: 'b', type: 'dimmerWave', targets: all }), fx({ id: 'c', type: 'chase', targets: all, blend: 'scale' })];
    const { engine } = makeEngine(p);
    ['a', 'b', 'c'].forEach((id) => engine.startEffect(id));
    const t0 = performance.now();
    run(engine, 5000); // 200 ticks
    const avg = (performance.now() - t0) / 200;
    console.info(`[charge] tick moyen = ${avg.toFixed(2)} ms pour 1000 projecteurs`);
    expect(avg).toBeLessThan(25);
    expect(engine.universes.size).toBe(12);
  });
});
