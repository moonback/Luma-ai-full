import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

export const idSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, 'Identifiant invalide');
export const nameSchema = z.string().trim().min(1, 'Nom requis').max(80);
export const dmxValueSchema = z.number().int().min(0).max(255);
export const unitSchema = z.number().min(0).max(1); // normalized attribute value
export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Couleur hexadécimale attendue (#RRGGBB)');
export const MAX_UNIVERSES = 64;
export const universeSchema = z.number().int().min(1).max(MAX_UNIVERSES);
export const addressSchema = z.number().int().min(1).max(512);

/* ------------------------------------------------------------------ */
/* Attributes                                                          */
/* ------------------------------------------------------------------ */

export const BUILTIN_ATTRIBUTES = [
  'dimmer', 'red', 'green', 'blue', 'white', 'amber', 'uv', 'cyan', 'magenta', 'yellow', 'cto', 'colorWheel',
  'warmWhite', 'coldWhite', 'lime', 'indigo', 'colorTemperature', 'colorMacro', 'colorMacroFade',
  'pan', 'tilt', 'panTiltSpeed', 'panTiltMode',
  'shutter', 'strobe', 'gobo', 'goboRotation', 'prism', 'focus', 'zoom', 'iris', 'frost', 'effectWheel', 'zoomMode',
  'gobo2', 'gobo2Rotation', 'prismIndex', 'prismRotation',
  'speed', 'macro', 'control', 'macroSpeed', 'fog', 'fan', 'dimmerCurve',
] as const;
export type BuiltinAttribute = (typeof BUILTIN_ATTRIBUTES)[number];
export const attributeSchema = z.union([
  z.enum(BUILTIN_ATTRIBUTES),
  z.string().regex(/^custom:[a-z0-9][a-z0-9-]{0,31}$/, 'Attribut personnalisé: custom:<nom>'),
]);
export type Attribute = z.infer<typeof attributeSchema>;
/** Value key: an attribute, or "<attribute>#<cell>" for a cell of a multi-cell / multi-head fixture. */
export const attributeKeySchema = z.string().max(48).refine((k) => {
  const [attr, cell, ...rest] = k.split('#');
  return rest.length === 0 && attributeSchema.safeParse(attr).success && (cell === undefined || /^[1-9]\d{0,2}$/.test(cell));
}, 'Attribut inconnu (attribut ou attribut#cellule)');

/* ------------------------------------------------------------------ */
/* Fixture profiles                                                    */
/* ------------------------------------------------------------------ */

export const RANGE_KINDS = ['open', 'closed', 'strobe', 'pulse', 'random', 'color', 'gobo', 'shake', 'rotation', 'reset', 'lamp-on', 'lamp-off', 'other'] as const;

export const channelRangeSchema = z
  .object({
    from: dmxValueSchema,
    to: dmxValueSchema,
    label: z.string().min(1).max(64),
    kind: z.enum(RANGE_KINDS).default('other'),
    color: hexColorSchema.optional(),
    /** Values in a dangerous range (reset, lamp off…) are only emitted after explicit manual confirmation. */
    dangerous: z.boolean().default(false),
    /** Real strobe/pulse frequency at `from` and `to` (Hz), when the manual documents it. */
    hzFrom: z.number().min(0).max(100).optional(),
    hzTo: z.number().min(0).max(100).optional(),
    /** Generic physical value at `from` and `to` (degrees, rpm…: unit given by the attribute). */
    physFrom: z.number().optional(),
    physTo: z.number().optional(),
  })
  .refine((r) => r.from <= r.to, { message: 'Plage DMX inversée (from > to)' });
export type ChannelRange = z.infer<typeof channelRangeSchema>;

export const channelSchema = z.object({
  name: z.string().min(1).max(48),
  attribute: attributeSchema,
  /** true = low byte of the 16-bit attribute whose coarse channel is also in the mode. */
  fine: z.boolean().default(false),
  /** Cell number for multi-cell fixtures (LED bars, pixel battens). Absent = whole fixture. */
  cell: z.number().int().min(1).max(512).optional(),
  default: dmxValueSchema.default(0),
  /** Exact 16-bit default (0..65535) of an attribute with a fine channel; overrides `default` for both bytes. */
  default16: z.number().int().min(0).max(65535).optional(),
  /** Light colour of a colour emitter (e.g. #FFFFCC for a warm white), used by the visualizer. */
  emitterColor: hexColorSchema.optional(),
  ranges: z.array(channelRangeSchema).default([]),
});
export type Channel = z.infer<typeof channelSchema>;

export const modeSchema = z
  .object({
    name: z.string().min(1).max(48),
    channels: z.array(channelSchema).min(1).max(512),
  })
  .superRefine((mode, ctx) => {
    const coarse = new Set<string>();
    const fine = new Set<string>();
    for (const [i, ch] of mode.channels.entries()) {
      const set = ch.fine ? fine : coarse;
      const key = ch.cell ? `${ch.attribute}#${ch.cell}` : ch.attribute;
      if (set.has(key)) {
        ctx.addIssue({ code: 'custom', path: ['channels', i, 'attribute'], message: `Attribut « ${key} » déclaré deux fois dans le mode « ${mode.name} »` });
      }
      set.add(key);
    }
    for (const a of fine) {
      if (!coarse.has(a)) ctx.addIssue({ code: 'custom', path: ['channels'], message: `Canal fin « ${a} » sans canal principal` });
    }
  });
export type FixtureMode = z.infer<typeof modeSchema>;

export const MODULE_BEAMS = ['spot', 'wash', 'beam', 'led', 'none'] as const;
/** 'lens' = the main optic, 'ring' = LED ring around the lens, 'pixel' = k-th pixel along a bar (order of `cells`). */
export const MODULE_GEOMETRIES = ['lens', 'ring', 'pixel'] as const;
/** One head of a multi-head fixture (moving head + LED ring, bar + strobe…). */
export const fixtureModuleSchema = z.object({
  name: z.string().trim().min(1).max(48),
  /** Cells whose channels belong to this module; empty = the channels without a cell (main head). */
  cells: z.array(z.number().int().min(1).max(512)).max(512).default([]),
  beam: z.enum(MODULE_BEAMS).default('wash'),
  /** Beam angle in degrees, absent = the profile's beamAngle. */
  angle: z.number().min(1).max(90).optional(),
  geometry: z.enum(MODULE_GEOMETRIES).default('lens'),
});
export type FixtureModule = z.infer<typeof fixtureModuleSchema>;

export const FIXTURE_TYPES = ['par', 'moving-head-spot', 'moving-head-wash', 'strobe', 'dimmer', 'led-bar', 'other'] as const;
export type FixtureType = (typeof FIXTURE_TYPES)[number];
export const profileSchema = z.object({
  id: idSchema,
  name: nameSchema,
  manufacturer: z.string().trim().min(1).max(80),
  type: z.enum(FIXTURE_TYPES),
  /** Fictional demo profiles must never be presented as certified commercial profiles. */
  fictional: z.boolean().default(false),
  physical: z
    .object({
      panRange: z.number().min(0).max(720).default(540),
      tiltRange: z.number().min(0).max(360).default(270),
      beamAngle: z.number().min(1).max(90).default(25),
      /** Asymmetric tilt travel in degrees (tilt 0 → tiltMin, 1 → tiltMax, tiltMin > tiltMax = inverted); absent = ±tiltRange/2. */
      tiltMin: z.number().min(-360).max(360).optional(),
      tiltMax: z.number().min(-360).max(360).optional(),
      /** Beam angle in degrees at zoom 0 and zoom 1. */
      zoomMin: z.number().min(1).max(90).optional(),
      zoomMax: z.number().min(1).max(90).optional(),
      /** Seconds for a 540° pan move at full speed. */
      panTiltTime: z.number().positive().max(60).optional(),
      /** Body size in meters. */
      dimensions: z.object({ width: z.number().positive().max(10), height: z.number().positive().max(10), depth: z.number().positive().max(10) }).optional(),
      weight: z.number().positive().max(1000).optional(),
      power: z.number().positive().max(100000).optional(),
      connector: z.string().trim().min(1).max(48).optional(),
    })
    .default({ panRange: 540, tiltRange: 270, beamAngle: 25 }),
  modes: z.array(modeSchema).min(1),
  modules: z.array(fixtureModuleSchema).max(64).default([]),
});
export type FixtureProfile = z.infer<typeof profileSchema>;

/* ------------------------------------------------------------------ */
/* Patch, groups, palettes                                             */
/* ------------------------------------------------------------------ */

export const fixtureMountSchema = z.enum(['auto', 'hanging', 'floor', 'wall']);
export type FixtureMount = z.infer<typeof fixtureMountSchema>;

export const fixtureSchema = z.object({
  id: idSchema,
  name: nameSchema,
  profileId: idSchema,
  mode: z.string().min(1),
  universe: universeSchema,
  address: addressSchema,
  tags: z.array(z.string().trim().min(1).max(32)).max(16).default([]),
  /** Stage position in meters, origin = downstage centre, y grows upstage. */
  position: z.object({ x: z.number().min(-100).max(100), y: z.number().min(-100).max(100) }).default({ x: 0, y: 0 }),
  /** Mounting rotation in degrees (0 = facing audience). */
  rotation: z.number().min(-360).max(360).default(0),
  /** Mounting height in meters (3D visualizer). */
  height: z.number().min(0).max(50).default(4),
  /** Mounting: absent or 'auto' = hanging, or standing on the floor below 1 m (rule of older projects). */
  mount: fixtureMountSchema.optional(),
  /** Tilt of the mounting axis in degrees: leans towards the audience (wall mount: downwards). */
  mountTilt: z.number().min(-90).max(90).optional(),
  /** Truss the fixture hangs from: it follows the truss when the truss moves. */
  trussId: idSchema.nullable().optional(),
  notes: z.string().max(500).default(''),
});
export type Fixture = z.infer<typeof fixtureSchema>;

export const groupSchema = z.object({
  id: idSchema,
  name: nameSchema,
  color: hexColorSchema.default('#8B5CF6'),
  fixtureIds: z.array(idSchema),
});
export type Group = z.infer<typeof groupSchema>;

export const PALETTE_KINDS = ['color', 'position', 'intensity', 'beam'] as const;
export const attributeValuesSchema = z.record(z.string(), unitSchema);
export type AttributeValues = Record<string, number>;
export const paletteSchema = z.object({
  id: idSchema,
  name: nameSchema,
  kind: z.enum(PALETTE_KINDS),
  /** For color palettes: converted per fixture capabilities (RGB, RGBW, color wheel…). */
  color: hexColorSchema.optional(),
  values: attributeValuesSchema.default({}),
});
export type Palette = z.infer<typeof paletteSchema>;

/* ------------------------------------------------------------------ */
/* Scenes, cues, effects, timeline                                     */
/* ------------------------------------------------------------------ */

export const fixtureValuesSchema = z.record(z.string(), attributeValuesSchema);
export type FixtureValues = Record<string, AttributeValues>;

export const sceneSchema = z.object({
  id: idSchema,
  name: nameSchema,
  notes: z.string().max(500).default(''),
  values: fixtureValuesSchema,
  origin: z.enum(['user', 'ai']).default('user'),
});
export type Scene = z.infer<typeof sceneSchema>;

export const curveSchema = z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'snap']);
export const cueTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }),
  /** Auto-GO `wait` seconds after the previous cue completed. */
  z.object({ type: z.literal('follow'), wait: z.number().min(0).max(3600) }),
]);
export const cueSchema = z.object({
  id: idSchema,
  number: z.number().min(0).max(9999),
  name: nameSchema,
  description: z.string().max(500).default(''),
  /** null = cue releases this list's look (fades intensities to 0). */
  sceneId: idSchema.nullable(),
  fade: z.number().min(0).max(600).default(2),
  delay: z.number().min(0).max(600).default(0),
  curve: curveSchema.default('linear'),
  trigger: cueTriggerSchema.default({ type: 'manual' }),
  /** Effects started when the cue fires and stopped when the list leaves the cue. */
  effectIds: z.array(idSchema).default([]),
});
export type Cue = z.infer<typeof cueSchema>;

