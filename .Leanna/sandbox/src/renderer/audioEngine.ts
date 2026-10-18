import { AudioAnalyzer, type AudioFeatures } from '../core/audio/analyzer';
import { predictFromTrack } from '../core/music/dropPredictor';
import type { SongSection } from '../core/model/schemas';
import type { AudioConfig } from '../core/model/schemas';
import { act } from './api';

/**
 * Audio capture + analysis loop living outside React so it keeps running while the user changes page.
 * Live mode: Web Audio AnalyserNode on a microphone/line input. Simulated mode: synthetic kick track
 * (clearly flagged as simulated everywhere it is displayed).
 */
type Listener = (f: AudioFeatures | null) => void;

class AudioEngine {
  source: 'none' | 'live' | 'simulated' | 'track' = 'none';
  simBpm = 124;
  error: string | null = null;
  last: AudioFeatures | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private raf = 0;
  private analyzer = new AudioAnalyzer({ sensitivity: 1, smoothing: 0.6, onsetThreshold: 1.5, riseRatio: 1.8 });
  private lastSent = 0;
  private listeners = new Set<Listener>();
  private time = new Float32Array(2048);
  private freq = new Uint8Array(1024);
  private simSeed = 1;
  /** Known track played by the app's player: exact drop/chorus prediction from the analysis. */
  private track: { sections: SongSection[]; bpm: number; position: () => number } | null = null;
  private ownsContext = true;

  configure(cfg: AudioConfig): void {
    this.analyzer.configure({ sensitivity: cfg.sensitivity, smoothing: cfg.smoothing, onsetThreshold: cfg.onsetThreshold, riseRatio: cfg.reactions.energyRiseGo.ratio, bpmRange: cfg.bpmRange });
  }

  /** Tap on the downbeat: re-phases the beat grid and makes this beat "1". */
  tap(): void {
    this.analyzer.tempo.tap(performance.now() / 1000);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async devices(): Promise<MediaDeviceInfo[]> {
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    } catch {
      return [];
    }
  }

  async startLive(deviceId: string | null): Promise<void> {
    this.stop();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0;
      this.ctx.createMediaStreamSource(this.stream).connect(this.analyser);
      this.source = 'live';
      this.error = null;
      this.loop();
    } catch (err) {
      this.error = `Entrée audio indisponible : ${err instanceof Error ? err.message : String(err)}`;
      this.source = 'none';
      this.emit(null);
    }
  }

  /**
   * Analyses the app's own player output (AudioContext owned by the player): live features plus the exact
   * drop/chorus prediction from the track analysis.
   */
  startTrack(ctx: AudioContext, node: AudioNode, track: { sections: SongSection[]; bpm: number; position: () => number }): void {
    this.stop();
    this.ctx = ctx;
    this.ownsContext = false;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    node.connect(this.analyser);
    this.track = track;
    this.source = 'track';
    this.error = null;
    this.loop();
  }

  startSimulated(bpm: number): void {
    this.stop();
    this.simBpm = bpm;
    this.source = 'simulated';
    this.error = null;
    this.loop();
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ownsContext) void this.ctx?.close().catch(() => undefined);
    this.analyser?.disconnect();
    this.ownsContext = true;
    this.track = null;
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.source = 'none';
    this.last = null;
    this.emit(null);
  }

  private frame(t: number): { rms: number; bass: number; high: number } {
    if (this.source === 'simulated') {
      const beat = 60 / this.simBpm;
      const kick = Math.exp(-(t % beat) * 18);
      this.simSeed = (this.simSeed * 1664525 + 1013904223) >>> 0;
      const noise = this.simSeed / 4294967296;
      const hat = Math.exp(-((t * 2) % beat) * 40) * 0.5;
      return { rms: 0.5 * (0.35 + 0.65 * kick) + noise * 0.02, bass: Math.min(1, 0.9 * kick + noise * 0.03), high: Math.min(1, hat + noise * 0.02) };
    }
    const a = this.analyser!;
    a.getFloatTimeDomainData(this.time);
    a.getByteFrequencyData(this.freq);
    let sum = 0;
    for (const v of this.time) sum += v * v;
    const binHz = (this.ctx?.sampleRate ?? 48000) / a.fftSize;
    const n = Math.max(1, Math.floor(150 / binHz));
    let bass = 0;
    for (let i = 1; i <= n; i++) bass += this.freq[i] ?? 0;
    const h0 = Math.floor(4000 / binHz);
    let high = 0;
    for (let i = h0; i < this.freq.length; i++) high += this.freq[i] ?? 0;
    return { rms: Math.sqrt(sum / this.time.length), bass: bass / n / 255, high: high / Math.max(1, this.freq.length - h0) / 255 };
  }

  private loop = (): void => {
    if (this.source === 'none') return;
    const t = performance.now() / 1000;
    const f = this.analyzer.push({ t, ...this.frame(t) });
    if (this.track) {
      const p = predictFromTrack(this.track.sections, this.track.position(), this.track.bpm);
      // Same clock as the live features: the predicted time is relative to now.
      f.prediction = p ? { ...p, at: t + (p.at - this.track.position()) } : null;
    }
    this.last = f;
    this.emit(f);
    const now = performance.now();
    if (f.onset || f.energyRise || now - this.lastSent > 40) {
      this.lastSent = now;
      void act({ type: 'audio.features', source: this.source, features: { ...f, level: Math.min(1, f.level), energy: Math.min(1, f.energy), bpm: f.bpm && f.bpm >= 20 && f.bpm <= 300 ? f.bpm : null, levelDb: Number.isFinite(f.levelDb) ? f.levelDb : -120 } });
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private emit(f: AudioFeatures | null): void {
    for (const l of this.listeners) l(f);
  }
}

export const audioEngine = new AudioEngine();
