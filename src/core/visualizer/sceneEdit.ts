import { performerSchema, propSchema, screenSchema, stageMarkerSchema, trussSchema, type Performer, type Project, type StageMarker, type StageProp, type StageScreen, type Truss } from '../model/schemas';
import { hangHeight, JUNCTION_ARMS, nearestOnTruss, trussSegments, type P2 } from './truss';

/**
 * Scene-element editing shared by the 2D plan, the 3D view and the scene panel: creation at a free spot,
 * duplication, removal, clipboard and automatic hanging of fixtures on trusses. Pure (ids come from `id`).
 */
type Vis = Project['visualizer'];
export type SceneKind = 'marker' | 'truss' | 'performer' | 'screen' | 'prop';
export interface SceneRef { kind: SceneKind; id: string }
/** What a click (or drop) on the stage will create: a kind, its label for the hint, an optional library preset. */
export interface PlaceSpec { kind: SceneKind; label: string; preset?: Record<string, unknown> }
export type Element = StageMarker | Truss | Performer | StageScreen | StageProp;

const LIST = { marker: 'markers', truss: 'trusses', performer: 'performers', screen: 'screens', prop: 'props' } as const;
const MAX = { marker: 64, truss: 64, performer: 64, screen: 16, prop: 256 } as const;
const SCHEMA = { marker: stageMarkerSchema, truss: trussSchema, performer: performerSchema, screen: screenSchema, prop: propSchema } as const;
export const SCENE_LABEL: Record<SceneKind, string> = { marker: 'Point', truss: 'Structure', performer: 'Artiste', screen: 'Écran', prop: 'Décor' };

const r2 = (v: number) => Math.round(v * 100) / 100;
const clampPos = (v: number) => Math.max(-100, Math.min(100, v));
const items = (vis: Vis, kind: SceneKind): Element[] => vis[LIST[kind]];

export const canAdd = (vis: Vis, kind: SceneKind) => items(vis, kind).length < MAX[kind];
export const findElement = (vis: Vis, ref: SceneRef): Element | undefined => items(vis, ref.kind).find((x) => x.id === ref.id);

/** First spot near `at` not already used by an element of the same kind: 0, +1, −1, +2, −2… m sideways. */
export function freeSpot(vis: Vis, kind: SceneKind, at: P2): P2 {
  const taken = items(vis, kind);
  for (let i = 0; i < 40; i++) {
    const dx = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2);
    const p = { x: r2(clampPos(at.x + dx)), y: r2(clampPos(at.y)) };
    if (!taken.some((e) => Math.hypot(e.x - p.x, e.y - p.y) < 0.5)) return p;
  }
  return at;
}

/** Default position of a new element when none is given (a sensible depth per kind). */
const defaultSpot = (vis: Vis, kind: SceneKind): P2 => ({ x: 0, y: r2(vis.stageDepth * { marker: 0.5, truss: 0.5, performer: 0.4, screen: 0.9, prop: 0.5 }[kind]) });

/**
 * New element of `kind`, placed at `at` (click / drop) or at the next free default spot. `preset` (a library item)
 * overrides the defaults; its `name` is the base of the generated name.
 */
export function newElement(vis: Vis, kind: SceneKind, id: () => string, at?: P2, preset: Record<string, unknown> = {}): Element {
  const p = at ? { x: r2(clampPos(at.x)), y: r2(clampPos(at.y)) } : freeSpot(vis, kind, defaultSpot(vis, kind));
  const { name: base = SCENE_LABEL[kind], ...over } = preset as { name?: string };
  // Numbered per base name: the first speaker is "Enceinte 1" even after a riser.
  const name = `${base} ${items(vis, kind).filter((e) => e.name.startsWith(`${base} `)).length + 1}`.slice(0, 80);
  const el = (() => {
    switch (kind) {
      case 'marker': return { id: id(), name, ...p, height: 1.7 };
      case 'truss': return { id: id(), name, shape: 'line', ...p, height: 6, length: Math.max(2, vis.stageWidth - 2), rotation: 0, support: 'towers' };
      case 'performer': return { id: id(), name, kind: 'standing', ...p, rotation: 0, markerId: null };
      case 'screen': return { id: id(), name, ...p, elevation: 1.5, width: Math.min(6, vis.stageWidth / 2), height: 3, rotation: 0, source: 'color', color: '#3b82f6', image: null, glow: 0.5 };
      case 'prop': return { id: id(), name, kind: 'riser', ...p, width: 2, depth: 1, height: 0.4, elevation: 0, rotation: 0, color: '#2a2f3a' };
    }
  })();
  // The schema keeps a malformed preset out of the project.
  return SCHEMA[kind].parse({ ...el, ...over }) as Element;
}