export const cueListSchema = z.object({
  id: idSchema,
  name: nameSchema,
  priority: z.number().int().min(1).max(99).default(50),
  loop: z.boolean().default(false),
  cues: z.array(cueSchema).max(999),
});
export type CueList = z.infer<typeof cueListSchema>;

export const EFFECT_TYPES = ['fade', 'pulse', 'chase', 'wave', 'rainbow', 'strobe', 'dimmerWave', 'colorCycle', 'panTilt', 'randomMove'] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];
export const targetSchema = z.object({
  fixtureIds: z.array(idSchema).default([]),
  groupIds: z.array(idSchema).default([]),
});
export type Target = z.infer<typeof targetSchema>;
export const effectParamsSchema = z.object({
  /** Cycles per second when not BPM-synced. */
  speed: z.number().min(0.01).max(30).default(0.5),
  bpmSync: z.boolean().default(false),
  beatsPerCycle: z.number().min(0.25).max(64).default(4),
  amplitude: unitSchema.default(1),
  /** Centre / base level. */
  offset: unitSchema.default(0.5),
  /** Fraction of a cycle spread across target fixtures (0 = all in sync). */
  phaseSpread: unitSchema.default(0),
  direction: z.enum(['forward', 'reverse', 'pingpong']).default('forward'),
  colors: z.array(hexColorSchema).max(16).default([]),
  attribute: attributeSchema.default('dimmer'),
  shape: z.enum(['circle', 'figure8', 'pan', 'tilt']).default('circle'),
  width: z.number().int().min(1).max(64).default(1),
  duty: z.number().min(0.05).max(0.95).default(0.5),
  seed: z.number().int().min(0).max(2 ** 31).default(1),
  /** BPM-synced effects restart their cycle on bar/phrase boundaries (downbeats) instead of drifting freely. */
  barSync: z.boolean().default(false),
});
export type EffectParams = z.infer<typeof effectParamsSchema>;
export const effectSchema = z.object({
  id: idSchema,
  name: nameSchema,
  type: z.enum(EFFECT_TYPES),
  targets: targetSchema,
  params: effectParamsSchema,
  priority: z.number().int().min(1).max(99).default(50),
  /** override = replaces values; scale = multiplies the underlying value (intensity modulation). */
  blend: z.enum(['override', 'scale']).default('override'),
  /** Seconds; null = runs until stopped. */
  duration: z.number().min(0.1).max(86400).nullable().default(null),
  trigger: z.enum(['manual', 'cue', 'beat']).default('manual'),
  origin: z.enum(['user', 'ai']).default('user'),
});
export type Effect = z.infer<typeof effectSchema>;

