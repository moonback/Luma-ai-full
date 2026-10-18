import { z } from 'zod';
import { EFFECT_TYPES, FIXTURE_TYPES, hexColorSchema, unitSchema } from '../model/schemas';

/**
 * The ONLY things an AI (local or remote) may ask for. Actions are validated against the patch and the
 * profiles' capabilities before anything is executed; the AI never produces DMX packets or code.
 */

export const aiTargetSchema = z.object({
  all: z.boolean().optional(),
  groupNames: z.array(z.string().max(80)).max(32).optional(),
  fixtureNames: z.array(z.string().max(80)).max(256).optional(),
  fixtureTypes: z.array(z.enum(FIXTURE_TYPES)).max(8).optional(),
  tags: z.array(z.string().max(32)).max(16).optional(),
  /** Keep only the first N fixtures after resolution (e.g. "les quatre lyres"). */
  limit: z.number().int().min(1).max(512).optional(),
});
export type AiTarget = z.infer<typeof aiTargetSchema>;

const fade = z.number().min(0).max(600).default(0);

export const lookPartSchema = z.object({
  target: aiTargetSchema,
  level: unitSchema.optional(),
  color: hexColorSchema.optional(),
  /** Several colours are distributed across the target fixtures in order. */
  colors: z.array(hexColorSchema).max(16).optional(),
  pan: unitSchema.optional(),
  tilt: unitSchema.optional(),
});
export type LookPart = z.infer<typeof lookPartSchema>;

export const aiEffectSpecSchema = z.object({
  name: z.string().trim().min(1).max(80),
  effectType: z.enum(EFFECT_TYPES),
  target: aiTargetSchema,
  speed: z.number().min(0.01).max(30).optional(),
  bpmSync: z.boolean().optional(),
  beatsPerCycle: z.number().min(0.25).max(64).optional(),
  amplitude: unitSchema.optional(),
  offset: unitSchema.optional(),
  phaseSpread: unitSchema.optional(),
  shape: z.enum(['circle', 'figure8', 'pan', 'tilt']).optional(),
  colors: z.array(hexColorSchema).max(16).optional(),
  duration: z.number().min(0.1).max(86400).nullable().optional(),
});
export type AiEffectSpec = z.infer<typeof aiEffectSpecSchema>;

export const aiActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('setIntensity'), target: aiTargetSchema, level: unitSchema, fade }),
  z.object({ type: z.literal('setColor'), target: aiTargetSchema, color: hexColorSchema.optional(), colors: z.array(hexColorSchema).min(1).max(16).optional(), fade })
    .refine((a) => a.color || a.colors, { message: 'color ou colors requis' }),
  z.object({ type: z.literal('setPosition'), target: aiTargetSchema, pan: unitSchema.optional(), tilt: unitSchema.optional(), fade }),
  z.object({ type: z.literal('startEffect'), effect: aiEffectSpecSchema }),
  z.object({ type: z.literal('stopEffect'), effectName: z.string().max(80).optional(), effectType: z.enum(EFFECT_TYPES).optional(), all: z.boolean().optional() }),
  z.object({ type: z.literal('createScene'), name: z.string().trim().min(1).max(80), look: z.array(lookPartSchema).min(1).max(64), apply: z.boolean().default(false), fade }),
  z.object({ type: z.literal('applyScene'), sceneName: z.string().trim().min(1).max(80), fade }),
  z.object({
    type: z.literal('createCue'),
    cueListName: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(80),
    sceneName: z.string().trim().min(1).max(80),
    fade: z.number().min(0).max(600).default(2),
    followAfter: z.number().min(0).max(3600).nullable().default(null),
  }),
  z.object({
    type: z.literal('createSequence'),
    name: z.string().trim().min(1).max(80),
    loop: z.boolean().default(false),
    cues: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(80),
          look: z.array(lookPartSchema).min(1).max(64),
          fade: z.number().min(0).max(600).default(2),
          /** Seconds held before auto-following to the next cue; null = manual GO. */
          hold: z.number().min(0).max(3600).nullable().default(null),
          effects: z.array(aiEffectSpecSchema).max(8).default([]),
        }),
      )
      .min(1)
      .max(64),
  }),
  z.object({ type: z.literal('setBpm'), bpm: z.number().min(20).max(300) }),
  z.object({ type: z.literal('releaseAi') }),
]);
export type AiAction = z.infer<typeof aiActionSchema>;
export type AiActionType = AiAction['type'];

export const MAX_ACTIONS_PER_PROPOSAL = 50;

export const aiPlanSchema = z.object({
  understanding: z.string().max(2000),
  actions: z.array(z.unknown()).max(MAX_ACTIONS_PER_PROPOSAL),
});

export type ActionStatus = 'ok' | 'warning' | 'rejected';

export interface ValidatedAction {
  index: number;
  status: ActionStatus;
  action: AiAction | null;
  raw: unknown;
  summary: string;
  messages: string[];
  /** Resolved fixture ids per target in the action (flattened). */
  fixtureIds: string[];
}

export interface AiProposal {
  id: string;
  prompt: string;
  provider: 'local' | 'openrouter';
  model: string | null;
  understanding: string;
  notices: string[];
  actions: ValidatedAction[];
  /** Fixture values the AI layer would hold after the proposal is applied (for preview). */
  preview: Record<string, Record<string, number>>;
  createdAt: string;
}

export interface AiExecutionReport {
  proposalId: string;
  executed: { index: number; summary: string; detail: string }[];
  skipped: { index: number; summary: string; reason: string }[];
  verification: { checked: number; matched: number; overriddenByManual: number; mismatches: string[] };
  created: { scenes: string[]; cueLists: string[]; effects: string[] };
}
