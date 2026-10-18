import type { RdmDevice } from '../protocols/rdm';
import { blobMean, blur3, detectBlobs, difference, autoThreshold, type Blob, type Gray } from './image';
import { intersectHeight, pixelRay, triangulate, type Camera, type Vec2, type Vec3 } from './geometry';

/**
 * Camera-based fixture localisation.
 * Sequence: a dark reference, a reference with every fixture lit, then either
 *  - "binary": each fixture gets a non-zero code; for every bit, one frame lights the fixtures whose bit is 1 and one
 *    frame the complement, so each bit is read by comparing a blob with itself (robust to ambient light and to how
 *    bright each fixture appears): n fixtures in 2 + 2·⌈log₂(n + 1)⌉ frames;
 *  - "sequential": one frame per fixture (slower, unambiguous).
 * The blobs found in "all lit − dark" are measured in every frame and decoded into fixture ids.
 */

export type LocateMode = 'binary' | 'sequential';

/** Per frame: time for fixtures (and LED drivers / lamps) to settle, then camera capture (averaged frames). */
export const FRAME_SETTLE_MS = 400;
export const FRAME_CAPTURE_MS = 250;
export const sequenceDuration = (frames: number, settleMs = FRAME_SETTLE_MS, captureMs = FRAME_CAPTURE_MS) => (frames * (settleMs + captureMs)) / 1000;

export interface LocateFrame {
  label: string;
  lit: string[];
}

export interface Sequence {
  mode: LocateMode;
  fixtureIds: string[];
  frames: LocateFrame[];
  /** Fixture id → code (binary) or frame index (sequential). */
  codes: Record<string, number>;
  bits: number;
}

export function buildSequence(fixtureIds: string[], mode: LocateMode): Sequence {
  const frames: LocateFrame[] = [{ label: 'Référence noire', lit: [] }, { label: 'Référence (tout allumé)', lit: [...fixtureIds] }];
  const codes: Record<string, number> = {};
  if (mode === 'sequential') {
    fixtureIds.forEach((id, i) => {
      codes[id] = frames.length;
      frames.push({ label: `Projecteur ${i + 1}/${fixtureIds.length}`, lit: [id] });
    });
    return { mode, fixtureIds, frames, codes, bits: 0 };
  }
  const bits = Math.max(1, Math.ceil(Math.log2(fixtureIds.length + 1)));
  fixtureIds.forEach((id, i) => { codes[id] = i + 1; });
  for (let b = 0; b < bits; b++) {
    frames.push({ label: `Bit ${b + 1}/${bits}`, lit: fixtureIds.filter((id) => (codes[id]! >> b) & 1) });
    frames.push({ label: `Bit ${b + 1}/${bits} inversé`, lit: fixtureIds.filter((id) => !((codes[id]! >> b) & 1)) });
  }
  return { mode, fixtureIds, frames, codes, bits };
}

export interface Detection {
  /** Blob centroid (pixels). */
  pixel: Vec2;
  area: number;
  /** Decoded fixture id, or null when the response matches no fixture of the sequence. */
  fixtureId: string | null;
  /** 0..1: weakest bit contrast relative to the blob's full brightness. */
  confidence: number;
  /** Raw code read (binary) or best frame (sequential). */
  code: number;
}

export interface DecodeOptions {
  /** Minimum bit contrast (fraction of the blob's "all lit" brightness) to trust a bit. */
  minContrast?: number;
  minArea?: number;
  maxArea?: number;
}

/** Decodes the captured frames (same order as `seq.frames`) into detections. */
export function decodeSequence(images: Gray[], seq: Sequence, o: DecodeOptions = {}): Detection[] {
  if (images.length !== seq.frames.length) throw new Error(`Séquence incomplète : ${images.length}/${seq.frames.length} images`);
  const dark = images[0]!;
  const ref = blur3(difference(images[1]!, dark));
  const blobs = detectBlobs(ref, autoThreshold(ref), o.minArea ?? 2, o.maxArea ?? (ref.width * ref.height) / 50);
  const minContrast = o.minContrast ?? 0.35;
  const byCode = new Map<number, string>(Object.entries(seq.codes).map(([id, c]) => [c, id]));
  const diffs = images.map((img) => blur3(difference(img, dark)));
  return blobs.map((b): Detection => {
    const full = blobMean(diffs[1]!, b) || 1e-6;
    const level = (k: number) => blobMean(diffs[k]!, b) / full;
    if (seq.mode === 'sequential') {
      // The frame where the blob is brightest; confidence = margin over the second brightest.
      const ls = seq.frames.map((_, k) => (k < 2 ? -1 : level(k)));
      const sorted = [...ls].sort((x, y) => y - x);
      const best = ls.indexOf(sorted[0]!);
      const confidence = Math.max(0, Math.min(1, sorted[0]! - Math.max(0, sorted[1] ?? 0)));
      return { pixel: [b.x, b.y], area: b.area, fixtureId: confidence >= minContrast ? byCode.get(best) ?? null : null, confidence, code: best };
    }
    let code = 0, confidence = 1;
    for (let bit = 0; bit < seq.bits; bit++) {
      const on = level(2 + 2 * bit), off = level(3 + 2 * bit);
      if (on > off) code |= 1 << bit;
      confidence = Math.min(confidence, Math.abs(on - off));
    }
    return { pixel: [b.x, b.y], area: b.area, fixtureId: confidence >= minContrast ? byCode.get(code) ?? null : null, confidence, code };
  });
}