export const timelineEventSchema = z
  .object({
    id: idSchema,
    kind: z.enum(['scene', 'effect', 'cue', 'marker']),
    start: z.number().min(0).max(86400),
    duration: z.number().min(0).max(86400).default(0),
    /** scene id / effect id / cue list id */
    refId: idSchema.nullable().default(null),
    /** For `cue` events: cue index in the list. */
    cueIndex: z.number().int().min(0).default(0),
    fade: z.number().min(0).max(60).default(0),
    /** Fade-out at the end of the event; defaults to `fade` (symmetric). 0 = hold until the end. */
    fadeOut: z.number().min(0).max(60).optional(),
    label: z.string().max(80).default(''),
    lane: z.number().int().min(0).max(31).default(0),
  })
  .refine((e) => e.kind === 'marker' || e.refId !== null, { message: 'Un événement doit référencer une scène, un effet ou une liste de cues' });
export type TimelineEvent = z.infer<typeof timelineEventSchema>;
export const timelineSchema = z.object({
  id: idSchema,
  name: nameSchema,
  duration: z.number().min(1).max(86400).default(120),
  loop: z.boolean().default(false),
  events: z.array(timelineEventSchema).max(5000),
});
export type Timeline = z.infer<typeof timelineSchema>;

/* ------------------------------------------------------------------ */
/* Audio reactive configuration (stored in the project)                */
/* ------------------------------------------------------------------ */

