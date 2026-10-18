import * as THREE from 'three';
import type { VisualFixture } from '../../../core/visualizer/model';
import type { StageGeometry } from '../../../core/visualizer/beam';
import type { Project, StageMarker, StageProp, Truss } from '../../../core/model/schemas';
import { JUNCTION_ARMS, trussSupports } from '../../../core/visualizer/truss';
import { labelSprite } from './rig';

/**
 * Stage set: deck, back wall (cyclorama catching the light), wings, audience floor, and box trusses built from
 * the scene (`visualizer.trusses`): adding fixtures to the patch never adds a truss.
 */
export function stageGeometry(vis: Project['visualizer'], fixtures: readonly VisualFixture[]): StageGeometry {
  const top = Math.max(0, ...fixtures.map((f) => f.height));
  return {
    width: vis.stageWidth,
    depth: vis.stageDepth,
    wallHeight: Math.max(6, Math.ceil(top + 2)),
    wall: vis.cyclo && vis.shape !== 'arena',
    thrust: vis.shape === 'thrust' ? vis.thrust : null,
    arena: vis.shape === 'arena',
    props: vis.props,
  };
}

function boxTruss(length: number, mat: THREE.Material, lattice: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const w = 0.29;
  const chord = new THREE.CylinderGeometry(0.024, 0.024, length, 8);
  chord.rotateZ(Math.PI / 2);
  for (const [y, z] of [[w / 2, w / 2], [w / 2, -w / 2], [-w / 2, w / 2], [-w / 2, -w / 2]] as const) {
    const m = new THREE.Mesh(chord, mat);
    m.position.set(0, y, z);
    g.add(m);
  }
  // Zig-zag lattice on the four faces (cheap line segments).
  const pts: number[] = [];
  const steps = Math.max(2, Math.round(length / 0.5));
  for (let i = 0; i < steps; i++) {
    const x0 = -length / 2 + (i * length) / steps, x1 = -length / 2 + ((i + 1) * length) / steps;
    const zag = (a: [number, number], b: [number, number]) => pts.push(x0, a[0], a[1], x1, b[0], b[1]);
    const h = w / 2;
    if (i % 2) { zag([h, h], [-h, h]); zag([h, -h], [-h, -h]); zag([h, h], [h, -h]); zag([-h, h], [-h, -h]); }
    else { zag([-h, h], [h, h]); zag([-h, -h], [h, -h]); zag([h, -h], [h, h]); zag([-h, -h], [-h, h]); }
  }
  const lines = new THREE.BufferGeometry();
  lines.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  g.add(new THREE.LineSegments(lines, lattice));
  return g;
}

/** Name of the 3D group of an explicit truss (picked and moved by the editor). */
export const trussObjectName = (id: string) => `truss:${id}`;

