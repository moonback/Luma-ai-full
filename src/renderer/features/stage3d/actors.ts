import * as THREE from 'three';
import type { Performer, StageMarker, StageProp, StageScreen } from '../../../core/model/schemas';
import type { VisualFixture } from '../../../core/visualizer/model';
import { floorAt, performerLight, performerSpot } from '../../../core/visualizer/lighting';
import { textures } from './textures';
import { labelSprite } from './rig';
import { screenVideo } from '../../screenMedia';

/**
 * Performers / instruments (simple silhouettes tinted by the light they receive) and LED screens (colour, image,
 * session video or pixel mapping of the multi-cell fixtures) with a soft spill light. Visual aid only.
 */

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ */
/* Performers                                                          */
/* ------------------------------------------------------------------ */

export interface PerformerRig { id: string; group: THREE.Group; skin: THREE.MeshStandardMaterial; gear: THREE.MeshStandardMaterial }

function person(g: THREE.Group, mat: THREE.Material, seated: boolean, z = 0): void {
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, seated ? 0.42 : 0.9, 4, 12), mat);
  body.position.set(0, seated ? 0.82 : 0.93, z);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), mat);
  head.position.set(0, seated ? 1.18 : 1.62, z);
  g.add(body, head);
}

function box(g: THREE.Group, mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  g.add(m);
  return m;
}

function drum(g: THREE.Group, mat: THREE.Material, r: number, h: number, x: number, y: number, z: number, lying = false): void {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 20), mat);
  m.position.set(x, y, z);
  if (lying) m.rotation.x = Math.PI / 2;
  g.add(m);
}

export function buildPerformer(p: Performer): PerformerRig {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0x3a404d, roughness: 0.8 });
  const gear = new THREE.MeshStandardMaterial({ color: 0x1d222c, roughness: 0.5, metalness: 0.3 });
  // Local +z faces the audience at rotation 0, like the fixtures.
  switch (p.kind) {
    case 'seated': box(g, gear, 0.45, 0.45, 0.45, 0, 0.225, 0); person(g, skin, true); break;
    case 'drums':
      box(g, gear, 0.38, 0.5, 0.38, 0, 0.25, -0.15); person(g, skin, true, -0.15);
      drum(g, gear, 0.28, 0.4, 0, 0.3, 0.45, true);
      drum(g, gear, 0.17, 0.14, 0.32, 0.65, 0.25);
      drum(g, gear, 0.14, 0.18, -0.25, 0.85, 0.35);
      for (const x of [-0.55, 0.6]) drum(g, gear, 0.24, 0.01, x, 1.15, 0.2);
      break;
    case 'keys':
      person(g, skin, false, -0.35);
      box(g, gear, 1.25, 0.08, 0.36, 0, 0.95, 0.1);
      for (const x of [-0.45, 0.45]) box(g, gear, 0.04, 0.9, 0.04, x, 0.45, 0.1);
      break;
    case 'lectern': {
      person(g, skin, false, -0.4);
      const desk = box(g, gear, 0.55, 1.1, 0.4, 0, 0.55, 0.12);
      desk.rotation.x = -0.05;
      break;
    }
    default: person(g, skin, false);
  }
  const tag = labelSprite(p.name);
  tag.position.set(0, p.kind === 'seated' || p.kind === 'drums' ? 1.55 : 2, 0);
  tag.visible = false;
  tag.name = 'tag';
  g.add(tag);
  g.traverse((o) => { if (o instanceof THREE.Mesh) { o.castShadow = true; o.receiveShadow = true; } });
  return { id: p.id, group: g, skin, gear };
}

/**
 * Pose and tint. In the fast mode (no real lights) the received light is shown as emissive colour; with real lights
 * the scene lights do it and the emissive stays black.
 */
