import { average, fromRgba, type Gray } from '../../core/vision/image';

/** Analysis resolution: about 2 cm per pixel at 10 m with a 60° lens, cheap to process. */
const MAX_WIDTH = 640;

function toGray(source: CanvasImageSource, w: number, h: number): Gray {
  const k = Math.min(1, MAX_WIDTH / w);
  const cw = Math.round(w * k), ch = Math.round(h * k);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, cw, ch);
  return fromRgba(ctx.getImageData(0, 0, cw, ch).data, cw, ch);
}

export async function videoDevices(): Promise<MediaDeviceInfo[]> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  } catch {
    return [];
  }
}

/** Webcam: opens the stream into `video` and grabs averaged grayscale frames. */
export class Webcam {
  private stream: MediaStream | null = null;
  constructor(readonly video: HTMLVideoElement) {}

  async start(deviceId: string | null): Promise<void> {
    this.stop();
    // Browsers rarely expose fixed exposure: frames are averaged and always compared to the dark reference.
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  get active(): boolean {
    return !!this.stream;
  }

  async grab(frames = 3): Promise<Gray> {
    const out: Gray[] = [];
    for (let i = 0; i < frames; i++) {
      out.push(toGray(this.video, this.video.videoWidth, this.video.videoHeight));
      await new Promise((r) => setTimeout(r, 40));
    }
    return average(out);
  }
}

/** Smartphone photo (JPEG, base64) → grayscale frame. */
export async function photoToGray(base64: string): Promise<Gray> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  const g = toGray(bmp, bmp.width, bmp.height);
  bmp.close();
  return g;
}

/** Grayscale frame → data URL (displayed under the click overlay). */
export function grayToDataUrl(g: Gray, gain = 1): string {
  const canvas = document.createElement('canvas');
  canvas.width = g.width;
  canvas.height = g.height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(g.width, g.height);
  for (let i = 0; i < g.data.length; i++) {
    const v = Math.min(255, Math.round(g.data[i]! * 255 * gain));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}
