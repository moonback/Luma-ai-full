import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { BRAND } from '../../shared/brand';
import { localIpv4Addresses } from './artnet';
import { OutputAdapter, type OutputConfig } from './types';

export const SACN_PORT = 5568;
const ACN_ID = Buffer.from([0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00]);
export const SACN_OPTION_STREAM_TERMINATED = 0x40;

export function multicastAddress(universe: number): string {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

export function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('CID invalide');
  return Buffer.from(hex, 'hex');
}

/** Builds an E1.31 (ANSI E1.31-2018) data packet carrying a full 512-slot universe (638 bytes). */
export function buildSacnPacket(opts: { universe: number; data: Uint8Array; sequence: number; priority: number; cid: Buffer; sourceName: string; options?: number }): Buffer {
  const { universe, data, sequence, priority, cid, sourceName } = opts;
  if (universe < 1 || universe > 63999) throw new Error(`Univers sACN invalide: ${universe}`);
  if (priority < 0 || priority > 200) throw new Error(`Priorité sACN invalide: ${priority}`);
  const slots = 512;
  const buf = Buffer.alloc(126 + slots);
  // Root layer
  buf.writeUInt16BE(0x0010, 0);
  buf.writeUInt16BE(0x0000, 2);
  ACN_ID.copy(buf, 4);
  buf.writeUInt16BE(0x7000 | (buf.length - 16), 16);
  buf.writeUInt32BE(0x00000004, 18);
  cid.copy(buf, 22, 0, 16);
  // Framing layer
  buf.writeUInt16BE(0x7000 | (buf.length - 38), 38);
  buf.writeUInt32BE(0x00000002, 40);
  buf.write(sourceName.slice(0, 63), 44, 'utf8');
  buf.writeUInt8(priority, 108);
  buf.writeUInt16BE(0, 109); // sync address
  buf.writeUInt8(sequence & 0xff, 111);
  buf.writeUInt8(opts.options ?? 0, 112);
  buf.writeUInt16BE(universe, 113);
  // DMP layer
  buf.writeUInt16BE(0x7000 | (buf.length - 115), 115);
  buf.writeUInt8(0x02, 117);
  buf.writeUInt8(0xa1, 118);
  buf.writeUInt16BE(0x0000, 119);
  buf.writeUInt16BE(0x0001, 121);
  buf.writeUInt16BE(slots + 1, 123);
  buf.writeUInt8(0x00, 125); // DMX start code
  buf.set(data.subarray(0, slots), 126);
  return buf;
}

export function parseSacnPacket(buf: Buffer): { universe: number; priority: number; sequence: number; options: number; data: Uint8Array } | null {
  if (buf.length < 126 || !buf.subarray(4, 16).equals(ACN_ID)) return null;
  const count = buf.readUInt16BE(123) - 1;
  return { universe: buf.readUInt16BE(113), priority: buf.readUInt8(108), sequence: buf.readUInt8(111), options: buf.readUInt8(112), data: new Uint8Array(buf.subarray(126, 126 + count)) };
}

type SacnConfig = Extract<OutputConfig, { kind: 'sacn' }>;

export class SacnOutput extends OutputAdapter {
  private socket: dgram.Socket | null = null;
  private seq = new Map<number, number>();
  private readonly cid: Buffer;
  private last = new Map<number, Uint8Array>();

  constructor(config: SacnConfig, cid: string = randomUUID(), private readonly port = SACN_PORT) {
    super(config);
    this.cid = uuidToBytes(cid);
  }

  private get cfg(): SacnConfig {
    return this.config as SacnConfig;
  }

  private dest(universe: number): string {
    return this.cfg.mode === 'unicast' ? this.cfg.host : multicastAddress(universe);
  }

  protected async doOpen(): Promise<void> {
    const { bindAddress } = this.cfg;
    if (bindAddress && !localIpv4Addresses().includes(bindAddress)) throw new Error(`Interface réseau ${bindAddress} introuvable sur cette machine`);
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (err) => this.fail(err));
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind({ address: bindAddress || undefined, port: 0 }, () => {
        socket.off('error', reject);
        resolve();
      });
    });
    if (this.cfg.mode === 'multicast') {
      socket.setMulticastTTL(8);
      if (bindAddress) socket.setMulticastInterface(bindAddress);
    }
    this.socket = socket;
  }

  private packet(universe: number, data: Uint8Array, options = 0): Buffer {
    const seq = ((this.seq.get(universe) ?? 0) + 1) & 0xff;
    this.seq.set(universe, seq);
    return buildSacnPacket({ universe, data, sequence: seq, priority: this.cfg.priority, cid: this.cid, sourceName: BRAND.sacnSourceName, options });
  }

  /** Per E1.31 §6.7.1: signal stream termination with 3 packets before closing. */
  protected async doClose(): Promise<void> {
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    for (const [u, data] of this.last) {
      for (let i = 0; i < 3; i++) {
        await new Promise<void>((r) => s.send(this.packet(u, data, SACN_OPTION_STREAM_TERMINATED), this.port, this.dest(u), () => r()));
      }
    }
    this.last.clear();
    await new Promise<void>((r) => s.close(() => r()));
  }

  protected doSend(universe: number, data: Uint8Array): void {
    if (!this.socket) throw new Error('Socket sACN fermé');
    this.last.set(universe, data.slice());
    this.socket.send(this.packet(universe, data), this.port, this.dest(universe), (err) => {
      if (err) this.fail(err);
    });
  }
}
