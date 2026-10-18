import { commandSchema } from '../../src/shared/commands';
import type { LocatePhoto } from '../../src/shared/commands';
import { makeService } from '../helpers';

async function setup() {
  const { svc } = makeService();
  await svc.init();
  await svc.execute({ type: 'project.new', name: 'Loc' });
  const { ids } = await svc.execute({ type: 'fixture.add', profileId: 'demo-par-rgbw', mode: '6ch DRGBW+Strobe', universe: 1, address: null, count: 3, namePrefix: 'PAR', tags: [] });
  return { svc, ids };
}

describe('séquence de localisation (moteur)', () => {
  it('confirmation obligatoire et intensité plafonnée à 60 %', () => {
    expect(commandSchema.safeParse({ type: 'locate.begin', mode: 'binary', level: 0.4 }).success).toBe(false);
    expect(commandSchema.safeParse({ type: 'locate.begin', confirmed: true, mode: 'binary', level: 0.9 }).success).toBe(false);
    expect(commandSchema.safeParse({ type: 'locate.begin', confirmed: true, mode: 'binary', level: 0.6 }).success).toBe(true);
  });

  it('motif : seuls les projecteurs du code sont allumés, en blanc, sans strobe ; fin = calque retiré', async () => {
    const { svc, ids } = await setup();
    svc.engine.setProgrammer([ids[0]!], { dimmer: 1, red: 1 });
    await svc.execute({ type: 'engine.blackout', on: true });
    await expect(svc.execute({ type: 'locate.begin', confirmed: true, mode: 'binary', level: 0.5, photo: false })).rejects.toThrow(/blackout/);
    await svc.execute({ type: 'engine.blackout', on: false });
    const r = await svc.execute({ type: 'locate.begin', confirmed: true, mode: 'binary', level: 0.5, photo: false });
    expect(r.frames).toHaveLength(2 + 2 * 2); // 3 fixtures → 2 bits
    expect(svc.engine.getProgrammer()).toEqual({}); // manual control released
    const lit = r.frames[2]!.lit;
    await svc.execute({ type: 'locate.frame', index: 2 });
    svc.engine.tick(25);
    for (const id of ids) {
      const v = svc.engine.values[id]!;
      if (lit.includes(id)) {
        expect(v.dimmer).toBeCloseTo(0.5);
        expect(v.white ?? v.red).toBeGreaterThan(0.9);
        expect(v.strobe).toBeLessThan(10 / 255); // « Pas de strobe » range
      } else expect(v.dimmer).toBe(0);
    }
    expect(svc.runtimeState().locate).toMatchObject({ active: true, frame: 2, total: 6 });
    await svc.execute({ type: 'locate.end' });
    svc.engine.tick(25);
    expect(svc.runtimeState().locate).toBeNull();
    expect(Object.values(svc.engine.sources).flatMap((s) => Object.values(s)).some((src) => src.includes('Localisation'))).toBe(false);
    await svc.dispose();
  });

  it('applique les positions mesurées au patch', async () => {
    const { svc, ids } = await setup();
    const r = await svc.execute({ type: 'locate.apply', updates: [{ fixtureId: ids[1]!, x: -3.456, y: 5.01, height: 5.5 }, { fixtureId: 'inconnu', x: 0, y: 0 }] });
    expect(r.updated).toBe(1);
    const f = svc.getProject().patch.find((x) => x.id === ids[1])!;
    expect(f).toMatchObject({ position: { x: -3.46, y: 5.01 }, height: 5.5 });
    await svc.dispose();
  });

  it('smartphone : la télécommande transmet la photo attendue, refuse les autres', async () => {
    const { svc } = await setup();
    const s = svc.getSettings();
    const port = 21000 + Math.floor(Math.random() * 1000);
    const token = s.control.remote.token!;
    await svc.execute({ type: 'settings.update', settings: { ...s, control: { ...s.control, remote: { enabled: true, port, token } } } });
    const photos: LocatePhoto[] = [];
    svc.on('locatePhoto', (p) => photos.push(p));
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const send = (frame: number, body: Buffer = jpeg) => fetch(`http://127.0.0.1:${port}/locate/photo?t=${token}&frame=${frame}`, { method: 'POST', body: new Uint8Array(body) }).then((x) => x.status);
    expect(await send(0)).toBe(400); // no session yet
    await svc.execute({ type: 'locate.begin', confirmed: true, mode: 'sequential', level: 0.4, photo: true });
    const events = await fetch(`http://127.0.0.1:${port}/events?t=${token}`);
    const first = JSON.parse(new TextDecoder().decode((await events.body!.getReader().read()).value).replace(/^data: /, '')) as { locate: { frame: number; total: number } };
    expect(first.locate).toMatchObject({ frame: 0, total: 5 });
    expect(await send(3)).toBe(400); // not the frame shown
    expect(await send(0, Buffer.from('pas un jpeg'))).toBe(400);
    expect(await send(0)).toBe(200);
    expect(await send(0)).toBe(400); // already received
    expect(photos).toEqual([{ frame: 0, jpeg: jpeg.toString('base64') }]);
    await svc.execute({ type: 'locate.frame', index: 1 });
    expect(await send(1)).toBe(200);
    await svc.execute({ type: 'locate.end' });
    await svc.dispose();
  });
});
