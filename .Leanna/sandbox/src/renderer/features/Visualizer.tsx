import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Armchair, Boxes, Crosshair, ExternalLink, LayoutTemplate, Library, MapPin, Monitor, Move, Plus, Redo2, Settings2, Theater, Trash2, Undo2, UserRound, Wand2, X } from 'lucide-react';
import { confirmAction, useStore } from '../store';
import { act, newId } from '../api';
import { NumberInput, PageHead, useResolved } from '../components/ui';
import { buildVisualModel, type VisualFixture } from '../../core/visualizer/model';
import { Stage3D } from './Stage3D';
import type { FixtureValues, Performer, Project, StageMarker, StageProp, StageScreen, Truss } from '../../core/model/schemas';
import { DARK_LEVEL, performerLight, toHex } from '../../core/visualizer/lighting';
import { setScreenVideo, screenVideo } from '../screenMedia';
import { JUNCTION_ARMS, nearestOnTruss, snapToTrusses, snapTrussEnds, trussSegments, trussSupports } from '../../core/visualizer/truss';
import { LIBRARY, LIBRARY_GROUPS, PROP_KIND_LABEL, TRUSS_LENGTH_LABEL, TRUSS_SHAPE_LABEL, type LibraryGroup, type LibraryItem } from '../../core/visualizer/library';
import { SCENE_LABEL, canAdd, findElement, withPatched, type SceneKind, type SceneRef } from '../../core/visualizer/sceneEdit';
import { LIBRARY_MIME, acceptLibraryDrag, addSceneElement, dropLibraryItem, equipRig, removeSceneElement, useSceneShortcuts } from '../sceneActions';
import { SCENE_TEMPLATES, hasSceneContent, sceneTemplate } from '../../core/visualizer/templates';

interface View { scale: number; ox: number; oy: number }

/**
 * 2D top-down stage view drawn on a canvas from the renderer-agnostic VisualFixture model
 * (the same model is designed to feed a future Three.js view). Approximate, not photometric.
 */
