import dgram from 'node:dgram';
import { ArtNetOutput, buildArtDmx, parseArtDmx } from '../../src/core/protocols/artnet';
import { buildSacnPacket, multicastAddress, parseSacnPacket, SacnOutput, SACN_OPTION_STREAM_TERMINATED } from '../../src/core/protocols/sacn';
import { buildEnttecProPacket } from '../../src/core/protocols/enttec';
import { VirtualOutput } from '../../src/core/protocols/virtual';
import { OutputManager } from '../../src/core/protocols/OutputManager';
import { outputConfigSchema, type OutputConfig } from '../../src/core/protocols/types';

const frame = (fill: (i: number) => number) => Uint8Array.from({ length: 512 }, (_, i) => fill(i));

function listen(): Promise<{ socket: dgram.Socket; port: number; packets: Buffer[] }> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const packets: Buffer[] = [];
    socket.on('message', (m) => packets.push(m));
    socket.bind(0, '127.0.0.1', () => resolve({ socket, port: socket.address().port, packets }));
  });
}
const waitFor = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('Art-Net', () => {
  it('construit un ArtDmx conforme (en-tête, OpCode LE, version 14, Port-Address 15 bits, longueur BE)', () => {
    const p = buildArtDmx(0x1234, frame((i) => i & 255), 7);
    expect(p.length).toBe(18 + 512);
    expect(p.toString('ascii', 0, 8)).toBe('Art-Net\0');
    expect([p[8], p[9]]).toEqual([0x00, 0x50]);
    expect([p[10], p[11]]).toEqual([0, 14]);
    expect(p[12]).toBe(7);
    expect([p[14], p[15]]).toEqual([0x34, 0x12]);
    expect([p[16], p[17]]).toEqual([0x02, 0x00]);
    expect(p[18 + 300]).toBe(300 & 255);
    expect(() => buildArtDmx(40000, frame(() => 0), 1)).toThrow();
  });

  it('émet réellement en UDP vers un récepteur local', async () => {
    const rx = await listen();
    const cfg = outputConfigSchema.parse({ id: 'a', name: 'A', kind: 'artnet', host: '127.0.0.1', universeMap: [{ local: 1, remote: 3 }] });
    const out = new ArtNetOutput(cfg as Extract<OutputConfig, { kind: 'artnet' }>, rx.port);
    await out.open();
    expect(out.state).toBe('ready');
    out.send(3, frame((i) => (i === 0 ? 255 : 0)));
    await waitFor(() => rx.packets.length > 0);
    const parsed = parseArtDmx(rx.packets[0]!)!;
    expect(parsed.portAddress).toBe(3);
    expect(parsed.data[0]).toBe(255);
    expect(parsed.sequence).toBe(1);
    await out.close();
    rx.socket.close();
  });

  it('signale une interface réseau inexistante comme erreur', async () => {
    const cfg = outputConfigSchema.parse({ id: 'a', name: 'A', kind: 'artnet', host: '127.0.0.1', bindAddress: '10.254.254.254', universeMap: [{ local: 1, remote: 0 }] });
    const out = new ArtNetOutput(cfg as Extract<OutputConfig, { kind: 'artnet' }>);
    await out.open();
    expect(out.state).toBe('error');
    expect(out.stats.lastError).toMatch(/introuvable/);
    await out.close();
  });

  it('refuse une destination invalide à la validation', () => {
    expect(outputConfigSchema.safeParse({ id: 'a', name: 'A', kind: 'artnet', host: '999.1.1.1', universeMap: [{ local: 1, remote: 0 }] }).success).toBe(false);
    expect(outputConfigSchema.safeParse({ id: 'a', name: 'A', kind: 'sacn', mode: 'unicast', host: '', universeMap: [{ local: 1, remote: 1 }] }).success).toBe(false);
    expect(outputConfigSchema.safeParse({ id: 'a', name: 'A', kind: 'sacn', universeMap: [{ local: 1, remote: 0 }] }).success).toBe(false);
  });
});