const emptyTarget = { fixtureIds: [], groupIds: [] };
export const audioReactionsSchema = z.object({
  bpmFollow: z.object({ enabled: z.boolean(), minConfidence: unitSchema }),
  levelToIntensity: z.object({ enabled: z.boolean(), floor: unitSchema, targets: targetSchema }),
  beatFlash: z.object({ enabled: z.boolean(), decay: z.number().min(0.02).max(2), targets: targetSchema }),
  energyToColor: z.object({ enabled: z.boolean(), lowColor: hexColorSchema, highColor: hexColorSchema, targets: targetSchema }),
  energyRiseGo: z.object({ enabled: z.boolean(), cueListId: idSchema.nullable(), ratio: z.number().min(1.1).max(5) }),
  /** Band followers: intensity from the bass band, colour from brightness, movement from onset density. */
  followers: z
    .object({
      intensityFromBass: z.object({ enabled: z.boolean(), amount: unitSchema, targets: targetSchema }),
      colorFromBrightness: z.object({ enabled: z.boolean(), darkColor: hexColorSchema, brightColor: hexColorSchema, targets: targetSchema }),
      moveFromOnsets: z.object({ enabled: z.boolean(), amount: unitSchema, targets: targetSchema }),
    })
    .default({
      intensityFromBass: { enabled: false, amount: 0.7, targets: { fixtureIds: [], groupIds: [] } },
      colorFromBrightness: { enabled: false, darkColor: '#FF3000', brightColor: '#00C8FF', targets: { fixtureIds: [], groupIds: [] } },
      moveFromOnsets: { enabled: false, amount: 0.5, targets: { fixtureIds: [], groupIds: [] } },
    }),
  /** Predicted drop/chorus -> GO on a cue list. Fires only while armed at runtime (never armed on load). */
  dropGo: z
    .object({ enabled: z.boolean(), cueListId: idSchema.nullable(), minConfidence: unitSchema, kinds: z.array(z.enum(['drop', 'chorus'])).min(1) })
    .default({ enabled: false, cueListId: null, minConfidence: 0.8, kinds: ['drop'] }),
});
export type AudioReactions = z.infer<typeof audioReactionsSchema>;
export const DEFAULT_AUDIO_REACTIONS: AudioReactions = {
  bpmFollow: { enabled: false, minConfidence: 0.5 },
  levelToIntensity: { enabled: false, floor: 0.2, targets: emptyTarget },
  beatFlash: { enabled: false, decay: 0.25, targets: emptyTarget },
  energyToColor: { enabled: false, lowColor: '#2244FF', highColor: '#FF2266', targets: emptyTarget },
  energyRiseGo: { enabled: false, cueListId: null, ratio: 1.8 },
  followers: {
    intensityFromBass: { enabled: false, amount: 0.7, targets: emptyTarget },
    colorFromBrightness: { enabled: false, darkColor: '#FF3000', brightColor: '#00C8FF', targets: emptyTarget },
    moveFromOnsets: { enabled: false, amount: 0.5, targets: emptyTarget },
  },
  dropGo: { enabled: false, cueListId: null, minConfidence: 0.8, kinds: ['drop'] },
};
export const audioConfigSchema = z.object({
  sensitivity: z.number().min(0.1).max(10).default(1),
  smoothing: unitSchema.default(0.6),
  /** Onset strength relative to the adaptive threshold needed to count as a beat. */
  onsetThreshold: z.number().min(1).max(5).default(1.5),
  /** Expected tempo range (genre): the live tracker never reports a tempo outside it (octave errors). */
  bpmRange: z.object({ min: z.number().min(40).max(250), max: z.number().min(50).max(300) }).refine((r) => r.max >= r.min * 1.2, 'Plage de tempo trop étroite').default({ min: 70, max: 180 }),
  reactions: audioReactionsSchema.default(DEFAULT_AUDIO_REACTIONS),
});
export type AudioConfig = z.infer<typeof audioConfigSchema>;