/** Visualizer patch that appends `el` to its list. */
export const withElement = (vis: Vis, kind: SceneKind, el: Element): Partial<Vis> => ({ [LIST[kind]]: [...items(vis, kind), el] });

/** Visualizer patch removing an element; performers standing on a removed point stay where it was. */
export function withoutElement(vis: Vis, ref: SceneRef): Partial<Vis> {
  const patch: Partial<Vis> = { [LIST[ref.kind]]: items(vis, ref.kind).filter((x) => x.id !== ref.id) };
  if (ref.kind === 'marker') {
    const m = vis.markers.find((x) => x.id === ref.id);
    if (m) patch.performers = vis.performers.map((pf) => (pf.markerId === m.id ? { ...pf, x: m.x, y: m.y, markerId: null } : pf));
  }
  return patch;
}

/** Copy of an element (new id, "(copie)" name, free spot 1 m aside); a copied performer is freed from its point. */
export function cloneElement(vis: Vis, kind: SceneKind, src: Element, id: () => string): Element {
  const p = freeSpot(vis, kind, { x: src.x + 1, y: src.y });
  const copy = { ...structuredClone(src), id: id(), name: `${src.name} (copie)`.slice(0, 80), ...p };
  return kind === 'performer' ? ({ ...copy, markerId: null } as Performer) : copy;
}

/* ---------- Clipboard (plain text, so it works between projects and windows) ---------- */

const CLIP_PREFIX = 'luma-scene:';
export const serializeElement = (kind: SceneKind, el: Element) => CLIP_PREFIX + JSON.stringify({ kind, el });

/** Parses clipboard text; anything malformed or out of bounds is rejected by the project schemas (trust boundary). */
export function parseElement(text: string): { kind: SceneKind; el: Element } | null {
  if (!text.startsWith(CLIP_PREFIX)) return null;
  try {
    const raw = JSON.parse(text.slice(CLIP_PREFIX.length)) as { kind?: unknown; el?: unknown };
    if (typeof raw.kind !== 'string' || !Object.hasOwn(SCHEMA, raw.kind)) return null;
    const kind = raw.kind as SceneKind;
    const parsed = SCHEMA[kind].safeParse(raw.el);
    return parsed.success ? { kind, el: parsed.data } : null;
  } catch {
    return null;
  }
}

/* ---------- Equip: hang fixtures evenly on the trusses ---------- */

/** Share of a totem in the spread (as many fixtures as 1 m of straight truss), and spacing of stacked fixtures. */
const TOTEM_SHARE = 1, TOTEM_STEP = 0.5;

export interface EquipFixture { id: string; movable: boolean }
export interface Placement { id: string; position: P2; height: number; trussId: string }

const segmentsOf = (t: Truss) => {
  // A totem takes a 1 m share of the fixtures, all on its clamp point.
  if (t.shape === 'totem') { const c = nearestOnTruss(t, t.x, t.y); return [{ a: c, b: c, t, len: TOTEM_SHARE }]; }
  return trussSegments(t).map(([a, b]) => ({ a, b, t, len: Math.hypot(b.x - a.x, b.y - a.y) }));
};
const lengthOf = (t: Truss) => segmentsOf(t).reduce((s, x) => s + x.len, 0);