/** One explicit truss, built around its centre at the truss height; every mesh carries `userData.trussId` for picking. */
function buildTruss(t: Truss, selected: boolean): THREE.Group {
  const g = new THREE.Group();
  g.name = trussObjectName(t.id);
  g.position.set(t.x, t.height, -t.y);
  g.rotation.y = THREE.MathUtils.degToRad(t.rotation);
  const mat = new THREE.MeshStandardMaterial({ color: 0x9aa3b5, metalness: 0.85, roughness: 0.3, emissive: selected ? 0x3b1f8a : 0x000000 });
  const lattice = new THREE.LineBasicMaterial({ color: selected ? 0xa78bfa : 0x6b7385 });
  const r = t.length / 2;
  const add = (o: THREE.Object3D, x: number, z: number, rotY: number) => { o.position.set(x, 0, z); o.rotation.y = rotY; g.add(o); };
  const arms = JUNCTION_ARMS[t.shape];
  if (arms) {
    // Junction: a node block plus one arm per direction (local x rotated by the arm angle, stage y = -z).
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.31, 0.31), mat));
    for (const deg of arms) {
      const a = THREE.MathUtils.degToRad(deg);
      add(boxTruss(t.length, mat, lattice), Math.cos(a) * r, -Math.sin(a) * r, a);
    }
  } else if (t.shape === 'totem') {
    // Vertical tower from the floor to the truss height, with a base plate and a top plate.
    const tower = boxTruss(t.height, mat, lattice);
    tower.rotation.z = Math.PI / 2;
    tower.position.set(0, -t.height / 2, 0);
    g.add(tower);
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.02, 0.6), mat);
    base.position.y = 0.01 - t.height;
    g.add(base, new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.02, 0.34), mat));
  } else if (t.shape === 'line') add(boxTruss(t.length, mat, lattice), 0, 0, 0);
  else if (t.shape === 'square') {
    add(boxTruss(t.length, mat, lattice), 0, r, 0);
    add(boxTruss(t.length, mat, lattice), 0, -r, 0);
    add(boxTruss(t.length, mat, lattice), r, 0, Math.PI / 2);
    add(boxTruss(t.length, mat, lattice), -r, 0, Math.PI / 2);
  } else {
    const n = 16;
    const chord = 2 * r * Math.sin(Math.PI / n);
    for (let i = 0; i < n; i++) {
      const a = ((i + 0.5) * 2 * Math.PI) / n;
      const mid = r * Math.cos(Math.PI / n);
      // Local x of the segment along the tangent of the circle.
      add(boxTruss(chord + 0.05, mat, lattice), mid * Math.cos(a), mid * Math.sin(a), -(a + Math.PI / 2));
    }
  }
  // Supports in the truss frame (trussSupports gives stage coordinates: undo the placement).
  const inv = new THREE.Matrix4().compose(g.position, new THREE.Quaternion().setFromEuler(g.rotation), new THREE.Vector3(1, 1, 1)).invert();
  for (const p of t.shape === 'totem' ? [] : trussSupports(t)) {
    const local = new THREE.Vector3(p.x, t.height, -p.y).applyMatrix4(inv);
    if (t.support === 'towers') {
      const tower = boxTruss(t.height + 0.35, mat, lattice);
      tower.rotation.z = Math.PI / 2;
      tower.position.set(local.x, (0.35 - t.height) / 2, local.z);
      g.add(tower);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.03, 0.7), mat);
      foot.position.set(local.x, 0.015 - t.height, local.z);
      g.add(foot);
    } else {
      // Chain hoist: motor body and chain up to the grid.
      const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 3, 6), mat);
      chain.position.set(local.x, 1.7, local.z);
      g.add(chain);
      const motor = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.32, 0.22), mat);
      motor.position.set(local.x, 0.45, local.z);
      g.add(motor);
    }
  }
  g.traverse((o) => { o.userData.trussId = t.id; });
  return g;
}

/** Name of the 3D group of a set piece (picked and moved by the editor). */
export const propObjectName = (id: string) => `prop:${id}`;

