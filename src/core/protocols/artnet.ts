import dgram from 'node:dgram';
import os from 'node:os';
import { OutputAdapter, type OutputConfig } from './types';

export const ARTNET_PORT = 6454;

/**
 * Builds an ArtDmx packet (Art-Net 4, OpCode 0x5000).
 * Layout: "Art-Net\0" | OpCode LE | ProtVer 14 | Sequence | Physical | SubUni | Net | Length BE | data
 */
export function buildArtDmx(portAddress: number, data: Uint8Array, sequence: number, physical = 0): Buffer {
  if (!Number.isInteger(portAddress) || portAddress < 0 || portAddress > 0x7fff) throw new Error(`Port-Address Art-Net invalide: ${portAddress}`);
  let len = Math.min(512, Math.max(2, data.length));
  if (len % 2) len++; // length must be even
  const buf = Buffer.alloc(18 + len);
  buf.write('Art-Net\0', 0, 'ascii');
  buf.writeUInt16LE(0x5000, 8);
  buf.writeUInt8(0, 10); // ProtVerHi
  buf.writeUInt8(14, 11); // ProtVerLo
  buf.writeUInt8(sequence & 0xff, 12);
  buf.writeUInt8(physical & 0xff, 13);
  buf.writeUInt8(portAddress & 0xff, 14); // SubUni
  buf.writeUInt8((portAddress >> 8) & 0x7f, 15); // Net
  buf.writeUInt16BE(len, 16);
  buf.set(data.subarray(0, len), 18);
  return buf;
}

export function parseArtDmx(buf: Buffer): { portAddress: number; sequence: number; data: Uint8Array } | null {
  if (buf.length < 20 || buf.toString('ascii', 0, 8) !== 'Art-Net\0' || buf.readUInt16LE(8) !== 0x5000) return null;
  const len = buf.readUInt16BE(16);
  return { portAddress: buf.readUInt8(14) | (buf.readUInt8(15) << 8), sequence: buf.readUInt8(12), data: new Uint8Array(buf.subarray(18, 18 + len)) };
}

export function localIpv4Addresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4')
    .map((i) => i.address);
}

type ArtNetConfig = Extract<OutputConfig, { kind: 'artnet' }>;

export class ArtNetOutput extends OutputAdapter {
  private socket: dgram.Socket | null = null;
  private seq = new Map<number, number>();

  constructor(config: ArtNetConfig, private readonly port = ARTNET_PORT) {
    super(config);
  }

  private get cfg(): ArtNetConfig {
    return this.config as ArtNetConfig;
  }

  protected async doOpen(): Promise<void> {
    const { bindAddress, broadcast } = this.cfg;
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
    if (broadcast) socket.setBroadcast(true);
    this.socket = socket;
  }

  protected async doClose(): Promise<void> {
    const s = this.socket;
    this.socket = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  protected doSend(remote: number, data: Uint8Array): void {
    if (!this.socket) throw new Error('Socket Art-Net fermé');
    const seq = ((this.seq.get(remote) ?? 0) % 255) + 1; // 1..255, 0 disables sequencing
    this.seq.set(remote, seq);
    const packet = buildArtDmx(remote, data, seq);
    this.socket.send(packet, this.port, this.cfg.host, (err) => {
      if (err) this.fail(err);
    });
  }
}
