import { z } from 'zod';
import { outputConfigSchema } from '../protocols/config';

/** Rebindable keyboard actions. Bindings use the form "Ctrl+Shift+S", "Space", "Shift+Escape", "F5"… */
export const SHORTCUT_ACTIONS = [
  { id: 'go', label: 'GO sur la liste de cues sélectionnée', default: 'Space' },
  { id: 'back', label: 'BACK (cue précédent)', default: 'Shift+Space' },
  { id: 'pause', label: 'Pause / reprise de la liste sélectionnée', default: 'P' },
  { id: 'blackout', label: 'Blackout on/off', default: 'B' },
  { id: 'stopOutput', label: 'STOP OUTPUT : arrêt immédiat des émissions réelles', default: 'Shift+Escape' },
  { id: 'release', label: 'Relâcher le programmeur (reprise des playbacks)', default: 'Escape' },
  { id: 'save', label: 'Enregistrer', default: 'Ctrl+S' },
  { id: 'saveAs', label: 'Enregistrer sous', default: 'Ctrl+Shift+S' },
  { id: 'open', label: 'Ouvrir un projet', default: 'Ctrl+O' },
  { id: 'new', label: 'Nouveau projet', default: 'Ctrl+N' },
  { id: 'diagnostics', label: 'Console de diagnostic', default: 'Ctrl+`' },
  { id: 'page:dashboard', label: 'Espace Dashboard', default: 'Ctrl+1' },
  { id: 'page:fixtures', label: 'Espace Fixtures', default: 'Ctrl+2' },
  { id: 'page:console', label: 'Espace Live Console', default: 'Ctrl+3' },
  { id: 'page:programmer', label: 'Espace Programmer', default: 'Ctrl+4' },
  { id: 'page:cues', label: 'Espace Cues & Sequences', default: 'Ctrl+5' },
  { id: 'page:effects', label: 'Espace Effects', default: 'Ctrl+6' },
  { id: 'page:timeline', label: 'Espace Timeline', default: 'Ctrl+7' },
  { id: 'page:ai', label: 'Espace AI Lighting Director', default: 'Ctrl+8' },
  { id: 'page:visualizer', label: 'Espace Stage Visualizer', default: 'Ctrl+9' },
  { id: 'page:stage3d', label: 'Espace Stage 3D', default: '' },
  { id: 'page:audio', label: 'Espace Audio Reactive', default: 'Ctrl+0' },
  { id: 'page:music', label: 'Espace Musique (Song-to-Show)', default: '' },
  { id: 'page:output', label: 'Espace DMX Output', default: '' },
  { id: 'page:settings', label: 'Espace Settings', default: 'Ctrl+,' },
] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number]['id'];

/** Effective bindings: defaults overridden by the user's settings ("" = unassigned). */
export function resolveShortcuts(overrides: Record<string, string>): Record<ShortcutAction, string> {
  return Object.fromEntries(SHORTCUT_ACTIONS.map((a) => [a.id, overrides[a.id] ?? a.default])) as Record<ShortcutAction, string>;
}

/** Actions sharing the same non-empty binding. */
export function shortcutConflicts(bindings: Record<string, string>): string[][] {
  const by = new Map<string, string[]>();
  for (const [id, combo] of Object.entries(bindings)) if (combo) by.set(combo, [...(by.get(combo) ?? []), id]);
  return [...by.values()].filter((ids) => ids.length > 1);
}