/** One set piece, built on its footprint centre at its elevation; every mesh carries `userData.propId` for picking. */
function buildProp(p: StageProp, selected: boolean): THREE.Group {
  const g = new THREE.Group();
  g.name = propObjectName(p.id);
  g.position.set(p.x, p.elevation, -p.y);
  g.rotation.y = THREE.MathUtils.degToRad(p.rotation);
  const mat = new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.8, metalness: 0.1, emissive: selected ? 0x3b1f8a : 0x000000 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x24272e, roughness: 0.9, emissive: selected ? 0x3b1f8a : 0x000000 });
  const { width: w, depth: d, height: h } = p;
  const box = (bw: number, bh: number, bd: number, x: number, y: number, z: number, m: THREE.Material = mat) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), m);
    o.position.set(x, y, z);
    g.add(o);
    return o;
  };
  switch (p.kind) {
    case 'stairs': {
      // Steps rising upstage (local -z), about 18 cm each.
      const n = Math.max(2, Math.round(h / 0.18));
      for (let i = 0; i < n; i++) box(w, (h * (i + 1)) / n, d / n, 0, (h * (i + 1)) / n / 2, d / 2 - ((i + 0.5) * d) / n);
      break;
    }
    case 'speaker':
      box(w, h, d, 0, h / 2, 0);
      box(w * 0.86, h * 0.9, 0.01, 0, h / 2, d / 2 + 0.006, dark); // front grille, towards the audience at 0°
      break;
    case 'monitor': {
      // Wedge: high at the back, sloped face towards local +z.
      const s = new THREE.Shape([new THREE.Vector2(-d / 2, 0), new THREE.Vector2(d / 2, 0), new THREE.Vector2(-d / 2, h)]);
      const geo = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false });
      geo.rotateY(Math.PI / 2);
      geo.translate(-w / 2, 0, 0);
      g.add(new THREE.Mesh(geo, mat));
      break;
    }
    case 'mic': {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, 0.02, 20), mat);
      base.position.y = 0.01;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, h, 8), mat);
      pole.position.y = h / 2;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), dark);
      head.position.set(0, h, 0.06);
      g.add(base, pole, head);
      break;
    }
    case 'table':
      box(w, 0.05, d, 0, h - 0.025, 0);
      for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) box(0.05, h - 0.05, 0.05, (x * (w - 0.1)) / 2, (h - 0.05) / 2, (z * (d - 0.1)) / 2, dark);
      break;
    case 'drape': {
      // Folded cloth: a vertical sheet waved along its width.
      const geo = new THREE.PlaneGeometry(w, h, Math.max(8, Math.round(w * 8)), 1);
      const pos = geo.attributes.position!;
      for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin(pos.getX(i) * 9) * Math.min(0.08, d));
      geo.computeVertexNormals();
      const cloth = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: p.color, roughness: 1, side: THREE.DoubleSide, emissive: selected ? 0x3b1f8a : 0x000000 }));
      cloth.position.y = h / 2;
      g.add(cloth);
      break;
    }
    case 'column': {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, h, 24), mat);
      c.position.y = h / 2;
      g.add(c);
      break;
    }
    default: {
      // Riser and box: a solid block; a riser gets a light edge so its outline reads in the dark.
      const b = box(w, h, d, 0, h / 2, 0);
      if (p.kind === 'riser') b.add(new THREE.LineSegments(new THREE.EdgesGeometry(b.geometry), new THREE.LineBasicMaterial({ color: selected ? 0xa78bfa : 0x4b5570 })));
    }
  }
  g.traverse((o) => { o.userData.propId = p.id; });
  return g;
}