/**
 * `n` points on `trusses`: each truss gets a share proportional to its length (largest remainders), spread evenly
 * and centred on it, so every truss has a regular, symmetric pitch. Junction pieces only carry fixtures when they
 * are all there is (they are the joints of the straight trusses).
 */
function spread(trusses: readonly Truss[], n: number): { p: P2; t: Truss }[] {
  const plain = trusses.filter((t) => !JUNCTION_ARMS[t.shape]);
  const on = (plain.length ? plain : [...trusses]).sort((a, b) => a.y - b.y || a.x - b.x);
  const lens = on.map(lengthOf), total = lens.reduce((s, x) => s + x, 0);
  const exact = lens.map((l) => (n * l) / total);
  const counts = exact.map(Math.floor);
  const byRemainder = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || lens[b.i]! - lens[a.i]!);
  for (let k = 0; k < n - counts.reduce((s, x) => s + x, 0); k++) counts[byRemainder[k]!.i]!++;
  return on.flatMap((t, i) => spreadOne(t, counts[i]!));
}

/** `n` points evenly spread along the outline of one truss. */
function spreadOne(truss: Truss, n: number): { p: P2; t: Truss }[] {
  const segs = segmentsOf(truss);
  const total = segs.reduce((s, x) => s + x.len, 0);
  const out: { p: P2; t: Truss }[] = [];
  for (let i = 0; i < n; i++) {
    let d = ((i + 0.5) * total) / n;
    let seg = segs[segs.length - 1]!;
    for (const s of segs) {
      if (d <= s.len) { seg = s; break; }
      d -= s.len;
    }
    const k = seg.len ? Math.min(1, d / seg.len) : 0;
    out.push({ p: { x: r2(seg.a.x + (seg.b.x - seg.a.x) * k), y: r2(seg.a.y + (seg.b.y - seg.a.y) * k) }, t: seg.t });
  }
  return out;
}

/**
 * Hangs fixtures evenly on the trusses: moving heads on the upstage half of the trusses (back light), the others on
 * the downstage half (front light); with a single truss, or when one family is missing, everything shares all trusses.
 */
export function equipTrusses(fixtures: readonly EquipFixture[], trusses: readonly Truss[]): Placement[] {
  const usable = trusses.filter((t) => t.shape === 'totem' || trussSegments(t).length);
  if (!usable.length || !fixtures.length) return [];
  const byDepth = [...usable].sort((a, b) => a.y - b.y);
  const half = Math.ceil(byDepth.length / 2);
  const movers = fixtures.filter((f) => f.movable), fixed = fixtures.filter((f) => !f.movable);
  // Single truss: both families share it in one spread (two spreads would land on the same points), interleaved
  // evenly by their rank in their own family.
  const rank = (fx: EquipFixture[]) => fx.map((f, i) => ({ f, k: (i + 0.5) / fx.length }));
  const mixed = [...rank(movers), ...rank(fixed)].sort((a, b) => a.k - b.k).map((x) => x.f);
  const groups = movers.length && fixed.length && byDepth.length > 1
    ? [{ fx: movers, on: byDepth.slice(half) }, { fx: fixed, on: byDepth.slice(0, half) }]
    : [{ fx: mixed, on: byDepth }];
  const onTotem = new Map<string, number>();
  return groups.flatMap(({ fx, on }) => spread(on, fx.length).map(({ p, t }, i) => {
    // Several fixtures on one totem are stacked downwards from the top, never below 0.5 m.
    const k = t.shape === 'totem' ? onTotem.get(t.id) ?? 0 : 0;
    if (t.shape === 'totem') onTotem.set(t.id, k + 1);
    return { id: fx[i]!.id, position: p, height: r2(Math.max(Math.min(0.5, hangHeight(t)), hangHeight(t) - k * TOTEM_STEP)), trussId: t.id };
  }));
}

/** Visualizer patch that changes fields of one element (moves, resizes). */
export const withPatched = (vis: Vis, ref: SceneRef, patch: Partial<Element>): Partial<Vis> =>
  ({ [LIST[ref.kind]]: items(vis, ref.kind).map((x) => (x.id === ref.id ? { ...x, ...patch } : x)) });
