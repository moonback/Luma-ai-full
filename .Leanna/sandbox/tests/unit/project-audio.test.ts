import { createProject, migrateProject, parseProject, ProjectLoadError, serializeProject } from '../../src/core/project/format';
import { AudioAnalyzer, simulateFrames } from '../../src/core/audio/analyzer';
import { demoProject } from '../helpers';

describe('format de projet', () => {
  it('sérialise et relit un projet à l’identique', () => {
    const p = demoProject();
    const { project, migratedFrom } = parseProject(serializeProject(p));
    expect(project).toEqual(p);
    expect(migratedFrom).toBeNull();
  });

  it('migre un projet v1 (clé fixtures) vers v2', () => {
    const v2 = demoProject();
    const { patch, audio: _a, visualizer: _v, ...rest } = v2;
    const v1 = { ...rest, version: 1, fixtures: patch };
    const { project, migratedFrom } = parseProject(JSON.stringify(v1));
    expect(migratedFrom).toBe(1);
    expect(project.patch).toHaveLength(5);
    expect(project.visualizer.stageWidth).toBe(12);
  });

  it('signale fichier corrompu, mauvais format, version future et données invalides', () => {
    const kind = (text: string) => { try { parseProject(text); return 'ok'; } catch (e) { return (e as ProjectLoadError).kind; } };
    expect(kind('{ "format": "luma')).toBe('corrupt-json');
    expect(kind('{"format":"autre"}')).toBe('invalid-format');
    expect(kind(JSON.stringify({ ...createProject('x'), version: 99 }))).toBe('unsupported-version');
    const bad = createProject('x');
    (bad.patch as unknown[]).push({ id: 'f', name: 'F', profileId: 'demo-par-rgb', mode: '3ch RGB', universe: 1, address: 900 });
    expect(kind(JSON.stringify(bad))).toBe('invalid-format');
    expect(() => migrateProject(null)).toThrow(ProjectLoadError);
  });

  it('ne contient jamais de clé API', () => {
    expect(serializeProject(createProject('x'))).not.toMatch(/api.?key|sk-ant/i);
  });
});

describe('analyse audio', () => {
  it('estime le BPM d’une piste simulée à 128 BPM (± 2)', () => {
    const a = new AudioAnalyzer({ sensitivity: 1, smoothing: 0.6, onsetThreshold: 1.5, riseRatio: 1.8 });
    let last;
    let onsets = 0;
    for (const f of simulateFrames({ bpm: 128, seconds: 10 })) {
      last = a.push(f);
      if (last.onset) onsets++;
    }
    expect(Math.abs(last!.bpm! - 128)).toBeLessThanOrEqual(2);
    expect(last!.bpmConfidence).toBeGreaterThan(0.3);
    expect(onsets).toBeGreaterThan(18); // ~21 beats in 10 s
    expect(onsets).toBeLessThan(25);
  });

  it('n’annonce pas de tempo sans assez d’attaques et détecte une montée d’énergie', () => {
    const a = new AudioAnalyzer({ sensitivity: 1, smoothing: 0.6, onsetThreshold: 1.5, riseRatio: 1.8 });
    let rises = 0;
    expect(a.push({ t: 0, rms: 0.1, bass: 0.1 }).bpm).toBeNull(); // no tempo without enough signal
    for (const f of simulateFrames({ bpm: 120, seconds: 10, level: 0.1 })) if (a.push(f).energyRise) rises++;
    for (const f of simulateFrames({ bpm: 120, seconds: 3, level: 0.9 })) if (a.push({ ...f, t: f.t + 10 }).energyRise) rises++;
    expect(rises).toBe(1);
  });
});
