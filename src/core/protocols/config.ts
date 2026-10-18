import { z } from 'zod';

/* Output configuration & status types. Kept free of Node imports so the renderer can validate forms. */

export const OUTPUT_KINDS = ['virtual', 'artnet', 'sacn', 'enttec-pro', 'open-dmx'] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

const ipv4 = z
  .string()
  .regex(/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/, 'Adresse IPv4 invalide');
const localUniverse = z.number().int().min(1).max(64);
const base = {
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(60),
  enabled: z.boolean().default(true),
  /** Max frames per second sent to this output (DMX512 refresh tops out around 44 Hz). */
  maxFps: z.number().int().min(1).max(44).default(40),
};

export const outputConfigSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('virtual'), universes: z.array(localUniverse).default([1]) }),
  z.object({
    ...base,
    kind: z.literal('artnet'),
    host: ipv4,
    /** Local interface address to bind ('' = any). */
    bindAddress: z.union([ipv4, z.literal('')]).default(''),
    broadcast: z.boolean().default(false),
    universeMap: z.array(z.object({ local: localUniverse, remote: z.number().int().min(0).max(32767) })).min(1),
  }),
  z.object({
    ...base,
    kind: z.literal('sacn'),
    mode: z.enum(['multicast', 'unicast']).default('multicast'),
    host: z.union([ipv4, z.literal('')]).default(''),
    bindAddress: z.union([ipv4, z.literal('')]).default(''),
    priority: z.number().int().min(0).max(200).default(100),
    universeMap: z.array(z.object({ local: localUniverse, remote: z.number().int().min(1).max(63999) })).min(1),
  }).refine((c) => c.mode === 'multicast' || c.host !== '', { message: 'Adresse de destination requise en unicast', path: ['host'] }),
  z.object({ ...base, kind: z.literal('enttec-pro'), path: z.string().min(1).max(200), universe: localUniverse }),
  /** FTDI interface without microcontroller: the host generates BREAK + 250 kbaud frame itself. */
  z.object({ ...base, kind: z.literal('open-dmx'), maxFps: z.number().int().min(1).max(40).default(30), path: z.string().min(1).max(200), universe: localUniverse }),
]);
export type OutputConfig = z.infer<typeof outputConfigSchema>;

export type OutputState = 'disabled' | 'disarmed' | 'connecting' | 'ready' | 'error';

export interface OutputStats {
  framesSent: number;
  packetsSent: number;
  bytesSent: number;
  errors: number;
  lastError: string | null;
  lastErrorAt: number | null;
  lastSendAt: number | null;
  measuredFps: number;
}

export interface OutputStatus {
  id: string;
  name: string;
  kind: OutputKind;
  /** Real outputs reach physical hardware / the network; virtual ones never do. */
  real: boolean;
  enabled: boolean;
  armed: boolean;
  state: OutputState;
  detail: string;
  stats: OutputStats;
}
