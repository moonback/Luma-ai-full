import dgram from 'node:dgram';
import { ARTNET_PORT } from './artnet';

/**
 * RDM (ANSI E1.20) over Art-Net: the node runs discovery on its DMX port and reports the Table of Devices
 * (ArtTodRequest → ArtTodData); requests travel in ArtRdm packets. Implemented from the specifications and tested
 * against a simulated node only — not verified on real hardware.
 */
export const RDM_START = 0xcc;
export const RDM_SUB_START = 0x01;
export const CC = { GET: 0x20, GET_RESPONSE: 0x21, SET: 0x30, SET_RESPONSE: 0x31 } as const;
export const PID = {
  DEVICE_INFO: 0x0060, DEVICE_MODEL_DESCRIPTION: 0x0080, MANUFACTURER_LABEL: 0x0081, DEVICE_LABEL: 0x0082,
  SENSOR_DEFINITION: 0x0200, SENSOR_VALUE: 0x0201, DEVICE_HOURS: 0x0400, LAMP_HOURS: 0x0401,
  SOFTWARE_VERSION_LABEL: 0x00c0, DMX_START_ADDRESS: 0x00f0, IDENTIFY_DEVICE: 0x1000,
} as const;
const RESPONSE = { ACK: 0, ACK_TIMER: 1, NACK_REASON: 2, ACK_OVERFLOW: 3 } as const;
/** Controller UID in the ESTA prototyping range (0x7FF0–0x7FFF). */
export const CONTROLLER_UID = '7FF0:4C554D41';

export const uidToBytes = (uid: string): Buffer => {
  const m = /^([0-9A-F]{4}):([0-9A-F]{8})$/i.exec(uid);
  if (!m) throw new Error(`UID RDM invalide : ${uid}`);
  return Buffer.from(m[1]! + m[2]!, 'hex');
};
export const uidFromBytes = (b: Buffer, at = 0): string => `${b.toString('hex', at, at + 2)}:${b.toString('hex', at + 2, at + 6)}`.toUpperCase();

export interface RdmPacket {
  dest: string;
  src: string;
  tn: number;
  /** Port id in requests, response type in responses. */
  portOrResponse: number;
  messageCount: number;
  subDevice: number;
  cc: number;
  pid: number;
  pd: Buffer;
}

/** Full RDM packet including the 0xCC start code and checksum. */
export function encodeRdm(p: RdmPacket): Buffer {
  const len = 24 + p.pd.length;
  const b = Buffer.alloc(len + 2);
  b[0] = RDM_START; b[1] = RDM_SUB_START; b[2] = len;
  uidToBytes(p.dest).copy(b, 3);
  uidToBytes(p.src).copy(b, 9);
  b[15] = p.tn & 0xff; b[16] = p.portOrResponse; b[17] = p.messageCount;
  b.writeUInt16BE(p.subDevice, 18);
  b[20] = p.cc;
  b.writeUInt16BE(p.pid, 21);
  b[23] = p.pd.length;
  p.pd.copy(b, 24);
  let sum = 0;
  for (let i = 0; i < len; i++) sum += b[i]!;
  b.writeUInt16BE(sum & 0xffff, len);
  return b;
}

/** Parses a full RDM packet (start code included); null when malformed or the checksum is wrong. */
export function decodeRdm(b: Buffer): RdmPacket | null {
  if (b.length < 26 || b[0] !== RDM_START || b[1] !== RDM_SUB_START) return null;
  const len = b[2]!;
  if (len < 24 || b.length < len + 2 || b[23]! !== len - 24) return null;
  let sum = 0;
  for (let i = 0; i < len; i++) sum += b[i]!;
  if ((sum & 0xffff) !== b.readUInt16BE(len)) return null;
  return {
    dest: uidFromBytes(b, 3), src: uidFromBytes(b, 9), tn: b[15]!, portOrResponse: b[16]!, messageCount: b[17]!,
    subDevice: b.readUInt16BE(18), cc: b[20]!, pid: b.readUInt16BE(21), pd: Buffer.from(b.subarray(24, len)),
  };
}

/* ---------------- Art-Net transport ---------------- */

function artHeader(op: number, size: number): Buffer {
  const b = Buffer.alloc(size);
  b.write('Art-Net\0', 0, 'ascii');
  b.writeUInt16LE(op, 8);
  b[11] = 14; // ProtVer
  return b;
}

export function buildArtTodRequest(portAddress: number): Buffer {
  const b = artHeader(0x8000, 56);
  b[21] = (portAddress >> 8) & 0x7f; // Net
  b[22] = 0; // TodFull
  b[23] = 1; // AdCount
  b[24] = portAddress & 0xff;
  return b;
}

