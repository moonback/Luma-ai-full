import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Camera, CircleStop, Cloud, Lightbulb, Link2, Moon, Crosshair, Copy, Expand, Eye, Focus, ImageDown, Move3d, Plus, Rotate3d, SlidersHorizontal, Sparkles, Tag, Sun, Trash2, TriangleAlert, Video, X } from 'lucide-react';
import { confirmAction, useStore } from '../store';
import { act, call, newId } from '../api';
import { useResolved } from '../components/ui';
import { buildVisualModel, type VisualFixture } from '../../core/visualizer/model';
import type { Fixture, FixtureValues, Project, StageProp, Truss } from '../../core/model/schemas';
import { followTruss, snapToTrusses, snapTrussEnds } from '../../core/visualizer/truss';
import { audienceGlare, beamDirection, type StageGeometry } from '../../core/visualizer/beam';
import { buildRig, disposeRig, rigKey, updateRig, type Rig } from './stage3d/rig';
import { buildEnvironment, buildLowFog, disposeGroup, propObjectName, setLowFog, stageGeometry, trussObjectName } from './stage3d/environment';
import { disposeTextures } from './stage3d/textures';
import { buildPerformer, buildScreen, disposeScreen, screenKey, updatePerformer, updateScreen, type PerformerRig, type ScreenRig } from './stage3d/actors';
import { AMBIENCES, FLOORS, LIGHT_BUDGET, RealLights, applyAmbience, buildFloorReflector, disposeReflector, type AmbienceId, type FloorId } from './stage3d/quality';
import { DARK_LEVEL, performerLight } from '../../core/visualizer/lighting';
import { screenMediaVersion } from '../screenMedia';
import { acceptLibraryDrag, addSceneElement, dropLibraryItem, duplicateSceneElement, hangFixture, removeSceneElement } from '../sceneActions';
import type { SceneRef } from '../../core/visualizer/sceneEdit';

/**
 * 3D stage preview (three.js) fed by the renderer-agnostic VisualFixture model.
 * Volumetric-looking beams, light pools with gobos on the floor and cyclorama, strobe flashes, prism facets and
 * per-cell beams for LED bars. A visual aid only: no photometry, shadows or real light transport.
 */

type ViewId = 'foh' | 'front' | 'top' | 'left' | 'right';
const VIEWS: { id: ViewId; label: string }[] = [
  { id: 'foh', label: 'Régie' }, { id: 'front', label: 'Face' }, { id: 'top', label: 'Dessus' }, { id: 'left', label: 'Jardin' }, { id: 'right', label: 'Cour' },
];

/** `view`: a built-in camera id or the id of a view saved in the project. */
interface Prefs { haze: number; glow: boolean; pools: boolean; labels: boolean; smoke: boolean; view: string; grid: number; real: boolean; ambience: AmbienceId; floor: FloorId }
const DEFAULT_PREFS: Prefs = { haze: 0.55, glow: true, pools: true, labels: false, smoke: false, view: 'foh', grid: 0.25, real: false, ambience: 'black', floor: 'matte' };
/** Editor grid steps in meters (0 = free); rotations snap to 15° whenever a grid is on. */
const GRIDS = [0, 0.25, 0.5, 1];
const ROTATION_SNAP_DEG = 15;
/** A fixture dropped this close (vertically) to a truss' hanging height snaps onto it. */
const SNAP_HEIGHT = 1;

type Placement = { x: number; y: number; height: number; rotation: number };
const r2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Degrees in [-180, 180]. */
const wrapDeg = (d: number) => r2(((((d + 180) % 360) + 360) % 360) - 180);
/** Stage placement of a 3D object (world z points to the audience, stage y upstage). */
const placementOf = (o: THREE.Object3D): Placement => ({
  x: r2(clamp(o.position.x, -100, 100)), y: r2(clamp(-o.position.z, -100, 100)), height: r2(o.position.y), rotation: wrapDeg(THREE.MathUtils.radToDeg(o.rotation.y)),
});
function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem('luma.stage3d') ?? '{}') as Partial<Prefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}
function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem('luma.stage3d', JSON.stringify(p));
  } catch {
    // preferences simply not persisted
  }
}

function viewPose(id: ViewId, st: StageGeometry): { pos: THREE.Vector3; target: THREE.Vector3 } {
  const { width: W, wallHeight: H } = st;
  // Frame the whole playing area: deck plus thrust.
  const front = st.thrust?.depth ?? 0;
  const D = st.depth + front;
  const span = Math.max(W, D);
  const target = new THREE.Vector3(0, Math.min(2, H / 3), front - D / 2);
  switch (id) {
    case 'front': return { pos: new THREE.Vector3(0, 1.7, front + span * 0.9), target };
    case 'top': return { pos: new THREE.Vector3(0, span * 1.6, target.z + 0.01), target: new THREE.Vector3(0, 0, target.z) };
    case 'left': return { pos: new THREE.Vector3(-span * 1.1, H * 0.6, target.z), target };
    case 'right': return { pos: new THREE.Vector3(span * 1.1, H * 0.6, target.z), target };
    default: return { pos: new THREE.Vector3(0, H * 0.75, front + span * 1.25), target };
  }
}


