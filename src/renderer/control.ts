import { MtcDecoder, parseMidi, timecodeSeconds, formatTimecode, type Timecode } from '../core/control/midi';
import { LtcDecoder } from '../core/control/timecode';
import type { Settings, ShortcutAction } from '../core/settings/settings';
import { act } from './api';
import { runShortcut } from './App';

/**
 * External control living outside React (like audioEngine): Web MIDI input (mapped to shortcut actions or the grand
 * master), MIDI Time Code and LTC (audio input) forwarded to the main process as `timeline.timecode`.
 */
type Control = Settings['control'];
export interface ControlStatus {
  midiInputs: string[];
  timecode: string | null;
  error: string | null;
}

class ExternalControl {
  status: ControlStatus = { midiInputs: [], timecode: null, error: null };
  /** Set by the Settings page while learning a mapping: receives the next MIDI key. */
  learn: ((key: string) => void) | null = null;
  private cfg: Control | null = null;
  private midi: MIDIAccess | null = null;
  private readonly mtc = new MtcDecoder();
  private ltc: { ctx: AudioContext; stream: MediaStream; node: ScriptProcessorNode } | null = null;
  private lastTcSent = 0;
  private readonly listeners = new Set<() => void>();

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private changed(patch: Partial<ControlStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l();
  }

  async configure(cfg: Control): Promise<void> {
    const before = this.cfg?.timecode;
    this.cfg = cfg;
    await this.ensureMidi();
    if (cfg.timecode.source !== before?.source || cfg.timecode.ltcDeviceId !== before?.ltcDeviceId) await this.setupLtc();
  }

  /** Web MIDI is opened when MIDI mappings, learning or MTC need it. */
  async ensureMidi(): Promise<void> {
    if (this.midi || !this.cfg || !(this.cfg.midi.enabled || this.cfg.timecode.source === 'mtc' || this.learn)) return;
    try {
      this.midi = await navigator.requestMIDIAccess({ sysex: true }); // sysex: MTC full-frame messages
      const bind = () => {
        const names: string[] = [];
        this.midi!.inputs.forEach((input) => {
          names.push(input.name ?? input.id);
          input.onmidimessage = (e) => { if (e.data) this.onMidi(e.data); };
        });
        this.changed({ midiInputs: names, error: null });
      };
      this.midi.onstatechange = bind;
      bind();
    } catch (err) {
      this.changed({ error: `MIDI indisponible : ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  private onMidi(data: Uint8Array): void {
    const cfg = this.cfg;
    if (!cfg) return;
    if (cfg.timecode.source === 'mtc') {
      const tc = this.mtc.push(data);
      if (tc) this.timecode(tc);
    }
    const ev = parseMidi(data);
    if (!ev) return;
    if (this.learn) {
      this.learn(ev.key);
      this.learn = null;
      return;
    }
    if (!cfg.midi.enabled) return;
    for (const m of cfg.midi.mappings) {
      if (m.key !== ev.key) continue;
      if (m.action === 'master') void act({ type: 'engine.master', value: ev.value });
      else if (ev.key.startsWith('note:') || ev.value >= 0.5) runShortcut(m.action as ShortcutAction);
    }
  }

  private timecode(tc: Timecode): void {
    const now = performance.now();
    if (now - this.lastTcSent < 100) return; // 10 Hz is enough: the engine runs freely between updates
    this.lastTcSent = now;
    this.changed({ timecode: `${formatTimecode(tc)} @ ${tc.fps}` });
    void window.luma.invoke({ type: 'timeline.timecode', seconds: timecodeSeconds(tc) });
  }

  private async setupLtc(): Promise<void> {
    if (this.ltc) {
      this.ltc.node.disconnect();
      this.ltc.stream.getTracks().forEach((t) => t.stop());
      void this.ltc.ctx.close().catch(() => undefined);
      this.ltc = null;
    }
    if (this.cfg?.timecode.source !== 'ltc') return;
    try {
      const id = this.cfg.timecode.ltcDeviceId;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const ctx = new AudioContext();
      const decoder = new LtcDecoder(ctx.sampleRate);
      // shortcut: ScriptProcessorNode is deprecated but needs no extra module under the strict CSP; move to an AudioWorklet if Chromium removes it.
      const node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (e) => { for (const tc of decoder.push(e.inputBuffer.getChannelData(0))) this.timecode(tc); };
      ctx.createMediaStreamSource(stream).connect(node);
      node.connect(ctx.destination);
      this.ltc = { ctx, stream, node };
      this.changed({ error: null });
    } catch (err) {
      this.changed({ error: `Entrée LTC indisponible : ${err instanceof Error ? err.message : String(err)}` });
    }
  }
}

export const externalControl = new ExternalControl();