export function buildArtTodData(portAddress: number, uids: string[]): Buffer {
  const b = artHeader(0x8100, 28 + uids.length * 6);
  b[12] = 1; b[13] = 1;
  b[21] = (portAddress >> 8) & 0x7f; b[23] = portAddress & 0xff;
  b.writeUInt16BE(uids.length, 24);
  b[27] = uids.length;
  uids.forEach((u, i) => uidToBytes(u).copy(b, 28 + i * 6));
  return b;
}

export function buildArtRdm(portAddress: number, rdm: Buffer): Buffer {
  const b = artHeader(0x8300, 24 + rdm.length - 1);
  b[12] = 1; // RdmVer
  b[21] = (portAddress >> 8) & 0x7f; b[23] = portAddress & 0xff;
  rdm.copy(b, 24, 1); // without the start code
  return b;
}

export type ArtRdmMessage =
  | { kind: 'tod'; portAddress: number; total: number; uids: string[] }
  | { kind: 'rdm'; portAddress: number; packet: RdmPacket }
  | { kind: 'todRequest'; portAddress: number };

export function parseArtRdm(b: Buffer): ArtRdmMessage | null {
  if (b.length < 24 || b.toString('ascii', 0, 8) !== 'Art-Net\0') return null;
  const op = b.readUInt16LE(8);
  if (op === 0x8000 && b.length >= 25) return { kind: 'todRequest', portAddress: ((b[21]! & 0x7f) << 8) | b[24]! };
  const pa = ((b[21]! & 0x7f) << 8) | b[23]!;
  if (op === 0x8100 && b.length >= 28) {
    const n = b[27]!;
    const uids: string[] = [];
    for (let i = 0; i < n && 28 + (i + 1) * 6 <= b.length; i++) uids.push(uidFromBytes(b, 28 + i * 6));
    return { kind: 'tod', portAddress: pa, total: b.readUInt16BE(24), uids };
  }
  if (op === 0x8300) {
    const packet = decodeRdm(Buffer.concat([Buffer.from([RDM_START]), b.subarray(24)]));
    return packet ? { kind: 'rdm', portAddress: pa, packet } : null;
  }
  return null;
}

export interface RdmDevice {
  uid: string;
  manufacturer: string | null;
  model: string | null;
  label: string | null;
  softwareVersion: string | null;
  startAddress: number | null;
  footprint: number | null;
  personality: string | null;
  deviceHours: number | null;
  lampHours: number | null;
  sensors: { name: string; value: number; unit: string }[];
  errors: string[];
}

const NACK_REASONS: Record<number, string> = { 0: 'commande inconnue', 1: 'données invalides', 3: 'paramètre non pris en charge', 4: 'hors plage', 5: 'appareil occupé', 6: 'protégé en écriture' };
const UNITS: Record<number, string> = { 0: '', 1: '°C', 2: 'V', 5: 'A', 9: 'W', 18: 'tr/min', 21: '%' };
const ascii = (b: Buffer) => b.toString('latin1').replace(/\0+$/, '').trim();

export interface ArtNetRdmOptions {
  host: string;
  portAddress: number;
  bindAddress?: string;
  /** Local listening port (Art-Net replies go to 6454). */
  listenPort?: number;
  /** Node port (6454). */
  nodePort?: number;
  timeoutMs?: number;
}

/** RDM controller talking to one Art-Net node port. */
export class ArtNetRdm {
  private socket: dgram.Socket | null = null;
  private tn = 0;
  private readonly waiters = new Set<(m: ArtRdmMessage) => boolean>();

  constructor(private readonly o: ArtNetRdmOptions) {}

