import { AudioAnalyzer, simulateFrames, type AudioFrame } from '../../src/core/audio/analyzer';
import { TempoTracker } from '../../src/core/music/tempoTracker';
import { predictFromTrack } from '../../src/core/music/dropPredictor';
import { AudioReactive } from '../../src/core/audio/reactive';
import { ProjectIndex } from '../../src/core/engine/resolve';
import { audioConfigSchema, effectParamsSchema } from '../../src/core/model/schemas';
import { makeEngine } from '../helpers';

const opts = { sensitivity: 1, smoothing: 0.6, onsetThreshold: 1.5, riseRatio: 1.8 };

function run(frames: AudioFrame[], range?: { min: number; max: number }) {
  const a = new AudioAnalyzer({ ...opts, bpmRange: range });
  return frames.map((f) => a.push(f));
}

const mod = (x: number, m: number) => ((x % m) + m) % m;

describe('suivi de tempo live', () => {
  it('verrouille 124 BPM en moins de 4 s', () => {
    const out = run(simulateFrames({ bpm: 124, seconds: 8, hats: true }));
    // Locked (flag raised, within ± 1.5 BPM) before 4.1 s; refined to ± 0.5 BPM with more history.
    const at4 = out.filter((f) => f.t <= 4.1).at(-1)!;
    expect(at4.tempoLocked).toBe(true);
    expect(Math.abs(at4.bpm! - 124)).toBeLessThan(1.5);
    expect(Math.abs(out.at(-1)!.bpm! - 124)).toBeLessThan(0.5);
    expect(out.at(-1)!.tempoLocked).toBe(true);
  });

  it('moins de 5 % d’erreurs d’octave de 80 à 170 BPM (charleston sur les croches)', () => {
    const tempos = Array.from({ length: 19 }, (_, i) => 80 + i * 5);
    const wrong = tempos.filter((bpm) => Math.abs(run(simulateFrames({ bpm, seconds: 10, hats: true, seed: bpm })).at(-1)!.bpm! - bpm) > 2);
    expect(wrong.length / tempos.length).toBeLessThanOrEqual(0.05);
  });

  it('respecte la plage de tempo du genre', () => {
    const got = run(simulateFrames({ bpm: 87, seconds: 10, hats: true }), { min: 70, max: 110 }).at(-1)!.bpm!;
    expect(Math.abs(got - 87)).toBeLessThan(1);
    // A range that excludes the real tempo: either nothing or a tempo inside the range, never outside.
    const fast = run(simulateFrames({ bpm: 87, seconds: 10, hats: true }), { min: 140, max: 200 }).at(-1)!.bpm;
    expect(fast === null || (fast >= 140 && fast <= 200)).toBe(true);
  });

  it('un tap sur le 1 recale la phase et le premier temps', () => {
    const beat = 60 / 120;
    const tr = new TempoTracker();
    // Accents on the off-beats: the tracker locks there.
    for (const f of simulateFrames({ bpm: 120, seconds: 8, offbeatAccent: true })) tr.push(f.t, f.bass);
    const before = tr.push(8, 0).nextBeatAt!;
    expect(Math.abs(mod(before, beat) / beat - 0.5)).toBeLessThan(0.12);
    tr.tap(8.0); // true downbeat at t = 8.0
    let s = tr.push(8.01, 0);
    const ph = mod(s.nextBeatAt!, beat);
    expect(Math.min(ph, beat - ph)).toBeLessThan(0.03);
    // Four beats later we are back on "1".
    for (let t = 8.02; t < 10.05; t += 1 / 60) s = tr.push(t, 0);
    expect(s.barPosition).toBe(0);
  });

  it('premiers temps : accents de basse sur le 1', () => {
    const beat = 60 / 120;
    const tr = new TempoTracker();
    const downs: number[] = [];
    for (let i = 0; i < 60 * 16; i++) {
      const t = i / 60;
      const k = Math.floor(t / beat), since = t - k * beat;
      const accent = since < 1 / 60 ? (k % 4 === 0 ? 3 : 1) : 0;
      const s = tr.push(t, accent, accent);
      if (s.beat && s.barPosition === 0 && t > 8) downs.push(t);
    }
    expect(downs.length).toBeGreaterThan(2);
    for (const t of downs) expect(Math.min(mod(t, 4 * beat), 4 * beat - mod(t, 4 * beat))).toBeLessThan(0.08);
  });
});

