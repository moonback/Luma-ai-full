import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppService } from '../src/core/app/AppService';
import { ProjectIndex } from '../src/core/engine/resolve';
import { Engine, type EngineSettings } from '../src/core/engine/Engine';
import { createProject } from '../src/core/project/format';
import type { Project } from '../src/core/model/schemas';

export const ENGINE_SETTINGS: EngineSettings = { rateHz: 40, blackoutPolicy: 'intensity-shutter', maxStrobeHz: 10, priorities: { ai: 60, timeline: 40, audio: 55 } };

export function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'luma-test-'));
}

export function makeService(dataDir = tempDir(), files: Record<string, string | null> = {}) {
  const secrets = new Map<string, string>();
  const svc = new AppService({
    dataDir,
    autoStart: false,
    dialogs: {
      openProject: async () => files.open ?? null,
      saveProject: async () => files.save ?? null,
      openProfile: async () => files.profile ?? null,
    },
    secrets: { get: (k) => secrets.get(k) ?? null, set: (k, v) => { if (v) secrets.set(k, v); else secrets.delete(k); } },
  });
  return { svc, dataDir, secrets };
}

/** Project with: 2 RGB PARs (u1 @1, @4), 1 RGBW PAR (u1 @10), 2 spots (u1 @20, @40). */
export function demoProject(): Project {
  const p = createProject('Test');
  p.patch = [
    { id: 'par1', name: 'PAR 1', profileId: 'demo-par-rgb', mode: '3ch RGB', universe: 1, address: 1, tags: [], position: { x: -2, y: 1 }, rotation: 0, height: 4, notes: '' },
    { id: 'par2', name: 'PAR 2', profileId: 'demo-par-rgb', mode: '3ch RGB', universe: 1, address: 4, tags: [], position: { x: 2, y: 1 }, rotation: 0, height: 4, notes: '' },
    { id: 'rgbw', name: 'PAR W', profileId: 'demo-par-rgbw', mode: '6ch DRGBW+Strobe', universe: 1, address: 10, tags: [], position: { x: 0, y: 1 }, rotation: 0, height: 4, notes: '' },
    { id: 'spot1', name: 'Spot 1', profileId: 'demo-spot', mode: '13ch étendu', universe: 1, address: 20, tags: [], position: { x: -3, y: 5 }, rotation: 0, height: 4, notes: '' },
    { id: 'spot2', name: 'Spot 2', profileId: 'demo-spot', mode: '13ch étendu', universe: 1, address: 40, tags: [], position: { x: 3, y: 5 }, rotation: 0, height: 4, notes: '' },
  ];
  p.groups = [{ id: 'g-pars', name: 'Pars', color: '#22D3EE', fixtureIds: ['par1', 'par2', 'rgbw'] }];
  return p;
}

export function makeEngine(project: Project = demoProject()) {
  const frames: Map<number, Uint8Array>[] = [];
  const engine = new Engine(new ProjectIndex(project), { sendFrames: (f) => { frames.push(new Map([...f].map(([k, v]) => [k, v.slice()]))); } }, ENGINE_SETTINGS);
  return { engine, frames, project };
}

/** Ticks the engine `ms` milliseconds in 25 ms steps. */
export function run(engine: Engine, ms: number, step = 25): void {
  for (let t = 0; t < ms; t += step) engine.tick(step);
}

export const u1 = (engine: Engine) => engine.universes.get(1)!;
