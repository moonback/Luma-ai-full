import { EventEmitter } from 'node:events';
import type { OutputConfig, OutputState, OutputStats } from './config';

export * from './config';

/** Base class: stats, state machine and controlled reconnection with backoff. */
export abstract class OutputAdapter extends EventEmitter<{ status: [] }> {
  state: OutputState = 'disarmed';
  detail = '';
  readonly stats: OutputStats = { framesSent: 0, packetsSent: 0, bytesSent: 0, errors: 0, lastError: null, lastErrorAt: null, lastSendAt: null, measuredFps: 0 };
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoff = 1000;
  private fpsWindow = { start: 0, frames: 0 };
  protected closing = false;

  constructor(public config: OutputConfig) {
    super();
  }

  protected abstract doOpen(): Promise<void>;
  protected abstract doClose(): Promise<void>;
  /** Sends one universe. Must report async failures through `fail()`. */
  protected abstract doSend(remoteUniverse: number, data: Uint8Array): void;

  async open(): Promise<void> {
    this.closing = false;
    this.setState('connecting', 'Ouverture…');
    try {
      await this.doOpen();
      this.backoff = 1000;
      this.setState('ready', 'Prêt');
    } catch (err) {
      this.fail(err);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      await this.doClose();
    } catch (err) {
      this.recordError(err);
    }
    this.setState('disarmed', 'Désarmée');
  }

  send(remoteUniverse: number, data: Uint8Array): void {
    if (this.state !== 'ready') return;
    try {
      this.doSend(remoteUniverse, data);
      this.stats.packetsSent++;
      this.stats.bytesSent += data.length;
    } catch (err) {
      this.fail(err);
    }
  }

  /** Marks a full frame (all universes of a tick) as handed to the transport. */
  markFrame(): void {
    const now = Date.now();
    this.stats.framesSent++;
    this.stats.lastSendAt = now;
    if (this.fpsWindow.start === 0) this.fpsWindow.start = now;
    this.fpsWindow.frames++;
    if (now - this.fpsWindow.start >= 1000) {
      this.stats.measuredFps = Math.round((this.fpsWindow.frames * 10000) / (now - this.fpsWindow.start)) / 10;
      this.fpsWindow = { start: now, frames: 0 };
    }
  }

  protected recordError(err: unknown): void {
    this.stats.errors++;
    this.stats.lastError = err instanceof Error ? err.message : String(err);
    this.stats.lastErrorAt = Date.now();
  }

  /** Records the error, enters `error` state and schedules a reconnection with exponential backoff (max 10 s). */
  protected fail(err: unknown): void {
    this.recordError(err);
    if (this.closing) return;
    this.setState('error', this.stats.lastError ?? 'Erreur');
    if (this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(10000, this.backoff * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closing) return;
      void this.doClose().catch(() => undefined).then(() => this.open());
    }, delay);
  }

  protected setState(state: OutputState, detail: string): void {
    if (this.state === state && this.detail === detail) return;
    this.state = state;
    this.detail = detail;
    this.emit('status');
  }
}