/* ------------------------------------------------------------------ */
/* Music: song analysis and Song-to-Show plans                         */
/* ------------------------------------------------------------------ */

export const SECTION_LABELS = ['intro', 'verse', 'prechorus', 'build', 'chorus', 'drop', 'break', 'bridge', 'outro'] as const;
export type SectionLabel = (typeof SECTION_LABELS)[number];
const seconds = z.number().min(0).max(86400);
export const songSectionSchema = z.object({
  start: seconds,
  end: seconds,
  label: z.enum(SECTION_LABELS),
  /** Repetition group: sections with the same cluster sound alike. */
  cluster: z.number().int().min(0).max(300),
  /** Mean loudness relative to the loudest section. */
  energy: unitSchema,
  /** Spectral centroid, normalized to the song range. */
  brightness: unitSchema,
  /** Onsets per second. */
  density: z.number().min(0).max(50),
  /** Share of low-frequency energy. */
  bassShare: unitSchema,
});
export type SongSection = z.infer<typeof songSectionSchema>;
export const songAnalysisSchema = z.object({
  version: z.literal(1),
  duration: seconds,
  bpm: z.number().min(20).max(300),
  tempoStable: z.boolean(),
  beats: z.array(seconds).max(40000),
  downbeats: z.array(seconds).max(10000),
  sections: z.array(songSectionSchema).max(300),
  key: z.object({ tonic: z.number().int().min(0).max(11), mode: z.enum(['major', 'minor']), confidence: unitSchema }),
  events: z.array(z.object({ t: seconds, kind: z.enum(['impact', 'riser', 'silence']), duration: z.number().min(0).max(600) })).max(2000),
});
export type SongAnalysis = z.infer<typeof songAnalysisSchema>;

