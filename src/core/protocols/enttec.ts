import { OutputAdapter, type OutputConfig } from './types';

/**
 * Enttec DMX USB Pro framing ("Output Only Send DMX Packet Request", label 6):
 * 0x7E | label | len LSB | len MSB | start code 0x00 + 512 slots | 0xE7
 * Implemented from Enttec's published API document. NOT verified against physical hardware in this repository.
 */
export function buildEnttecProPacket(data: Uint8Array): Buffer {
  const slots = data.subarray(0, 512);
  const len = slots.length + 1;
  const buf = Buffer.alloc(len + 5);
  buf[0] = 0x7e;
  buf[1] = 6;
  buf[2] = len & 0xff;
  buf[3] = (len >> 8) & 0xff;
  buf[4] = 0x00;
  buf.set(slots, 5);
  buf[buf.length - 1] = 0xe7;
  return buf;
}

export interface SerialPortInfo {
  path: string;
  manufacturer: string | null;
  vendorId: string | null;
  productId: string | null;
  serialNumber: string | null;
  /** FTDI chip detected (VID 0403). Enttec Pro uses FTDI, but so do many other devices: not a confirmation. */
  ftdi: boolean;
}

interface SerialLike {
  write(data: Buffer, cb: (err: Error | null | undefined) => void): void;
  close(cb: (err: Error | null) => void): void;
  on(event: 'close' | 'error', cb: (err?: Error) => void): void;
  isOpen: boolean;
}

/** Lists serial ports via the optional native `serialport` module. Returns [] with a reason if unavailable. */
export async function listSerialPorts(): Promise<{ ports: SerialPortInfo[]; error: string | null }> {
  try {
    const { SerialPort } = await import('serialport');
    const ports = await SerialPort.list();
    return {
      ports: ports.map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer ?? null,
        vendorId: p.vendorId ?? null,
        productId: p.productId ?? null,
        serialNumber: p.serialNumber ?? null,
        ftdi: (p.vendorId ?? '').toLowerCase() === '0403',
      })),
      error: null,
    };
  } catch (err) {
    return { ports: [], error: `Module série indisponible : ${err instanceof Error ? err.message : String(err)}` };
  }
}

type EnttecConfig = Extract<OutputConfig, { kind: 'enttec-pro' }>;

export class EnttecProOutput extends OutputAdapter {
  private port: SerialLike | null = null;
  private busy = false;

  constructor(config: EnttecConfig) {
    super(config);
  }

  protected async doOpen(): Promise<void> {
    const { SerialPort } = await import('serialport');
    const path = (this.config as EnttecConfig).path;
    const port = await new Promise<SerialLike>((resolve, reject) => {
      const p = new SerialPort({ path, baudRate: 57600, autoOpen: false });
      p.open((err) => (err ? reject(err) : resolve(p as unknown as SerialLike)));
    });
    port.on('close', () => {
      if (!this.closing) this.fail(new Error(`Périphérique ${path} déconnecté`));
    });
    port.on('error', (err) => this.fail(err ?? new Error('Erreur série')));
    this.port = port;
  }

  protected async doClose(): Promise<void> {
    const p = this.port;
    this.port = null;
    if (p?.isOpen) await new Promise<void>((r) => p.close(() => r()));
  }

  protected doSend(_universe: number, data: Uint8Array): void {
    if (!this.port) throw new Error('Port série fermé');
    if (this.busy) return; // drop frame rather than queueing unbounded writes on a slow link
    this.busy = true;
    this.port.write(buildEnttecProPacket(data), (err) => {
      this.busy = false;
      if (err) this.fail(err);
    });
  }
}
