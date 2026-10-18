import { randomUUID } from 'node:crypto';
import { PROJECT_FORMAT_VERSION, projectSchema, type Project } from '../model/schemas';

export class ProjectLoadError extends Error {
  constructor(message: string, readonly kind: 'corrupt-json' | 'invalid-format' | 'unsupported-version' | 'io', readonly details: string[] = []) {
    super(message);
  }
}

export function createProject(name: string, now = new Date()): Project {
  return projectSchema.parse({
    format: 'luma-ai-dmx-project',
    version: PROJECT_FORMAT_VERSION,
    id: randomUUID(),
    meta: { name, show: '', createdAt: now.toISOString(), modifiedAt: now.toISOString(), notes: '' },
    show: { bpm: 120, universes: 1 },
    cueLists: [{ id: randomUUID(), name: 'Liste principale', priority: 50, loop: false, cues: [] }],
  });
}

type Json = Record<string, unknown>;

/**
 * Format history:
 *  v1 – first internal development format: patch stored under `fixtures`, no `audio`/`visualizer` sections.
 *  v2 – `patch` key, audio-reactive and visualizer settings.
 *  v3 – current: `music` (analysed tracks, Song-to-Show plans). Older apps refuse v3 files instead of silently
 *       dropping the section.
 * Each migration takes the previous version's JSON and returns the next version's JSON.
 */
const MIGRATIONS: Record<number, (p: Json) => Json> = {
  1: (p) => {
    const { fixtures, ...rest } = p;
    return { ...rest, patch: Array.isArray(fixtures) ? fixtures : [], version: 2 };
  },
  2: (p) => ({ ...p, music: { tracks: [] }, version: 3 }),
};

export function migrateProject(raw: unknown): { data: unknown; migratedFrom: number | null } {
  if (!raw || typeof raw !== 'object') throw new ProjectLoadError('Le fichier ne contient pas un objet projet', 'invalid-format');
  let p = raw as Json;
  if (p.format !== 'luma-ai-dmx-project') throw new ProjectLoadError('Ce fichier n’est pas un projet Luma AI DMX', 'invalid-format');
  const start = typeof p.version === 'number' ? p.version : NaN;
  if (!Number.isInteger(start)) throw new ProjectLoadError('Version de format absente', 'invalid-format');
  if (start > PROJECT_FORMAT_VERSION) throw new ProjectLoadError(`Format v${start} créé par une version plus récente du logiciel (supporté : v${PROJECT_FORMAT_VERSION})`, 'unsupported-version');
  let v = start;
  while (v < PROJECT_FORMAT_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) throw new ProjectLoadError(`Aucune migration depuis la version ${v}`, 'unsupported-version');
    p = m(p);
    v = p.version as number;
  }
  return { data: p, migratedFrom: start === PROJECT_FORMAT_VERSION ? null : start };
}

export function parseProject(text: string): { project: Project; migratedFrom: number | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ProjectLoadError(`Fichier corrompu (JSON illisible) : ${err instanceof Error ? err.message : String(err)}`, 'corrupt-json');
  }
  const { data, migratedFrom } = migrateProject(raw);
  const parsed = projectSchema.safeParse(data);
  if (!parsed.success) {
    throw new ProjectLoadError('Le projet contient des données invalides', 'invalid-format', parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return { project: parsed.data, migratedFrom };
}

export function serializeProject(p: Project): string {
  return JSON.stringify(p, null, 2);
}