export const SHOW_MOVEMENTS = ['none', 'slow', 'sweep', 'fast'] as const;
export const SHOW_EFFECTS = ['none', 'wave', 'pulse', 'chase', 'rainbow', 'strobe'] as const;
/** Beam look of the moving heads: open, a gobo, gobo + prism, or frost (soft edge). */
export const SHOW_BEAMS = ['open', 'gobo', 'prism', 'frost'] as const;
export const showSectionPlanSchema = z.object({
  index: z.number().int().min(0).max(300),
  /** 0 = almost dark, 5 = maximum. */
  energy: z.number().int().min(0).max(5),
  palette: z.array(hexColorSchema).min(1).max(4),
  layers: z.object({ wash: z.boolean(), moving: z.boolean(), bars: z.boolean() }),
  movement: z.enum(SHOW_MOVEMENTS),
  effect: z.enum(SHOW_EFFECTS),
  beam: z.enum(SHOW_BEAMS).default('open'),
  /** Effect cycle in beats. */
  effectBeats: z.number().min(0.5).max(16),
  /** Flash on detected impacts inside the section. */
  accents: z.boolean(),
  /** Locked sections are kept when the show is regenerated. */
  locked: z.boolean().default(false),
  note: z.string().max(200).default(''),
});
export type ShowSectionPlan = z.infer<typeof showSectionPlanSchema>;
export const showPlanSchema = z.object({
  intent: z.string().max(500),
  provider: z.enum(['local', 'openrouter']),
  model: z.string().max(150).nullable(),
  variant: z.number().int().min(0).max(1000),
  summary: z.string().max(1000),
  sections: z.array(showSectionPlanSchema).max(300),
});
export type ShowPlan = z.infer<typeof showPlanSchema>;
export const musicTrackSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  /** SHA-256 of the audio file: the analysis cache key (the audio itself is never stored in the project). */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  analysis: songAnalysisSchema,
  plan: showPlanSchema.nullable().default(null),
  /** Objects generated by Song-to-Show for this track (replaced on regeneration). */
  created: z.object({ sceneIds: z.array(idSchema), effectIds: z.array(idSchema), timelineId: idSchema.nullable() }).default({ sceneIds: [], effectIds: [], timelineId: null }),
});
export type MusicTrack = z.infer<typeof musicTrackSchema>;

