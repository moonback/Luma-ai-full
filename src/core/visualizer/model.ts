import type { FixtureProfile, FixtureType, FixtureValues, Fixture, FixtureMode, Channel } from '../model/schemas';
import { cellColors, displayColor } from '../fixtures/color';
import { coarseChannel, rangeAt } from '../fixtures/profiles';
import { rgbToHex } from '../util/math';

/**
 * Renderer-agnostic visual model consumed by the 2D canvas and the 3D view.
 * Positions/height in meters, pan/tilt in degrees. This is an approximation, not a photometric simulation.
 */
export interface VisualFixture {
  id: string;
  name: string;
  type: FixtureType;
  x: number;
  y: number;
  rotation: number;
  color: string;
  intensity: number;
  movable: boolean;
  panDeg: number;
  tiltDeg: number;
  /** Effective beam angle in degrees (profile angle, widened/narrowed by the zoom channel when present). */
  beamAngle: number;
  /** Mounting height in meters. */
  height: number;
  /** Hung (beam points down), standing on the floor (beam points up) or on a wall (beam points out, along `rotation`). */
  mount: VisualMount;
  /** Tilt of the mounting axis in degrees (towards the audience; wall mount: downwards). */
  mountTilt: number;
  /** Truss the fixture hangs from, null when it is free (drawn alone, without a truss). */
  trussId: string | null;
  /** Per-cell colours for multi-cell fixtures (left to right), already scaled by intensity. Ring modules excluded. */
  cells: string[];
  /** Colours of LED rings around the lens (modules with geometry 'ring'), already scaled by their intensity. */
  rings: string[];
  /** Estimated strobe frequency in Hz from the strobe/shutter channel, 0 when not strobing. */
  strobeHz: number;
  /** 1-based index of the selected gobo slot, 0 when open / no gobo wheel. */
  gobo: number;
  /** Prism engaged (beam split). */
  prism: boolean;
}

export type VisualMount = 'hanging' | 'floor' | 'wall';
/** Floor-standing below this height when the mounting is automatic. */
export const FLOOR_MOUNT_MAX_HEIGHT = 1;

/** Effective mounting: the explicit choice, or the height rule of older projects ('auto' / absent). */
export function mountOf(f: Pick<Fixture, 'mount' | 'height'>): VisualMount {
  if (f.mount && f.mount !== 'auto') return f.mount;
  return f.height < FLOOR_MOUNT_MAX_HEIGHT ? 'floor' : 'hanging';
}
const MIN_STROBE_HZ = 1;
const MAX_STROBE_HZ = 20;

/** Position inside a "strobe" range → frequency: the documented Hz when the range has them, else slow → fast 1..20 Hz. */
export function strobeFrequency(channel: Channel | undefined, value: number | undefined): number {
  if (!channel || value === undefined) return 0;
  const dmx = Math.round(value * 255);
  const r = rangeAt(channel, dmx);
  if (!r || (r.kind !== 'strobe' && r.kind !== 'random' && r.kind !== 'pulse')) return 0;
  const k = r.to > r.from ? (dmx - r.from) / (r.to - r.from) : 0;
  if (r.hzFrom !== undefined && r.hzTo !== undefined) return r.hzFrom + k * (r.hzTo - r.hzFrom);
  return MIN_STROBE_HZ + k * (MAX_STROBE_HZ - MIN_STROBE_HZ);
}

export function goboIndex(channel: Channel | undefined, value: number | undefined): number {
  if (!channel || value === undefined) return 0;
  const r = rangeAt(channel, Math.round(value * 255));
  if (!r || r.kind !== 'gobo') return 0;
  return channel.ranges.filter((x) => x.kind === 'gobo').indexOf(r) + 1;
}

/** Zoom 0..1 maps zoomMin..zoomMax when the profile has them, else the nominal angle from 40 % to 160 % (approximation). */
export function zoomedAngle(nominal: number, zoom: number | undefined, physical?: Pick<FixtureProfile['physical'], 'zoomMin' | 'zoomMax'>): number {
  if (zoom === undefined) return nominal;
  if (physical?.zoomMin !== undefined && physical.zoomMax !== undefined) return physical.zoomMin + zoom * (physical.zoomMax - physical.zoomMin);
  return Math.min(90, Math.max(2, nominal * (0.4 + 1.2 * zoom)));
}

/** Tilt 0..1 → degrees: tiltMin..tiltMax when documented, else symmetric ±tiltRange/2. */
export function tiltDegrees(physical: FixtureProfile['physical'], tilt: number): number {
  const lo = physical.tiltMin ?? -physical.tiltRange / 2;
  const hi = physical.tiltMax ?? physical.tiltRange / 2;
  return lo + tilt * (hi - lo);
}

export function buildVisualModel(
  items: readonly { fixture: Fixture; profile: FixtureProfile; mode: FixtureMode; attributes: string[] }[],
  values: FixtureValues,
): VisualFixture[] {
  return items.map((rf) => {
    const v = values[rf.fixture.id] ?? {};
    const { color, intensity } = displayColor(rf, v);
    const movable = rf.attributes.includes('pan') || rf.attributes.includes('tilt');
    const strobe = Math.max(
      strobeFrequency(coarseChannel(rf.mode, 'strobe'), v.strobe),
      strobeFrequency(coarseChannel(rf.mode, 'shutter'), v.shutter),
    );
    const prism = coarseChannel(rf.mode, 'prism');
    const prismRange = prism && v.prism !== undefined ? rangeAt(prism, Math.round(v.prism * 255)) : undefined;
    const ringCells = new Set(rf.profile.modules.filter((m) => m.geometry === 'ring').flatMap((m) => m.cells));
    const cells = cellColors(rf, v);
    return {
      id: rf.fixture.id,
      name: rf.fixture.name,
      type: rf.profile.type,
      x: rf.fixture.position.x,
      y: rf.fixture.position.y,
      rotation: rf.fixture.rotation,
      color: rgbToHex(color),
      intensity,
      movable,
      panDeg: movable ? ((v.pan ?? 0.5) - 0.5) * rf.profile.physical.panRange : 0,
      tiltDeg: movable ? tiltDegrees(rf.profile.physical, v.tilt ?? 0.5) : 0,
      beamAngle: zoomedAngle(rf.profile.physical.beamAngle, rf.attributes.includes('zoom') ? v.zoom : undefined, rf.profile.physical),
      height: rf.fixture.height,
      mount: mountOf(rf.fixture),
      mountTilt: rf.fixture.mountTilt ?? 0,
      trussId: rf.fixture.trussId ?? null,
      cells: cells.filter((c) => !ringCells.has(c.cell)).map((c) => rgbToHex(c.color)),
      rings: cells.filter((c) => ringCells.has(c.cell)).map((c) => rgbToHex(c.color)),
      strobeHz: strobe,
      gobo: goboIndex(coarseChannel(rf.mode, 'gobo'), v.gobo),
      prism: !!prismRange && prismRange.kind !== 'open' && !/sans|aucun|no function|open/i.test(prismRange.label),
    };
  });
}