/** Groove 32 beats → breakdown 16 beats (no bass, riser over the last 8) → drop at beat 48. */
function edmFrames(bpm = 128) {
  const beat = 60 / bpm;
  const frames: AudioFrame[] = [];
  let seed = 3;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 0.02;
  for (let i = 0; i < 64 * beat * 60; i++) {
    const t = i / 60, b = t / beat;
    const kick = Math.exp(-(t % beat) * 18);
    const inBreak = b >= 32 && b < 48;
    const riser = inBreak && b >= 40 ? (b - 40) / 8 : 0;
    frames.push({
      t,
      rms: (inBreak ? 0.15 + 0.3 * riser : 0.5) * (0.4 + 0.6 * (inBreak ? 0.5 : kick)) + rnd(),
      // The high band keeps a beat pulse in the breakdown so the tempo stays tracked without the kick.
      bass: inBreak ? 0.02 + rnd() : 0.9 * kick + 0.1 + rnd(),
      high: (inBreak ? 0.1 + 0.7 * riser : 0.3) * (0.5 + 0.5 * kick) + rnd(),
    });
  }
  return { frames, beat, dropAt: 48 * beat };
}

describe('prédiction de drop', () => {
  it('annonce le drop (> 0,8) dans les 8 temps qui précèdent, à ± 1 temps, sans fausse alerte avant', () => {
    const { frames, beat, dropAt } = edmFrames();
    const out = run(frames);
    const groove = out.filter((f) => f.t > 4 && f.t < 30 * beat);
    expect(Math.max(0, ...groove.map((f) => f.prediction?.confidence ?? 0))).toBeLessThan(0.5);
    const window = out.filter((f) => f.t > dropAt - 8 * beat && f.t < dropAt - beat);
    const confident = window.filter((f) => f.prediction && f.prediction.kind === 'drop' && f.prediction.confidence > 0.8);
    expect(confident.length / window.length).toBeGreaterThan(0.5);
    for (const f of confident) expect(Math.abs(f.prediction!.at - dropAt)).toBeLessThan(beat);
  });

  it('morceau connu : prédiction exacte depuis l’analyse', () => {
    const p = predictFromTrack([{ start: 0, label: 'intro' }, { start: 30, label: 'drop' }], 26, 120);
    expect(p).toMatchObject({ kind: 'drop', confidence: 1, at: 30, source: 'track' });
    expect(p!.inBeats).toBeCloseTo(8);
    expect(predictFromTrack([{ start: 30, label: 'drop' }], 10, 120)).toBeNull(); // beyond the 16-beat horizon
  });

  it('GO armé : un seul déclenchement à l’heure prédite, rien sans armement', () => {
    const { engine, project } = makeEngine();
    project.cueLists = [{ id: 'L', name: 'L', priority: 50, loop: false, cues: [] }];
    const index = new ProjectIndex(project);
    engine.setIndex(index);
    let now = 1000;
    const cfg = audioConfigSchema.parse({});
    cfg.reactions.dropGo = { enabled: true, cueListId: 'L', minConfidence: 0.8, kinds: ['drop'] };
    const r = new AudioReactive(engine, () => index, () => cfg, () => 55, () => now);
    const gos: string[] = [];
    engine.cueGo = (id: string) => { gos.push(id); return true; };
    const feat = (t: number, at: number | null) => ({
      t, level: 0.5, levelDb: -6, energy: 0.5, onset: false, onsetStrength: 0, bpm: 128, bpmConfidence: 0.9, energyRise: false,
      beat: false, barPosition: null, tempoLocked: true, bass: 0, brightness: 0, onsetDensity: 0,
      prediction: at === null ? null : { kind: 'drop' as const, confidence: 0.9, at, inBeats: 4, source: 'live' as const },
    });
    r.push(feat(10, 12), 'live');
    now += 2500; engine.tick(25);
    expect(gos).toEqual([]); // not armed
    r.armDrop(true);
    now = 5000; r.push(feat(20, 22), 'live');
    now = 6900; engine.tick(25);
    expect(gos).toEqual([]);
    now = 7001; engine.tick(25);
    expect(gos).toEqual(['L']);
    expect(r.status().dropArmed).toBe(false);
    now = 8000; r.push(feat(23, 24), 'live');
    now = 9500; engine.tick(25);
    expect(gos).toEqual(['L']); // one shot
  });

  it('effets calés sur la mesure : le cycle repart sur le premier temps', () => {
    const { engine, project } = makeEngine();
    project.effects = [{ id: 'e', name: 'e', type: 'pulse', targets: { fixtureIds: ['par1'], groupIds: [] }, params: effectParamsSchema.parse({ bpmSync: true, beatsPerCycle: 4, barSync: true }), priority: 50, blend: 'override', duration: null, trigger: 'manual', origin: 'user' }];
    engine.setIndex(new ProjectIndex(project));
    engine.startEffect('e');
    const phase = () => (engine as unknown as { effects: Map<string, { phase: number }> }).effects.values().next().value!.phase;
    for (let i = 0; i < 37; i++) engine.tick(25); // 0.925 s at 120 BPM: phase ≈ 0.46
    engine.onDownbeat();
    expect(phase()).toBe(0);
    for (let i = 0; i < 25; i++) engine.tick(25); // + 0.31 cycle
    engine.onDownbeat();
    expect(phase()).toBe(0);
    for (let i = 0; i < 60; i++) engine.tick(25); // + 0.75 cycle
    engine.onDownbeat();
    expect(phase()).toBe(1);
  });
});