/* ---------------- 3D positions ---------------- */

export interface View {
  camera: Camera;
  detections: Detection[];
}

export interface Located {
  fixtureId: string;
  position: Vec3;
  method: 'triangulated' | 'height';
  /** Estimated uncertainty in metres (ray spread, or pixel footprint at the fixture distance). */
  uncertainty: number;
  views: number;
}

/**
 * 3D position of every fixture seen. Two or more views: least-squares triangulation. One view: intersection of the
 * viewing ray with the fixture's known height (`heightOf`, e.g. the truss height or the patch height).
 * Fixtures seen in several blobs of one view (shared address) are skipped here and reported by `analyzePatch`.
 */
export function solvePositions(views: View[], heightOf: (fixtureId: string) => number): Located[] {
  const rays = new Map<string, { ray: ReturnType<typeof pixelRay>; cam: Camera }[]>();
  for (const v of views) {
    const count = new Map<string, number>();
    for (const d of v.detections) if (d.fixtureId) count.set(d.fixtureId, (count.get(d.fixtureId) ?? 0) + 1);
    for (const d of v.detections) {
      if (!d.fixtureId || count.get(d.fixtureId) !== 1) continue;
      const list = rays.get(d.fixtureId) ?? [];
      list.push({ ray: pixelRay(v.camera, d.pixel), cam: v.camera });
      rays.set(d.fixtureId, list);
    }
  }
  const out: Located[] = [];
  for (const [fixtureId, list] of rays) {
    if (list.length >= 2) {
      const t = triangulate(list.map((x) => x.ray));
      if (t) out.push({ fixtureId, position: t.point, method: 'triangulated', uncertainty: Math.max(0.02, t.spread), views: list.length });
      continue;
    }
    const { ray, cam } = list[0]!;
    const p = intersectHeight(ray, heightOf(fixtureId));
    if (!p) continue;
    const dist = Math.hypot(p[0] - ray.origin[0], p[1] - ray.origin[1], p[2] - ray.origin[2]);
    // One pixel at that distance, amplified by grazing angles on the height plane.
    const grazing = 1 / Math.max(0.15, Math.abs(ray.dir[2]));
    out.push({ fixtureId, position: p, method: 'height', uncertainty: Math.max(0.02, (dist / cam.f) * grazing), views: 1 });
  }
  return out;
}

/* ---------------- Patch diagnosis ---------------- */

export interface PatchFixture {
  id: string;
  name: string;
  universe: number;
  address: number;
  channels: number;
  position: { x: number; y: number };
  height: number;
  manufacturer: string;
  model: string;
}

export type IssueKind = 'no-response' | 'shared-address' | 'unidentified' | 'moved' | 'swapped' | 'rdm-model' | 'rdm-footprint' | 'rdm-unpatched' | 'rdm-missing';
export interface PatchIssue {
  kind: IssueKind;
  fixtureIds: string[];
  message: string;
}

export const sideOf = (x: number) => (Math.abs(x) < 0.5 ? 'au centre' : x < 0 ? 'à jardin' : 'à cour');
const fmtPos = (p: { x: number; y: number }) => `${sideOf(p.x)} (x ${p.x.toFixed(1)} m, ${p.y.toFixed(1)} m du bord)`;

/**
 * Patch errors revealed by the camera: fixtures that never answered, an address answered by several fixtures, blobs
 * whose answer matches no fixture (offset address or wrong mode), fixtures far from their patch position, and pairs
 * that sit at each other's place (crossed addresses).
 */