export function StageCanvas({ values, compact, editable, groupFilter }: { values?: FixtureValues; compact?: boolean; editable?: boolean; groupFilter?: string | null }) {
  const live = useStore((s) => s.values);
  const project = useStore((s) => s.project!.project);
  const selection = useStore((s) => s.selection);
  const setSelection = useStore((s) => s.setSelection);
  const { fixtures } = useResolved();
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ scale: 0, ox: 0, oy: 0 });
  const drag = useRef<{ kind: 'pan' | 'fixture' | 'marker' | 'performer' | 'element'; id?: string; ref?: SceneRef; x: number; y: number; ox: number; oy: number; moved: boolean; keep?: boolean } | null>(null);
  const placing = useStore((s) => s.placing);
  const sceneSel = useStore((s) => s.sceneSel);
  const setSceneSel = useStore((s) => s.setSceneSel);
  const local = useRef(new Map<string, { x: number; y: number; height?: number }>());
  const fitKey = useRef('');
  const model = useMemo(() => buildVisualModel(fixtures, values ?? live), [fixtures, values, live]);
  const group = groupFilter ? project.groups.find((g) => g.id === groupFilter) : null;
  const vis = project.visualizer;
  const W = vis.stageWidth, D = vis.stageDepth;
  const thrust = vis.shape === 'thrust' ? vis.thrust : null;
  const front = thrust?.depth ?? 0;
  const markerPos = (m: StageMarker) => local.current.get(m.id) ?? { x: m.x, y: m.y };
  /** Element at its position while dragged (truss, set piece, screen). */
  const at = <T extends { id: string; x: number; y: number }>(e: T): T => ({ ...e, ...local.current.get(e.id) });
  /** Performer position, following its stage point (also while that point is being dragged). */
  const performerPos = (pf: Performer) => {
    const m = pf.markerId ? vis.markers.find((x) => x.id === pf.markerId) : undefined;
    return local.current.get(pf.id) ?? (m ? markerPos(m) : { x: pf.x, y: pf.y });
  };

  // Fit stage on first layout.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const key = `${W}|${D}|${front}|${Math.round(r.width)}`;
      setView((v) => {
        // Refit when the stage outline or the view width changes (scene panel opened), keep the user's zoom/pan otherwise.
        if (v.scale && fitKey.current === key) return v;
        fitKey.current = key;
        const scale = Math.min(r.width / (W + 4), r.height / (D + front + 4));
        return { scale, ox: r.width / 2, oy: r.height - 20 - front * scale };
      });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [W, D, front]);

  const toScreen = (x: number, y: number, v = view) => ({ x: v.ox + x * v.scale, y: v.oy - y * v.scale });
  const pos = (f: VisualFixture) => local.current.get(f.id) ?? { x: f.x, y: f.y };

  useEffect(() => {
    const c = canvas.current, el = wrap.current;
    if (!c || !el || !view.scale) return;
    const r = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = r.width * dpr;
    c.height = r.height * dpr;
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    // Stage
    const a = toScreen(-W / 2, D), b = toScreen(W / 2, 0);
    g.fillStyle = '#0d1018';
    g.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    g.strokeStyle = '#283142';
    g.lineWidth = 1;
    g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    g.strokeStyle = 'rgba(40,49,66,0.45)';
    for (let x = Math.ceil(-W / 2); x <= W / 2; x++) { const p = toScreen(x, 0), q = toScreen(x, D); g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke(); }
    for (let y = 1; y < D; y++) { const p = toScreen(-W / 2, y), q = toScreen(W / 2, y); g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke(); }
    if (thrust) {
      const ta = toScreen(-thrust.width / 2, 0), tb = toScreen(thrust.width / 2, -thrust.depth);
      g.fillStyle = '#0d1018';
      g.fillRect(ta.x, ta.y, tb.x - ta.x, tb.y - ta.y);
      g.strokeStyle = '#283142';
      g.strokeRect(ta.x, ta.y, tb.x - ta.x, tb.y - ta.y);
    }
    g.fillStyle = '#66718a';
    g.font = '11px sans-serif';
    if (vis.shape === 'arena') {
      g.fillText('PUBLIC', toScreen(0, D).x - 20, toScreen(0, D).y - 8);
      g.fillText('PUBLIC', toScreen(0, 0).x - 20, toScreen(0, 0).y + 14);
    } else {
      const lip = toScreen(thrust ? thrust.width / 2 + 1 : 0, 0);
      g.fillText('PUBLIC', lip.x - (thrust ? 0 : 20), lip.y + 14);
      if (vis.cyclo) {
        g.strokeStyle = '#4b5570';
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, a.y);
        g.stroke();
        g.lineWidth = 1;
      }
    }
    // Set pieces: footprint in their colour (round for columns and mic stands), outline, name.
    for (const p0 of vis.props) {
      const p = at(p0);
      g.fillStyle = `${p.color}cc`;
      g.strokeStyle = '#4b5570';
      g.beginPath();
      if (p.kind === 'column' || p.kind === 'mic') {
        const q = toScreen(p.x, p.y);
        g.arc(q.x, q.y, Math.max(4, (p.width / 2) * view.scale), 0, Math.PI * 2);
      } else {
        const a = (p.rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
        [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([u, v], i) => {
          const lx = (u! * p.width) / 2, ly = (v! * p.depth) / 2;
          const q = toScreen(p.x + lx * c - ly * s, p.y + lx * s + ly * c);
          if (i) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y);
        });
        g.closePath();
      }
      g.fill();
      g.stroke();
      const q = toScreen(p.x, p.y);
      g.fillStyle = '#98a3b5';
      g.font = '10px sans-serif';
      g.fillText(p.name, q.x + 6, q.y + 3);
    }
    // Explicit trusses: thick outline (a totem: a square seen from above), support feet, name.
    for (const t0 of vis.trusses) {
      const t = at(t0);
      if (t.shape === 'totem') {
        const q = toScreen(t.x, t.y), s = Math.max(8, 0.3 * view.scale);
        g.fillStyle = '#9aa3b5';
        g.fillRect(q.x - s / 2, q.y - s / 2, s, s);
      }
      g.strokeStyle = '#6b7385';
      g.lineWidth = Math.max(3, 0.29 * view.scale);
      g.lineCap = 'round';
      g.beginPath();
      for (const [a0, b0] of trussSegments(t)) {
        const pa = toScreen(a0.x, a0.y), pb = toScreen(b0.x, b0.y);
        g.moveTo(pa.x, pa.y);
        g.lineTo(pb.x, pb.y);
      }
      g.stroke();
      g.lineWidth = 1;
      g.fillStyle = t.support === 'towers' ? '#9aa3b5' : '#4b5570';
      for (const sp of trussSupports(t)) { const q = toScreen(sp.x, sp.y); g.fillRect(q.x - 4, q.y - 4, 8, 8); }
      const c = toScreen(t.x, t.y);
      g.fillStyle = '#7d879c';
      g.font = '10px sans-serif';
      g.fillText(`${t.name} · ${t.height} m`, c.x + 6, c.y - 8);
    }
    // Stage points: cyan diamond + name.
    for (const m of vis.markers) {
      const p = toScreen(markerPos(m).x, markerPos(m).y);
      g.fillStyle = '#22d3ee';
      g.beginPath();
      g.moveTo(p.x, p.y - 7);
      g.lineTo(p.x + 7, p.y);
      g.lineTo(p.x, p.y + 7);
      g.lineTo(p.x - 7, p.y);
      g.closePath();
      g.fill();
      g.fillStyle = '#67e8f9';
      g.font = '10px sans-serif';
      g.fillText(m.name, p.x + 10, p.y + 3);
    }
    // Screens: thick bar seen from above, in their colour.
    for (const sc0 of vis.screens) {
      const sc = at(sc0);
      const a2 = (sc.rotation * Math.PI) / 180, hw = sc.width / 2;
      const p1 = toScreen(sc.x - Math.cos(a2) * hw, sc.y - Math.sin(a2) * hw), p2 = toScreen(sc.x + Math.cos(a2) * hw, sc.y + Math.sin(a2) * hw);
      g.strokeStyle = sc.source === 'color' ? sc.color : '#5b6b8c';
      g.lineWidth = 5;
      g.beginPath(); g.moveTo(p1.x, p1.y); g.lineTo(p2.x, p2.y); g.stroke();
      g.lineWidth = 1;
      g.fillStyle = '#7d879c';
      g.font = '10px sans-serif';
      g.fillText(sc.name, (p1.x + p2.x) / 2 + 6, (p1.y + p2.y) / 2 - 6);
    }
    // Performers: disc tinted by the light on their face, red ring when in the dark.
    for (const pf of vis.performers) {
      const q = toScreen(performerPos(pf).x, performerPos(pf).y);
      const l = performerLight({ ...pf, ...performerPos(pf), markerId: null }, vis.markers, model);
      g.beginPath();
      g.arc(q.x, q.y, 8, 0, Math.PI * 2);
      g.fillStyle = l.level < DARK_LEVEL ? '#1b1f29' : toHex({ r: 0.15 + l.r * 0.85, g: 0.15 + l.g * 0.85, b: 0.15 + l.b * 0.85 });
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = l.level < DARK_LEVEL ? '#f87171' : '#e2e8f0';
      g.stroke();
      g.lineWidth = 1;
      g.fillStyle = '#e2e8f0';
      g.font = '10px sans-serif';
      g.fillText(`${pf.name} · ${Math.round(l.level * 100)} %`, q.x + 11, q.y + 3);
    }
    // Selected stage element: violet outline (bar for trusses, ring otherwise).
    const selEl = sceneSel && findElement(vis, sceneSel);
    if (selEl) {
      g.strokeStyle = '#8b5cf6';
      g.lineWidth = 2;
      g.setLineDash([4, 3]);
      if (sceneSel.kind === 'truss') {
        g.beginPath();
        for (const [a0, b0] of trussSegments(selEl as Truss)) { const pa = toScreen(a0.x, a0.y), pb = toScreen(b0.x, b0.y); g.moveTo(pa.x, pa.y); g.lineTo(pb.x, pb.y); }
        g.stroke();
      } else {
        const at = sceneSel.kind === 'performer' ? performerPos(selEl as Performer) : sceneSel.kind === 'marker' ? markerPos(selEl as StageMarker) : selEl;
        const q = toScreen(at.x, at.y);
        g.beginPath();
        g.arc(q.x, q.y, 14, 0, Math.PI * 2);
        g.stroke();
      }
      g.setLineDash([]);
      g.lineWidth = 1;
    }
    // Beams first (additive look), then bodies
    g.globalCompositeOperation = 'lighter';
    for (const f of model) {
      if (f.intensity <= 0.01) continue;
      const p = toScreen(pos(f).x, pos(f).y);
      const center = Math.PI / 2 + ((f.rotation + (f.movable ? f.panDeg : 0)) * Math.PI) / 180; // canvas angle; 0° = towards audience (down)
      const reach = (f.movable ? 1.2 + 4 * Math.abs(Math.cos((f.tiltDeg * Math.PI) / 180)) : 2.5) * view.scale;
      const half = ((f.beamAngle / 2) * Math.PI) / 180 + 0.08;
      const grad = g.createRadialGradient(p.x, p.y, 2, p.x, p.y, reach);
      const col = f.color;
      const alpha = Math.round(Math.min(1, f.intensity) * 150).toString(16).padStart(2, '0');
      grad.addColorStop(0, `${col}${alpha}`);
      grad.addColorStop(1, `${col}00`);
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(p.x, p.y);
      g.arc(p.x, p.y, reach, center - half, center + half);
      g.closePath();
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    for (const f of model) {
      const p = toScreen(pos(f).x, pos(f).y);
      const dim = group && !group.fixtureIds.includes(f.id);
      g.globalAlpha = dim ? 0.25 : 1;
      g.beginPath();
      g.arc(p.x, p.y, f.movable ? 9 : 7, 0, Math.PI * 2);
      g.fillStyle = '#191f2b';
      g.fill();
      g.beginPath();
      g.arc(p.x, p.y, f.movable ? 6 : 5, 0, Math.PI * 2);
      const k = f.intensity;
      const rgb = [1, 3, 5].map((i) => Math.round(parseInt(f.color.slice(i, i + 2), 16) * k));
      g.fillStyle = `rgb(${rgb.join(',')})`;
      g.fill();
      if (f.cells.length) {
        // Multi-cell fixture: draw its cells as a row of segments under the body.
        const w = 6;
        f.cells.forEach((c, i) => {
          g.fillStyle = c;
          g.fillRect(p.x - (f.cells.length * w) / 2 + i * w, p.y + 9, w - 1, 5);
        });
      }
      g.lineWidth = selection.includes(f.id) ? 2 : 1;
      g.strokeStyle = selection.includes(f.id) ? '#8b5cf6' : group?.fixtureIds.includes(f.id) ? group.color : '#36415a';
      g.beginPath();
      g.arc(p.x, p.y, f.movable ? 9 : 7, 0, Math.PI * 2);
      g.stroke();
      if (!compact || view.scale > 30) {
        g.fillStyle = '#98a3b5';
        g.font = '10px sans-serif';
        g.fillText(f.name, p.x + 11, p.y + 3);
      }
      g.globalAlpha = 1;
    }
  });

  const hit = (cx: number, cy: number) => {
    const r = wrap.current!.getBoundingClientRect();
    const x = cx - r.left, y = cy - r.top;
    return model.find((f) => { const p = toScreen(pos(f).x, pos(f).y); return Math.hypot(p.x - x, p.y - y) < 11; });
  };
  const hitMarker = (cx: number, cy: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return vis.markers.find((m) => { const p = toScreen(markerPos(m).x, markerPos(m).y); return Math.hypot(p.x - (cx - r.left), p.y - (cy - r.top)) < 9; });
  };
  const hitPerformer = (cx: number, cy: number) => {
    const r = wrap.current!.getBoundingClientRect();
    return vis.performers.find((pf) => { const q = toScreen(performerPos(pf).x, performerPos(pf).y); return Math.hypot(q.x - (cx - r.left), q.y - (cy - r.top)) < 10; });
  };
  /** Truss, screen or set piece under the pointer (within 8 px of a truss outline seen from above). */
  const hitStructure = (cx: number, cy: number): SceneRef | undefined => {
    const r = wrap.current!.getBoundingClientRect();
    const x = (cx - r.left - view.ox) / view.scale, y = (view.oy - (cy - r.top)) / view.scale;
    const tol = 8 / view.scale;
    const near = (t: Truss) => nearestOnTruss(t, x, y).dist < tol;
    const t = vis.trusses.find((t) => (t.shape === 'totem' ? Math.hypot(t.x - x, t.y - y) < Math.max(tol, 0.2) : near(t)));
    if (t) return { kind: 'truss', id: t.id };
    // A screen seen from above is a straight bar: test it as a straight truss of the same width.
    const sc = vis.screens.find((s) => near({ ...s, shape: 'line', length: s.width, height: 1, support: 'towers' }));
    if (sc) return { kind: 'screen', id: sc.id };
    // Set pieces last (large areas), the most recent on top.
    const pr = [...vis.props].reverse().find((p) => {
      if (p.kind === 'column' || p.kind === 'mic') return Math.hypot(p.x - x, p.y - y) <= Math.max(p.width / 2, tol);
      const a = (p.rotation * Math.PI) / 180, dx = x - p.x, dy = y - p.y;
      const lx = dx * Math.cos(a) + dy * Math.sin(a), ly = -dx * Math.sin(a) + dy * Math.cos(a);
      return Math.abs(lx) <= p.width / 2 + tol / 2 && Math.abs(ly) <= p.depth / 2 + tol / 2;
    });
    return pr ? { kind: 'prop', id: pr.id } : undefined;
  };
  const down = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (placing && e.button === 0) {
      const r = wrap.current!.getBoundingClientRect();
      addSceneElement(placing.kind, { x: (e.clientX - r.left - view.ox) / view.scale, y: (view.oy - (e.clientY - r.top)) / view.scale }, placing.preset);
      return;
    }
    const f = hit(e.clientX, e.clientY);
    const pf = !f && e.button === 0 ? hitPerformer(e.clientX, e.clientY) : undefined;
    const mk = !f && !pf && e.button === 0 ? hitMarker(e.clientX, e.clientY) : undefined;
    const ref: SceneRef | undefined = pf ? { kind: 'performer', id: pf.id } : mk ? { kind: 'marker', id: mk.id } : !f && e.button === 0 ? hitStructure(e.clientX, e.clientY) : undefined;
    if (ref) setSceneSel(ref);
    if (pf && editable) {
      const at = performerPos(pf);
      drag.current = { kind: 'performer', id: pf.id, x: e.clientX, y: e.clientY, ox: at.x, oy: at.y, moved: false };
    } else if (mk && editable) {
      drag.current = { kind: 'marker', id: mk.id, x: e.clientX, y: e.clientY, ox: mk.x, oy: mk.y, moved: false };
    } else if (ref && editable && (ref.kind === 'truss' || ref.kind === 'prop' || ref.kind === 'screen')) {
      const el = findElement(vis, ref)!;
      drag.current = { kind: 'element', ref, id: ref.id, x: e.clientX, y: e.clientY, ox: el.x, oy: el.y, moved: false };
    } else if (f && e.button === 0) {
      setSceneSel(null);
      if (e.ctrlKey || e.shiftKey) setSelection(selection.includes(f.id) ? selection.filter((x) => x !== f.id) : [...selection, f.id]);
      else if (!selection.includes(f.id)) setSelection([f.id]);
      drag.current = editable ? { kind: 'fixture', id: f.id, x: e.clientX, y: e.clientY, ox: pos(f).x, oy: pos(f).y, moved: false } : null;
    } else {
      // A click on an element (not editable) selects it but still pans the view when dragged.
      drag.current = { kind: 'pan', x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy, moved: false, keep: !!ref };
    }
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.moved = true;
    if (d.kind === 'pan') setView({ ...view, ox: d.ox + e.clientX - d.x, oy: d.oy + e.clientY - d.y });
    else if (d.id) {
      // Fixtures and stage elements share the local drag overlay (ids never collide: all are UUIDs).
      const p = { x: Math.round((d.ox + (e.clientX - d.x) / view.scale) * 10) / 10, y: Math.round((d.oy - (e.clientY - d.y) / view.scale) * 10) / 10 };
      const t = d.ref?.kind === 'truss' ? vis.trusses.find((x) => x.id === d.id) : undefined;
      // Truss pieces snap end to end (and take the height of the piece they join) while dragged.
      const snap = t ? snapTrussEnds({ ...t, ...p }, vis.trusses) : null;
      local.current.set(d.id, snap ? { x: snap.x, y: snap.y, height: snap.height } : p);
      setView({ ...view });
    }
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.kind === 'pan' && !d.moved && !d.keep) { setSelection([]); setSceneSel(null); }
    if (d?.kind === 'performer' && d.id && d.moved) {
      const p = local.current.get(d.id)!;
      const clampPos = (v: number) => Math.max(-100, Math.min(100, v));
      // Dropped on a stage point (within 50 cm): the performer stands on it and follows it; else free.
      const near = vis.markers.find((m) => Math.hypot(m.x - p.x, m.y - p.y) <= 0.5);
      const performers = vis.performers.map((x) => (x.id === d.id ? { ...x, x: clampPos(near?.x ?? p.x), y: clampPos(near?.y ?? p.y), markerId: near?.id ?? null } : x));
      void act({ type: 'project.update', visualizer: { performers } }).finally(() => local.current.delete(d.id!));
    }
    if (d?.kind === 'element' && d.ref && d.id && d.moved) {
      const p = local.current.get(d.id)!;
      const clampPos = (v: number) => Math.max(-100, Math.min(100, v));
      const patch = { x: clampPos(p.x), y: clampPos(p.y), ...(p.height !== undefined ? { height: p.height } : {}) };
      void act({ type: 'project.update', visualizer: withPatched(vis, d.ref, patch) }).finally(() => local.current.delete(d.id!));
    }
    if (d?.kind === 'marker' && d.id && d.moved) {
      const p = local.current.get(d.id)!;
      const clampPos = (v: number) => Math.max(-100, Math.min(100, v));
      const markers = vis.markers.map((m) => (m.id === d.id ? { ...m, x: clampPos(p.x), y: clampPos(p.y) } : m));
      void act({ type: 'project.update', visualizer: { markers } }).finally(() => local.current.delete(d.id!));
    }
    if (d?.kind === 'fixture' && d.id && d.moved) {
      const p = local.current.get(d.id)!;
      const position = { x: Math.max(-100, Math.min(100, p.x)), y: Math.max(-100, Math.min(100, p.y)) };
      const f = model.find((x) => x.id === d.id);
      // Hung fixtures dropped near a truss hang on it; dragged away, they are detached.
      const snap = f?.mount === 'hanging' ? snapToTrusses(vis.trusses, position.x, position.y) : null;
      const patch = snap
        ? { position: { x: snap.x, y: snap.y }, height: snap.height, trussId: snap.truss.id }
        : { position, ...(f?.trussId ? { trussId: null } : {}) };
      if (snap) local.current.set(d.id, patch.position);
      void act({ type: 'fixture.update', id: d.id, patch }).finally(() => local.current.delete(d.id!));
    }
  };
  const wheel = (e: React.WheelEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const k = Math.exp(-e.deltaY * 0.0015);
    const scale = Math.max(5, Math.min(400, view.scale * k));
    setView({ scale, ox: mx - ((mx - view.ox) * scale) / view.scale, oy: my - ((my - view.oy) * scale) / view.scale });
  };
  return (
    <div ref={wrap} className="canvas-wrap" style={{ height: '100%', cursor: placing ? 'crosshair' : undefined }} onPointerDown={down} onDragOver={acceptLibraryDrag} onDrop={(e) => { const r = wrap.current!.getBoundingClientRect(); dropLibraryItem(e, { x: (e.clientX - r.left - view.ox) / view.scale, y: (view.oy - (e.clientY - r.top)) / view.scale }); }} onPointerMove={move} onPointerUp={up} onWheel={wheel} data-testid="stage-canvas">
      <canvas ref={canvas} />
    </div>
  );
}

