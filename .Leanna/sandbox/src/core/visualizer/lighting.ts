import type { Performer, StageMarker } from '../model/schemas';
import type { VisualFixture } from './model';
import { beamDirection, type Vec3 } from './beam';

/**
 * Approximate light received at a point: sum of the beams whose cone contains it (soft edge), dimmed with distance.
 * A visual cue to spot performers left in the dark, not photometry (no occlusion, no reflections).
 */
export interface Received { r: number; g: number; b: number; level: number }

const DEG = Math.PI / 180;
/** Below this level a performer is reported "in the dark". */
export const DARK_LEVEL = 0.08;
/** Height of the face (what must be lit) per silhouette kind, meters. */
export const FACE_HEIGHT: Record<Performer['kind'], number> = { standing: 1.6, seated: 1.15, drums: 1.15, keys: 1.6, lectern: 1.6 };

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function lightAt(p: Vec3, fixtures: readonly VisualFixture[]): Received {
  let r = 0, g = 0, b = 0;
  for (const f of fixtures) {
    if (f.intensity <= 0.005) continue;
    const o = { x: f.x, y: f.height, z: -f.y };
    const v = { x: p.x - o.x, y: p.y - o.y, z: p.z - o.z };
    const dist = Math.hypot(v.x, v.y, v.z);
    if (dist < 0.05) continue;
    const d = beamDirection(f);
    const cos = (v.x * d.x + v.y * d.y + v.z * d.z) / dist;
    const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
    const half = (f.beamAngle / 2) * DEG;
    // Full inside 85 % of the half angle, fading to zero at 115 % (soft beam edge).
    const edge = angle <= half * 0.85 ? 1 : Math.max(0, 1 - (angle - half * 0.85) / (half * 0.3));
    if (edge <= 0) continue;
    // Same distance cue as the light pools (narrow beams are not brighter here: visual estimate only).
    const k = f.intensity * edge * Math.min(1, 6 / (6 + dist * dist * 0.15));
    const [cr, cg, cb] = hexRgb(f.color);
    const m = Math.max(cr, cg, cb) || 1; // colour normalized: the level comes from the intensity
    r += (cr / m) * k; g += (cg / m) * k; b += (cb / m) * k;
  }
  return { r: Math.min(1, r), g: Math.min(1, g), b: Math.min(1, b), level: Math.min(1, Math.max(r, g, b)) };
}

/** Stage position of a performer: on its stage point when attached (and the point exists), else its own. */
export function performerSpot(p: Performer, markers: readonly StageMarker[]): { x: number; y: number } {
  const m = p.markerId ? markers.find((x) => x.id === p.markerId) : undefined;
  return m ? { x: m.x, y: m.y } : { x: p.x, y: p.y };
}

/** Light received on the performer's face. */
export function performerLight(p: Performer, markers: readonly StageMarker[], fixtures: readonly VisualFixture[]): Received {
  const s = performerSpot(p, markers);
  return lightAt({ x: s.x, y: FACE_HEIGHT[p.kind], z: -s.y }, fixtures);
}

export const toHex = (c: Pick<Received, 'r' | 'g' | 'b'>) => `#${[c.r, c.g, c.b].map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