export function analyzePatch(fixtures: PatchFixture[], views: View[], located: Located[], o: { movedThreshold?: number } = {}): PatchIssue[] {
  const issues: PatchIssue[] = [];
  const name = new Map(fixtures.map((f) => [f.id, f.name]));
  const seen = new Set<string>();
  views.forEach((v, vi) => {
    const count = new Map<string, Detection[]>();
    for (const d of v.detections) {
      if (d.fixtureId) {
        seen.add(d.fixtureId);
        count.set(d.fixtureId, [...(count.get(d.fixtureId) ?? []), d]);
      } else {
        issues.push({ kind: 'unidentified', fixtureIds: [], message: `Vue ${vi + 1} : projecteur non identifié vers (${d.pixel[0].toFixed(0)}, ${d.pixel[1].toFixed(0)}) px — réponse incohérente (adresse décalée, mode DMX différent ou deux projecteurs superposés)` });
      }
    }
    for (const [id, ds] of count) if (ds.length > 1) issues.push({ kind: 'shared-address', fixtureIds: [id], message: `${name.get(id)} : ${ds.length} projecteurs répondent à son adresse (vue ${vi + 1}) — adresse en double sur les appareils` });
  });
  for (const f of fixtures) if (!seen.has(f.id)) issues.push({ kind: 'no-response', fixtureIds: [f.id], message: `${f.name} (U${f.universe}.${f.address}) ne répond pas ou n’est pas visible de la caméra` });

  const threshold = o.movedThreshold ?? 1;
  const at = new Map(located.map((l) => [l.fixtureId, l]));
  const dist = (a: { x: number; y: number }, b: Vec3) => Math.hypot(a.x - b[0], a.y - b[1]);
  const swapped = new Set<string>();
  for (const a of fixtures) {
    const la = at.get(a.id);
    if (!la || dist(a.position, la.position) <= threshold) continue;
    const b = fixtures.find((f) => f.id !== a.id && dist(f.position, la.position) <= threshold && at.get(f.id) && dist(a.position, at.get(f.id)!.position) <= threshold);
    if (b && !swapped.has(b.id)) {
      swapped.add(a.id);
      swapped.add(b.id);
      issues.push({ kind: 'swapped', fixtureIds: [a.id, b.id], message: `${a.name} et ${b.name} semblent inversés : ce que vous appelez ${a.name} est en réalité ${fmtPos({ x: la.position[0], y: la.position[1] })} (adresses croisées ?)` });
    }
  }
  for (const a of fixtures) {
    const la = at.get(a.id);
    if (!la || swapped.has(a.id) || dist(a.position, la.position) <= threshold) continue;
    issues.push({ kind: 'moved', fixtureIds: [a.id], message: `${a.name} est ${fmtPos({ x: la.position[0], y: la.position[1] })}, pas ${fmtPos(a.position)} comme dans le patch` });
  }
  return issues;
}

/* ---------------- RDM cross-check ---------------- */

const simplify = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

/** Patch ↔ RDM (one universe): model and footprint per address, unpatched devices, patched fixtures RDM did not find. */
export function crossCheckRdm(fixtures: PatchFixture[], devices: RdmDevice[], universe: number): PatchIssue[] {
  const issues: PatchIssue[] = [];
  const inUniverse = fixtures.filter((f) => f.universe === universe);
  for (const d of devices) {
    if (d.startAddress === null) continue;
    const f = inUniverse.find((x) => x.address === d.startAddress);
    const label = [d.manufacturer, d.model].filter(Boolean).join(' ') || d.uid;
    if (!f) {
      issues.push({ kind: 'rdm-unpatched', fixtureIds: [], message: `RDM : ${label} (${d.uid}) à l’adresse U${universe}.${d.startAddress} n’est pas dans le patch` });
      continue;
    }
    const model = simplify(d.model ?? ''), patched = simplify(`${f.manufacturer}${f.model}`);
    if (model && !patched.includes(model) && !model.includes(simplify(f.model))) issues.push({ kind: 'rdm-model', fixtureIds: [f.id], message: `${f.name} : le patch indique ${f.manufacturer} ${f.model}, l’appareil répond « ${label} »` });
    if (d.footprint !== null && d.footprint !== f.channels) issues.push({ kind: 'rdm-footprint', fixtureIds: [f.id], message: `${f.name} : ${f.channels} canaux dans le patch, ${d.footprint} annoncés par l’appareil (mode DMX différent)` });
  }
  for (const f of inUniverse) if (!devices.some((d) => d.startAddress === f.address)) issues.push({ kind: 'rdm-missing', fixtureIds: [f.id], message: `${f.name} (U${universe}.${f.address}) : aucun appareil RDM à cette adresse (non RDM, éteint, ou adresse différente)` });
  return issues;
}

export type { Blob };