  async open(): Promise<void> {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('message', (buf) => {
      const m = parseArtRdm(buf);
      if (m) for (const w of [...this.waiters]) if (w(m)) this.waiters.delete(w);
    });
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.bind({ port: this.o.listenPort ?? ARTNET_PORT, address: this.o.bindAddress || undefined }, () => { s.off('error', reject); resolve(); });
    });
    this.socket = s;
  }

  async close(): Promise<void> {
    const s = this.socket;
    this.socket = null;
    this.waiters.clear();
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private send(b: Buffer): void {
    if (!this.socket) throw new Error('Client RDM fermé');
    this.socket.send(b, this.o.nodePort ?? ARTNET_PORT, this.o.host);
  }

  /** Table of Devices: waits for every ArtTodData block (or the timeout). */
  async discover(): Promise<string[]> {
    const uids = new Set<string>();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.waiters.delete(w); resolve(); }, this.o.timeoutMs ?? 1500);
      const w = (m: ArtRdmMessage) => {
        if (m.kind !== 'tod' || m.portAddress !== this.o.portAddress) return false;
        m.uids.forEach((u) => uids.add(u));
        if (uids.size < m.total) return false;
        clearTimeout(timer);
        resolve();
        return true;
      };
      this.waiters.add(w);
      this.send(buildArtTodRequest(this.o.portAddress));
    });
    return [...uids].sort();
  }

  /** One GET/SET transaction; throws on timeout or NACK. */
  request(uid: string, cc: number, pid: number, pd: Buffer = Buffer.alloc(0)): Promise<Buffer> {
    const tn = (this.tn = (this.tn + 1) & 0xff);
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(w); reject(new Error(`pas de réponse (PID 0x${pid.toString(16).padStart(4, '0')})`)); }, this.o.timeoutMs ?? 1000);
      const w = (m: ArtRdmMessage) => {
        if (m.kind !== 'rdm') return false;
        const p = m.packet;
        if (p.tn !== tn || p.src !== uid || p.dest !== CONTROLLER_UID || p.cc !== cc + 1 || p.pid !== pid) return false;
        clearTimeout(timer);
        if (p.portOrResponse === RESPONSE.ACK) resolve(p.pd);
        else if (p.portOrResponse === RESPONSE.NACK_REASON) reject(new Error(`refusé : ${NACK_REASONS[p.pd.length >= 2 ? p.pd.readUInt16BE(0) : -1] ?? 'raison inconnue'}`));
        else reject(new Error('réponse différée ou fragmentée non prise en charge'));
        return true;
      };
      this.waiters.add(w);
      this.send(buildArtRdm(this.o.portAddress, encodeRdm({ dest: uid, src: CONTROLLER_UID, tn, portOrResponse: 1, messageCount: 0, subDevice: 0, cc, pid, pd })));
    });
  }

  /** Reads identification, address, hours and sensors; each failed read is reported, not fatal. */
  async readDevice(uid: string): Promise<RdmDevice> {
    const d: RdmDevice = { uid, manufacturer: null, model: null, label: null, softwareVersion: null, startAddress: null, footprint: null, personality: null, deviceHours: null, lampHours: null, sensors: [], errors: [] };
    const get = async <T>(name: string, pid: number, parse: (b: Buffer) => T, pd?: Buffer): Promise<T | null> => {
      try {
        return parse(await this.request(uid, CC.GET, pid, pd));
      } catch (err) {
        d.errors.push(`${name} : ${(err as Error).message}`);
        return null;
      }
    };
    const info = await get('DEVICE_INFO', PID.DEVICE_INFO, (b) => {
      if (b.length < 19) throw new Error('réponse trop courte');
      return { footprint: b.readUInt16BE(10), personality: `${b[12]}/${b[13]}`, start: b.readUInt16BE(14), sensors: b[18]! };
    });
    if (info) {
      d.footprint = info.footprint;
      d.personality = info.personality;
      d.startAddress = info.start === 0xffff ? null : info.start;
    }
    d.manufacturer = await get('MANUFACTURER_LABEL', PID.MANUFACTURER_LABEL, ascii);
    d.model = await get('DEVICE_MODEL_DESCRIPTION', PID.DEVICE_MODEL_DESCRIPTION, ascii);
    d.label = await get('DEVICE_LABEL', PID.DEVICE_LABEL, ascii);
    d.softwareVersion = await get('SOFTWARE_VERSION_LABEL', PID.SOFTWARE_VERSION_LABEL, ascii);
    d.deviceHours = await get('DEVICE_HOURS', PID.DEVICE_HOURS, (b) => b.readUInt32BE(0));
    d.lampHours = await get('LAMP_HOURS', PID.LAMP_HOURS, (b) => b.readUInt32BE(0));
    for (let i = 0; i < Math.min(8, info?.sensors ?? 0); i++) {
      const def = await get(`SENSOR_DEFINITION ${i}`, PID.SENSOR_DEFINITION, (b) => ({ unit: UNITS[b[2]!] ?? '', name: ascii(b.subarray(13)) || `Capteur ${i + 1}` }), Buffer.from([i]));
      const value = await get(`SENSOR_VALUE ${i}`, PID.SENSOR_VALUE, (b) => b.readInt16BE(1), Buffer.from([i]));
      if (def && value !== null) d.sensors.push({ name: def.name, value, unit: def.unit });
    }
    return d;
  }

  async identify(uid: string, on: boolean): Promise<void> {
    await this.request(uid, CC.SET, PID.IDENTIFY_DEVICE, Buffer.from([on ? 1 : 0]));
  }

  async setStartAddress(uid: string, address: number): Promise<void> {
    if (!Number.isInteger(address) || address < 1 || address > 512) throw new Error('Adresse DMX hors plage (1–512)');
    const pd = Buffer.alloc(2);
    pd.writeUInt16BE(address);
    await this.request(uid, CC.SET, PID.DMX_START_ADDRESS, pd);
  }
}
