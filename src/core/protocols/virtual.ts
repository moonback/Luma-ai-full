import { OutputAdapter, type OutputConfig } from './types';

export interface ChannelChange {
  t: number;
  universe: number;
  channel: number; // 1-based
  from: number;
  to: number;
}

export type VirtualInjection = { type: 'fail-next'; count: number } | { type: 'disconnect' } | { type: 'reconnect' };

/**
 * Deterministic virtual output for development and tests. Never touches hardware or the network.
 * Exposes received frames, a bounded change history and supports fault injection.
 */
export class VirtualOutput extends OutputAdapter {
  readonly frames = new Map<number, Uint8Array>();
  readonly history: ChannelChange[] = [];
  private failNext = 0;
  private disconnected = false;
  static readonly HISTORY_LIMIT = 2000;

  constructor(config: OutputConfig, private readonly clock: () => number = Date.now) {
    super(config);
  }

  protected async doOpen(): Promise<void> {
    if (this.disconnected) throw new Error('Sortie virtuelle déconnectée (injection de test)');
  }

  protected async doClose(): Promise<void> {}

  protected doSend(universe: number, data: Uint8Array): void {
    if (this.disconnected) throw new Error('Sortie virtuelle déconnectée (injection de test)');
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('Erreur de transmission simulée (injection de test)');
    }
    const prev = this.frames.get(universe);
    const now = this.clock();
    for (let i = 0; i < 512; i++) {
      const to = data[i] ?? 0;
      const from = prev?.[i] ?? 0;
      if (to !== from) this.history.push({ t: now, universe, channel: i + 1, from, to });
    }
    if (this.history.length > VirtualOutput.HISTORY_LIMIT) this.history.splice(0, this.history.length - VirtualOutput.HISTORY_LIMIT);
    this.frames.set(universe, data.slice(0, 512));
  }

  inject(i: VirtualInjection): void {
    if (i.type === 'fail-next') this.failNext += i.count;
    else if (i.type === 'disconnect') {
      this.disconnected = true;
      this.fail(new Error('Sortie virtuelle déconnectée (injection de test)'));
    } else {
      this.disconnected = false;
    }
  }
}
