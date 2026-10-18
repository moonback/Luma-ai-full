import { useEffect } from 'react';
import { act, newId } from './api';
import { useStore } from './store';
import { setScreenVideo } from './screenMedia';
import type { VisualFixture } from '../core/visualizer/model';
import { snapTrussEnds, type P2 } from '../core/visualizer/truss';
import type { Truss } from '../core/model/schemas';
import { libraryItem } from '../core/visualizer/library';
import {
  SCENE_LABEL, canAdd, cloneElement, equipTrusses, findElement, newElement, parseElement, serializeElement, withElement, withoutElement,
  type SceneKind, type SceneRef,
} from '../core/visualizer/sceneEdit';

/** Scene-element actions shared by the scene panel, the 2D plan and the 3D view (all undoable with Ctrl+Z). */

/** Drag-and-drop type of a library tile (its data is the library item id). */
export const LIBRARY_MIME = 'application/x-luma-library';

const vis = () => useStore.getState().project?.project.visualizer;
const toast = (title: string, detail?: string, kind: 'info' | 'error' = 'info') => useStore.getState().toast({ kind, title, detail });

/** Adds an element at `at` (click on the stage) or at the next free spot, and selects it. */
export function addSceneElement(kind: SceneKind, at?: P2, preset?: Record<string, unknown>): void {
  const v = vis();
  const st = useStore.getState();
  st.setPlacing(null);
  if (!v) return;
  if (!canAdd(v, kind)) { toast('Limite atteinte', `Nombre maximal de « ${SCENE_LABEL[kind]} » atteint.`, 'error'); return; }
  const el = (() => { try { return newElement(v, kind, newId, at, preset); } catch { return null; } })(); // a preset outside the schema bounds
  if (!el) { toast('Élément invalide', undefined, 'error'); return; }
  // A truss piece placed next to another one joins it end to end, at its height.
  const snap = kind === 'truss' ? snapTrussEnds(el as Truss, v.trusses) : null;
  if (snap) Object.assign(el, { x: snap.x, y: snap.y, height: snap.height });
  void act({ type: 'project.update', visualizer: withElement(v, kind, el) }).then((r) => r && st.setSceneSel({ kind, id: el.id }));
}

export function removeSceneElement(ref: SceneRef): void {
  const v = vis();
  if (!v || !findElement(v, ref)) return;
  if (ref.kind === 'screen') setScreenVideo(ref.id, null);
  if (useStore.getState().sceneSel?.id === ref.id) useStore.getState().setSceneSel(null);
  void act({ type: 'project.update', visualizer: withoutElement(v, ref) });
}

export function duplicateSceneElement(ref: SceneRef): void {
  const v = vis();
  const src = v && findElement(v, ref);
  if (!v || !src) return;
  if (!canAdd(v, ref.kind)) { toast('Limite atteinte', undefined, 'error'); return; }
  const copy = cloneElement(v, ref.kind, src, newId);
  void act({ type: 'project.update', visualizer: withElement(v, ref.kind, copy) }).then((r) => r && useStore.getState().setSceneSel({ kind: ref.kind, id: copy.id }));
}

/** Copies through the system clipboard as text, so elements can be pasted into another project or window. */
export async function copySceneElement(ref: SceneRef): Promise<void> {
  const v = vis();
  const el = v && findElement(v, ref);
  if (!el) return;
  try {
    await navigator.clipboard.writeText(serializeElement(ref.kind, el));
    toast('Copié', `« ${el.name} » — Ctrl+V pour coller`);
  } catch {
    toast('Copie impossible', 'Presse-papiers indisponible', 'error');
  }
}

export async function pasteSceneElement(): Promise<void> {
  const v = vis();
  if (!v) return;
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { /* clipboard unavailable: nothing to paste */ }
  const parsed = parseElement(text);
  if (!parsed) return;
  if (!canAdd(v, parsed.kind)) { toast('Limite atteinte', undefined, 'error'); return; }
  const copy = cloneElement(v, parsed.kind, parsed.el, newId);
  void act({ type: 'project.update', visualizer: withElement(v, parsed.kind, copy) }).then((r) => r && useStore.getState().setSceneSel({ kind: parsed.kind, id: copy.id }));
}

/**
 * Hangs the selected fixtures (or every hung fixture, floor and wall ones staying put) evenly on the trusses:
 * moving heads at the back, the others at the front. One undo step.
 */
export function equipRig(model: readonly VisualFixture[]): void {
  const v = vis();
  const patch = useStore.getState().project?.project.patch ?? [];
  if (!v?.trusses.length) return;
  const sel = new Set(useStore.getState().selection);
  const explicit = new Map(patch.map((f) => [f.id, f.mount ?? 'auto']));
  const chosen = model.filter((f) => (sel.size ? sel.has(f.id) : f.mount === 'hanging'));
  // A selected floor / wall fixture is re-mounted as hung; 'auto' follows its new height.
  const placements = equipTrusses(chosen, v.trusses).map((p) => ({ ...p, ...(['floor', 'wall'].includes(explicit.get(p.id) ?? 'auto') ? { mount: 'hanging' as const } : {}) }));
  if (!placements.length) { toast('Rien à accrocher', 'Aucun projecteur suspendu ou sélectionné.'); return; }
  void act({ type: 'fixture.place', placements }).then((r) => r !== undefined && toast(`${placements.length} projecteur(s) accroché(s)`, 'Ctrl+Z pour annuler'));
}

/**
 * Stage-page keyboard: Ctrl+D duplicate, Suppr delete, Ctrl+C / Ctrl+V copy / paste, Échap cancels a click placement.
 * Ctrl+D on fixtures duplicates them in the patch (next free address). Ignored while typing in a field.
 */
export function useSceneShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input,textarea,select,[contenteditable]')) return;
      const st = useStore.getState();
      const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (e.key === 'Escape' && st.placing) {
        // Captured before the global Échap (release programmer): only cancels the placement.
        e.preventDefault();
        e.stopImmediatePropagation();
        st.setPlacing(null);
      } else if (ctrl && k === 'd') {
        e.preventDefault();
        if (st.sceneSel) duplicateSceneElement(st.sceneSel);
        else if (st.selection.length) void act({ type: 'fixture.duplicate', ids: st.selection }).then((r) => r && st.setSelection(r.ids));
      } else if (e.key === 'Delete' && st.sceneSel) {
        e.preventDefault();
        removeSceneElement(st.sceneSel);
      } else if (ctrl && k === 'c' && st.sceneSel) {
        e.preventDefault();
        void copySceneElement(st.sceneSel);
      } else if (ctrl && k === 'v') {
        void pasteSceneElement();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      useStore.getState().setPlacing(null);
    };
  }, []);
}

/** Drag over the stage: accept library tiles only. */
export function acceptLibraryDrag(e: React.DragEvent): void {
  if (e.dataTransfer.types.includes(LIBRARY_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
}

/** Drop of a library tile at a stage position (null when the drop missed the floor). */
export function dropLibraryItem(e: React.DragEvent, at: P2 | null): void {
  const item = libraryItem(e.dataTransfer.getData(LIBRARY_MIME));
  if (!item) return;
  e.preventDefault();
  if (at) addSceneElement(item.kind, at, item.preset);
}
