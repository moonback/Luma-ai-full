import dgram from 'node:dgram';
import { MtcDecoder, parseMidi, timecodeSeconds, type Timecode } from '../../src/core/control/midi';
import { encodeLtc, LtcDecoder, ltcFrameBits } from '../../src/core/control/timecode';
import { encodeOsc, parseOsc } from '../../src/core/control/osc';
import { defaultSettings } from '../../src/core/settings/settings';
import { makeService } from '../helpers';

describe('MIDI', () => {
  it('note-on et CC → clés de mapping, note-on vélocité 0 ignorée', () => {
    expect(parseMidi([0x90, 60, 100])).toEqual({ key: 'note:1:60', value: 100 / 127 });
    expect(parseMidi([0xb3, 7, 127])).toEqual({ key: 'cc:4:7', value: 1 });
    expect(parseMidi([0x90, 60, 0])).toBeNull();
    expect(parseMidi([0x80, 60, 0])).toBeNull();
  });

  it('MTC quarter-frame : 01:02:03:10 à 25 i/s (+2 images de compensation)', () => {
    const d = new MtcDecoder();
    const v = [10 & 0xf, 10 >> 4, 3, 0, 2, 0, 1, 1 << 1]; // rate bits 01 = 25 fps
    let tc: Timecode | null = null;
    v.forEach((x, piece) => { tc = d.push([0xf1, (piece << 4) | x]) ?? tc; });
    expect(tc).toEqual({ hours: 1, minutes: 2, seconds: 3, frames: 12, fps: 25 });
    expect(timecodeSeconds(tc!)).toBeCloseTo(3723.48);
  });

  it('MTC full frame SysEx', () => {
    expect(new MtcDecoder().push([0xf0, 0x7f, 0x7f, 0x01, 0x01, (3 << 5) | 2, 30, 15, 29, 0xf7])).toEqual({ hours: 2, minutes: 30, seconds: 15, frames: 29, fps: 30 });
  });
});

describe('LTC', () => {
  it.each([25, 30, 24])('décode une suite de trames à %i i/s', (fps) => {
    const rate = 48000;
    const dec = new LtcDecoder(rate);
    const got: string[] = [];
    let level = 1;
    for (let f = 0; f < 7; f++) { // a frame completes on the first edge of the next one
      const enc = encodeLtc(ltcFrameBits({ hours: 10, minutes: 59, seconds: 58, frames: f, fps }), rate, fps, level);
      level = enc.level;
      for (const tc of dec.push(enc.samples)) got.push(`${tc.hours}:${tc.minutes}:${tc.seconds}:${tc.frames}@${tc.fps}`);
    }
    // The first frames train the bit-period tracker; the following ones must all decode.
    expect(got.slice(-4)).toEqual([2, 3, 4, 5].map((f) => `10:59:58:${f}@${fps}`));
  });
});

describe('OSC', () => {
  it('aller-retour message et bundle', () => {
    const msg = encodeOsc('/luma/master', [0.5, 3, 'x', true]);
    expect(parseOsc(msg)).toEqual([{ address: '/luma/master', args: [0.5, 3, 'x', true] }]);
    const a = encodeOsc('/luma/go'), b = encodeOsc('/luma/blackout', [1]);
    const size = (x: Buffer) => { const s = Buffer.alloc(4); s.writeInt32BE(x.length); return s; };
    const bundle = Buffer.concat([Buffer.from('#bundle\0'), Buffer.alloc(8), size(a), a, size(b), b]);
    expect(parseOsc(bundle).map((m) => m.address)).toEqual(['/luma/go', '/luma/blackout']);
    expect(() => parseOsc(Buffer.from('nope'))).toThrow();
  });

  it('serveur OSC → commandes AppService, accusé de réception, pas d’armement possible', async () => {
    const { svc } = makeService();
    await svc.init();
    const s = defaultSettings();
    await svc.execute({ type: 'settings.update', settings: { ...s, control: { ...s.control, osc: { enabled: true, port: 18000 + Math.floor(Math.random() * 1000), bind: '127.0.0.1' } } } });
    const port = svc.osc.port!;
    const client = dgram.createSocket('udp4');
    await new Promise<void>((r) => client.bind(0, '127.0.0.1', () => r()));
    const send = (addr: string, args: (number | string | boolean)[] = []) => new Promise<unknown[]>((resolve) => {
      client.once('message', (buf) => resolve(parseOsc(buf)[0]!.args));
      client.send(encodeOsc(addr, args), port, '127.0.0.1');
    });
    expect(await send('/luma/master', [0.25])).toEqual(['/luma/master', true]);
    expect(svc.engine.master).toBeCloseTo(0.25);
    expect(await send('/luma/blackout', [1])).toEqual(['/luma/blackout', true]);
    expect(svc.engine.blackout).toBe(true);
    expect(await send('/luma/stop')).toEqual(['/luma/stop', true]);
    expect(svc.outputs.transmitting).toBe(false);
    expect(await send('/luma/arm', ['virtual-1'])).toEqual(['/luma/arm', false]);
    expect(await send('/luma/go')).toEqual(['/luma/go', false]); // no cue list in a new project
    client.close();
    await svc.dispose();
  });
});

describe('timecode → timeline', () => {
  it('la timeline suit la position reçue et se recale au-delà de 2 images', async () => {
    const { svc } = makeService();
    await svc.init();
    await svc.execute({ type: 'timeline.upsert', timeline: { id: 't1', name: 'Show', duration: 600, loop: false, events: [] } });
    expect(await svc.execute({ type: 'timeline.timecode', seconds: 42 })).toEqual({ chasing: true });
    let st = svc.engine.snapshot().timeline;
    expect(st).toMatchObject({ timelineId: 't1', state: 'playing' });
    expect(st.time).toBeCloseTo(42);
    svc.engine.tick(40);
    await svc.execute({ type: 'timeline.timecode', seconds: 42.06 }); // within tolerance: no seek
    expect(svc.engine.snapshot().timeline.time).toBeCloseTo(42.04);
    await svc.execute({ type: 'timeline.timecode', seconds: 100 });
    st = svc.engine.snapshot().timeline;
    expect(st.time).toBeCloseTo(100);
    await svc.dispose();
  });
});