/* ------------------------------------------------------------------ */
/* Project                                                             */
/* ------------------------------------------------------------------ */

/** Stage layout. `thrust` adds a runway towards the audience; `arena` has the audience all around and no cyclorama. */
export const stageShapeSchema = z.enum(['rect', 'thrust', 'arena']);
export const thrustSchema = z.object({ width: z.number().min(1).max(50), depth: z.number().min(1).max(50) });
/** Named stage point (singer, drummer…), position like fixtures (meters, y upstage) plus the aiming height. */
export const stageMarkerSchema = z.object({
  id: idSchema,
  name: nameSchema,
  x: z.number().min(-100).max(100),
  y: z.number().min(-100).max(100),
  height: z.number().min(0).max(10),
});
export type StageMarker = z.infer<typeof stageMarkerSchema>;
const vec3Schema = z.object({ x: z.number().min(-500).max(500), y: z.number().min(-500).max(500), z: z.number().min(-500).max(500) });
/** Saved 3D camera (world coordinates of the visualizer). */
export const stageViewSchema = z.object({ id: idSchema, name: nameSchema, pos: vec3Schema, target: vec3Schema });
/**
 * Explicit truss. Position = centre (meters, y upstage), `height` = height of the truss axis, `length` = length of a
 * straight truss, diameter of a circle, side of a square, or arm length of a corner / tee / cross junction (measured
 * from the junction node). A totem is a vertical tower from the floor up to `height` (`length` unused). Rotation in
 * degrees around the vertical (counter-clockwise seen from above, 0 = parallel to the stage lip). Supported by towers
 * on the floor, hung from motors, or `none` when it rests on other pieces (totems, junctions).
 */
export const trussShapeSchema = z.enum(['line', 'circle', 'square', 'corner', 'tee', 'cross', 'totem']);
export const trussSchema = z.object({
  id: idSchema,
  name: nameSchema,
  shape: trussShapeSchema,
  x: z.number().min(-100).max(100),
  y: z.number().min(-100).max(100),
  height: z.number().min(0.5).max(30),
  length: z.number().min(0.5).max(60),
  rotation: z.number().min(-360).max(360),
  support: z.enum(['towers', 'hung', 'none']),
});
export type Truss = z.infer<typeof trussSchema>;
/** Performer or instrument silhouette (meters, y upstage, rotation like fixtures: 0 = facing the audience). */
export const performerSchema = z.object({
  id: idSchema,
  name: nameSchema,
  kind: z.enum(['standing', 'seated', 'drums', 'keys', 'lectern']),
  x: z.number().min(-100).max(100),
  y: z.number().min(-100).max(100),
  rotation: z.number().min(-360).max(360),
  /** Stage point the performer stands on: the silhouette follows it. */
  markerId: idSchema.nullable().optional(),
});
export type Performer = z.infer<typeof performerSchema>;
/**
 * LED screen / video surface: centre x, y (meters, y upstage), bottom edge `elevation`, size, rotation (0 = facing
 * the audience). Image stored as a small data URL; videos are chosen per session and never saved in the project.
 */
