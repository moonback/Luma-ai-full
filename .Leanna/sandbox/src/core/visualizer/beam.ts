import type { VisualFixture, VisualMount } from './model';

/**
 * Pure beam geometry shared by the 3D view and the tests. World axes: x = stage left/right, y = up,
 * z = towards the audience. The stage deck spans z ∈ [-depth, 0]; the back wall (cyclorama) stands at z = -depth.
 */
export interface Vec3 { x: number; y: number; z: number }
export interface StageGeometry {
  width: number;
  depth: number;
  wallHeight: number;
  /** Back wall present (false: no cyclorama, beams go through). Default true. */
  wall?: boolean;
  /** Runway from the stage lip towards the audience (z ∈ [0, depth]). */
  thrust?: { width: number; depth: number } | null;
  /** Audience all around the deck (no cyclorama). */
  arena?: boolean;
}

const DEG = Math.PI / 180;
/** Fixed aim of non-moving fixtures, in degrees from their mounting axis (floor fixtures wash the back wall). */
export const FIXED_AIM = { hanging: 35, floor: -20, wall: 0 } as const;

type Aimable = Pick<VisualFixture, 'movable' | 'panDeg' | 'tiltDeg' | 'rotation' | 'mount'> & { mountTilt?: number };

/** Direction of the mounting axis in the fixture base: −Y hung (and on a wall, before the 90° tilt), +Y on the floor. */
export const mountSign = (m: VisualMount): 1 | -1 => (m === 'floor' ? 1 : -1);

/**
 * Rig angles in radians, applied as root (yaw, then tilt around the local x axis) → yoke (pan) → head (tilt).
 * A wall mount is a hung base tilted by 90° so the beam leaves the wall along `rotation`; its mount tilt aims down.
 */
export function rigAngles(f: Aimable): { yaw: number; tilt: number; pan: number; head: number } {
  const s = mountSign(f.mount);
  const mountTilt = f.mountTilt ?? 0;
  return {
    yaw: f.rotation * DEG,
    tilt: s * (f.mount === 'wall' ? 90 - mountTilt : mountTilt) * DEG,
    pan: (f.movable ? f.panDeg : 0) * DEG,
    head: s * (f.movable ? f.tiltDeg : FIXED_AIM[f.mount]) * DEG,
  };
}

const rx = (v: Vec3, a: number): Vec3 => { const c = Math.cos(a), s = Math.sin(a); return { x: v.x, y: v.y * c - v.z * s, z: v.y * s + v.z * c }; };
const ry = (v: Vec3, a: number): Vec3 => { const c = Math.cos(a), s = Math.sin(a); return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c }; };

/** Unit beam direction, identical to the 3D rig: Ry(yaw)·Rx(tilt)·Ry(pan)·Rx(head)·(0, s, 0). */
export function beamDirection(f: Aimable): Vec3 {
  const a = rigAngles(f);
  return ry(rx(ry(rx({ x: 0, y: mountSign(f.mount), z: 0 }, a.head), a.pan), a.tilt), a.yaw);
}

/** Rotates a direction around the vertical axis (used to fan out prism facets). */
export function rotateY(d: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return { x: d.x * c + d.z * s, y: d.y, z: -d.x * s + d.z * c };
}

export interface BeamHit {
  surface: 'floor' | 'wall';
  point: Vec3;
  normal: Vec3;
  distance: number;
}

/** First surface hit by the beam axis: the floor (deck + audience area) or the back wall. */
export function beamHit(origin: Vec3, dir: Vec3, stage: StageGeometry): BeamHit | null {
  const hits: BeamHit[] = [];
  if (dir.y < -1e-3) {
    const t = -origin.y / dir.y;
    const p = { x: origin.x + dir.x * t, y: 0, z: origin.z + dir.z * t };
    if (t > 0.05 && Math.abs(p.x) <= stage.width / 2 + 10 && p.z >= -stage.depth - (stage.arena ? 15 : 0) && p.z <= 15) hits.push({ surface: 'floor', point: p, normal: { x: 0, y: 1, z: 0 }, distance: t });
  }
  if (dir.z < -1e-3 && stage.wall !== false && !stage.arena) {
    const t = (-stage.depth - origin.z) / dir.z;
    const p = { x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: -stage.depth };
    if (t > 0.05 && p.y >= 0 && p.y <= stage.wallHeight && Math.abs(p.x) <= stage.width / 2 + 2) hits.push({ surface: 'wall', point: p, normal: { x: 0, y: 0, z: 1 }, distance: t });
  }
  hits.sort((a, b) => a.distance - b.distance);
  return hits[0] ?? null;
}

/** Light pool on the hit surface: circle radius from the beam angle, stretched by the incidence angle. */
export function poolShape(hit: BeamHit, dir: Vec3, beamAngleDeg: number): { radius: number; stretch: number; falloff: number } {
  const radius = hit.distance * Math.tan((beamAngleDeg / 2) * DEG);
  const cosInc = Math.abs(dir.x * hit.normal.x + dir.y * hit.normal.y + dir.z * hit.normal.z);
  return {
    radius,
    stretch: 1 / Math.max(0.25, cosInc),
    // Distance and incidence dimming so far / grazing pools look softer (visual cue only, not photometry).
    falloff: Math.min(1, 6 / (6 + hit.distance * hit.distance * 0.15)) * Math.max(0.3, cosInc),
  };
}

/** Strobe flash state at time t (s): short flashes at `hz`, always on when not strobing. */
export function flickerOn(t: number, hz: number): boolean {
  if (hz <= 0) return true;
  const ph = t * hz;
  return ph - Math.floor(ph) < 0.3;
}

/** Visual length of the beam: up to the first surface, capped. */
export function beamLength(hit: BeamHit | null, cap = 30): number {
  return Math.min(cap, hit ? hit.distance : cap);
}

/** On the deck or the thrust (performers' area), as opposed to the audience. World coordinates. */
export function onStage(x: number, z: number, stage: StageGeometry): boolean {
  if (Math.abs(x) <= stage.width / 2 && z <= 0 && z >= -stage.depth) return true;
  const t = stage.thrust;
  return !!t && Math.abs(x) <= t.width / 2 && z >= 0 && z <= t.depth;
}

/** Audience eye level (seated to standing), meters. */
export const EYE_LEVEL = { min: 1.1, max: 1.8 } as const;

/**
 * Moving heads whose beam axis crosses the audience at eye level (glare risk). Fixed fixtures are skipped: their aim
 * is the visualizer's assumption (FIXED_AIM), not a measured focus. Approximation: the axis only, not the whole
 * cone, sampled every 20 cm up to the first surface; only beams above 5 % intensity count.
 */
export function audienceGlare(fixtures: readonly VisualFixture[], stage: StageGeometry): VisualFixture[] {
  return fixtures.filter((f) => {
    if (!f.movable || f.intensity < 0.05) return false;
    const o = { x: f.x, y: f.height, z: -f.y };
    const d = beamDirection(f);
    const len = beamLength(beamHit(o, d, stage));
    for (let t = 0.2; t <= len; t += 0.2) {
      const y = o.y + d.y * t;
      if (y < EYE_LEVEL.min || y > EYE_LEVEL.max) continue;
      const x = o.x + d.x * t, z = o.z + d.z * t;
      if (onStage(x, z, stage) || Math.abs(x) > stage.width / 2 + 10 || z > 15) continue;
      if (stage.arena || z > 0) return true;
    }
    return false;
  });
}
