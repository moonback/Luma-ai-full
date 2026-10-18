import { EventEmitter } from 'node:events';
import type { FrameSink } from '../engine/Engine';
import { ArtNetOutput } from './artnet';
import { EnttecProOutput } from './enttec';
import { OpenDmxOutput } from './opendmx';
import { SacnOutput } from './sacn';
import { OutputAdapter, type OutputConfig, type OutputStatus } from './types';
import { VirtualOutput } from './virtual';

export type AdapterFactory = (config: OutputConfig) => OutputAdapter;

export function createAdapter(config: OutputConfig, sacnCid?: string): OutputAdapter {
  switch (config.kind) {
    case 'virtual': return new VirtualOutput(config);
    case 'artnet': return new ArtNetOutput(config);
    case 'sacn': return new SacnOutput(config, sacnCid);
    case 'enttec-pro': return new EnttecProOutput(config);
    case 'open-dmx': return new OpenDmxOutput(config);
  }
}

function routes(c: OutputConfig): { local: number; remote: number }[] {
  switch (c.kind) {
    case 'virtual': return c.universes.map((u) => ({ local: u, remote: u }));
    case 'artnet':
    case 'sacn': return c.universeMap;
    case 'enttec-pro':
    case 'open-dmx': return [{ local: c.universe, remote: c.universe }];
  }
}

export interface TransmittedFrame {
  data: Uint8Array;
  at: number;
}

/**
 * Owns all output adapters. Safety rules:
 *  - real outputs (Art-Net, sACN, USB) always start DISARMED and are only opened by an explicit `arm()`;
 *  - `transmitting = false` (STOP OUTPUT) stops every emission immediately; virtual outputs keep recording.
 * Keeps the "transmitted" state (last frame successfully handed to each transport), separate from the computed state.
 */
export class OutputManager extends EventEmitter<{ status: [] }> implements FrameSink {
  private readonly adapters = new Map<string, OutputAdapter>();
  private readonly armed = new Set<string>();
  private readonly lastSentAt = new Map<string, number>();
  readonly transmitted = new Map<string, Map<number, TransmittedFrame>>();
  transmitting = true;

  constructor(private readonly factory: AdapterFactory = (c) => createAdapter(c), private readonly now: () => number = Date.now) {
    super();
  }

  async configure(configs: readonly OutputConfig[]): Promise<void> {
    const ids = new Set(configs.map((c) => c.id));
    for (const [id, a] of this.adapters) {
      if (!ids.has(id)) {
        await a.close();
        this.adapters.delete(id);
        this.armed.delete(id);
        this.transmitted.delete(id);
      }
    }
    for (const c of configs) {
      const existing = this.adapters.get(c.id);
      if (existing && JSON.stringify(existing.config) === JSON.stringify(c)) continue;
      const wasArmed = this.armed.has(c.id);
      if (existing) await existing.close();
      const adapter = this.factory(c);
      adapter.on('status', () => this.emit('status'));
      this.adapters.set(c.id, adapter);
      if (!c.enabled) {
        this.armed.delete(c.id);
        continue;
      }
      // Virtual outputs are always safe to open; real outputs re-open only if they were armed before the edit.
      if (c.kind === 'virtual' || wasArmed) {
        this.armed.add(c.id);
        await adapter.open();
      }
    }
    this.emit('status');
  }

  async arm(id: string): Promise<void> {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`Sortie inconnue: ${id}`);
    if (!a.config.enabled) throw new Error('Sortie désactivée dans les paramètres');
    this.armed.add(id);
    await a.open();
    this.emit('status');
  }

  async disarm(id: string): Promise<void> {
    const a = this.adapters.get(id);
    if (!a) return;
    this.armed.delete(id);
    await a.close();
    this.emit('status');
  }

  async disarmAllReal(): Promise<void> {
    for (const [id, a] of this.adapters) if (a.config.kind !== 'virtual' && this.armed.has(id)) await this.disarm(id);
  }

  setTransmitting(on: boolean): void {
    this.transmitting = on;
    this.emit('status');
  }

  get(id: string): OutputAdapter | undefined {
    return this.adapters.get(id);
  }

  virtual(): VirtualOutput | undefined {
    for (const a of this.adapters.values()) if (a instanceof VirtualOutput && a.state === 'ready') return a;
    return undefined;
  }

  get liveMode(): boolean {
    for (const [id, a] of this.adapters) if (a.config.kind !== 'virtual' && this.armed.has(id) && a.state !== 'disarmed') return true;
    return false;
  }

  sendFrames(frames: ReadonlyMap<number, Uint8Array>): void {
    const now = this.now();
    for (const [id, a] of this.adapters) {
      if (a.state !== 'ready') continue;
      if (!this.transmitting && a.config.kind !== 'virtual') continue;
      const last = this.lastSentAt.get(id) ?? 0;
      if (now - last < 1000 / a.config.maxFps - 1) continue; // per-output rate limit
      this.lastSentAt.set(id, now);
      let sent = this.transmitted.get(id);
      if (!sent) this.transmitted.set(id, (sent = new Map()));
      let any = false;
      for (const r of routes(a.config)) {
        const data = frames.get(r.local);
        if (!data) continue;
        const before = a.stats.errors;
        a.send(r.remote, data);
        if (a.state === 'ready' && a.stats.errors === before) {
          sent.set(r.local, { data: data.slice(), at: now });
          any = true;
        }
      }
      if (any) a.markFrame();
    }
  }

  status(): OutputStatus[] {
    return [...this.adapters.values()].map((a) => ({
      id: a.config.id,
      name: a.config.name,
      kind: a.config.kind,
      real: a.config.kind !== 'virtual',
      enabled: a.config.enabled,
      armed: this.armed.has(a.config.id),
      state: a.config.enabled ? a.state : 'disabled',
      detail: !this.transmitting && a.config.kind !== 'virtual' && a.state === 'ready' ? 'Émission arrêtée (STOP)' : a.detail,
      stats: { ...a.stats },
    }));
  }

  async closeAll(): Promise<void> {
    for (const a of this.adapters.values()) await a.close();
    this.armed.clear();
  }
}
