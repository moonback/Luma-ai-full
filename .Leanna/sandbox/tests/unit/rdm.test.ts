import dgram from 'node:dgram';
import { AppService } from '../../src/core/app/AppService';
import { buildArtTodData, CC, CONTROLLER_UID, decodeRdm, encodeRdm, parseArtRdm, PID, buildArtRdm } from '../../src/core/protocols/rdm';
import { tempDir } from '../helpers';

describe('RDM : codage E1.20', () => {
  it('aller-retour avec checksum, paquet altéré rejeté', () => {
    const p = { dest: '0001:00000002', src: CONTROLLER_UID, tn: 7, portOrResponse: 1, messageCount: 0, subDevice: 0, cc: CC.GET, pid: PID.DEVICE_INFO, pd: Buffer.alloc(0) };
    const b = encodeRdm(p);
    expect(b.length).toBe(26);
    expect(decodeRdm(b)).toEqual(p);
    b[10] = b[10]! ^ 1;
    expect(decodeRdm(b)).toBeNull();
  });
});

/** Simulated Art-Net node with two RDM fixtures (the second one answers discovery but no requests). */
function fakeNode(portAddress: number) {
  const sock = dgram.createSocket('udp4');
  const devices = new Map([['4C55:00000001', { address: 1, identify: false }]]);
  const silent = '4C55:00000002';
  sock.on('message', (buf, r) => {
    const m = parseArtRdm(buf);
    if (m?.kind === 'todRequest' && m.portAddress === portAddress) {
      // Two ArtTodData blocks, as nodes do for larger tables.
      for (const uids of [['4C55:00000001'], [silent]]) {
        const b = buildArtTodData(portAddress, uids);
        b.writeUInt16BE(2, 24); // UidTotal
        sock.send(b, r.port, r.address);
      }
    }
    if (m?.kind !== 'rdm') return;
    const q = m.packet;
    const dev = devices.get(q.dest);
    if (!dev) return;
    let pd = Buffer.alloc(0);
    let type = 0;
    if (q.cc === CC.GET && q.pid === PID.DEVICE_INFO) {
      pd = Buffer.alloc(19);
      pd.writeUInt16BE(0x0100, 0); pd.writeUInt16BE(12, 10); pd[12] = 2; pd[13] = 3; pd.writeUInt16BE(dev.address, 14); pd[18] = 1;
    } else if (q.cc === CC.GET && q.pid === PID.MANUFACTURER_LABEL) pd = Buffer.from('Luma Labs');
    else if (q.cc === CC.GET && q.pid === PID.DEVICE_MODEL_DESCRIPTION) pd = Buffer.from('Spot 300');
    else if (q.cc === CC.GET && q.pid === PID.DEVICE_HOURS) { pd = Buffer.alloc(4); pd.writeUInt32BE(1234); }
    else if (q.cc === CC.GET && q.pid === PID.SENSOR_DEFINITION) { pd = Buffer.alloc(13 + 4); pd[0] = q.pd[0]!; pd[2] = 1; pd.write('Tete', 13); }
    else if (q.cc === CC.GET && q.pid === PID.SENSOR_VALUE) { pd = Buffer.alloc(9); pd[0] = q.pd[0]!; pd.writeInt16BE(47, 1); }
    else if (q.cc === CC.SET && q.pid === PID.DMX_START_ADDRESS) dev.address = q.pd.readUInt16BE(0);
    else if (q.cc === CC.SET && q.pid === PID.IDENTIFY_DEVICE) dev.identify = q.pd[0] === 1;
    else { type = 2; pd = Buffer.from([0, 0]); } // NACK: unknown PID (LAMP_HOURS, DEVICE_LABEL…)
    const res = encodeRdm({ dest: q.src, src: q.dest, tn: q.tn, portOrResponse: type, messageCount: 0, subDevice: 0, cc: q.cc + 1, pid: q.pid, pd });
    sock.send(buildArtRdm(portAddress, res), r.port, r.address);
  });
  return { sock, devices };
}

describe('RDM via Art-Net (nœud simulé)', () => {
  it('découverte, lecture, identify et changement d’adresse depuis AppService', async () => {
    const node = fakeNode(5);
    const nodePort = 20000 + Math.floor(Math.random() * 1000);
    await new Promise<void>((r) => node.sock.bind(nodePort, '127.0.0.1', () => r()));
    const svc = new AppService({
      dataDir: tempDir(), autoStart: false,
      dialogs: { openProject: async () => null, saveProject: async () => null, openProfile: async () => null },
      secrets: { get: () => null, set: () => undefined },
      rdm: { listenPort: nodePort + 1, nodePort, timeoutMs: 300 },
    });
    await svc.init();
    await svc.execute({ type: 'output.configure', outputs: [{ id: 'an', name: 'Nœud', kind: 'artnet', enabled: true, maxFps: 40, host: '127.0.0.1', bindAddress: '', broadcast: false, universeMap: [{ local: 1, remote: 5 }] }] });

    const { devices } = await svc.execute({ type: 'rdm.discover', outputId: 'an', universe: 1 });
    expect(devices.map((d) => d.uid)).toEqual(['4C55:00000001', '4C55:00000002']);
    expect(devices[0]).toMatchObject({ manufacturer: 'Luma Labs', model: 'Spot 300', startAddress: 1, footprint: 12, personality: '2/3', deviceHours: 1234, lampHours: null, sensors: [{ name: 'Tete', value: 47, unit: '°C' }] });
    expect(devices[0]!.errors.join(' ')).toMatch(/LAMP_HOURS : refusé/);
    expect(devices[1]!.errors[0]).toMatch(/pas de réponse/);

    await svc.execute({ type: 'rdm.identify', outputId: 'an', universe: 1, uid: '4C55:00000001', on: true });
    expect(node.devices.get('4C55:00000001')!.identify).toBe(true);
    await svc.execute({ type: 'rdm.setAddress', outputId: 'an', universe: 1, uid: '4C55:00000001', address: 101, confirmed: true });
    expect(node.devices.get('4C55:00000001')!.address).toBe(101);

    await expect(svc.execute({ type: 'rdm.discover', outputId: 'an', universe: 2 })).rejects.toThrow(/pas routé/);
    await expect(svc.execute({ type: 'rdm.discover', outputId: 'virtual-1', universe: 1 })).rejects.toThrow(/introuvable/);
    await expect(svc.execute({ type: 'rdm.identify', outputId: 'an', universe: 1, uid: '4C55:00000002', on: true })).rejects.toThrow(/pas de réponse/);
    node.sock.close();
    await svc.dispose();
  });
});
