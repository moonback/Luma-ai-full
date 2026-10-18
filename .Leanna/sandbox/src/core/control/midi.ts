/**
 * MIDI helpers shared by the renderer (Web MIDI input) and tests: message → mapping key, and MIDI Time Code decoding.
 * Keys: "note:<channel>:<note>" (note-on, velocity > 0) and "cc:<channel>:<controller>", channels 1–16.
 */
export interface MidiEvent {
  key: string;
  /** 0..1 (velocity or controller value). */
  value: number;
}

export function parseMidi(data: ArrayLike<number>): MidiEvent | null {
  const status = data[0] ?? 0;
  const type = status & 0xf0;
  const ch = (status & 0x0f) + 1;
  const d1 = data[1] ?? 0, d2 = data[2] ?? 0;
  if (type === 0x90 && d2 > 0) return { key: `note:${ch}:${d1}`, value: d2 / 127 };
  if (type === 0xb0) return { key: `cc:${ch}:${d1}`, value: d2 / 127 };
  return null;
}

export const MIDI_RATES = [24, 25, 29.97, 30] as const;

export interface Timecode {
  hours: number;
  minutes: number;
  seconds: number;
  frames: number;
  fps: number;
}

export const timecodeSeconds = (t: Timecode): number => t.hours * 3600 + t.minutes * 60 + t.seconds + t.frames / t.fps;
export const formatTimecode = (t: Timecode): string =>
  [t.hours, t.minutes, t.seconds, t.frames].map((n) => String(n).padStart(2, '0')).join(':');

/** MIDI Time Code: quarter-frame messages (F1 xx) and full-frame SysEx (F0 7F 7F 01 01 hh mm ss ff F7). */
export class MtcDecoder {
  private readonly pieces = new Array<number>(8).fill(0);
  private seen = 0;

  push(data: ArrayLike<number>): Timecode | null {
    if (data[0] === 0xf0 && data[1] === 0x7f && data[3] === 0x01 && data[4] === 0x01 && data.length >= 10) {
      const hr = data[5]!;
      return { hours: hr & 0x1f, minutes: data[6]!, seconds: data[7]!, frames: data[8]!, fps: MIDI_RATES[(hr >> 5) & 3]! };
    }
    if (data[0] !== 0xf1) return null;
    const d = data[1] ?? 0;
    const piece = d >> 4;
    this.pieces[piece] = d & 0x0f;
    this.seen |= 1 << piece;
    if (piece !== 7 || this.seen !== 0xff) return null;
    this.seen = 0;
    const p = this.pieces;
    const fps = MIDI_RATES[(p[7]! >> 1) & 3]!;
    // A complete quarter-frame sequence spans 2 frames: it describes the time 2 frames ago.
    const tc = { hours: p[6]! | ((p[7]! & 1) << 4), minutes: p[4]! | (p[5]! << 4), seconds: p[2]! | (p[3]! << 4), frames: (p[0]! | (p[1]! << 4)) + 2, fps };
    const nominal = Math.round(fps);
    if (tc.frames >= nominal) {
      tc.frames -= nominal;
      tc.seconds++;
    }
    return tc;
  }
}
