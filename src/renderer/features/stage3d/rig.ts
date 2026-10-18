import * as THREE from 'three';
import type { VisualFixture } from '../../../core/visualizer/model';
import { beamHit, mountSign, rigAngles, beamLength, flickerOn, poolShape, type StageGeometry } from '../../../core/visualizer/beam';
import { textures } from './textures';

/**
 * Articulated fixture rigs. Hierarchy: root (mount position, yaw then mount tilt) → yoke (pan) → head (tilt) → lens.
 * The lens points along s·Y in head space (s = −1 hung or on a wall, +1 floor) so the world beam matches `beamDirection()`.
 */

/* ------------------------------------------------------------------ */
/* Volumetric beam shader                                              */
/* ------------------------------------------------------------------ */

const BEAM_VERT = /* glsl */ `
  varying float vLen;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vWorld;
  void main() {
    vLen = -position.y;                       // 0 at the lens, 1 at the far end
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vView = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }`;
const BEAM_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  uniform float uHaze;
  uniform float uTime;
  varying float vLen;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec3 vWorld;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  void main() {
    // Drifting haze: two octaves of value noise in world space, slowly rising and moving stage left.
    vec3 q = vWorld * 0.45 + vec3(uTime * 0.07, -uTime * 0.05, uTime * 0.03);
    float drift = 0.6 + 0.8 * (0.65 * noise(q) + 0.35 * noise(q * 2.3 + 17.0));
    // Soft edges: brighter where we look through the beam's thickness (view-dependent rim trick).
    float edge = pow(abs(dot(normalize(vNormal), normalize(vView))), 1.2);
    // Bright near the source, fading with distance; quick fade-in right at the lens.
    float along = pow(clamp(1.0 - vLen, 0.0, 1.0), 1.3) * smoothstep(0.0, 0.03, vLen);
    // Hot core near the lens so narrow beams stay readable.
    float core = exp(-vLen * 6.0) * 0.6;
    float a = uIntensity * uHaze * (edge * along * 1.5 * drift + core);
    gl_FragColor = vec4(uColor * a, a);
  }`;

export function beamMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uIntensity: { value: 0 }, uHaze: { value: 0.5 }, uTime: { value: 0 } },
    vertexShader: BEAM_VERT,
    fragmentShader: BEAM_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/* ------------------------------------------------------------------ */
/* Shared geometries                                                   */
/* ------------------------------------------------------------------ */

let geo: Record<string, THREE.BufferGeometry> | null = null;
function geometries() {
  if (!geo) {
    const cone = new THREE.ConeGeometry(1, 1, 40, 1, true);
    cone.translate(0, -0.5, 0); // apex at origin, opening towards −y
    geo = {
      cone,
      pool: new THREE.PlaneGeometry(2, 2),
      base: new THREE.BoxGeometry(0.38, 0.12, 0.3),
      arm: new THREE.BoxGeometry(0.05, 0.34, 0.07),
      headMover: new THREE.CylinderGeometry(0.15, 0.12, 0.34, 24),
      lensMover: new THREE.CircleGeometry(0.11, 24),
      can: new THREE.CylinderGeometry(0.13, 0.11, 0.26, 20),
      lensCan: new THREE.CircleGeometry(0.1, 20),
      bracket: new THREE.TorusGeometry(0.15, 0.012, 6, 24, Math.PI),
      strobe: new THREE.BoxGeometry(0.42, 0.12, 0.16),
      lensStrobe: new THREE.PlaneGeometry(0.36, 0.08),
      ring: new THREE.RingGeometry(0.3, 0.36, 32),
    };
  }
  return geo;
}

const bodyMaterial = () => new THREE.MeshStandardMaterial({ color: 0x1c2230, roughness: 0.55, metalness: 0.45 });

/* ------------------------------------------------------------------ */
/* Rig                                                                 */
/* ------------------------------------------------------------------ */

interface BeamUnit {
  cone: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  pool: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  lens: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  /** Cell index (multi-cell bars) or -1. */
  cell: number;
  /** Prism facet angle around the head's local z (radians), 0 for the main beam. */
  facet: number;
}

export interface Rig {
  key: string;
  root: THREE.Group;
  yoke: THREE.Group;
  head: THREE.Group;
  bodies: THREE.Mesh[];
  beams: BeamUnit[];
  ring: THREE.Mesh;
  /** LED rings around the lens (ring modules), one per VisualFixture.rings entry. */
  leds: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[];
  label: THREE.Sprite;
}

/** Changes in these properties need a rebuild of the rig (structure), everything else is updated per frame. */
export const rigKey = (f: VisualFixture) => `${f.type}|${f.movable}|${f.mount}|${f.cells.length}|${f.rings.length}|${f.prism}`;

export function labelSprite(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 48;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(11,13,18,0.75)';
  g.beginPath();
  g.roundRect(2, 6, 252, 36, 8);
  g.fill();
  g.fillStyle = '#f2f5fa';
  g.font = '600 22px "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text.length > 18 ? `${text.slice(0, 17)}…` : text, 128, 25);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(1.1, 0.2, 1);
  s.renderOrder = 10;
  return s;
}

export function buildRig(f: VisualFixture, scene: THREE.Scene): Rig {
  const g = geometries();
  const s = mountSign(f.mount);
  const root = new THREE.Group();
  root.rotation.order = 'YXZ'; // matches beamDirection(): Ry(yaw)·Rx(mount tilt)
  const yoke = new THREE.Group();
  const head = new THREE.Group();
  root.add(yoke);
  const bodies: THREE.Mesh[] = [];
  const addBody = (mesh: THREE.Mesh, parent: THREE.Object3D) => {
    mesh.userData.fixtureId = f.id;
    bodies.push(mesh);
    parent.add(mesh);
    return mesh;
  };
  let lensGeo: THREE.BufferGeometry = g.lensCan!;
  let lensOffset = 0.14;
  const cellXs: number[] = [];

  if (f.movable) {
    addBody(new THREE.Mesh(g.base!, bodyMaterial()), root);
    for (const x of [-0.19, 0.19]) {
      const arm = addBody(new THREE.Mesh(g.arm!, bodyMaterial()), yoke);
      arm.position.set(x, s * 0.2, 0);
    }
    head.position.set(0, s * 0.3, 0);
    addBody(new THREE.Mesh(g.headMover!, bodyMaterial()), head).rotation.x = s < 0 ? Math.PI : 0;
    lensGeo = g.lensMover!;
    lensOffset = 0.175;
  } else if (f.cells.length || f.type === 'led-bar') {
    const len = Math.max(0.6, Math.max(1, f.cells.length) * 0.15);
    const bar = addBody(new THREE.Mesh(new THREE.BoxGeometry(len, 0.09, 0.12), bodyMaterial()), head);
    bar.position.y = s * 0.05;
    head.position.set(0, s * 0.05, 0);
    lensGeo = new THREE.PlaneGeometry((len / Math.max(1, f.cells.length)) * 0.8, 0.08);
    lensOffset = 0.1;
    const n = Math.max(1, f.cells.length);
    for (let i = 0; i < n; i++) cellXs.push(-len / 2 + (len / n) * (i + 0.5));
  } else if (f.type === 'strobe') {
    head.position.set(0, s * 0.12, 0);
    addBody(new THREE.Mesh(g.strobe!, bodyMaterial()), head);
    lensGeo = g.lensStrobe!;
    lensOffset = 0.07;
  } else {
    const bracket = addBody(new THREE.Mesh(g.bracket!, bodyMaterial()), yoke);
    bracket.rotation.set(0, Math.PI / 2, s < 0 ? Math.PI : 0);
    head.position.set(0, s * 0.12, 0);
    addBody(new THREE.Mesh(g.can!, bodyMaterial()), head);
  }
  yoke.add(head);

  const beams: BeamUnit[] = [];
  const makeBeam = (x: number, cell: number, facet: number) => {
    const lens = new THREE.Mesh(lensGeo, new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide }));
    lens.position.set(x, s * lensOffset, 0);
    lens.rotation.x = Math.PI / 2;
    head.add(lens);
    const cone = new THREE.Mesh(g.cone!, beamMaterial());
    cone.position.set(x, s * lensOffset, 0);
    if (s > 0) cone.rotation.x = Math.PI; // floor: open towards +y
    cone.rotateZ(facet);
    cone.frustumCulled = false;
    head.add(cone);
    const pool = new THREE.Mesh(g.pool!, new THREE.MeshBasicMaterial({ map: textures().pool, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -2 }));
    pool.renderOrder = 2;
    scene.add(pool);
    beams.push({ cone, pool, lens, cell, facet });
  };
  if (cellXs.length && f.cells.length) cellXs.forEach((x, i) => makeBeam(x, i, 0));
  else {
    makeBeam(0, -1, 0);
    if (f.prism) for (const a of [-0.16, 0.16]) makeBeam(0, -1, a);
  }

  // A ring module is drawn as a glowing ring around the lens, not as a second beam.
  const leds = f.rings.map((_, i) => {
    const led = new THREE.Mesh(new THREE.RingGeometry(0.115 + i * 0.03, 0.14 + i * 0.03, 32), new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide }));
    led.position.set(0, s * (lensOffset + 0.002), 0);
    led.rotation.x = Math.PI / 2;
    head.add(led);
    return led;
  });

  const ring = new THREE.Mesh(g.ring!, new THREE.MeshBasicMaterial({ color: 0x8b5cf6, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
  ring.rotation.x = Math.PI / 2;
  ring.renderOrder = 9;
  root.add(ring);
  const label = labelSprite(f.name);
  label.position.set(0, -s * 0.45, 0);
  root.add(label);
  scene.add(root);
  return { key: rigKey(f), root, yoke, head, bodies, beams, ring, leds, label };
}

export function disposeRig(r: Rig, scene: THREE.Scene): void {
  scene.remove(r.root);
  for (const b of r.beams) {
    scene.remove(b.pool);
    b.cone.material.dispose();
    b.pool.material.dispose();
    b.lens.material.dispose();
  }
  r.root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (m && !r.beams.some((b) => b.cone.material === m || b.lens.material === m)) m.dispose();
  });
  (r.label.material as THREE.SpriteMaterial).map?.dispose();
}

export interface FrameOptions {
  time: number;
  haze: number;
  pools: boolean;
  labels: boolean;
  selected: boolean;
  dimmed: boolean;
  stage: StageGeometry;
}

const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpDir = new THREE.Vector3();

function colorOf(hex: string): { color: THREE.Color; level: number } {
  const c = new THREE.Color(hex);
  const level = Math.max(c.r, c.g, c.b);
  if (level > 0) c.multiplyScalar(1 / level);
  return { color: c, level };
}

/** Per-frame update: pose, beam colours/lengths, light pools on floor and back wall, strobe flashes. */
export function updateRig(r: Rig, f: VisualFixture, o: FrameOptions): void {
  r.root.position.set(f.x, f.height, -f.y);
  const a = rigAngles(f);
  r.root.rotation.y = a.yaw;
  r.root.rotation.x = a.tilt;
  r.yoke.rotation.y = a.pan;
  r.head.rotation.x = a.head;
  r.root.updateMatrixWorld(true);
  r.ring.visible = o.selected;
  r.label.visible = o.labels || o.selected;
  for (const b of r.bodies) (b.material as THREE.MeshStandardMaterial).emissive.set(o.selected ? 0x2a1a55 : 0x000000);

  const flash = flickerOn(o.time, f.strobeHz) ? 1 : 0;
  r.leds.forEach((led, i) => {
    const { color, level } = colorOf(f.rings[i] ?? '#000000');
    led.material.color.copy(color).multiplyScalar(Math.min(1, level * (o.dimmed ? 0.25 : 1) * 1.4));
  });
  const base = colorOf(f.color);
  for (const b of r.beams) {
    const cellHex = b.cell >= 0 ? f.cells[b.cell] : undefined;
    const { color, level } = cellHex ? colorOf(cellHex) : { color: base.color, level: f.intensity };
    const intensity = level * flash * (o.dimmed ? 0.25 : 1) * (b.facet ? 0.6 : 1);
    b.lens.material.color.copy(color).multiplyScalar(Math.min(1, 0.15 + intensity * 1.6));
    // World ray of this beam.
    b.cone.getWorldPosition(tmpV);
    b.cone.getWorldQuaternion(tmpQ);
    tmpDir.set(0, -1, 0).applyQuaternion(tmpQ).normalize();
    const hit = beamHit({ x: tmpV.x, y: tmpV.y, z: tmpV.z }, { x: tmpDir.x, y: tmpDir.y, z: tmpDir.z }, o.stage);
    const angle = b.cell >= 0 ? Math.min(f.beamAngle, 20) : f.beamAngle;
    const length = beamLength(hit);
    const radius = length * Math.tan(THREE.MathUtils.degToRad(angle / 2));
    b.cone.scale.set(Math.max(0.01, radius), length, Math.max(0.01, radius));
    const u = b.cone.material.uniforms;
    u.uColor!.value.copy(color);
    // Narrow beams cover few pixels: compensate so a 10° spot reads like a 30° wash in haze (visual only).
    u.uIntensity!.value = intensity * Math.min(2.5, Math.max(1, Math.sqrt(30 / angle)));
    u.uHaze!.value = o.haze;
    u.uTime!.value = o.time;
    b.cone.visible = intensity > 0.005 && o.haze > 0.01;

    const showPool = o.pools && hit !== null && intensity > 0.005;
    b.pool.visible = showPool;
    if (showPool && hit) {
      const shape = poolShape(hit, { x: tmpDir.x, y: tmpDir.y, z: tmpDir.z }, angle);
      const n = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
      b.pool.position.set(hit.point.x, hit.point.y, hit.point.z).addScaledVector(n, 0.01);
      b.pool.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      // Stretch along the projected beam direction.
      const local = tmpDir.clone().applyQuaternion(b.pool.quaternion.clone().invert());
      b.pool.rotateZ(Math.atan2(local.y, local.x));
      b.pool.scale.set(shape.radius * shape.stretch, shape.radius, 1);
      b.pool.material.map = f.gobo && b.cell < 0 ? textures().gobo(f.gobo) : textures().pool;
      b.pool.material.color.copy(color).multiplyScalar(Math.min(1.5, intensity * shape.falloff * 1.4));
    }
  }
}
