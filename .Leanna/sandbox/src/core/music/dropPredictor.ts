/**
 * Live drop / chorus prediction, evaluated once per tracked beat from beat-synchronous levels:
 *  - breakdown: bass over the last 4 beats far below the 16 beats before (EDM drops come back from a bass cut);
 *  - riser: high band rising over the last 8 beats;
 *  - build: overall level rising over the last 8 beats;
 *  - phrase: the event is expected on the next 16-beat (4-bar) boundary counted from the start of the breakdown/build.
 * The scores are combined by a hand-weighted logistic function (no trained model: no annotated corpus yet).
 * The prediction is an estimate; nothing fires on it unless a reaction is explicitly armed.
 */
export interface Prediction {
  kind: 'drop' | 'chorus';
  confidence: number;
  /** Predicted time (same clock as the frames). */
  at: number;
  /** Beats remaining until `at`. */
  inBeats: number;
  source: 'live' | 'track';
}

interface BeatSample { t: number; bass: number; high: number; level: number }

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const logistic = (x: number) => 1 / (1 + Math.exp(-x));

function slope(ys: number[]): number {
  const n = ys.length;
  const mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  ys.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) ** 2; });
  return den ? num / den : 0;
}

export class DropPredictor {
  private readonly beats: BeatSample[] = [];
  private phraseStart: number | null = null; // beat index where the current breakdown/build started
  private beatCount = 0;
  private current: Prediction | null = null;
  private period = 0.5;
  /** Bass level of the groove (updated only while the bass is present). */
  private grooveBass = 0;
  private cooldown = 0;

  /** Called on every tracked beat. */
  onBeat(s: BeatSample, period: number): void {
    this.period = period;
    this.beats.push(s);
    this.beatCount++;
    if (this.beats.length > 64) this.beats.shift();
    const b = this.beats;
    if (b.length < 24) { this.current = null; return; }
    const avg = (xs: BeatSample[], k: keyof BeatSample) => xs.reduce((a, x) => a + x[k], 0) / Math.max(1, xs.length);
    const recentBass = avg(b.slice(-2), 'bass');
    if (this.grooveBass === 0) this.grooveBass = avg(b.slice(-16), 'bass');
    else if (recentBass > 0.6 * this.grooveBass) this.grooveBass += (recentBass - this.grooveBass) * 0.1;
    const breakdown = this.grooveBass > 0.03 ? clamp01((0.5 - recentBass / this.grooveBass) / 0.4) : 0;
    // The bass is back after a breakdown: the event happened. Clear and hold off for two bars.
    if (this.phraseStart !== null && recentBass > 0.6 * this.grooveBass && this.beatCount - this.phraseStart > 4) {
      this.phraseStart = null;
      this.current = null;
      this.cooldown = 8;
      return;
    }
    if (this.cooldown > 0) { this.cooldown--; this.current = null; return; }
    const last8 = b.slice(-8);
    const highMean = avg(last8, 'high') || 1e-3;
    const riser = clamp01((slope(last8.map((x) => x.high)) / highMean) * 8);
    const build = clamp01((slope(last8.map((x) => x.level)) / (avg(last8, 'level') || 1e-3)) * 8);
    const active = breakdown > 0.5 || riser > 0.5;
    if (active) this.phraseStart ??= this.beatCount - 2; // the bass window spans the last 2 beats
    else if (breakdown < 0.2 && riser < 0.2) this.phraseStart = null;
    if (this.phraseStart === null) { this.current = null; return; }
    const since = this.beatCount - this.phraseStart;
    const inBeats = 16 - (since % 16) || 16;
    const confidence = logistic(-3.2 + 2.6 * breakdown + 2.4 * riser + 1.2 * build + (inBeats <= 8 ? 1 : 0));
    this.current = confidence < 0.3 ? null : { kind: breakdown > 0.5 ? 'drop' : 'chorus', confidence, at: s.t + inBeats * period, inBeats, source: 'live' };
  }

  /** Prediction at time `t` (beats remaining updated between beats); null once the predicted time has passed. */
  at(t: number): Prediction | null {
    const c = this.current;
    if (!c || t > c.at + this.period / 2) return null;
    return { ...c, inBeats: Math.max(0, (c.at - t) / this.period) };
  }
}

/**
 * Known track (played by the app's own player): the next drop/chorus is read from the analysis, so the prediction is
 * exact (confidence 1) as long as the playback position is right.
 */
export function predictFromTrack(sections: readonly { start: number; label: string }[], position: number, bpm: number, horizonBeats = 16): Prediction | null {
  const period = 60 / bpm;
  const next = sections.find((s) => s.start > position && (s.label === 'drop' || s.label === 'chorus'));
  if (!next) return null;
  const inBeats = (next.start - position) / period;
  if (inBeats > horizonBeats) return null;
  return { kind: next.label === 'drop' ? 'drop' : 'chorus', confidence: 1, at: next.start, inBeats, source: 'track' };
}