function download(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');

type CtxTarget = SceneRef | { kind: 'fixture'; id: string };

/** Edit-mode right-click menu on a fixture, a truss or a set piece. */
function ContextMenu({ ctx, model, vis, patch, onClose }: { ctx: { x: number; y: number; target: CtxTarget }; model: readonly VisualFixture[]; vis: Project['visualizer']; patch: readonly Fixture[]; onClose: () => void }) {
  const [hanging, setHanging] = useState(false);
  const t = ctx.target;
  const f = t.kind === 'fixture' ? model.find((x) => x.id === t.id) : undefined;
  const fixture = t.kind === 'fixture' ? patch.find((x) => x.id === t.id) : undefined;
  const truss = t.kind === 'truss' ? vis.trusses.find((x) => x.id === t.id) : undefined;
  const prop = t.kind === 'prop' ? vis.props.find((x) => x.id === t.id) : undefined;
  const at = f ? { x: f.x, y: f.y, height: f.height } : truss ? { x: truss.x, y: truss.y, height: truss.height } : prop ? { x: prop.x, y: prop.y, height: prop.elevation + prop.height / 2 } : null;
  if (!at) return null;
  const run = (fn: () => void) => () => { onClose(); fn(); };
  const duplicate = () => {
    if (t.kind !== 'fixture') duplicateSceneElement(t);
    else void act({ type: 'fixture.duplicate', ids: [t.id] }).then((r) => r && useStore.getState().setSelection(r.ids));
  };
  const remove = async () => {
    if (t.kind !== 'fixture') { removeSceneElement(t); return; }
    if (await confirmAction({ title: 'Supprimer le projecteur', message: `« ${f?.name ?? ''} » sera retiré du patch.`, confirmLabel: 'Supprimer' })) void act({ type: 'fixture.remove', ids: [t.id] });
  };
  return (
    <div className="stage3d-pop stage3d-ctx" role="menu" aria-label="Actions" data-testid="ctx-menu" style={{ left: ctx.x, top: ctx.y }} onPointerDown={(e) => e.stopPropagation()}>
      <b className="small">{f?.name ?? truss?.name ?? prop?.name}</b>
      <button role="menuitem" className="btn ghost sm" onClick={run(duplicate)} data-testid="ctx-duplicate"><Copy size={12} />Dupliquer</button>
      <button role="menuitem" className="btn ghost sm" onClick={run(() => void remove())} data-testid="ctx-delete"><Trash2 size={12} />Supprimer</button>
      {fixture && (
        <>
          <button role="menuitem" className="btn ghost sm" aria-expanded={hanging} disabled={!vis.trusses.length} onClick={() => setHanging(!hanging)} data-testid="ctx-hang"><Link2 size={12} />Accrocher à…</button>
          {hanging && (
            <div className="col" style={{ paddingLeft: 14, gap: 2 }}>
              {vis.trusses.map((x) => <button key={x.id} role="menuitem" className={`btn ghost sm ${fixture.trussId === x.id ? 'on' : ''}`} onClick={run(() => hangFixture(fixture, x))}>{x.name}</button>)}
              {fixture.trussId && <button role="menuitem" className="btn ghost sm" onClick={run(() => void act({ type: 'fixture.update', id: fixture.id, patch: { trussId: null } }))}>Décrocher</button>}
            </div>
          )}
        </>
      )}
      <button role="menuitem" className="btn ghost sm" onClick={run(() => useStore.getState().frameOn(at))} data-testid="ctx-frame"><Focus size={12} />Centrer la vue</button>
      {f && <button role="menuitem" className="btn ghost sm" onClick={run(() => useStore.getState().setBeamView(f.id))} data-testid="ctx-beam"><Crosshair size={12} />Vue projecteur</button>}
    </div>
  );
}

export function Stage3D({ values, groupFilter }: { values?: FixtureValues; groupFilter?: string | null }) {
  const wrap = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const live = useStore((s) => s.values);
  const project = useStore((s) => s.project!.project);
  const selection = useStore((s) => s.selection);
  const { fixtures } = useResolved();
  const model = useMemo(() => buildVisualModel(fixtures, values ?? live), [fixtures, values, live]);
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number; f: VisualFixture } | null>(null);
  const setPrefs = (p: Partial<Prefs>) => setPrefsState((cur) => { const n = { ...cur, ...p }; savePrefs(n); return n; });

  const vis = project.visualizer;
  const stage = useMemo(() => stageGeometry(vis, model), [vis, model]);
  const glare = useMemo(() => audienceGlare(model, stage), [model, stage]);
  const dark = useMemo(() => vis.performers.filter((pf) => performerLight(pf, vis.markers, model, vis.props).level < DARK_LEVEL), [vis.performers, vis.markers, vis.props, model]);
  const follow = useStore((s) => s.beamView);
  const setFollow = useStore((s) => s.setBeamView);
  const frame = useStore((s) => s.frame);
  const [ctx, setCtx] = useState<{ x: number; y: number; target: SceneRef | { kind: 'fixture'; id: string } } | null>(null);
  const [recording, setRecording] = useState(false);
  const [edit, setEdit] = useState(false);
  const [tool, setTool] = useState<'translate' | 'rotate'>('translate');
  // The selected truss is the shared stage selection (scene panel, 2D plan, Ctrl+D / Suppr).
  const sceneSel = useStore((s) => s.sceneSel);
  const placing = useStore((s) => s.placing);
  // Truss or set piece selected: highlighted, and moved by the gizmo in edit mode.
  const selSet = sceneSel && (sceneSel.kind === 'truss' || sceneSel.kind === 'prop') ? sceneSel : null;
  const [dims, setDims] = useState<string | null>(null);
  const [lights, setLights] = useState(0);
  const [shadows, setShadows] = useState(0);
  const [menu, setMenu] = useState(false);
  const latest = useRef({ model, selection, groupFilter, prefs, stage, vis, follow, edit, tool, selSet });
  latest.current = { model, selection, groupFilter, prefs, stage, vis, follow, edit, tool, selSet };
  const api = useRef<{
    goTo: (v: string) => void;
    groundAt: (cx: number, cy: number) => { x: number; y: number } | null;
    pose: () => { pos: THREE.Vector3; target: THREE.Vector3 };
    capture: () => void;
    record: (on: boolean) => void;
    setBloom: (on: boolean) => void;
    frame: (at: { x: number; y: number; height: number }) => void;
  } | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    } catch (err) {
      setError(`WebGL indisponible : ${(err as Error).message}`);
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05060a);
    scene.fog = new THREE.Fog(0x05060a, 30, 70);
    const hemi = new THREE.HemisphereLight(0x8899bb, 0x0b0d14, 0.5);
    scene.add(hemi);
    const key = new THREE.DirectionalLight(0xb8c4ff, 0.35);
    key.position.set(-6, 12, 10);
    scene.add(key);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    const real = new RealLights(scene, renderer.capabilities.maxTextures);
    let ambienceKey = '';
    let floorGroup: THREE.Group | null = null;
    const performers = new Map<string, PerformerRig>();
    const screens = new Map<string, ScreenRig>();
    let mediaVersion = -1;
    let budgetAt = performance.now();
    const camera = new THREE.PerspectiveCamera(48, 1, 0.05, 300);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = 1.5;
    controls.maxDistance = 120;

    // Direct editing: a gizmo on the selected fixture (through a proxy, the rig follows the model) or truss group.
    const tc = new TransformControls(camera, renderer.domElement);
    tc.setSpace('world');
    tc.size = 0.8;
    scene.add(tc.getHelper());
    const proxy = new THREE.Object3D();
    scene.add(proxy);
    /** Placements shown while dragging and until the main process confirms the edit. */
    const overrides = new Map<string, Placement>();
    let attached = '';
    let gizmoCfg = '';
    let dragging = false;
    const describe = (p: Placement, extra = '') => `X ${p.x.toFixed(2)} m · Y ${p.y.toFixed(2)} m · H ${p.height.toFixed(2)} m · ${p.rotation.toFixed(0)}°${extra}`;
    /** Truss a fixture would hang on if dropped here (close horizontally and near the hanging height). */
    const trussSnap = (p: Placement) => {
      const snap = snapToTrusses(latest.current.vis.trusses, p.x, p.y);
      return snap && Math.abs(p.height - snap.height) <= SNAP_HEIGHT ? snap : null;
    };
    const editedTruss = (): { before: Truss; after: Truss; joint?: Truss } | null => {
      const id = attached.startsWith('truss:') ? attached.split(':')[1]! : null;
      const trusses = latest.current.vis.trusses;
      const before = id ? trusses.find((t) => t.id === id) : undefined;
      const obj = tc.object;
      if (!before || !obj) return null;
      const p = placementOf(obj);
      const after = { ...before, x: p.x, y: p.y, height: r2(clamp(p.height, 0.5, 30)), rotation: p.rotation };
      // Moved close to another piece: end to end on it, at its height.
      const snap = latest.current.tool === 'translate' ? snapTrussEnds(after, trusses) : null;
      return snap ? { before, after: { ...after, x: snap.x, y: snap.y, height: snap.height }, joint: snap.to } : { before, after };
    };
    const editedProp = (): { before: StageProp; after: StageProp } | null => {
      const id = attached.startsWith('prop:') ? attached.split(':')[1]! : null;
      const before = id ? latest.current.vis.props.find((x) => x.id === id) : undefined;
      const obj = tc.object;
      if (!before || !obj) return null;
      const p = placementOf(obj);
      return { before, after: { ...before, x: p.x, y: p.y, elevation: r2(clamp(p.height, 0, 20)), rotation: p.rotation } };
    };
    const onChange = () => {
      const obj = tc.object;
      if (!obj || !dragging) return;
      const p = placementOf(obj);
      if (obj === proxy) {
        const id = attached.split(':')[1]!;
        overrides.set(id, p);
        const snap = latest.current.tool === 'translate' ? trussSnap(p) : null;
        setDims(describe(p, snap ? ` · accroche : ${snap.truss.name}` : ''));
      } else if (attached.startsWith('prop:')) {
        const pr = editedProp();
        if (pr) setDims(describe({ ...p, height: pr.after.elevation }, ' (élévation)'));
      } else {
        const tr = editedTruss();
        if (!tr) return;
        // Hung fixtures ride along with the truss while it moves.
        for (const f of useStore.getState().project?.project.patch ?? []) {
          if (f.trussId !== tr.before.id) continue;
          const n = followTruss(tr.before, tr.after, f);
          overrides.set(f.id, { x: n.position.x, y: n.position.y, height: n.height, rotation: n.rotation });
        }
        setDims(describe(tr.after, tr.joint ? ` · raccord : ${tr.joint.name}` : ''));
      }
    };
    const commit = () => {
      const obj = tc.object;
      setDims(null);
      if (!obj) return;
      if (obj === proxy) {
        const id = attached.split(':')[1]!;
        const fixture = useStore.getState().project?.project.patch.find((f) => f.id === id);
        if (!fixture) { overrides.delete(id); return; }
        const p = placementOf(proxy);
        const patch: { position: { x: number; y: number }; height: number; rotation: number; trussId?: string | null } = {
          position: { x: p.x, y: p.y }, height: r2(clamp(p.height, 0, 50)), rotation: p.rotation,
        };
        if (latest.current.tool === 'translate') {
          const snap = trussSnap(p);
          if (snap) Object.assign(patch, { position: { x: snap.x, y: snap.y }, height: snap.height, trussId: snap.truss.id });
          else if (fixture.trussId) patch.trussId = null;
        }
        overrides.set(id, { x: patch.position.x, y: patch.position.y, height: patch.height, rotation: p.rotation });
        void act({ type: 'fixture.update', id, patch }).finally(() => overrides.delete(id));
      } else if (attached.startsWith('prop:')) {
        const pr = editedProp();
        if (!pr) return;
        const props = latest.current.vis.props.map((x) => (x.id === pr.before.id ? pr.after : x));
        void call({ type: 'project.update', visualizer: { props } }).catch(() => { envKey = ''; });
      } else {
        const tr = editedTruss();
        if (!tr) return;
        const trusses = latest.current.vis.trusses.map((t) => (t.id === tr.before.id ? tr.after : t));
        void call({ type: 'project.update', visualizer: { trusses } })
          .catch(() => { envKey = ''; }) // refused: rebuild the set at its saved place
          .finally(() => overrides.clear());
      }
    };
    tc.addEventListener('dragging-changed', (e) => {
      dragging = !!e.value;
      if (!dragging) commit();
    });
    tc.addEventListener('objectChange', onChange);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.55, 0.12);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    bloom.enabled = latest.current.prefs.glow;

    let env: THREE.Group | null = null;
    let fog: THREE.Group | null = null;
    let envKey = '';
    const rigs = new Map<string, Rig>();

    // Camera transitions.
    let anim: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; start: number } | null = null;
    const goTo = (v: string, instant = false) => {
      const { stage: st, vis: cfg } = latest.current;
      const saved = cfg.views.find((x) => x.id === v);
      const pose = saved
        ? { pos: new THREE.Vector3(saved.pos.x, saved.pos.y, saved.pos.z), target: new THREE.Vector3(saved.target.x, saved.target.y, saved.target.z) }
        : viewPose(VIEWS.some((x) => x.id === v) ? (v as ViewId) : 'foh', st);
      if (instant) {
        camera.position.copy(pose.pos);
        controls.target.copy(pose.target);
        controls.update();
      } else anim = { from: camera.position.clone(), to: pose.pos, tFrom: controls.target.clone(), tTo: pose.target, start: performance.now() };
    };
    goTo(latest.current.prefs.view, true);

    const resize = () => {
      const r = el.getBoundingClientRect();
      const w = Math.max(1, r.width), h = Math.max(1, r.height);
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    // Picking (click = select, hover = tooltip).
    const ray = new THREE.Raycaster();
    const pick = (cx: number, cy: number): string | undefined => {
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObjects([...rigs.values()].flatMap((x) => x.bodies))[0];
      return hit?.object.userData.fixtureId as string | undefined;
    };
    let downAt = { x: 0, y: 0 };
    let lastHover = 0;
    const onDown = (e: PointerEvent) => { downAt = { x: e.clientX, y: e.clientY }; };
    /** Truss or set piece under the pointer. */
    const pickSet = (cx: number, cy: number): SceneRef | undefined => {
      if (!env) return undefined;
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
      const o = ray.intersectObject(env, true).find((h) => h.object.userData.trussId || h.object.userData.propId)?.object;
      return o ? (o.userData.trussId ? { kind: 'truss', id: o.userData.trussId as string } : { kind: 'prop', id: o.userData.propId as string }) : undefined;
    };
    /** Stage point under the pointer, where the view ray meets the floor (click placement, library drop). */
    const groundAt = (cx: number, cy: number): { x: number; y: number } | null => {
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1), camera);
      const at = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      return at ? { x: at.x, y: -at.z } : null;
    };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0 || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
      if (tc.axis !== null || dragging) return; // click on the gizmo
      const placing = useStore.getState().placing;
      if (placing) {
        const at = groundAt(e.clientX, e.clientY);
        if (at) addSceneElement(placing.kind, at, placing.preset);
        return;
      }
      const id = pick(e.clientX, e.clientY);
      const st = useStore.getState();
      const set = !id ? pickSet(e.clientX, e.clientY) : undefined;
      st.setSceneSel(set ?? null);
      if (set) st.setSelection([]);
      else if (!id) st.setSelection([]);
      else if (e.ctrlKey || e.shiftKey) st.setSelection(st.selection.includes(id) ? st.selection.filter((x) => x !== id) : [...st.selection, id]);
      else st.setSelection([id]);
    };
    const onMove = (e: PointerEvent) => {
      const now = performance.now();
      if (e.buttons || now - lastHover < 60) return;
      lastHover = now;
      const id = pick(e.clientX, e.clientY);
      const f = id ? latest.current.model.find((m) => m.id === id) : undefined;
      const r = el.getBoundingClientRect();
      setHover(f ? { x: e.clientX - r.left, y: e.clientY - r.top, f } : null);
    };
    const onLeave = () => setHover(null);
    // Edit mode: right click on a fixture, truss or set piece opens its menu (a right drag still pans the camera).
    const onContext = (e: MouseEvent) => {
      if (!latest.current.edit || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
      const id = pick(e.clientX, e.clientY);
      const set = id ? undefined : pickSet(e.clientX, e.clientY);
      if (!id && !set) return;
      e.preventDefault();
      const st = useStore.getState();
      if (id) { if (!st.selection.includes(id)) st.setSelection([id]); } else st.setSceneSel(set!);
      const r = el.getBoundingClientRect();
      setCtx({ x: e.clientX - r.left, y: e.clientY - r.top, target: id ? { kind: 'fixture', id } : set! });
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerleave', onLeave);
    renderer.domElement.addEventListener('contextmenu', onContext);

    let wantCapture = false;
    let recorder: MediaRecorder | null = null;
    api.current = {
      goTo: (v) => goTo(v),
      groundAt,
      pose: () => ({ pos: camera.position.clone(), target: controls.target.clone() }),
      capture: () => { wantCapture = true; },
      record: (on) => {
        if (!on) { recorder?.stop(); return; }
        const chunks: Blob[] = [];
        recorder = new MediaRecorder(renderer.domElement.captureStream(30), { mimeType: 'video/webm' });
        recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        recorder.onstop = () => {
          const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
          download(url, `scene-${stamp()}.webm`);
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
          recorder = null;
        };
        recorder.start(1000);
      },
      setBloom: (on) => { bloom.enabled = on; },
      frame: (at) => {
        // Same viewing direction, target on the element, 3 to 8 m away.
        const tTo = new THREE.Vector3(at.x, at.height, -at.y);
        const off = camera.position.clone().sub(controls.target);
        off.setLength(clamp(off.length(), 3, 8));
        anim = { from: camera.position.clone(), to: tTo.clone().add(off), tFrom: controls.target.clone(), tTo, start: performance.now() };
      },
    };

    let raf = 0;
    let frames = 0;
    let fpsStart = performance.now();
    const t0 = performance.now();
    const loop = () => {
      const now = performance.now();
      const { model: m, selection: sel, groupFilter: gf, prefs: p, stage: st, vis: cfg, follow: fid, edit: editing, tool: tl, selSet: selS } = latest.current;
      // Environment follows the stage layout, stage points, trusses, set pieces and the selection (fixtures never add a truss).
      const k = `${JSON.stringify(st)}|${JSON.stringify(cfg.markers)}|${JSON.stringify(cfg.trusses)}|${JSON.stringify(cfg.props)}|${selS?.id ?? ''}`;
      if (k !== envKey) {
        if (env) { scene.remove(env); disposeGroup(env); }
        if (fog) { scene.remove(fog); disposeGroup(fog); }
        env = buildEnvironment(st, cfg.markers, cfg.trusses, selS?.id ?? null, cfg.props);
        // Real-lighting mode: the set receives shadows, the trusses cast them.
        env.traverse((o) => { if (o instanceof THREE.Mesh) { o.receiveShadow = true; o.castShadow = !!(o.userData.trussId || o.userData.propId); } });
        fog = buildLowFog(st);
        scene.add(env, fog);
        envKey = k;
        ambienceKey = ''; // the floor mirror follows the stage outline
      }
      const ak = `${p.ambience}|${p.floor}|${envKey}`;
      if (ak !== ambienceKey) {
        ambienceKey = ak;
        applyAmbience(p.ambience, scene, hemi, key);
        if (floorGroup) { scene.remove(floorGroup); disposeReflector(floorGroup); }
        floorGroup = buildFloorReflector(p.floor, st, renderer.getDrawingBufferSize(new THREE.Vector2()));
        if (floorGroup) scene.add(floorGroup);
      }
      // Performers and screens: rebuilt when added/removed or when their structure changes, updated every frame.
      for (const [id, r] of performers) {
        const pf = cfg.performers.find((x) => x.id === id);
        if (!pf || r.group.userData.kind !== `${pf.kind}|${pf.name}`) { scene.remove(r.group); disposeGroup(r.group); performers.delete(id); }
      }
      for (const pf of cfg.performers) {
        let r = performers.get(pf.id);
        if (!r) { r = buildPerformer(pf); r.group.userData.kind = `${pf.kind}|${pf.name}`; performers.set(pf.id, r); scene.add(r.group); }
        updatePerformer(r, pf, cfg.markers, m, { realLights: p.real, labels: p.labels }, cfg.props);
      }
      const mv = screenMediaVersion();
      for (const [id, r] of screens) {
        const sc = cfg.screens.find((x) => x.id === id);
        if (!sc || r.key !== screenKey(sc) || mv !== mediaVersion) { scene.remove(r.group); disposeScreen(r); screens.delete(id); }
      }
      mediaVersion = mv;
      for (const sc of cfg.screens) {
        let r = screens.get(sc.id);
        if (!r) { r = buildScreen(sc); screens.set(sc.id, r); scene.add(r.group); }
        updateScreen(r, sc, m, p.haze);
      }
      if (fog) setLowFog(fog, (now - t0) / 1000, p.smoke ? 0.25 + 0.5 * p.haze : 0);
      const group = gf ? useStore.getState().project?.project.groups.find((g) => g.id === gf) : null;
      const ids = new Set(m.map((f) => f.id));
      for (const [id, r] of rigs) if (!ids.has(id)) { disposeRig(r, scene); rigs.delete(id); }
      for (const f of m) {
        let r = rigs.get(f.id);
        if (!r || r.key !== rigKey(f)) {
          if (r) disposeRig(r, scene);
          r = buildRig(f, scene);
          rigs.set(f.id, r);
        }
        const o = overrides.get(f.id);
        updateRig(r, o ? { ...f, ...o } : f, { time: (now - t0) / 1000, haze: p.haze, pools: p.pools && !p.real, labels: p.labels, selected: sel.includes(f.id), dimmed: !!group && !group.fixtureIds.includes(f.id), stage: st });
      }
      real.setEnabled(p.real);
      real.update(m, (f) => !!group && !group.fixtureIds.includes(f.id));
      if (anim) {
        const k2 = Math.min(1, (now - anim.start) / 700);
        const e = k2 < 0.5 ? 2 * k2 * k2 : 1 - (-2 * k2 + 2) ** 2 / 2;
        camera.position.lerpVectors(anim.from, anim.to, e);
        controls.target.lerpVectors(anim.tFrom, anim.tTo, e);
        if (k2 >= 1) anim = null;
      }
      // Gizmo target: the selected truss, else the single selected fixture (edit mode only).
      const target = !editing || fid ? '' : selS ? `${selS.kind}:${selS.id}:${env?.uuid}` : sel.length === 1 && m.some((f) => f.id === sel[0]) ? `fixture:${sel[0]}` : '';
      if (target !== attached && !dragging) {
        attached = target;
        const obj = selS && !target.startsWith('fixture:') && target ? env?.getObjectByName(selS.kind === 'truss' ? trussObjectName(selS.id) : propObjectName(selS.id)) : target ? proxy : undefined;
        if (obj) tc.attach(obj);
        else tc.detach();
      }
      if (attached.startsWith('fixture:') && !dragging) {
        const f = m.find((x) => x.id === attached.split(':')[1]);
        const o = f && (overrides.get(f.id) ?? f);
        if (o) {
          proxy.position.set(o.x, o.height, -o.y);
          proxy.rotation.set(0, THREE.MathUtils.degToRad(o.rotation), 0);
        }
      }
      const cfgKey = `${tl}|${p.grid}`;
      if (cfgKey !== gizmoCfg) {
        gizmoCfg = cfgKey;
        tc.setMode(tl);
        tc.showX = tc.showZ = tl === 'translate';
        tc.setTranslationSnap(p.grid || null);
        tc.setRotationSnap(p.grid ? THREE.MathUtils.degToRad(ROTATION_SNAP_DEG) : null);
      }
      // Beam's-eye view: the camera rides just ahead of the lens along the beam axis (orbit disabled meanwhile).
      const followed = fid ? m.find((f) => f.id === fid) : undefined;
      controls.enabled = !followed && !dragging;
      if (followed) {
        const d = beamDirection(followed);
        const dir = new THREE.Vector3(d.x, d.y, d.z);
        camera.position.set(followed.x, followed.height, -followed.y).addScaledVector(dir, 0.45);
        camera.lookAt(camera.position.clone().addScaledVector(dir, 10));
        anim = null;
      } else controls.update();
      if (bloom.enabled) composer.render();
      else renderer.render(scene, camera);
      if (wantCapture) {
        // Read back in the same task as the render: the drawing buffer is not preserved afterwards.
        wantCapture = false;
        download(renderer.domElement.toDataURL('image/png'), `scene-${stamp()}.png`);
      }
      frames++;
      if (now - fpsStart > 1000) {
        const rate = (frames * 1000) / (now - fpsStart);
        // Adaptive shadow budget: fewer lights below 30 i/s, more above 50 i/s (at most one step every 3 s).
        if (p.real && now - budgetAt > 3000) {
          const n = real.budget;
          if (rate < 30 && n > LIGHT_BUDGET.min) { real.setBudget(n - LIGHT_BUDGET.step); budgetAt = now; }
          else if (rate > 50 && n < LIGHT_BUDGET.max) { real.setBudget(n + LIGHT_BUDGET.step); budgetAt = now; }
        }
        setLights(p.real ? real.budget : 0);
        setShadows(real.shadows);
        setFps(Math.round(rate));
        frames = 0;
        fpsStart = now;
      }
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      if (recorder?.state === 'recording') recorder.stop();
      ro.disconnect();
      tc.detach();
      tc.dispose();
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerleave', onLeave);
      renderer.domElement.removeEventListener('contextmenu', onContext);
      for (const r of rigs.values()) disposeRig(r, scene);
      if (env) disposeGroup(env);
      if (fog) disposeGroup(fog);
      if (floorGroup) disposeReflector(floorGroup);
      for (const r of performers.values()) disposeGroup(r.group);
      for (const r of screens.values()) disposeScreen(r);
      real.dispose();
      disposeTextures();
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      api.current = null;
    };
  }, []);

  useEffect(() => api.current?.setBloom(prefs.glow), [prefs.glow]);
  // Framing requested by a double-click on a card (an older request is ignored when the view mounts).
  const frameSeq = useRef(frame?.seq);
  useEffect(() => {
    if (!frame || frame.seq === frameSeq.current) return;
    frameSeq.current = frame.seq;
    setFollow(null);
    api.current?.frame(frame);
  }, [frame, setFollow]);
  useEffect(() => () => useStore.getState().setBeamView(null), []);
  useEffect(() => {
    if (!ctx) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtx(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctx]);
  useEffect(() => { if (!edit) setCtx(null); }, [edit]);
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  const pickView = (id: string) => { setFollow(null); setPrefs({ view: id }); api.current?.goTo(id); };
  const saveView = () => {
    const pose = api.current?.pose();
    if (!pose) return;
    const r = (v: THREE.Vector3) => ({ x: Math.round(v.x * 100) / 100, y: Math.round(v.y * 100) / 100, z: Math.round(v.z * 100) / 100 });
    const view = { id: newId(), name: `Vue ${vis.views.length + 1}`, pos: r(pose.pos), target: r(pose.target) };
    void act({ type: 'project.update', visualizer: { views: [...vis.views, view] } });
    setPrefs({ view: view.id });
  };
  const deleteView = (id: string) => void act({ type: 'project.update', visualizer: { views: vis.views.filter((v) => v.id !== id) } });
  const toggleRecord = () => { api.current?.record(!recording); setRecording(!recording); };
  const fullscreen = () => {
    const el = wrap.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => undefined);
  };

  if (error) return <div className="empty">{error}. Utilisez la vue 2D.</div>;
  return (
    <div ref={wrap} className="canvas-wrap stage3d" style={{ height: '100%' }}>
      <div ref={host} style={{ position: 'absolute', inset: 0, cursor: placing ? 'crosshair' : undefined }} onPointerDown={() => { setMenu(false); setCtx(null); }} onDragOver={acceptLibraryDrag} onDrop={(e) => dropLibraryItem(e, api.current?.groundAt(e.clientX, e.clientY) ?? null)} data-testid="stage-3d" />
      <div className="stage3d-toolbar">
        <div className="chips" role="group" aria-label="Caméras">
          <Camera size={14} className="dim" />
          {VIEWS.map((v) => (
            <button key={v.id} className={`chip ${prefs.view === v.id && !follow ? 'on' : ''}`} data-testid={`cam-${v.id}`} onClick={() => pickView(v.id)}>{v.label}</button>
          ))}
          {vis.views.map((v) => (
            <span key={v.id} className={`chip ${prefs.view === v.id && !follow ? 'on' : ''}`} data-testid="cam-saved">
              <button className="chip-link" onClick={() => pickView(v.id)}>{v.name}</button>
              <button className="chip-link" onClick={() => deleteView(v.id)} title={`Supprimer « ${v.name} »`} aria-label={`Supprimer la vue ${v.name}`}><X size={10} /></button>
            </span>
          ))}
          {vis.views.length < 20 && <button className="chip" onClick={saveView} title="Enregistrer le point de vue actuel dans le projet" aria-label="Enregistrer la vue" data-testid="cam-save"><Plus size={12} /></button>}
        </div>
        <div className="grow" />
        <button className={`chip ${edit ? 'on' : ''}`} onClick={() => setEdit(!edit)} title="Édition directe : déplacer et pivoter projecteurs et structures" data-testid="edit3d"><Move3d size={12} /> Éditer</button>
        {edit && (
          <>
            <div className="chips" role="group" aria-label="Outil">
              <button className={`chip ${tool === 'translate' ? 'on' : ''}`} onClick={() => setTool('translate')} title="Déplacer (et monter / descendre)" data-testid="tool-move"><Move3d size={12} /></button>
              <button className={`chip ${tool === 'rotate' ? 'on' : ''}`} onClick={() => setTool('rotate')} title="Pivoter autour de la verticale" data-testid="tool-rotate"><Rotate3d size={12} /></button>
            </div>
            <label className="row small" title="Aimantation à la grille (et rotations par 15°)">Grille
              <select className="select" style={{ width: 82, height: 26 }} value={prefs.grid} onChange={(e) => setPrefs({ grid: Number(e.target.value) })} data-testid="grid">
                {GRIDS.map((g) => <option key={g} value={g}>{g ? `${String(g).replace('.', ',')} m` : 'Libre'}</option>)}
              </select>
            </label>
          </>
        )}
        <span className="stage3d-sep" />
        <button className={`chip ${menu ? 'on' : ''}`} onClick={() => setMenu(!menu)} aria-expanded={menu} title="Brume, halo, taches, fumée, ombres, ambiance, sol, noms" data-testid="render-menu"><SlidersHorizontal size={12} /> Rendu</button>
        <button className="chip" onClick={() => api.current?.capture()} title="Capture d’image (PNG)" aria-label="Capture d’image" data-testid="capture"><ImageDown size={12} /></button>
        <button className={`chip ${recording ? 'on' : ''}`} onClick={toggleRecord} title={recording ? 'Arrêter l’enregistrement' : 'Enregistrer une vidéo de la vue (WebM)'} aria-label={recording ? 'Arrêter l’enregistrement' : 'Enregistrer une vidéo'} data-testid="record">{recording ? <CircleStop size={12} /> : <Video size={12} />}</button>
        <button className="chip" onClick={fullscreen} title="Plein écran (Échap pour sortir)" aria-label="Plein écran"><Expand size={12} /></button>
        <span className="mono small dim" data-testid="fps">{fps} i/s</span>
        {menu && (
          <div className="stage3d-pop" role="dialog" aria-label="Réglages de rendu" data-testid="render-pop">
            <label className="row small" title="Densité de brume : visibilité des faisceaux dans l’air">
              <Sun size={13} className="dim" /><span className="grow">Brume</span>
              <input type="range" min={0} max={100} value={Math.round(prefs.haze * 100)} style={{ width: 130 }} onChange={(e) => setPrefs({ haze: Number(e.target.value) / 100 })} data-testid="haze" />
            </label>
            <div className="chips">
              <button className={`chip ${prefs.glow ? 'on' : ''}`} onClick={() => setPrefs({ glow: !prefs.glow })} title="Halo lumineux (bloom)"><Sparkles size={12} /> Glow</button>
              <button className={`chip ${prefs.pools ? 'on' : ''}`} onClick={() => setPrefs({ pools: !prefs.pools })} title="Taches de lumière et gobos au sol et sur le cyclorama"><Eye size={12} /> Taches</button>
              <button className={`chip ${prefs.smoke ? 'on' : ''}`} onClick={() => setPrefs({ smoke: !prefs.smoke })} title="Fumée lourde au sol" data-testid="smoke"><Cloud size={12} /> Fumée</button>
              <button className={`chip ${prefs.labels ? 'on' : ''}`} onClick={() => setPrefs({ labels: !prefs.labels })} title="Noms des projecteurs"><Tag size={12} /> Noms</button>
              <button className={`chip ${prefs.real ? 'on' : ''}`} onClick={() => setPrefs({ real: !prefs.real })} title={`Éclairage réel avec ombres : les projecteurs les plus intenses (budget adaptatif ${LIGHT_BUDGET.min}–${LIGHT_BUDGET.max} sources, dont ${shadows || 'jusqu’à'} ombrées selon la carte graphique)`} data-testid="real-lights"><Lightbulb size={12} /> Ombres{prefs.real && lights ? ` · ${lights}` : ''}</button>
            </div>
            <label className="row small"><span className="grow">Ambiance</span>
              <select className="select" style={{ width: 160, height: 26 }} value={prefs.ambience} onChange={(e) => setPrefs({ ambience: e.target.value as AmbienceId })} data-testid="ambience">
                {(Object.keys(AMBIENCES) as AmbienceId[]).map((id) => <option key={id} value={id}>{AMBIENCES[id].label}</option>)}
              </select>
            </label>
            <label className="row small" title="Laqué / mouillé : reflets (un rendu de plus)"><span className="grow">Sol</span>
              <select className="select" style={{ width: 160, height: 26 }} value={prefs.floor} onChange={(e) => setPrefs({ floor: e.target.value as FloorId })} data-testid="floor">
                {(Object.keys(FLOORS) as FloorId[]).map((id) => <option key={id} value={id}>{FLOORS[id]}</option>)}
              </select>
            </label>
          </div>
        )}
      </div>
      {hover && (
        <div className="stage3d-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <b>{hover.f.name}</b>
          <span className="small muted">{Math.round(hover.f.intensity * 100)} % · {hover.f.color.toUpperCase()}{hover.f.movable ? ` · P ${hover.f.panDeg.toFixed(0)}° T ${hover.f.tiltDeg.toFixed(0)}°` : ''}</span>
        </div>
      )}
      {dims && <div className="stage3d-dims mono small" data-testid="dims">{dims}</div>}
      {ctx && <ContextMenu ctx={ctx} model={model} vis={vis} patch={project.patch} onClose={() => setCtx(null)} />}
      <div className="stage3d-status">
        {(dark.length > 0 || glare.length > 0) && (
          <div className="row" style={{ gap: 6 }}>
            {dark.length > 0 && (
              <span className="badge warn" data-testid="dark" title={`Visage peu ou pas éclairé : ${dark.map((x) => x.name).join(', ')}. Estimation sans occultation.`}>
                <Moon size={12} /> Dans le noir : {dark.length}
              </span>
            )}
            {glare.length > 0 && (
              <span className="badge warn" data-testid="glare" title={`Faisceau à hauteur des yeux du public : ${glare.map((f) => f.name).join(', ')}. Estimation sur l’axe du faisceau.`}>
                <TriangleAlert size={12} /> Éblouissement public : {glare.length}
              </span>
            )}
          </div>
        )}
        <div className="small dim">{edit ? 'Édition : cliquer un projecteur ou une structure, puis tirer les flèches du gizmo · clic droit : menu · Ctrl+Z : annuler' : 'Glisser : orbite · clic droit : déplacer · molette : zoom · clic : sélection · aperçu non photométrique'}</div>
      </div>
    </div>
  );
}

