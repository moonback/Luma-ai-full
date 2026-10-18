import { OutputAdapter, type OutputConfig } from './types';

/**
 * "Open DMX" style interfaces (FTDI FT232R + RS-485 driver, no microcontroller, e.g. Enttec Open DMX USB).
 * The host generates the whole DMX512 frame: BREAK (line held low ≥ 88 µs), MARK AFTER BREAK, then the start
 * code + 512 slots at 250 000 baud, 8 data bits, 2 stop bits, no parity.
 *
 * Timing depends on the OS and the FTDI driver (BREAK is set/cleared with system calls, so it lasts about 1 ms
 * or more — within the DMX512 limit of 1 s, but jittery). Not verified on hardware in this repository.
 */
export const OPEN_DMX_BAUD = 250000;
export const BREAK_MS = 1;

export function buildOpenDmxFrame(data: Uint8Array): Buffer {
  const buf = Buffer.alloc(513);
  buf[0] = 0x00; // DMX512 null start code
  buf.set(data.subarray(0, 512), 1);
  return buf;
}

export interface BreakCapablePort {
  isOpen: boolean;
  set(opts: { brk: boolean }, cb: (err: Error | null) => void): void;
  write(data: Buffer, cb: (err: Error | null | undefined) => void): void;
  drain(cb: (err: Error | null) => void): void;
  close(cb: (err: Error | null) => void): void;
  on(event: 'close' | 'error', cb: (err?: Error) => void): void;
}

export type PortFactory = (path: string) => Promise<BreakCapablePort>;

const defaultFactory: PortFactory = async (path) => {
  const { SerialPort } = await import('serialport');
  return new Promise((resolve, reject) => {
    const p = new SerialPort({ path, baudRate: OPEN_DMX_BAUD, dataBits: 8, stopBits: 2, parity: 'none', autoOpen: false });
    p.open((err) => (err ? reject(err) : resolve(p as unknown as BreakCapablePort)));
  });
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = (fn: (cb: (err: Error | null | undefined) => void) => void) =>
  new Promise<void>((resolve, reject) => fn((err) => (err ? reject(err) : resolve())));

type OpenDmxConfig = Extract<OutputConfig, { kind: 'open-dmx' }>;

export class OpenDmxOutput extends OutputAdapter {
  private port: BreakCapablePort | null = null;
  private busy = false;
  /** Frames dropped because the previous frame was still being written (link slower than the engine). */
  dropped = 0;

  constructor(config: OpenDmxConfig, private readonly factory: PortFactory = defaultFactory) {
    super(config);
  }

  protected async doOpen(): Promise<void> {
    const path = (this.config as OpenDmxConfig).path;
    const port = await this.factory(path);
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
    const port = this.port;
    if (!port) throw new Error('Port série fermé');
    if (this.busy) {
      this.dropped++;
      return;
    }
    this.busy = true;
    const frame = buildOpenDmxFrame(data);
    void this.sendFrame(port, frame)
      .catch((err) => this.fail(err))
      .finally(() => {
        this.busy = false;
      });
  }

  /** BREAK → MARK AFTER BREAK → start code + slots, then wait for the bytes to leave the UART. */
  async sendFrame(port: BreakCapablePort, frame: Buffer): Promise<void> {
    await call((cb) => port.set({ brk: true }, cb));
    await sleep(BREAK_MS);
    await call((cb) => port.set({ brk: false }, cb)); // MAB = time until the first byte is clocked out (> 12 µs)
    await call((cb) => port.write(frame, cb));
    await call((cb) => port.drain(cb));
  }
}
