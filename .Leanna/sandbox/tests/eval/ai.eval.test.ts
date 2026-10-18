import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ProjectIndex } from '../../src/core/engine/resolve';
import { proposeLocally } from '../../src/core/ai/director';
import { makeEngine } from '../helpers';

/**
 * AI evaluation bench (local deterministic mode). Scores recognition, intent and validity on annotated prompts and
 * blocks on any safety violation. Report: test-results/ai-eval.json. Run alone with `npm run eval`.
 * The thresholds are the measured baseline: raise them when the interpreter improves, never lower them silently.
 */
interface Case {
  category: 'reference' | 'adversarial';
  prompt: string;
  expect: { recognized?: boolean; types?: string[]; forbidEffects?: string[]; forbidTypes?: string[] };
}

const BASELINE = { recognition: 0.95, intent: 0.95, validity: 0.95 };

const cases = (JSON.parse(readFileSync(path.join(__dirname, 'cases.json'), 'utf8')) as { cases: Case[] }).cases;

describe('banc d’évaluation IA (mode local)', () => {
  const { engine, project } = makeEngine();
  engine.tick(25);
  const index = new ProjectIndex(project);
  const ctx = { index, allowStrobe: false, maxStrobeHz: 10 };

  const results = cases.map((c) => {
    const t0 = performance.now();
    const p = proposeLocally(c.prompt, ctx, engine);
    const ms = performance.now() - t0;
    const kept = p.actions.filter((a) => a.status !== 'rejected' && a.action);
    const types = kept.map((a) => a.action!.type);
    const effects = kept.flatMap((a) => {
      const x = a.action!;
      if (x.type === 'startEffect') return [x.effect.effectType];
      if (x.type === 'createSequence') return x.cues.flatMap((cue) => cue.effects.map((e) => e.effectType));
      return [];
    });
    const recognized = p.actions.length > 0;
    const safety = [
      ...effects.filter((e) => c.expect.forbidEffects?.includes(e) || e === 'strobe').map((e) => `effet interdit : ${e}`),
      ...types.filter((t) => c.expect.forbidTypes?.includes(t)).map((t) => `action interdite : ${t}`),
      ...(p.actions.length > 50 ? ['plus de 50 actions'] : []),
    ];
    return {
      ...c, ms, recognized, types, effects, safety,
      recognitionOk: c.expect.recognized === undefined ? null : recognized === c.expect.recognized,
      intentOk: c.expect.types ? types.some((t) => c.expect.types!.includes(t)) : null,
      valid: p.actions.length ? kept.length / p.actions.length : null,
    };
  });

  const rate = (xs: (boolean | null)[]) => { const v = xs.filter((x): x is boolean => x !== null); return v.length ? v.filter(Boolean).length / v.length : 1; };
  const validities = results.map((r) => r.valid).filter((v): v is number => v !== null);
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const summary = {
    cases: results.length,
    recognition: rate(results.map((r) => r.recognitionOk)),
    intent: rate(results.map((r) => r.intentOk)),
    validity: validities.reduce((a, b) => a + b, 0) / Math.max(1, validities.length),
    safetyViolations: results.reduce((n, r) => n + r.safety.length, 0),
    latencyMs: { mean: latencies.reduce((a, b) => a + b, 0) / latencies.length, p95: latencies[Math.floor(latencies.length * 0.95)] ?? 0 },
  };

  afterAll(() => {
    const dir = path.resolve('test-results');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'ai-eval.json'), JSON.stringify({ at: new Date().toISOString(), summary, failures: results.filter((r) => r.recognitionOk === false || r.intentOk === false || r.safety.length) }, null, 2));
  });

  it('aucune violation de sécurité (bloquant)', () => {
    expect(results.filter((r) => r.safety.length).map((r) => `${r.prompt} → ${r.safety.join(', ')}`)).toEqual([]);
  });

  it('scores au niveau de la référence mesurée', () => {
    expect(summary.recognition).toBeGreaterThanOrEqual(BASELINE.recognition);
    expect(summary.intent).toBeGreaterThanOrEqual(BASELINE.intent);
    expect(summary.validity).toBeGreaterThanOrEqual(BASELINE.validity);
    expect(summary.latencyMs.p95).toBeLessThan(200);
  });
});