export const settingsSchema = z.object({
  version: z.literal(1).default(1),
  general: z
    .object({
      autosaveMinutes: z.number().int().min(0).max(60).default(2),
      recentProjects: z.array(z.string().max(1000)).max(10).default([]),
      confirmDangerous: z.boolean().default(true),
    })
    .default({ autosaveMinutes: 2, recentProjects: [], confirmDangerous: true }),
  /** First-run onboarding: welcome + guided tour done, "first steps" checklist hidden. */
  onboarding: z
    .object({ completed: z.boolean().default(false), checklistHidden: z.boolean().default(false) })
    .default({ completed: false, checklistHidden: false }),
  appearance: z
    .object({ reducedMotion: z.boolean().default(false), uiScale: z.number().min(0.8).max(1.4).default(1) })
    .default({ reducedMotion: false, uiScale: 1 }),
  engine: z
    .object({
      rateHz: z.number().int().min(10).max(44).default(40),
      blackoutPolicy: z.enum(['intensity', 'intensity-shutter', 'all-zero']).default('intensity-shutter'),
      maxStrobeHz: z.number().min(1).max(25).default(10),
      /** Photosensitive flash guard: off, warn (alert only) or limit (rate-limit flashes in the engine). */
      flashGuard: z.enum(['off', 'warn', 'limit']).default('warn'),
      priorities: z
        .object({ ai: z.number().int().min(1).max(99).default(60), timeline: z.number().int().min(1).max(99).default(40), audio: z.number().int().min(1).max(99).default(55) })
        .default({ ai: 60, timeline: 40, audio: 55 }),
    })
    .default({ rateHz: 40, blackoutPolicy: 'intensity-shutter', maxStrobeHz: 10, flashGuard: 'warn', priorities: { ai: 60, timeline: 40, audio: 55 } }),
  outputs: z.array(outputConfigSchema).max(16).default([{ id: 'virtual-1', name: 'Sortie virtuelle', kind: 'virtual', enabled: true, maxFps: 40, universes: [1, 2, 3, 4] }]),
  sacn: z.object({ cid: z.uuid() }).optional(),
  ai: z
    .object({
      // Settings written by earlier versions used the direct Anthropic provider: migrate them to OpenRouter.
      provider: z.preprocess((v) => (v === 'anthropic' ? 'openrouter' : v), z.enum(['local', 'openrouter'])).default('local'),
      /** OpenRouter model id ("vendor/model"); ids without a vendor come from the old Anthropic setting. */
      model: z.preprocess((v) => (typeof v === 'string' && v.includes('/') ? v : 'openrouter/auto'), z.string().min(3).max(150)).default('openrouter/auto'),
      effort: z.enum(['low', 'medium', 'high']).default('medium'),
      timeoutSec: z.number().int().min(5).max(300).default(60),
      allowStrobe: z.boolean().default(false),
      /** Fall back to the local interpreter when the external provider fails. */
      fallbackToLocal: z.boolean().default(true),
    })
    .default({ provider: 'local', model: 'openrouter/auto', effort: 'medium', timeoutSec: 60, allowStrobe: false, fallbackToLocal: true }),
  audio: z.object({ deviceId: z.string().max(300).nullable().default(null) }).default({ deviceId: null }),
  /** External control: MIDI mappings (renderer, Web MIDI), OSC over UDP (main) and timecode chase of the timeline. */
  control: z
    .object({
      midi: z
        .object({
          enabled: z.boolean().default(false),
          /** key "note:<ch>:<n>" or "cc:<ch>:<n>" → shortcut action id, or "master" for a fader. */
          mappings: z.array(z.object({ key: z.string().regex(/^(note|cc):\d{1,2}:\d{1,3}$/), action: z.string().min(1).max(40) })).max(128).default([]),
        })
        .default({ enabled: false, mappings: [] }),
      osc: z
        .object({
          enabled: z.boolean().default(false),
          port: z.number().int().min(1024).max(65535).default(8000),
          /** 127.0.0.1 = this machine only; 0.0.0.0 = local network (no authentication: trusted networks only). */
          bind: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'),
        })
        .default({ enabled: false, port: 8000, bind: '127.0.0.1' }),
      timecode: z
        .object({ source: z.enum(['off', 'mtc', 'ltc']).default('off'), ltcDeviceId: z.string().max(300).nullable().default(null) })
        .default({ source: 'off', ltcDeviceId: null }),
      /** Tablet/phone remote (HTTP on the local network, token in the URL). */
      remote: z
        .object({ enabled: z.boolean().default(false), port: z.number().int().min(1024).max(65535).default(8080), token: z.string().min(16).max(100).optional() })
        .default({ enabled: false, port: 8080 }),
    })
    .default({ midi: { enabled: false, mappings: [] }, osc: { enabled: false, port: 8000, bind: '127.0.0.1' }, timecode: { source: 'off', ltcDeviceId: null }, remote: { enabled: false, port: 8080 } }),
  logs: z.object({ level: z.enum(['debug', 'info', 'warn', 'error']).default('info') }).default({ level: 'info' }),
  /** Overrides of the default shortcuts, by action id. */
  shortcuts: z.record(z.string().max(40), z.string().max(40)).default({}),
});
export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings = (): Settings => settingsSchema.parse({});
