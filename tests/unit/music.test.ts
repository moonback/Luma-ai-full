import { analyzeAudio, detectKey } from '../../src/core/music/analyze';
import { songAnalysisSchema } from '../../src/core/model/schemas';
import { demoSong, edmSong, synthSong, type SynthSection } from '../music-synth';

describe('analyse de morceau (synthétique, vérité terrain connue)', () => {
  it.each([100, 124, 140])('%i BPM : tempo, premiers temps, frontières, étiquettes', async (bpm) => {
    const song = demoSong(bpm);
    const a = await analyzeAudio(song.samples, song.sr);
    expect(songAnalysisSchema.safeParse(a).success).toBe(true);
    expect(Math.abs(a.bpm - bpm)).toBeLessThan(1);
    expect(a.tempoStable).toBe(true);
    // Downbeats: every true bar start found within 70 ms (> 90 %).
    const bars = Math.round(song.duration / song.bar);
    const hits = Array.from({ length: bars }, (_, b) => b * song.bar).filter((t) => a.downbeats.some((d) => Math.abs(d - t) < 0.07)).length;
    expect(hits / bars).toBeGreaterThan(0.9);
    // Section boundaries within ± 1 beat.
    const truth = song.boundaries.slice(1).map((b) => b.start);
    const found = a.sections.slice(1).map((s) => s.start);
    expect(found.length).toBe(truth.length);
    found.forEach((t, i) => expect(Math.abs(t - truth[i]!)).toBeLessThan(song.beat));
    expect(a.sections.map((s) => s.label)).toEqual(['intro', 'verse', 'chorus', 'build', 'chorus', 'outro']);
    const [, , c1, , c2] = a.sections;
    expect(c1!.cluster).toBe(c2!.cluster);
    expect(new Set(a.sections.map((s) => s.cluster)).size).toBe(5);
    expect(a.events.some((e) => e.kind === 'riser' && e.t >= song.boundaries[3]!.start - 0.1 && e.t < song.boundaries[4]!.start)).toBe(true);
  });

  it('EDM : montées et drops (groupe à forte basse entré depuis un passage calme)', async () => {
    const song = edmSong(128);
    const a = await analyzeAudio(song.samples, song.sr);
    console.info(`[musique] EDM ${a.bpm} BPM ${a.sections.map((s) => `${s.label}@${s.start.toFixed(1)}(e${s.energy.toFixed(2)},b${s.bassShare.toFixed(2)})`).join(' ')}`);
    expect(Math.abs(a.bpm - 128)).toBeLessThan(1);
    const labels = a.sections.map((s) => s.label);
    expect(labels.filter((l) => l === 'drop')).toHaveLength(2);
    expect(labels.filter((l) => l === 'build').length).toBeGreaterThanOrEqual(1);
    expect(labels[0]).toBe('intro');
  });

  it('respecte la plage de tempo demandée (pas d’erreur d’octave)', async () => {
    const song = demoSong(88);
    const a = await analyzeAudio(song.samples, song.sr, { bpmMin: 70, bpmMax: 110 });
    expect(Math.abs(a.bpm - 88)).toBeLessThan(1);
  });

  it('tonalité : Do majeur / La mineur relatif ; Ré majeur', () => {
    const fromNotes = (notes: number[]) => Array.from({ length: 12 }, (_, i) => (notes.includes(i) ? 1 : 0.1) + (i === notes[0] ? 1 : 0));
    const c = detectKey(fromNotes([0, 4, 7, 2, 5, 9, 11]));
    expect(c).toMatchObject({ tonic: 0, mode: 'major' });
    expect(detectKey(fromNotes([2, 6, 9, 4, 7, 11, 1]))).toMatchObject({ tonic: 2, mode: 'major' });
    expect(detectKey(fromNotes([9, 0, 4, 2, 5, 7, 11]))).toMatchObject({ tonic: 9, mode: 'minor' });
  });

  it('un titre de 4 min est analysé en moins de 15 s', async () => {
    const base: SynthSection = { label: 'x', bars: 8, kick: true, snare: true, hats: true, bass: true, chords: [57, 53, 48, 55], pad: 0.8, bright: false };
    const song = synthSong({ bpm: 120, sections: Array.from({ length: 15 }, (_, i) => ({ ...base, bright: i % 2 === 1, gain: i % 3 ? 1 : 0.6 })) });
    expect(song.duration).toBeGreaterThan(235);
    const t0 = performance.now();
    let yields = 0;
    const a = await analyzeAudio(song.samples, song.sr, { yieldFn: async () => { yields++; } });
    const s = (performance.now() - t0) / 1000;
    console.info(`[musique] ${song.duration.toFixed(0)} s analysées en ${s.toFixed(2)} s`);
    expect(s).toBeLessThan(15);
    expect(yields).toBeGreaterThan(3); // cooperative: the UI thread gets control back regularly
    expect(Math.abs(a.bpm - 120)).toBeLessThan(1);
  }, 60_000);
});
