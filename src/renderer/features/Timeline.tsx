import { useEffect, useRef, useState } from 'react';
import { ChartGantt, Copy, Pause, Play, Plus, Redo2, Square, Trash2, Undo2 } from 'lucide-react';
import { useStore, confirmAction } from '../store';
import { act, newId } from '../api';
import { Empty, Field, NumberInput, PageHead, Panel } from '../components/ui';
import type { Timeline, TimelineEvent } from '../../core/model/schemas';

const KIND_COLORS: Record<TimelineEvent['kind'], string> = { scene: '#6d28d9', effect: '#0e7490', cue: '#047857', marker: '#4b5563' };
const KIND_LABELS: Record<TimelineEvent['kind'], string> = { scene: 'Scène', effect: 'Effet', cue: 'Cue', marker: 'Repère' };
const LANES = 6;

/** Timeline editor with local undo/redo; every committed edit is validated by the main process. */
function Editor({ timeline }: { timeline: Timeline }) {
  const project = useStore((s) => s.project!.project);
  const status = useStore((s) => s.runtime?.engine.timeline);
  const [draft, setDraft] = useState(timeline);
  const [past, setPast] = useState<Timeline[]>([]);
  const [future, setFuture] = useState<Timeline[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [zoom, setZoom] = useState(12); // px per second
  const drag = useRef<{ id: string; mode: 'move' | 'resize'; x0: number; start: number; duration: number; lane: number; y0: number } | null>(null);
  useEffect(() => setDraft(timeline), [timeline]);

  const commit = (next: Timeline, record = true) => {
    if (record) { setPast([...past.slice(-49), draft]); setFuture([]); }
    setDraft(next);
    void act({ type: 'timeline.upsert', timeline: next }).then((r) => { if (!r) setDraft(timeline); });
  };
  const undo = () => { const prev = past.at(-1); if (!prev) return; setFuture([draft, ...future]); setPast(past.slice(0, -1)); commit(prev, false); };
  const redo = () => { const nx = future[0]; if (!nx) return; setPast([...past, draft]); setFuture(future.slice(1)); commit(nx, false); };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) {
        if (e.key === 'Delete' && sel && !(e.target as HTMLElement).closest('input,textarea,select')) commit({ ...draft, events: draft.events.filter((x) => x.id !== sel) });
        return;
      }
      if (e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
      if (e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      if (e.key.toLowerCase() === 'd' && sel) { e.preventDefault(); duplicate(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const update = (id: string, patch: Partial<TimelineEvent>, record = true) => commit({ ...draft, events: draft.events.map((e) => (e.id === id ? { ...e, ...patch } : e)) }, record);
  const duplicate = () => {
    const ev = draft.events.find((e) => e.id === sel);
    if (!ev) return;
    const copy = { ...ev, id: newId(), start: Math.min(draft.duration, ev.start + Math.max(1, ev.duration)) };
    commit({ ...draft, events: [...draft.events, copy] });
    setSel(copy.id);
  };
  const add = (kind: TimelineEvent['kind']) => {
    const refId = kind === 'scene' ? project.scenes[0]?.id : kind === 'effect' ? project.effects[0]?.id : kind === 'cue' ? project.cueLists[0]?.id : null;
    if (kind !== 'marker' && !refId) { useStore.getState().toast({ kind: 'warn', title: `Aucun(e) ${KIND_LABELS[kind].toLowerCase()} disponible` }); return; }
    const t = Math.min(draft.duration - 1, status?.timelineId === draft.id ? status.time : 0);
    const ev: TimelineEvent = { id: newId(), kind, start: Math.round(t * 10) / 10, duration: kind === 'cue' || kind === 'marker' ? 0 : 8, refId: refId ?? null, cueIndex: 0, fade: kind === 'scene' ? 1 : 0, label: '', lane: { scene: 0, effect: 2, cue: 4, marker: 5 }[kind] };
    commit({ ...draft, events: [...draft.events, ev] });
    setSel(ev.id);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dt = (e.clientX - d.x0) / zoom;
    setDraft((cur) => ({
      ...cur,
      events: cur.events.map((ev) => {
        if (ev.id !== d.id) return ev;
        if (d.mode === 'resize') return { ...ev, duration: Math.max(0.5, Math.round((d.duration + dt) * 10) / 10) };
        const lane = Math.max(0, Math.min(LANES - 1, d.lane + Math.round((e.clientY - d.y0) / 44)));
        return { ...ev, start: Math.max(0, Math.min(cur.duration, Math.round((d.start + dt) * 10) / 10)), lane };
      }),
    }));
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    if (JSON.stringify(draft) !== JSON.stringify(timeline)) { setPast([...past.slice(-49), timeline]); setFuture([]); commit(draft, false); }
  };

  const name = (ev: TimelineEvent) => ev.label || (ev.kind === 'scene' ? project.scenes.find((s) => s.id === ev.refId)?.name : ev.kind === 'effect' ? project.effects.find((s) => s.id === ev.refId)?.name : ev.kind === 'cue' ? `${project.cueLists.find((s) => s.id === ev.refId)?.name ?? ''} #${ev.cueIndex + 1}` : 'Repère') || '?';
  const selected = draft.events.find((e) => e.id === sel);
  const width = draft.duration * zoom + 40;
  const playing = status?.timelineId === draft.id ? status : null;

  return (
    <div className="col gap-lg">
      <Panel>
        <div className="row wrap">
          <button className="btn accent" onClick={() => void act({ type: 'timeline.play', id: draft.id })}><Play size={14} />Lecture</button>
          <button className="btn" onClick={() => void act({ type: 'timeline.pause' })}><Pause size={14} />Pause</button>
          <button className="btn" onClick={() => void act({ type: 'timeline.stop' })}><Square size={14} />Stop</button>
          <span className="mono" style={{ minWidth: 110 }}>{(playing?.time ?? 0).toFixed(1)} / {draft.duration} s</span>
          <div className="top-sep" />
          {(['scene', 'effect', 'cue', 'marker'] as const).map((k) => <button key={k} className="btn sm" onClick={() => add(k)}><Plus size={12} />{KIND_LABELS[k]}</button>)}
          <div className="top-sep" />
          <button className="btn sm icon" title="Annuler (Ctrl+Z)" disabled={!past.length} onClick={undo}><Undo2 size={13} /></button>
          <button className="btn sm icon" title="Rétablir (Ctrl+Y)" disabled={!future.length} onClick={redo}><Redo2 size={13} /></button>
          <button className="btn sm icon" title="Dupliquer (Ctrl+D)" disabled={!sel} onClick={duplicate}><Copy size={13} /></button>
          <button className="btn sm icon danger" title="Supprimer (Suppr)" disabled={!sel} onClick={() => commit({ ...draft, events: draft.events.filter((x) => x.id !== sel) })}><Trash2 size={13} /></button>
          <div className="grow" />
          <span className="small muted">Zoom</span>
          <input type="range" min={3} max={60} value={zoom} style={{ width: 110 }} onChange={(e) => setZoom(Number(e.target.value))} />
        </div>
      </Panel>
      <div className="tl" style={{ maxHeight: 340 }} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp}>
        <div style={{ width, position: 'relative' }}>
          <div className="tl-ruler" onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); void act({ type: 'timeline.seek', seconds: Math.max(0, (e.clientX - r.left) / zoom) }); }} title="Cliquer pour déplacer la tête de lecture">
            {Array.from({ length: Math.floor(draft.duration / 5) + 1 }, (_, i) => (
              <span key={i} className="small dim mono" style={{ position: 'absolute', left: i * 5 * zoom + 2, top: 4 }}>{i * 5}s</span>
            ))}
          </div>
          {Array.from({ length: LANES }, (_, lane) => (
            <div key={lane} className="tl-lane" onPointerDown={() => setSel(null)}>
              {draft.events.filter((e) => e.lane === lane).map((ev) => (
                <div
                  key={ev.id}
                  className={`tl-ev ${sel === ev.id ? 'sel' : ''}`}
                  style={{ left: ev.start * zoom, width: Math.max(10, ev.duration * zoom), background: KIND_COLORS[ev.kind] }}
                  onPointerDown={(e) => { e.stopPropagation(); setSel(ev.id); (e.currentTarget.parentElement!.parentElement!.parentElement as HTMLElement).setPointerCapture?.(e.pointerId); drag.current = { id: ev.id, mode: (e.target as HTMLElement).classList.contains('handle') ? 'resize' : 'move', x0: e.clientX, y0: e.clientY, start: ev.start, duration: ev.duration, lane: ev.lane }; }}
                  title={`${KIND_LABELS[ev.kind]} · ${name(ev)} · ${ev.start}s${ev.duration ? ` → ${ev.start + ev.duration}s` : ''}`}
                >
                  {name(ev)}
                  {(ev.kind === 'scene' || ev.kind === 'effect') && <span className="handle" />}
                </div>
              ))}
            </div>
          ))}
          {playing && playing.state !== 'stopped' && <div className="tl-head" style={{ left: playing.time * zoom }} />}
        </div>
      </div>
      {selected && (
        <Panel title={`Événement — ${KIND_LABELS[selected.kind]}`}>
          <div className="grid g4">
            {selected.kind !== 'marker' && (
              <Field label="Référence">
                <select className="select" value={selected.refId ?? ''} onChange={(e) => update(selected.id, { refId: e.target.value })}>
                  {(selected.kind === 'scene' ? project.scenes : selected.kind === 'effect' ? project.effects : project.cueLists).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </Field>
            )}
            <Field label="Début (s)"><NumberInput value={selected.start} min={0} max={draft.duration} step={0.1} onChange={(v) => update(selected.id, { start: v })} /></Field>
            {(selected.kind === 'scene' || selected.kind === 'effect') && <Field label="Durée (s)"><NumberInput value={selected.duration} min={0.5} max={86400} step={0.1} onChange={(v) => update(selected.id, { duration: v })} /></Field>}
            {selected.kind === 'scene' && <Field label="Fondu entrée/sortie (s)"><NumberInput value={selected.fade} min={0} max={60} step={0.1} onChange={(v) => update(selected.id, { fade: v })} /></Field>}
            {selected.kind === 'cue' && <Field label="N° de cue (index)"><NumberInput value={selected.cueIndex + 1} min={1} max={999} onChange={(v) => update(selected.id, { cueIndex: v - 1 })} /></Field>}
            <Field label="Libellé"><input className="input" defaultValue={selected.label} key={selected.id} onBlur={(e) => e.target.value !== selected.label && update(selected.id, { label: e.target.value })} /></Field>
          </div>
        </Panel>
      )}
    </div>
  );
}

export function TimelinePage() {
  const timelines = useStore((s) => s.project!.project.timelines);
  const [sel, setSel] = useState<string | null>(timelines[0]?.id ?? null);
  const tl = timelines.find((t) => t.id === sel) ?? timelines[0];
  const create = async () => {
    const id = newId();
    if (await act({ type: 'timeline.upsert', timeline: { id, name: `Timeline ${timelines.length + 1}`, duration: 120, loop: false, events: [] } })) setSel(id);
  };
  return (
    <div className="page">
      <PageHead title="Timeline" subtitle="Organisation temporelle des scènes, effets et cues — glisser pour déplacer, poignée droite pour redimensionner">
        {timelines.length > 0 && (
          <select className="select" style={{ width: 200 }} value={tl?.id} onChange={(e) => setSel(e.target.value)}>
            {timelines.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        {tl && (
          <>
            <div style={{ width: 90 }} title="Durée totale (s)"><NumberInput value={tl.duration} min={1} max={86400} onChange={(v) => void act({ type: 'timeline.upsert', timeline: { ...tl, duration: v } })} /></div>
            <label className="check"><input type="checkbox" checked={tl.loop} onChange={(e) => void act({ type: 'timeline.upsert', timeline: { ...tl, loop: e.target.checked } })} />Boucle</label>
            <button className="btn danger icon" title="Supprimer la timeline" onClick={async () => (await confirmAction({ title: 'Supprimer la timeline', message: `Supprimer « ${tl.name} » ?`, confirmLabel: 'Supprimer' })) && void act({ type: 'timeline.remove', id: tl.id })}><Trash2 size={14} /></button>
          </>
        )}
        <button className="btn primary" onClick={() => void create()}><Plus size={14} />Timeline</button>
      </PageHead>
      {tl ? <Editor key={tl.id} timeline={tl} /> : <Empty icon={<ChartGantt size={32} />} title="Aucune timeline" action={<button className="btn primary" onClick={() => void create()}>Créer une timeline</button>}>Placez des scènes, effets et déclenchements de cues sur une ligne de temps lue par le moteur.</Empty>}
    </div>
  );
}
