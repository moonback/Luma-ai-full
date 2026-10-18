/**
 * Deterministic synthetic songs with known ground truth (tempo, downbeats, sections) for the music analysis tests.
 * Instruments: kick on every beat, snare on 2 and 4, hats on eighths, bass on beats 1 and 3, chords changing every bar
 * (the bar's first beat carries the harmonic change), noise riser before high-energy sections.
 */
export interface SynthSection {
  label: string;
  bars: number;
  kick: boolean;
  snare: boolean;
  hats: boolean;
  bass: boolean;
  /** Chord progression (MIDI roots, one per bar, cycled). */
  chords: number[];
  /** 0..1 chord level; `bright` adds upper harmonics. */
  pad: number;
  bright: boolean;
  /** Bars of noise riser at the end of the section. */
  riser?: number;
  gain?: number;
}

export function synthSong(opts: { bpm: number; sections: SynthSection[]; sr?: number; seed?: number }) {
  const sr = opts.sr ?? 22050;
  const beat = 60 / opts.bpm;
  const bar = 4 * beat;
  const totalBars = opts.sections.reduce((s, x) => s + x.bars, 0);
  const n = Math.ceil(totalBars * bar * sr) + sr;
  const out = new Float32Array(n);
  let seed = opts.seed ?? 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const add = (t0: number, len: number, fn: (t: number) => number) => {
    const a = Math.max(0, Math.round(t0 * sr)), b = Math.min(n, Math.round((t0 + len) * sr));
    for (let i = a; i < b; i++) out[i] = out[i]! + fn((i - a) / sr);
  };
  const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);
  const boundaries: { label: string; start: number }[] = [];
  let barIndex = 0;
  for (const s of opts.sections) {
    const g = s.gain ?? 1;
    boundaries.push({ label: s.label, start: barIndex * bar });
    for (let b = 0; b < s.bars; b++, barIndex++) {
      const t0 = barIndex * bar;
      const root = s.chords[b % s.chords.length]!;
      if (s.pad > 0) {
        const notes = [root, root + 4, root + 7];
        add(t0, bar, (t) => {
          let v = 0;
          for (const m of notes) {
            const f = hz(m);
            v += Math.sin(2 * Math.PI * f * t);
            if (s.bright) v += 0.5 * Math.sin(4 * Math.PI * f * t) + 0.35 * Math.sin(6 * Math.PI * f * t) + 0.25 * Math.sin(8 * Math.PI * f * t);
          }
          return g * s.pad * 0.06 * v * Math.min(1, t * 20);
        });
      }
      for (let k = 0; k < 4; k++) {
        const tb = t0 + k * beat;
        if (s.kick) add(tb, 0.25, (t) => g * 0.8 * Math.exp(-t * 18) * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-t * 30)) * t));
        if (s.snare && k % 2 === 1) add(tb, 0.18, (t) => g * 0.35 * Math.exp(-t * 25) * rnd());
        if (s.bass && k % 2 === 0) add(tb, beat * 0.9, (t) => g * (k === 0 ? 0.5 : 0.3) * Math.exp(-t * 3) * Math.sin(2 * Math.PI * hz(root - 24) * t));
        if (s.hats) for (const h of [0, 0.5]) add(tb + h * beat, 0.05, (t) => g * 0.12 * Math.exp(-t * 80) * (rnd() - 0.8 * Math.sin(2 * Math.PI * 9000 * t)));
      }
      if (s.riser && b >= s.bars - s.riser) {
        const start = s.bars - s.riser;
        add(t0, bar, (t) => (g * 0.25 * ((b - start) * bar + t)) / (s.riser! * bar) * rnd());
      }
    }
  }
  return { samples: out, sr, beat, bar, boundaries, duration: totalBars * bar };
}

const AM = [57, 53, 48, 55]; // A F C G
const CH = [48, 55, 57, 53]; // C G A F

/** Pop/EDM-like structure: intro 8, verse 8, chorus 8, break 4 (+ riser), chorus 8, outro 4 bars. */
export function demoSong(bpm = 124) {
  const base = { kick: false, snare: false, hats: false, bass: false, chords: AM, pad: 0, bright: false };
  return synthSong({
    bpm,
    sections: [
      { ...base, label: 'intro', bars: 8, hats: true, pad: 0.6 },
      { ...base, label: 'verse', bars: 8, kick: true, bass: true, pad: 0.8 },
      { ...base, label: 'chorus', bars: 8, kick: true, snare: true, hats: true, bass: true, chords: CH, pad: 1, bright: true, gain: 1.3 },
      { ...base, label: 'break', bars: 4, pad: 0.7, riser: 2 },
      { ...base, label: 'chorus', bars: 8, kick: true, snare: true, hats: true, bass: true, chords: CH, pad: 1, bright: true, gain: 1.3 },
      { ...base, label: 'outro', bars: 4, pad: 0.5, gain: 0.6 },
    ],
  });
}

/** EDM structure: intro 8, build 4 (riser), drop 8 (kick + heavy bass), break 8, build 4, drop 8, outro 4 bars. */
export function edmSong(bpm = 128) {
  const base = { kick: false, snare: false, hats: false, bass: false, chords: AM, pad: 0, bright: false };
  const drop = { ...base, label: 'drop', bars: 8, kick: true, bass: true, pad: 0.2, gain: 1.5 };
  return synthSong({
    bpm,
    sections: [
      { ...base, label: 'intro', bars: 8, hats: true, kick: true, pad: 0.3, gain: 0.5 },
      { ...base, label: 'build', bars: 4, pad: 0.5, riser: 4, gain: 0.7 },
      drop,
      { ...base, label: 'break', bars: 8, pad: 0.6, chords: CH, gain: 0.6 },
      { ...base, label: 'build', bars: 4, pad: 0.5, riser: 4, gain: 0.7 },
      drop,
      { ...base, label: 'outro', bars: 4, hats: true, pad: 0.3, gain: 0.4 },
    ],
  });
}
