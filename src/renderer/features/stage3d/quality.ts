import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import type { VisualFixture } from '../../../core/visualizer/model';
import { beamDirection, type StageGeometry } from '../../../core/visualizer/beam';

/**
 * Optional "real lighting" mode and room ambiences.
 * Real lighting: a pool of shadow-casting SpotLights given to the most intense fixtures each frame; the pool size
 * adapts to the frame rate. The fast mode (cone shader + pools) stays the default.
 */

export const LIGHT_BUDGET = { min: 4, max: 24, step: 4, start: 12 } as const;
/** Texture units kept for the materials' own maps (colour map, reflections…): the rest can hold shadow maps. */
const RESERVED_TEXTURE_UNITS = 4;
const DEG = Math.PI / 180;

export class RealLights {
  private lights: THREE.SpotLight[] = [];
  private enabled = false;
  /** Each shadow map takes a texture unit: lights beyond this count light without casting shadows. */
  readonly maxShadows: number;

  constructor(private scene: THREE.Scene, maxTextureUnits: number) {
    this.maxShadows = Math.max(0, maxTextureUnits - RESERVED_TEXTURE_UNITS);
  }

  get shadows(): number { return Math.min(this.lights.length, this.maxShadows); }

  get budget(): number { return this.lights.length; }

  /** Changing the number of lights recompiles the materials once: only done on toggle or budget steps. */
  setBudget(n: number): void {
    while (this.lights.length < n) {
      const l = new THREE.SpotLight(0xffffff, 0, 40, 0.5, 0.45, 1.2);
      l.castShadow = this.lights.length < this.maxShadows; // the most intense fixtures come first
      l.shadow.mapSize.set(512, 512);
      l.shadow.bias = -0.0005;
      l.shadow.camera.near = 0.2;
      l.shadow.camera.far = 40;
      l.visible = this.enabled;
      this.scene.add(l, l.target);
      this.lights.push(l);
    }
    while (this.lights.length > n) {
      const l = this.lights.pop()!;
      this.scene.remove(l, l.target);
      l.dispose();
    }
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on && !this.lights.length) this.setBudget(LIGHT_BUDGET.start);
    for (const l of this.lights) l.visible = on;
  }

  /** Most intense fixtures get a light; unused lights stay in the scene at zero intensity (no recompilation). */
  update(fixtures: readonly VisualFixture[], dimmed: (f: VisualFixture) => boolean): void {
    if (!this.enabled) return;
    const ranked = fixtures.filter((f) => f.intensity > 0.02).sort((a, b) => b.intensity - a.intensity).slice(0, this.lights.length);
    this.lights.forEach((l, i) => {
      const f = ranked[i];
      if (!f) { l.intensity = 0; return; }
      const d = beamDirection(f);
      l.position.set(f.x + d.x * 0.25, f.height + d.y * 0.25, -f.y + d.z * 0.25);
      l.target.position.set(l.position.x + d.x * 10, l.position.y + d.y * 10, l.position.z + d.z * 10);
      l.angle = Math.min(Math.PI / 2.2, (f.beamAngle / 2) * DEG * 1.1);
      const c = new THREE.Color(f.color);
      const m = Math.max(c.r, c.g, c.b) || 1;
      l.color.setRGB(c.r / m, c.g / m, c.b / m);
      // Physical units (candela, decay 1.2): about the brightness of the light pools of the fast mode at 5–8 m.
      l.intensity = f.intensity * (dimmed(f) ? 0.25 : 1) * 500;
    });
  }

  dispose(): void { this.setBudget(0); }
}

/* ------------------------------------------------------------------ */
/* Room ambiences and floor                                            */
/* ------------------------------------------------------------------ */

export type AmbienceId = 'black' | 'work' | 'outdoor' | 'club' | 'theatre';
interface Ambience { label: string; bg: number; fog: [number, number]; sky: number; ground: number; hemi: number; key: number; keyColor: number }

export const AMBIENCES: Record<AmbienceId, Ambience> = {
  black: { label: 'Salle noire', bg: 0x05060a, fog: [30, 70], sky: 0x8899bb, ground: 0x0b0d14, hemi: 0.5, key: 0.35, keyColor: 0xb8c4ff },
  work: { label: 'Lumière de service', bg: 0x1b1e26, fog: [45, 140], sky: 0xffffff, ground: 0x4a4a4a, hemi: 2.4, key: 1.4, keyColor: 0xfff4e0 },
  outdoor: { label: 'Plein air nuit', bg: 0x0a1528, fog: [25, 95], sky: 0x4a6a9a, ground: 0x0b0d14, hemi: 0.7, key: 0.5, keyColor: 0x9db4ff },
  club: { label: 'Club', bg: 0x0c0612, fog: [12, 45], sky: 0x6a4a8a, ground: 0x08040c, hemi: 0.35, key: 0.12, keyColor: 0xc4a0ff },
  theatre: { label: 'Théâtre', bg: 0x110b07, fog: [30, 80], sky: 0xffc89a, ground: 0x100a06, hemi: 0.45, key: 0.25, keyColor: 0xffd2a8 },
};

export function applyAmbience(id: AmbienceId, scene: THREE.Scene, hemi: THREE.HemisphereLight, key: THREE.DirectionalLight): void {
  const a = AMBIENCES[id] ?? AMBIENCES.black;
  (scene.background as THREE.Color).set(a.bg);
  const fog = scene.fog as THREE.Fog;
  fog.color.set(a.bg);
  [fog.near, fog.far] = a.fog;
  hemi.color.set(a.sky);
  hemi.groundColor.set(a.ground);
  hemi.intensity = a.hemi;
  key.color.set(a.keyColor);
  key.intensity = a.key;
}

export type FloorId = 'matte' | 'lacquer' | 'wet';
export const FLOORS: Record<FloorId, string> = { matte: 'Mat', lacquer: 'Laqué', wet: 'Mouillé' };

/** Mirror just above the deck (and thrust) for a glossy floor; null for a matte floor. Costs one extra render. */
export function buildFloorReflector(floor: FloorId, stage: StageGeometry, pixelSize: THREE.Vector2): THREE.Group | null {
  if (floor === 'matte') return null;
  const g = new THREE.Group();
  const color = floor === 'wet' ? 0x5d6675 : 0x30343e;
  const opts = { color, textureWidth: Math.max(256, pixelSize.x / 2), textureHeight: Math.max(256, pixelSize.y / 2), clipBias: 0.003 };
  const add = (w: number, d: number, z: number) => {
    const m = new Reflector(new THREE.PlaneGeometry(w, d), opts);
    m.rotation.x = -Math.PI / 2;
    m.position.set(0, 0.001, z);
    g.add(m);
  };
  add(stage.width, stage.depth, -stage.depth / 2);
  if (stage.thrust) add(stage.thrust.width, stage.thrust.depth, stage.thrust.depth / 2);
  return g;
}

export function disposeReflector(g: THREE.Group): void {
  g.traverse((o) => { if (o instanceof Reflector) o.dispose(); });
}