export const Visualizer = () => <StagePage mode="2d" />;
export const StageVisualizer3D = () => <StagePage mode="3d" />;

export const DETACHED_STAGE_HASH = '#stage3d';

/** Chrome-less live 3D view for a second screen, opened by the "Détacher" button. F11 : plein écran. */
export function DetachedStage3D() {
  const ready = useStore((s) => !!s.project);
  useEffect(() => {
    document.title = 'Stage 3D';
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F11') return;
      e.preventDefault();
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return <div style={{ height: '100vh' }}>{ready ? <Stage3D /> : <div className="empty">Connexion au moteur…</div>}</div>;
}

type Vis = Project['visualizer'];
const SHAPES: { id: Vis['shape']; label: string }[] = [
  { id: 'rect', label: 'Rectangle' }, { id: 'thrust', label: 'Avancée' }, { id: 'arena', label: 'Arène (360°)' },
];

/** Collapsible panel section (native <details>: keyboard accessible, toggled state kept by the browser). */
function Section({ icon, title, count, open = true, children }: { icon: ReactNode; title: string; count?: number; open?: boolean; children: ReactNode }) {
  return (
    <details className="scene-section" open={open}>
      <summary>{icon}<span className="grow">{title}</span>{count !== undefined && <span className="badge">{count}</span>}</summary>
      <div className="scene-section-body">{children}</div>
    </details>
  );
}

/** Labeled numeric field of a scene card. */
function Num({ label, title, value, min, max, step = 0.25, onChange }: { label: string; title: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return <label className="scene-num" title={title}><span>{label}</span><NumberInput value={value} min={min} max={max} step={step} onChange={onChange} /></label>;
}

/** Name field committed on blur; `key` resets it when the saved name changes (undo, template). */
function NameInput({ value, label, onChange }: { value: string; label: string; onChange: (name: string) => void }) {
  return (
    <input key={value} className="input grow" defaultValue={value} maxLength={80} aria-label={label}
      onBlur={(e) => { const name = e.target.value.trim(); if (name && name !== value) onChange(name); else e.target.value = value; }} />
  );
}

/** Element card; clicking or focusing it selects the element (Ctrl+D, Suppr, Ctrl+C apply to it). */
function Card({ testId, sel, head, children }: { testId: string; sel: SceneRef; head: ReactNode; children?: ReactNode }) {
  const selected = useStore((s) => s.sceneSel?.id === sel.id);
  const el = useRef<HTMLDivElement>(null);
  // Selected from the 2D / 3D view: bring the card into sight.
  useEffect(() => { if (selected && !el.current?.contains(document.activeElement)) el.current?.scrollIntoView({ block: 'nearest' }); }, [selected]);
  const select = () => { if (!selected) useStore.getState().setSceneSel(sel); };
  return (
    <div ref={el} className={`scene-card ${selected ? 'on' : ''}`} data-testid={testId} onPointerDown={select} onFocus={select}>
      <div className="row" style={{ gap: 6 }}>{head}</div>
      {children && <div className="scene-card-grid">{children}</div>}
    </div>
  );
}

const DeleteBtn = ({ name, title, sel }: { name: string; title?: string; sel: SceneRef }) => (
  <button className="btn ghost sm icon" title={title ?? `Supprimer « ${name} » (Suppr)`} aria-label={`Supprimer ${name}`} onClick={() => removeSceneElement(sel)}><Trash2 size={12} /></button>
);

/** "+ Add" (next free spot) and "place with a click on the stage" for one kind of element. */
function AddBtn({ kind, label, testId }: { kind: SceneKind; label: string; testId: string }) {
  const vis = useStore((s) => s.project!.project.visualizer);
  const placing = useStore((s) => s.placing?.kind === kind && !s.placing.preset);
  const full = !canAdd(vis, kind);
  return (
    <div className="row" style={{ gap: 6 }}>
      <button className="btn sm" onClick={() => addSceneElement(kind)} disabled={full} data-testid={testId}><Plus size={12} />{label}</button>
      <button className={`btn sm ${placing ? 'on' : ''}`} onClick={() => useStore.getState().setPlacing(placing ? null : { kind, label: SCENE_LABEL[kind].toLowerCase() })} disabled={full} aria-pressed={placing}
        title="Poser au clic sur le plateau (2D ou 3D) — Échap pour annuler" data-testid={`${testId}-place`}><Crosshair size={12} />Poser au clic</button>
    </div>
  );
}

/** One-click starting layouts; replacing a non-empty scene asks first (and stays undoable). */
function TemplatePicker({ vis }: { vis: Vis }) {
  const apply = async (t: (typeof SCENE_TEMPLATES)[number]) => {
    if (hasSceneContent(vis) && !(await confirmAction({
      title: 'Remplacer la scène',
      message: `Le modèle « ${t.label} » remplace le plateau, les points, structures, interprètes et écrans actuels.\nLes projecteurs restent en place. Ctrl+Z pour annuler.`,
      confirmLabel: 'Remplacer',
    }))) return;
    for (const sc of vis.screens) setScreenVideo(sc.id, null);
    void act({ type: 'project.update', visualizer: sceneTemplate(t.id, newId) });
  };
  return (
    <div className="scene-templates">
      {SCENE_TEMPLATES.map((t) => (
        <button key={t.id} className="scene-template" onClick={() => void apply(t)} data-testid={`template-${t.id}`}>
          <b>{t.label}</b><span className="small dim">{t.hint}</span>
        </button>
      ))}
    </div>
  );
}

/** Scene builder shared by the 2D and 3D views: template, stage, points, trusses, performers, screens. */
function ScenePanel({ vis, onClose }: { vis: Vis; onClose: () => void }) {
  const update = (v: Partial<Vis>) => void act({ type: 'project.update', visualizer: v });
  const setMarker = (id: string, patch: Partial<StageMarker>) => update({ markers: vis.markers.map((m) => (m.id === id ? { ...m, ...patch } : m)) });
  return (
    <aside className="scene-panel" data-testid="stage-settings" aria-label="Construction de la scène">
      <div className="scene-panel-head">
        <Settings2 size={14} className="dim" /><b className="grow">Construire la scène</b>
        <button className="btn ghost sm icon" onClick={onClose} title="Fermer le panneau" aria-label="Fermer le panneau"><X size={14} /></button>
      </div>
      <div className="scene-panel-body">
        <Section icon={<LayoutTemplate size={13} />} title="Partir d’un modèle" open={!hasSceneContent(vis)}>
          <TemplatePicker vis={vis} />
        </Section>
        <Section icon={<Library size={13} />} title="Bibliothèque">
          <LibraryPicker />
        </Section>
        <Section icon={<Theater size={13} />} title="Plateau">
          <div className="chips" role="group" aria-label="Forme du plateau">
            {SHAPES.map((sh) => <button key={sh.id} className={`chip ${vis.shape === sh.id ? 'on' : ''}`} data-testid={`shape-${sh.id}`} onClick={() => update({ shape: sh.id })}>{sh.label}</button>)}
          </div>
          <div className="scene-card-grid">
            <Num label="Largeur" title="Largeur du plateau, jardin ↔ cour (m)" value={vis.stageWidth} min={2} max={200} step={1} onChange={(v) => update({ stageWidth: v })} />
            <Num label="Profondeur" title="Profondeur du plateau (m)" value={vis.stageDepth} min={2} max={200} step={1} onChange={(v) => update({ stageDepth: v })} />
            {vis.shape !== 'arena' && (
              <label className="row small scene-check"><input type="checkbox" checked={vis.cyclo} onChange={(e) => update({ cyclo: e.target.checked })} data-testid="cyclo" />Cyclorama</label>
            )}
            {vis.shape === 'thrust' && (
              <>
                <Num label="Avancée L" title="Largeur de l’avancée (m)" value={vis.thrust.width} min={1} max={50} step={0.5} onChange={(v) => update({ thrust: { ...vis.thrust, width: v } })} />
                <Num label="Avancée P" title="Profondeur de l’avancée (m)" value={vis.thrust.depth} min={1} max={50} step={0.5} onChange={(v) => update({ thrust: { ...vis.thrust, depth: v } })} />
              </>
            )}
          </div>
        </Section>
        <Section icon={<MapPin size={13} />} title="Points de scène" count={vis.markers.length}>
          {vis.markers.map((m) => (
            <Card key={m.id} testId="marker-row" sel={{ kind: 'marker', id: m.id }} head={<><NameInput value={m.name} label="Nom du point" onChange={(name) => setMarker(m.id, { name })} /><DeleteBtn name={m.name} sel={{ kind: 'marker', id: m.id }} /></>}>
              <Num label="X" title="Jardin ↔ cour (m)" value={m.x} min={-100} max={100} step={0.1} onChange={(v) => setMarker(m.id, { x: v })} />
              <Num label="Y" title="Profondeur (m)" value={m.y} min={-100} max={100} step={0.1} onChange={(v) => setMarker(m.id, { y: v })} />
              <Num label="H visée" title="Hauteur de visée (m)" value={m.height} min={0} max={10} step={0.1} onChange={(v) => setMarker(m.id, { height: v })} />
            </Card>
          ))}
          <AddBtn kind="marker" label="Point de scène" testId="marker-add" />
          <p className="scene-hint">Repères « chanteur », « batteur »… déplaçables en 2D (Positionner).</p>
        </Section>
        <TrussSettings vis={vis} />
        <PropSettings vis={vis} />
        <PerformerSettings vis={vis} />
        <ScreenSettings vis={vis} />
      </div>
    </aside>
  );
}

/** Small top view of a library item (drawn, so every piece reads at a glance whatever the icon set). */
function LibraryGlyph({ item }: { item: LibraryItem }) {
  const s = { stroke: 'currentColor', strokeWidth: 2, fill: 'none', strokeLinecap: 'round' as const };
  let body: ReactNode;
  if (item.kind === 'truss') {
    const p = item.preset;
    const arms = JUNCTION_ARMS[p.shape ?? 'line'];
    if (arms) body = <>{arms.map((a) => <line key={a} x1={14} y1={14} x2={14 + 10 * Math.cos((a * Math.PI) / 180)} y2={14 - 10 * Math.sin((a * Math.PI) / 180)} {...s} strokeWidth={4} />)}<rect x={11} y={11} width={6} height={6} fill="currentColor" /></>;
    else if (p.shape === 'totem') body = <><rect x={11} y={3} width={6} height={20} {...s} /><line x1={6} y1={25} x2={22} y2={25} {...s} /></>;
    else if (p.shape === 'circle') body = <circle cx={14} cy={14} r={10} {...s} strokeWidth={3} />;
    else if (p.shape === 'square') body = <rect x={4} y={4} width={20} height={20} {...s} strokeWidth={3} />;
    else {
      const len = Math.min(24, 4 + (p.length ?? 2) * 5);
      body = <><line x1={14 - len / 2} y1={14} x2={14 + len / 2} y2={14} {...s} strokeWidth={4} />{p.support === 'towers' && <><line x1={2} y1={14} x2={2} y2={26} {...s} /><line x1={26} y1={14} x2={26} y2={26} {...s} /></>}</>;
    }
  } else if (item.kind === 'prop') {
    const k = item.preset.kind;
    if (k === 'column' || k === 'mic') body = <><circle cx={14} cy={k === 'mic' ? 7 : 14} r={k === 'mic' ? 3 : 8} {...s} />{k === 'mic' && <line x1={14} y1={10} x2={14} y2={25} {...s} />}</>;
    else if (k === 'stairs') body = <path d="M4 24h6v-6h6v-6h6v-6h2" {...s} />;
    else if (k === 'drape') body = <path d="M4 4v20M9 4v20M14 4v20M19 4v20M24 4v20" {...s} strokeWidth={1.5} />;
    else if (k === 'monitor') body = <path d="M4 22h20L8 10z" {...s} />;
    else if (k === 'speaker') body = <><rect x={8} y={3} width={12} height={22} {...s} /><circle cx={14} cy={17} r={4} {...s} /></>;
    else if (k === 'table') body = <path d="M3 10h22M6 10v14M22 10v14" {...s} />;
    else body = <rect x={k === 'riser' ? 2 : 6} y={k === 'riser' ? 9 : 6} width={k === 'riser' ? 24 : 16} height={k === 'riser' ? 10 : 16} {...s} />;
  } else if (item.kind === 'performer') body = <><circle cx={14} cy={7} r={4} {...s} /><path d="M7 25c0-6 3-10 7-10s7 4 7 10" {...s} /></>;
  else if (item.kind === 'screen') body = <rect x={3} y={7} width={22} height={13} {...s} />;
  else body = <path d="M14 4l8 10-8 10-8-10z" {...s} />;
  return <svg width={28} height={28} viewBox="0 0 28 28" aria-hidden>{body}</svg>;
}

/** Library of pieces: click a tile then the stage, or drag the tile onto the 2D / 3D view. */
function LibraryPicker() {
  const [group, setGroup] = useState<LibraryGroup>('truss');
  const placing = useStore((s) => s.placing);
  return (
    <>
      <div className="chips" role="tablist" aria-label="Catégories">
        {LIBRARY_GROUPS.map((g) => <button key={g.id} role="tab" aria-selected={group === g.id} className={`chip ${group === g.id ? 'on' : ''}`} onClick={() => setGroup(g.id)} data-testid={`lib-group-${g.id}`}>{g.label}</button>)}
      </div>
      <div className="scene-library">
        {LIBRARY.filter((x) => x.group === group).map((item) => (
          <button key={item.id} className={`scene-lib-item ${placing?.label === item.label ? 'on' : ''}`} draggable data-testid={`lib-${item.id}`}
            title={`${item.label} — cliquer puis cliquer sur le plateau, ou glisser sur la vue`}
            onClick={() => useStore.getState().setPlacing(placing?.label === item.label ? null : { kind: item.kind, label: item.label, preset: { ...item.preset } })}
            onDragStart={(e) => { e.dataTransfer.setData(LIBRARY_MIME, item.id); e.dataTransfer.effectAllowed = 'copy'; }}>
            <LibraryGlyph item={item} />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <p className="scene-hint">Les pièces se raccordent bout à bout quand on les approche (aimantation 35 cm) et prennent la hauteur de la pièce rejointe.</p>
    </>
  );
}

const PROP_KINDS = Object.entries(PROP_KIND_LABEL) as [StageProp['kind'], string][];

/** Set pieces (risers, stairs, speakers, monitors, mic stands, tables, drapes, boxes, columns). */
function PropSettings({ vis }: { vis: Vis }) {
  const set = (id: string, patch: Partial<StageProp>) => void act({ type: 'project.update', visualizer: withPatched(vis, { kind: 'prop', id }, patch) });
  return (
    <Section icon={<Armchair size={13} />} title="Décor" count={vis.props.length}>
      {vis.props.map((p) => (
        <Card key={p.id} testId="prop-row" sel={{ kind: 'prop', id: p.id }} head={<>
          <NameInput value={p.name} label="Nom de l’élément" onChange={(name) => set(p.id, { name })} />
          <select className="select" style={{ width: 110 }} value={p.kind} aria-label="Type" onChange={(e) => set(p.id, { kind: e.target.value as StageProp['kind'] })}>
            {PROP_KINDS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <DeleteBtn name={p.name} sel={{ kind: 'prop', id: p.id }} />
        </>}>
          <Num label="X" title="Centre, jardin ↔ cour (m)" value={p.x} min={-100} max={100} onChange={(v) => set(p.id, { x: v })} />
          <Num label="Y" title="Centre, profondeur (m)" value={p.y} min={-100} max={100} onChange={(v) => set(p.id, { y: v })} />
          <Num label="Rotation" title="Rotation (°)" value={p.rotation} min={-360} max={360} step={15} onChange={(v) => set(p.id, { rotation: v })} />
          <Num label="Largeur" title="Largeur (m)" value={p.width} min={0.05} max={40} step={0.1} onChange={(v) => set(p.id, { width: v })} />
          <Num label="Profondeur" title="Profondeur (m)" value={p.depth} min={0.05} max={40} step={0.1} onChange={(v) => set(p.id, { depth: v })} />
          <Num label="Hauteur" title="Hauteur (m)" value={p.height} min={0.05} max={20} step={0.1} onChange={(v) => set(p.id, { height: v })} />
          <Num label="Élévation" title="Posé à cette hauteur (empilement sur un praticable…)" value={p.elevation} min={0} max={20} step={0.1} onChange={(v) => set(p.id, { elevation: v })} />
          <label className="scene-num"><span>Couleur</span>
            <input type="color" value={p.color} aria-label="Couleur" onChange={(e) => set(p.id, { color: e.target.value })} className="scene-color" />
          </label>
        </Card>
      ))}
      <AddBtn kind="prop" label="Décor" testId="prop-add" />
      <p className="scene-hint">Plus de modèles dans la bibliothèque (onglet Décor) ; en mode Positionner, glisser pour déplacer.</p>
    </Section>
  );
}

const TRUSS_SHAPES = Object.entries(TRUSS_SHAPE_LABEL) as [Truss['shape'], string][];

/** Explicit trusses: hung fixtures follow them (handled by the main process when a truss changes). */
function TrussSettings({ vis }: { vis: Vis }) {
  const save = (trusses: Truss[]) => void act({ type: 'project.update', visualizer: { trusses } });
  const set = (id: string, patch: Partial<Truss>) => save(vis.trusses.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const { fixtures } = useResolved();
  const selection = useStore((s) => s.selection);
  return (
    <Section icon={<Boxes size={13} />} title="Structures (truss)" count={vis.trusses.length}>
      {vis.trusses.length > 0 && fixtures.length > 0 && (
        <button className="btn sm primary" onClick={() => equipRig(buildVisualModel(fixtures, {}))} data-testid="equip"
          title="Répartir les projecteurs sur les structures : lyres en contre, projecteurs fixes en face (Ctrl+Z pour annuler)">
          <Wand2 size={12} />{selection.length ? `Équiper avec la sélection (${selection.length})` : 'Équiper les structures'}
        </button>
      )}
      {vis.trusses.map((t) => (
        <Card key={t.id} testId="truss-row" sel={{ kind: 'truss', id: t.id }} head={<>
          <NameInput value={t.name} label="Nom de la structure" onChange={(name) => set(t.id, { name })} />
          <select className="select" style={{ width: 104 }} value={t.shape} aria-label="Forme" onChange={(e) => set(t.id, { shape: e.target.value as Truss['shape'] })}>
            {TRUSS_SHAPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <DeleteBtn name={t.name} title={`Supprimer « ${t.name} » (les projecteurs restent en place, décrochés)`} sel={{ kind: 'truss', id: t.id }} />
        </>}>
          {/* Field order L, X, Y, H, ° is relied upon by the end-to-end tests. */}
          {t.shape !== 'totem' && <Num label={TRUSS_LENGTH_LABEL[t.shape]} title="Taille (m)" value={t.length} min={0.5} max={60} step={0.5} onChange={(v) => set(t.id, { length: v })} />}
          <Num label="X" title="Centre, jardin ↔ cour (m)" value={t.x} min={-100} max={100} onChange={(v) => set(t.id, { x: v })} />
          <Num label="Y" title="Centre, profondeur (m)" value={t.y} min={-100} max={100} onChange={(v) => set(t.id, { y: v })} />
          <Num label="Hauteur" title="Hauteur de la structure (m)" value={t.height} min={0.5} max={30} onChange={(v) => set(t.id, { height: v })} />
          <Num label="Rotation" title="Rotation (°)" value={t.rotation} min={-360} max={360} step={15} onChange={(v) => set(t.id, { rotation: v })} />
          <label className="scene-num"><span>Support</span>
            <select className="select" value={t.support} aria-label="Support" onChange={(e) => set(t.id, { support: e.target.value as Truss['support'] })}>
              <option value="towers">Sur pieds</option>
              <option value="hung">Suspendue</option>
              <option value="none">Posée (assemblage)</option>
            </select>
          </label>
        </Card>
      ))}
      <AddBtn kind="truss" label="Structure" testId="truss-add" />
      <p className="scene-hint">Les projecteurs accrochés suivent la structure ; aimantation au dépôt.</p>
    </Section>
  );
}

const PERFORMER_KINDS: { id: Performer['kind']; label: string }[] = [
  { id: 'standing', label: 'Debout' }, { id: 'seated', label: 'Assis' }, { id: 'drums', label: 'Batterie' }, { id: 'keys', label: 'Clavier' }, { id: 'lectern', label: 'Pupitre' },
];

/** Performer and instrument silhouettes; their face shows the light received (2D disc, 3D tint). */
function PerformerSettings({ vis }: { vis: Vis }) {
  const save = (performers: Performer[]) => void act({ type: 'project.update', visualizer: { performers } });
  const set = (id: string, patch: Partial<Performer>) => save(vis.performers.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  return (
    <Section icon={<UserRound size={13} />} title="Interprètes et instruments" count={vis.performers.length}>
      {vis.performers.map((pf) => (
        <Card key={pf.id} testId="performer-row" sel={{ kind: 'performer', id: pf.id }} head={<>
          <NameInput value={pf.name} label="Nom de l’interprète" onChange={(name) => set(pf.id, { name })} />
          {/* The silhouette must stay the first select of the card (end-to-end tests). */}
          <select className="select" style={{ width: 92 }} value={pf.kind} aria-label="Silhouette" onChange={(e) => set(pf.id, { kind: e.target.value as Performer['kind'] })}>
            {PERFORMER_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          <DeleteBtn name={pf.name} sel={{ kind: 'performer', id: pf.id }} />
        </>}>
          <label className="scene-num span2"><span>Position</span>
            <select className="select" value={pf.markerId ?? ''} aria-label="Point de scène" data-testid="performer-marker" onChange={(e) => {
              const m = vis.markers.find((x) => x.id === e.target.value);
              set(pf.id, m ? { markerId: m.id, x: m.x, y: m.y } : { markerId: null });
            }}>
              <option value="">Position libre</option>
              {vis.markers.map((m) => <option key={m.id} value={m.id}>Sur « {m.name} »</option>)}
            </select>
          </label>
          <Num label="Orientation" title="Orientation (0° = face au public)" value={pf.rotation} min={-360} max={360} step={15} onChange={(v) => set(pf.id, { rotation: v })} />
          {!pf.markerId && (
            <>
              <Num label="X" title="Jardin ↔ cour (m)" value={pf.x} min={-100} max={100} onChange={(v) => set(pf.id, { x: v })} />
              <Num label="Y" title="Profondeur (m)" value={pf.y} min={-100} max={100} onChange={(v) => set(pf.id, { y: v })} />
            </>
          )}
        </Card>
      ))}
      <AddBtn kind="performer" label="Interprète" testId="performer-add" />
      <p className="scene-hint">Lâché sur un point de scène en 2D, l’interprète s’y pose et le suit.</p>
    </Section>
  );
}

const SCREEN_SOURCES: { id: StageScreen['source']; label: string }[] = [
  { id: 'color', label: 'Couleur' }, { id: 'image', label: 'Image' }, { id: 'video', label: 'Vidéo' }, { id: 'pixels', label: 'Pixel mapping' },
];
/** Images are downscaled before being stored in the project (keeps project files small). */
const SCREEN_IMAGE_MAX_PX = 512;

function shrinkImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, SCREEN_IMAGE_MAX_PX / Math.max(img.width, img.height));
      const c = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(img.width * k)), height: Math.max(1, Math.round(img.height * k)) });
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image illisible')); };
    img.src = url;
  });
}

/** LED screens / video surfaces with a light spill on their surroundings. */
function ScreenSettings({ vis }: { vis: Vis }) {
  const [, rerender] = useState(0);
  const toast = useStore((s) => s.toast);
  const save = (screens: StageScreen[]) => void act({ type: 'project.update', visualizer: { screens } });
  const set = (id: string, patch: Partial<StageScreen>) => save(vis.screens.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  return (
    <Section icon={<Monitor size={13} />} title="Écrans LED" count={vis.screens.length}>
      {vis.screens.map((sc) => (
        <Card key={sc.id} testId="screen-row" sel={{ kind: 'screen', id: sc.id }} head={<>
          <NameInput value={sc.name} label="Nom de l’écran" onChange={(name) => set(sc.id, { name })} />
          <DeleteBtn name={sc.name} sel={{ kind: 'screen', id: sc.id }} />
        </>}>
          <label className="scene-num span2"><span>Contenu</span>
            <select className="select" value={sc.source} aria-label="Contenu" data-testid="screen-source" onChange={(e) => set(sc.id, { source: e.target.value as StageScreen['source'] })}>
              {SCREEN_SOURCES.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
          </label>
          <div className="scene-num">
            <span>&nbsp;</span>
            {sc.source === 'color' && <input type="color" value={sc.color} aria-label="Couleur de l’écran" onChange={(e) => set(sc.id, { color: e.target.value })} className="scene-color" />}
            {sc.source === 'image' && (
              <label className="btn sm" title="Image (réduite à 512 px et enregistrée dans le projet)">{sc.image ? 'Changer' : 'Image…'}
                <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) shrinkImage(file).then((image) => set(sc.id, { image })).catch((err: Error) => toast({ kind: 'error', title: 'Image', detail: err.message }));
                }} />
              </label>
            )}
            {sc.source === 'video' && (
              <label className="btn sm" title="Vidéo lue pendant cette session uniquement : le fichier n’est pas copié dans le projet">{screenVideo(sc.id) ? 'Changer' : 'Vidéo…'}
                <input type="file" accept="video/*" hidden onChange={(e) => { setScreenVideo(sc.id, e.target.files?.[0] ?? null); rerender((n) => n + 1); }} />
              </label>
            )}
          </div>
          <Num label="X" title="Centre, jardin ↔ cour (m)" value={sc.x} min={-100} max={100} onChange={(v) => set(sc.id, { x: v })} />
          <Num label="Y" title="Profondeur (m)" value={sc.y} min={-100} max={100} onChange={(v) => set(sc.id, { y: v })} />
          <Num label="Bas à" title="Hauteur du bas de l’écran (m)" value={sc.elevation} min={0} max={30} onChange={(v) => set(sc.id, { elevation: v })} />
          <Num label="Largeur" title="Largeur (m)" value={sc.width} min={0.2} max={60} onChange={(v) => set(sc.id, { width: v })} />
          <Num label="Hauteur" title="Hauteur (m)" value={sc.height} min={0.2} max={30} onChange={(v) => set(sc.id, { height: v })} />
          <Num label="Rotation" title="Rotation (0° = face au public)" value={sc.rotation} min={-360} max={360} step={15} onChange={(v) => set(sc.id, { rotation: v })} />
          <label className="scene-num span3" title="Lumière diffusée sur le plateau et la brume"><span>Halo {Math.round(sc.glow * 100)} %</span>
            <input type="range" min={0} max={100} value={Math.round(sc.glow * 100)} onChange={(e) => set(sc.id, { glow: Number(e.target.value) / 100 })} />
          </label>
        </Card>
      ))}
      <AddBtn kind="screen" label="Écran" testId="screen-add" />
      <p className="scene-hint">Couleur, image, vidéo (non enregistrée) ou pixel mapping des barres LED.</p>
    </Section>
  );
}

/** Scene-layout undo / redo (main-process history), with Ctrl+Z / Ctrl+Y outside text fields. */
function SceneHistory() {
  const history = useStore((s) => s.project?.sceneHistory);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement).closest('input,textarea,select,[contenteditable]')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); void act({ type: 'scene.undo' }); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); void act({ type: 'scene.redo' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <button className="btn icon" title="Annuler la dernière modification de scène (Ctrl+Z)" disabled={!history?.undo} onClick={() => void act({ type: 'scene.undo' })} data-testid="scene-undo"><Undo2 size={14} /></button>
      <button className="btn icon" title="Rétablir (Ctrl+Y)" disabled={!history?.redo} onClick={() => void act({ type: 'scene.redo' })} data-testid="scene-redo"><Redo2 size={14} /></button>
    </>
  );
}

function StagePage({ mode }: { mode: '2d' | '3d' }) {
  const { fixtures } = useResolved();
  const project = useStore((s) => s.project!.project);
  const preview = useStore((s) => s.preview);
  const setPreview = useStore((s) => s.setPreview);
  const [edit, setEdit] = useState(false);
  const [settings, setSettings] = useState(false);
  const [group, setGroup] = useState<string | null>(null);
  const placing = useStore((s) => s.placing);
  useSceneShortcuts();
  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column' }}>
      <PageHead title={mode === '3d' ? 'Stage 3D' : 'Stage Visualizer'} subtitle={mode === '3d' ? 'Aperçu 3D approximatif de la scène et des faisceaux' : 'Plan de dessus synchronisé avec le moteur'}>
        <button className={`btn ${settings ? 'on' : ''}`} onClick={() => setSettings(!settings)} title="Modèles, plateau, points de scène, structures, interprètes et écrans" data-testid="stage-settings-toggle"><Settings2 size={14} />Scène</button>
        {mode === '2d' && <button className={`btn ${edit ? 'on' : ''}`} onClick={() => setEdit(!edit)} title="Déplacer projecteurs, points et interprètes sur la scène (enregistré dans le projet)"><Move size={14} />Positionner</button>}
        <SceneHistory />
        <select className="select" style={{ width: 160 }} value={group ?? ''} onChange={(e) => setGroup(e.target.value || null)} aria-label="Filtrer par groupe">
          <option value="">Tous les groupes</option>
          {project.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        {mode === '3d' && <button className="btn" data-testid="stage3d-detach" onClick={() => window.open(location.href.split('#')[0] + DETACHED_STAGE_HASH, 'luma-stage3d')} title="Ouvrir la vue 3D dans une fenêtre séparée (second écran, F11 : plein écran)"><ExternalLink size={14} />Détacher</button>}
      </PageHead>
      {preview && (
        <div className="panel row" style={{ padding: '8px 12px', marginBottom: 10, borderColor: 'rgba(139,92,246,.6)' }}>
          <span className="badge violet">APERÇU</span>
          <span className="grow">{preview.label.startsWith('Prévisualisation') ? preview.label : 'Prévisualisation d’une proposition IA'} — non envoyé aux sorties</span>
          <button className="btn sm" onClick={() => setPreview(null)}><X size={12} />Revenir au direct</button>
        </div>
      )}
      <div className="stage-layout">
        {settings && <ScenePanel vis={project.visualizer} onClose={() => setSettings(false)} />}
        <div className="stage-view">
          {mode === '3d' ? <Stage3D values={preview?.values} groupFilter={group} /> : <StageCanvas values={preview?.values} editable={edit} groupFilter={group} />}
          {placing && (
            <div className="stage-empty stage-placing" data-testid="placing">
              <Crosshair size={16} />
              <span className="grow">Cliquez sur le plateau pour poser : <b>{placing.label}</b></span>
              <button className="btn sm" onClick={() => useStore.getState().setPlacing(null)}>Annuler (Échap)</button>
            </div>
          )}
          {fixtures.length === 0 && !placing && (
            <div className="stage-empty">
              <Theater size={18} className="dim" />
              <span className="grow">Aucun projecteur : ajoutez-en dans le Patch. Vous pouvez déjà construire le décor.</span>
              {!settings && <button className="btn sm" onClick={() => setSettings(true)}><Settings2 size={12} />Construire la scène</button>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