export function buildEnvironment(
  stage: StageGeometry,
  markers: readonly StageMarker[] = [],
  trusses: readonly Truss[] = [],
  selected: string | null = null,
  props: readonly StageProp[] = [],
): THREE.Group {
  const env = new THREE.Group();
  const { width: W, depth: D, wallHeight: H } = stage;

  const deckMat = new THREE.MeshStandardMaterial({ color: 0x14171f, roughness: 0.85, metalness: 0.05 });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(W, 1, D), deckMat);
  deck.position.set(0, -0.5, -D / 2);
  env.add(deck);
  const lip = new THREE.Mesh(new THREE.BoxGeometry(W, 0.04, 0.04), new THREE.MeshBasicMaterial({ color: 0x8b5cf6 }));
  lip.position.set(0, 0.01, 0);
  env.add(lip);
  const grid = new THREE.GridHelper(Math.max(W, D), Math.max(W, D), 0x232a3a, 0x1a2030);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.5;
  grid.position.set(0, 0.002, -D / 2);
  grid.scale.set(W / Math.max(W, D), 1, D / Math.max(W, D));
  env.add(grid);

  if (stage.thrust) {
    const { width: tw, depth: td } = stage.thrust;
    const runway = new THREE.Mesh(new THREE.BoxGeometry(tw, 1, td), deckMat);
    runway.position.set(0, -0.5, td / 2);
    env.add(runway);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(tw, td)),
      new THREE.LineBasicMaterial({ color: 0x8b5cf6 }),
    );
    edges.rotation.x = -Math.PI / 2;
    edges.position.set(0, 0.01, td / 2);
    env.add(edges);
  }

  // Audience floor, slightly lower and darker: in front of the stage, or all around in arena.
  const house = new THREE.Mesh(
    stage.arena ? new THREE.PlaneGeometry(W + 20, D + 30) : new THREE.PlaneGeometry(W + 20, 16),
    new THREE.MeshStandardMaterial({ color: 0x0c0e14, roughness: 1 }),
  );
  house.rotation.x = -Math.PI / 2;
  house.position.set(0, -0.001, stage.arena ? -D / 2 : 8);
  env.add(house);

  if (stage.wall !== false && !stage.arena) {
    // Cyclorama: matte light-grey surface so beams hitting it read clearly.
    const cyc = new THREE.Mesh(new THREE.PlaneGeometry(W + 2, H), new THREE.MeshStandardMaterial({ color: 0x23293a, roughness: 0.95 }));
    cyc.position.set(0, H / 2, -D);
    env.add(cyc);
  }
  if (!stage.arena) {
    const wingMat = new THREE.MeshStandardMaterial({ color: 0x0a0b10, roughness: 1, side: THREE.DoubleSide });
    for (const x of [-W / 2 - 0.5, W / 2 + 0.5]) {
      const wing = new THREE.Mesh(new THREE.PlaneGeometry(D, H), wingMat);
      wing.rotation.y = Math.PI / 2;
      wing.position.set(x, H / 2, -D / 2);
      env.add(wing);
    }
  }

  // Stage points: floor disc, thin pole up to the aiming height, name tag.
  const markMat = new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
  for (const m of markers) {
    const disc = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.24, 24), markMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(m.x, 0.012, -m.y);
    env.add(disc);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, Math.max(0.01, m.height), 6), markMat);
    pole.position.set(m.x, m.height / 2, -m.y);
    env.add(pole);
    const tag = labelSprite(m.name);
    tag.position.set(m.x, m.height + 0.25, -m.y);
    env.add(tag);
  }

  for (const t of trusses) env.add(buildTruss(t, t.id === selected));
  for (const p of props) env.add(buildProp(p, p.id === selected));

  return env;
}

const FOG_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uDensity;
  uniform float uLayer;
  varying vec2 vUv;
  varying vec3 vWorld;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  void main() {
    vec2 p = vWorld.xz * 0.35 + vec2(uTime * 0.05, uTime * 0.02) + uLayer * 7.0;
    float n = 0.6 * noise(p) + 0.4 * noise(p * 2.7 - uTime * 0.04);
    // Fade towards the plane borders so the sheet has no visible edge.
    float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x) * smoothstep(0.0, 0.18, vUv.y) * smoothstep(1.0, 0.82, vUv.y);
    float a = uDensity * smoothstep(0.3, 0.85, n) * edge * (0.28 - uLayer * 0.08);
    gl_FragColor = vec4(vec3(0.42, 0.46, 0.56), a);
  }`;
const FOG_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

/** Low smoke (heavy fog machine): three stacked noise sheets just above the floor. Animate with `setLowFog`. */
export function buildLowFog(stage: StageGeometry): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.PlaneGeometry(stage.width + 6, stage.depth + (stage.thrust?.depth ?? 0) + 6);
  for (let i = 0; i < 3; i++) {
    const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uDensity: { value: 0 }, uLayer: { value: i } },
      vertexShader: FOG_VERT,
      fragmentShader: FOG_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, 0.06 + i * 0.14, (stage.thrust?.depth ?? 0) / 2 - stage.depth / 2);
    mesh.renderOrder = 1;
    g.add(mesh);
  }
  return g;
}

export function setLowFog(g: THREE.Group, time: number, density: number): void {
  g.visible = density > 0.01;
  for (const m of g.children as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[]) {
    m.material.uniforms.uTime!.value = time;
    m.material.uniforms.uDensity!.value = density;
  }
}

export function disposeGroup(g: THREE.Object3D): void {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    // Sprite labels own their canvas texture.
    if (o instanceof THREE.Sprite) o.material.map?.dispose();
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}