export const screenSchema = z.object({
  id: idSchema,
  name: nameSchema,
  x: z.number().min(-100).max(100),
  y: z.number().min(-100).max(100),
  elevation: z.number().min(0).max(30),
  width: z.number().min(0.2).max(60),
  height: z.number().min(0.2).max(30),
  rotation: z.number().min(-360).max(360),
  source: z.enum(['color', 'image', 'video', 'pixels']),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  image: z.string().max(1_500_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/).nullable().optional(),
  /** Light spill on the surroundings, 0..1. */
  glow: z.number().min(0).max(1),
});
export type StageScreen = z.infer<typeof screenSchema>;
export type StageView = z.infer<typeof stageViewSchema>;
/**
 * Set piece from the library (riser, stairs, speaker, stage monitor, mic stand, table, drape, box, column): centre
 * x, y (meters, y upstage), footprint width × depth, height, raised by `elevation` (stacking), rotation like trusses.
 */
export const propSchema = z.object({
  id: idSchema,
  name: nameSchema,
  kind: z.enum(['riser', 'stairs', 'speaker', 'monitor', 'mic', 'table', 'drape', 'box', 'column']),
  x: z.number().min(-100).max(100),
  y: z.number().min(-100).max(100),
  width: z.number().min(0.05).max(40),
  depth: z.number().min(0.05).max(40),
  height: z.number().min(0.05).max(20),
  elevation: z.number().min(0).max(20),
  rotation: z.number().min(-360).max(360),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
export type StageProp = z.infer<typeof propSchema>;

export const PROJECT_FORMAT_VERSION = 3;

export const projectSchema = z.object({
  format: z.literal('luma-ai-dmx-project'),
  version: z.literal(PROJECT_FORMAT_VERSION),
  id: idSchema,
  meta: z.object({
    name: nameSchema,
    show: z.string().trim().max(80).default(''),
    createdAt: z.string(),
    modifiedAt: z.string(),
    notes: z.string().max(5000).default(''),
  }),
  show: z.object({ bpm: z.number().min(20).max(300).default(120), universes: z.number().int().min(1).max(MAX_UNIVERSES).default(1) }),
  /** Custom / imported profiles. Built-in profiles are referenced by id and not embedded. */
  profiles: z.array(profileSchema).default([]),
  patch: z.array(fixtureSchema).default([]),
  groups: z.array(groupSchema).default([]),
  palettes: z.array(paletteSchema).default([]),
  scenes: z.array(sceneSchema).default([]),
  cueLists: z.array(cueListSchema).default([]),
  effects: z.array(effectSchema).default([]),
  timelines: z.array(timelineSchema).default([]),
  audio: audioConfigSchema.default({ sensitivity: 1, smoothing: 0.6, onsetThreshold: 1.5, bpmRange: { min: 70, max: 180 }, reactions: DEFAULT_AUDIO_REACTIONS }),
  music: z.object({ tracks: z.array(musicTrackSchema).max(100).default([]) }).default({ tracks: [] }),
  visualizer: z
    .object({
      stageWidth: z.number().min(2).max(200).default(12),
      stageDepth: z.number().min(2).max(200).default(8),
      shape: stageShapeSchema.default('rect'),
      thrust: thrustSchema.default({ width: 3, depth: 4 }),
      cyclo: z.boolean().default(true),
      markers: z.array(stageMarkerSchema).max(64).default([]),
      views: z.array(stageViewSchema).max(20).default([]),
      trusses: z.array(trussSchema).max(64).default([]),
      performers: z.array(performerSchema).max(64).default([]),
      screens: z.array(screenSchema).max(16).default([]),
      props: z.array(propSchema).max(256).default([]),
    })
    .default({ stageWidth: 12, stageDepth: 8, shape: 'rect', thrust: { width: 3, depth: 4 }, cyclo: true, markers: [], views: [], trusses: [], performers: [], screens: [], props: [] }),
  ai: z
    .object({ notes: z.string().max(2000).default(''), recentPrompts: z.array(z.string().max(500)).max(20).default([]) })
    .default({ notes: '', recentPrompts: [] }),
});
export type Project = z.infer<typeof projectSchema>;
export type ProjectInput = z.input<typeof projectSchema>;
