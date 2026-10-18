import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

/** Open Sound Control 1.0: messages and bundles over UDP. Supported argument types: i, f, s, T, F. */
export type OscArg = number | string | boolean;
export interface OscMessage {
  address: string;
  args: OscArg[];
}

const pad4 = (n: number) => (n + 3) & ~3;

function readString(buf: Buffer, at: number): [string, number] {
  const end = buf.indexOf(0, at);
  if (end < 0) throw new Error('chaîne OSC non terminée');
  return [buf.toString('utf8', at, end), pad4(end + 1)];
}

/** Parses one UDP packet (message or bundle, recursively). Throws on malformed data. */
export function parseOsc(buf: Buffer): OscMessage[] {
  if (buf.toString('ascii', 0, 8) === '#bundle\0') {
    const out: OscMessage[] = [];
    for (let at = 16; at + 4 <= buf.length;) {
      const size = buf.readInt32BE(at);
      if (size <= 0 || at + 4 + size > buf.length) throw new Error('élément de bundle OSC invalide');
      out.push(...parseOsc(buf.subarray(at + 4, at + 4 + size)));
      at += 4 + size;
    }
    return out;
  }
  const [address, afterAddress] = readString(buf, 0);
  if (!address.startsWith('/')) throw new Error('adresse OSC invalide');
  if (afterAddress >= buf.length) return [{ address, args: [] }];
  const [tags, afterTags] = readString(buf, afterAddress);
  let at = afterTags;
  const args: OscArg[] = [];
  for (const t of tags.slice(1)) {
    if (t === 'i') { args.push(buf.readInt32BE(at)); at += 4; }
    else if (t === 'f') { args.push(buf.readFloatBE(at)); at += 4; }
    else if (t === 's') { let s: string; [s, at] = readString(buf, at); args.push(s); }
    else if (t === 'T' || t === 'F') args.push(t === 'T');
    else throw new Error(`type OSC non pris en charge « ${t} »`);
  }
  return [{ address, args }];
}

export function encodeOsc(address: string, args: OscArg[] = []): Buffer {
  const str = (s: string) => { const b = Buffer.alloc(pad4(Buffer.byteLength(s) + 1)); b.write(s); return b; };
  const parts = [str(address)];
  let tags = ',';
  for (const a of args) {
    if (typeof a === 'boolean') tags += a ? 'T' : 'F';
    else if (typeof a === 'string') { tags += 's'; parts.push(str(a)); }
    else if (Number.isInteger(a)) { tags += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a); parts.push(b); }
    else { tags += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(a); parts.push(b); }
  }
  parts.splice(1, 0, str(tags));
  return Buffer.concat(parts);
}

/** UDP OSC receiver; replies `/luma/ack <address> <ok>` to the sender of each handled message. */
export class OscServer extends EventEmitter<{ message: [OscMessage, (ok: boolean) => void]; error: [Error] }> {
  private socket: dgram.Socket | null = null;

  async start(port: number, address: string): Promise<void> {
    await this.stop();
    const s = dgram.createSocket('udp4');
    s.on('message', (buf, rinfo) => {
      let msgs: OscMessage[];
      try {
        msgs = parseOsc(buf);
      } catch (err) {
        this.emit('error', new Error(`Paquet OSC ignoré (${rinfo.address}) : ${(err as Error).message}`));
        return;
      }
      for (const m of msgs) this.emit('message', m, (ok) => s.send(encodeOsc('/luma/ack', [m.address, ok]), rinfo.port, rinfo.address));
    });
    s.on('error', (err) => this.emit('error', err));
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.bind(port, address, () => { s.off('error', reject); resolve(); });
    });
    this.socket = s;
  }

  async stop(): Promise<void> {
    const s = this.socket;
    this.socket = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  get port(): number | null {
    return this.socket?.address().port ?? null;
  }
}