export function updatePerformer(r: PerformerRig, p: Performer, markers: readonly StageMarker[], fixtures: readonly VisualFixture[], o: { realLights: boolean; labels: boolean }, props: readonly StageProp[] = []): void {
  const s = performerSpot(p, markers);
  r.group.position.set(s.x, floorAt(s.x, s.y, props), -s.y);
  r.group.rotation.y = p.rotation * DEG;
  const tag = r.group.getObjectByName('tag');
  if (tag) tag.visible = o.labels;
  if (o.realLights) { r.skin.emissive.setRGB(0, 0, 0); r.gear.emissive.setRGB(0, 0, 0); return; }
  const l = performerLight(p, markers, fixtures, props);
  r.skin.emissive.setRGB(l.r * 0.85, l.g * 0.85, l.b * 0.85);
  r.gear.emissive.setRGB(l.r * 0.45, l.g * 0.45, l.b * 0.45);
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

export interface ScreenRig {
  key: string;
  group: THREE.Group;
  face: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  halo: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  light: THREE.PointLight;
  canvas?: HTMLCanvasElement;
  video?: HTMLVideoElement;
  /** Average colour of the content (drives the spill light and the halo). */
  avg: THREE.Color;
  frame: number;
}

/** Changes of these fields rebuild the screen; the rest is updated per frame. */
export const screenKey = (s: StageScreen) => `${s.source}|${s.source === 'image' ? (s.image ?? '').length : ''}|${s.source === 'video' ? screenVideo(s.id) ?? '' : ''}`;

const sampler = (() => {
  let c: CanvasRenderingContext2D | null = null;
  return (src: CanvasImageSource, out: THREE.Color) => {
    c ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
    if (!c) return;
    try {
      c.drawImage(src, 0, 0, 1, 1);
      const d = c.getImageData(0, 0, 1, 1).data;
      out.setRGB(d[0]! / 255, d[1]! / 255, d[2]! / 255, THREE.SRGBColorSpace);
    } catch {
      // media not ready yet
    }
  };
})();

export function buildScreen(s: StageScreen): ScreenRig {
  const g = new THREE.Group();
  const face = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
  const back = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.6 }));
  back.name = 'back';
  back.castShadow = true;
  back.receiveShadow = true;
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: textures().pool, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  halo.renderOrder = 3;
  const light = new THREE.PointLight(0xffffff, 0, 8, 1.5);
  g.add(back, face, halo, light);
  const rig: ScreenRig = { key: screenKey(s), group: g, face, halo, light, avg: new THREE.Color(0, 0, 0), frame: 0 };
  if (s.source === 'image' && s.image) {
    const img = new Image();
    const tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace;
    img.onload = () => { tex.needsUpdate = true; sampler(img, rig.avg); };
    img.src = s.image;
    face.material.map = tex;
  } else if (s.source === 'video' && screenVideo(s.id)) {
    const v = Object.assign(document.createElement('video'), { src: screenVideo(s.id)!, muted: true, loop: true, playsInline: true });
    void v.play().catch(() => undefined);
    const tex = new THREE.VideoTexture(v);
    tex.colorSpace = THREE.SRGBColorSpace;
    face.material.map = tex;
    rig.video = v;
  } else if (s.source === 'pixels') {
    rig.canvas = document.createElement('canvas');
    const tex = new THREE.CanvasTexture(rig.canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    face.material.map = tex;
  }
  return rig;
}

/** Pixel mapping: one row per multi-cell fixture (LED bars, matrices), cells left to right. */
function drawPixels(c: HTMLCanvasElement, fixtures: readonly VisualFixture[], avg: THREE.Color): void {
  const rows = fixtures.filter((f) => f.cells.length > 1);
  const cols = Math.max(1, ...rows.map((f) => f.cells.length));
  if (c.width !== cols || c.height !== Math.max(1, rows.length)) { c.width = cols; c.height = Math.max(1, rows.length); }
  const g = c.getContext('2d')!;
  g.fillStyle = '#05060a';
  g.fillRect(0, 0, c.width, c.height);
  let r = 0, gg = 0, b = 0, n = 0;
  rows.forEach((f, y) => f.cells.forEach((hex, x) => {
    g.fillStyle = hex;
    g.fillRect(x, y, 1, 1);
    const v = parseInt(hex.slice(1), 16);
    r += (v >> 16) & 255; gg += (v >> 8) & 255; b += v & 255; n++;
  }));
  avg.setRGB(n ? r / n / 255 : 0, n ? gg / n / 255 : 0, n ? b / n / 255 : 0, THREE.SRGBColorSpace);
}

export function updateScreen(r: ScreenRig, s: StageScreen, fixtures: readonly VisualFixture[], haze: number): void {
  r.group.position.set(s.x, s.elevation + s.height / 2, -s.y);
  r.group.rotation.y = s.rotation * DEG;
  r.face.scale.set(s.width, s.height, 1);
  r.face.position.z = 0.051;
  const back = r.group.getObjectByName('back')!;
  back.scale.set(s.width + 0.1, s.height + 0.1, 0.1);
  if (s.source === 'color') {
    r.face.material.color.set(s.color);
    r.avg.set(s.color);
  } else {
    r.face.material.color.set(r.face.material.map ? 0xffffff : 0x111318); // video not chosen in this session: dark
    if (s.source === 'pixels' && r.canvas) {
      drawPixels(r.canvas, fixtures, r.avg);
      if (r.face.material.map) r.face.material.map.needsUpdate = true;
    }
    if (r.video && r.frame++ % 15 === 0) sampler(r.video, r.avg);
  }
  // Spill: point light in front of the screen and a soft additive halo catching the haze.
  r.light.color.copy(r.avg);
  r.light.position.set(0, 0, 0.8);
  const level = Math.max(r.avg.r, r.avg.g, r.avg.b);
  r.light.intensity = s.glow * level * 6 * Math.sqrt(s.width * s.height);
  r.halo.position.z = 0.07;
  r.halo.scale.set(s.width * 1.6, s.height * 1.6, 1);
  r.halo.material.color.copy(r.avg).multiplyScalar(s.glow * (0.15 + haze * 0.35));
}

export function disposeScreen(r: ScreenRig): void {
  r.video?.pause();
  r.group.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.MeshBasicMaterial | undefined;
    if (mat?.map && mat.map !== textures().pool) mat.map.dispose();
    mat?.dispose?.();
  });
}