describe('sACN / E1.31', () => {
  it('construit un paquet de données de 638 octets aux offsets de la norme', () => {
    const cid = Buffer.alloc(16, 0xab);
    const p = buildSacnPacket({ universe: 258, data: frame(() => 9), sequence: 42, priority: 150, cid, sourceName: 'Test' });
    expect(p.length).toBe(638);
    expect(p.readUInt16BE(0)).toBe(0x0010);
    expect(p.toString('ascii', 4, 13)).toBe('ASC-E1.17');
    expect(p.readUInt16BE(16)).toBe(0x7000 | 622);
    expect(p.readUInt32BE(18)).toBe(4);
    expect(p.subarray(22, 38).equals(cid)).toBe(true);
    expect(p.readUInt16BE(38)).toBe(0x7000 | 600);
    expect(p.readUInt32BE(40)).toBe(2);
    expect(p.toString('utf8', 44, 48)).toBe('Test');
    expect(p[108]).toBe(150);
    expect(p[111]).toBe(42);
    expect(p.readUInt16BE(113)).toBe(258);
    expect(p.readUInt16BE(115)).toBe(0x7000 | 523);
    expect([p[117], p[118]]).toEqual([0x02, 0xa1]);
    expect(p.readUInt16BE(123)).toBe(513);
    expect(p[125]).toBe(0);
    expect(p[126]).toBe(9);
    expect(multicastAddress(258)).toBe('239.255.1.2');
    expect(() => buildSacnPacket({ universe: 0, data: frame(() => 0), sequence: 0, priority: 100, cid, sourceName: 'x' })).toThrow();
  });

  it('émet en unicast puis envoie 3 paquets « stream terminated » à la fermeture', async () => {
    const rx = await listen();
    const cfg = outputConfigSchema.parse({ id: 's', name: 'S', kind: 'sacn', mode: 'unicast', host: '127.0.0.1', priority: 120, universeMap: [{ local: 1, remote: 7 }] });
    const out = new SacnOutput(cfg as Extract<OutputConfig, { kind: 'sacn' }>, '6f1c7b52-7ad1-4e8a-9a5c-1d2e3f4a5b6c', rx.port);
    await out.open();
    out.send(7, frame((i) => (i === 1 ? 77 : 0)));
    await waitFor(() => rx.packets.length >= 1);
    const first = parseSacnPacket(rx.packets[0]!)!;
    expect([first.universe, first.priority, first.data[1]]).toEqual([7, 120, 77]);
    await out.close();
    await waitFor(() => rx.packets.length >= 4);
    const term = rx.packets.slice(1).map((b) => parseSacnPacket(b)!);
    expect(term.every((t) => (t.options & SACN_OPTION_STREAM_TERMINATED) !== 0)).toBe(true);
    rx.socket.close();
  });
});

describe('Enttec DMX USB Pro', () => {
  it('encadre les données selon le label 6', () => {
    const p = buildEnttecProPacket(frame((i) => i & 1));
    expect(p.length).toBe(518);
    expect([p[0], p[1], p[2], p[3], p[4]]).toEqual([0x7e, 6, 0x01, 0x02, 0x00]);
    expect(p[6]).toBe(1);
    expect(p[517]).toBe(0xe7);
  });
});

describe('sortie virtuelle et gestionnaire de sorties', () => {
  const virtual = outputConfigSchema.parse({ id: 'v', name: 'V', kind: 'virtual', universes: [1] });
  const artnet = outputConfigSchema.parse({ id: 'a', name: 'A', kind: 'artnet', host: '127.0.0.1', universeMap: [{ local: 1, remote: 0 }] });

  it('historise les changements et injecte des erreurs', async () => {
    const v = new VirtualOutput(virtual, () => 1000);
    await v.open();
    v.send(1, frame((i) => (i === 4 ? 200 : 0)));
    expect(v.history).toEqual([{ t: 1000, universe: 1, channel: 5, from: 0, to: 200 }]);
    v.inject({ type: 'fail-next', count: 1 });
    v.send(1, frame(() => 0));
    expect(v.state).toBe('error');
    expect(v.stats.errors).toBe(1);
    await v.close();
  });

  it('les sorties réelles démarrent désarmées ; STOP coupe les émissions réelles mais pas la virtuelle', async () => {
    const sent: string[] = [];
    const m = new OutputManager((c) => {
      const v = new VirtualOutput(c);
      const orig = v.send.bind(v);
      v.send = (u, d) => { sent.push(c.id); orig(u, d); };
      return v;
    }, (() => { let t = 0; return () => (t += 100); })());
    await m.configure([virtual, artnet]);
    expect(m.status().map((s) => [s.id, s.armed, s.state])).toEqual([['v', true, 'ready'], ['a', false, 'disarmed']]);
    expect(m.liveMode).toBe(false);
    m.sendFrames(new Map([[1, frame(() => 1)]]));
    expect(sent).toEqual(['v']);
    await m.arm('a');
    expect(m.liveMode).toBe(true);
    m.sendFrames(new Map([[1, frame(() => 2)]]));
    expect(sent.slice(1).sort()).toEqual(['a', 'v']);
    m.setTransmitting(false);
    sent.length = 0;
    m.sendFrames(new Map([[1, frame(() => 3)]]));
    expect(sent).toEqual(['v']);
    expect(m.transmitted.get('a')!.get(1)!.data[0]).toBe(2); // last frame actually handed to the transport
    await m.closeAll();
  });
});
