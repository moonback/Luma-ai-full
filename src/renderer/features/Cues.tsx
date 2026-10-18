import { useState } from 'react';
import { ArrowDown, ArrowUp, ListOrdered, Pause, Play, Plus, SkipBack, Square, Trash2 } from 'lucide-react';
import { useStore, confirmAction } from '../store';
import { act, newId } from '../api';
import { Empty, Field, Modal, NumberInput, PageHead, Panel } from '../components/ui';
import type { Cue, CueList } from '../../core/model/schemas';

const CURVES = { linear: 'Linéaire', easeIn: 'Accélérée', easeOut: 'Décélérée', easeInOut: 'Douce', snap: 'Instantanée' } as const;

function ListDialog({ list, onClose }: { list?: CueList; onClose: () => void }) {
  const [name, setName] = useState(list?.name ?? 'Nouvelle liste');
  const [priority, setPriority] = useState(list?.priority ?? 50);
  const [loop, setLoop] = useState(list?.loop ?? false);
  const save = async () => {
    const id = list?.id ?? newId();
    if (await act({ type: 'cueList.upsert', cueList: { id, name: name.trim() || 'Liste', priority, loop, cues: list?.cues ?? [] } })) {
      useStore.getState().setCueList(id);
      onClose();
    }
  };
  return (
    <Modal title={list ? 'Propriétés de la liste' : 'Nouvelle liste de cues'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Annuler</button><button className="btn primary" onClick={() => void save()}>Valider</button></>}>
      <div className="grid g2">
        <Field label="Nom"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Priorité" hint="1–99. Priorité supérieure = remplace les autres listes ; égale = HTP intensité / LTP reste"><NumberInput value={priority} min={1} max={99} onChange={setPriority} /></Field>
        <label className="check"><input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />Boucler à la fin de la liste</label>
      </div>
    </Modal>
  );
}

export function Cues() {
  const project = useStore((s) => s.project!.project);
  const listId = useStore((s) => s.cueListId);
  const setCueList = useStore((s) => s.setCueList);
  const rt = useStore((s) => s.runtime);
  const [dialog, setDialog] = useState<{ list?: CueList } | null>(null);
  const list = project.cueLists.find((l) => l.id === listId);
  const pb = rt?.engine.playbacks.find((p) => p.cueListId === listId);
  const save = (cues: Cue[]) => list && void act({ type: 'cueList.upsert', cueList: { ...list, cues } });
  const update = (i: number, patch: Partial<Cue>) => list && save(list.cues.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  const addCue = () => {
    if (!list) return;
    const last = list.cues.at(-1);
    save([...list.cues, { id: newId(), number: Math.floor(last?.number ?? 0) + 1, name: `Cue ${list.cues.length + 1}`, description: '', sceneId: project.scenes[0]?.id ?? null, fade: 2, delay: 0, curve: 'linear', trigger: { type: 'manual' }, effectIds: [] }]);
  };
  const move = (i: number, d: -1 | 1) => {
    if (!list || !list.cues[i + d]) return;
    const cues = [...list.cues];
    [cues[i], cues[i + d]] = [cues[i + d]!, cues[i]!];
    save(cues.map((c, k) => ({ ...c, number: k + 1 })));
  };

  return (
    <div className="page">
      <PageHead title="Cues & Sequences" subtitle="Listes de cues avec transitions calculées par le moteur">
        <select className="select" style={{ width: 220 }} value={listId ?? ''} onChange={(e) => setCueList(e.target.value || null)}>
          {project.cueLists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        {list && <button className="btn" onClick={() => setDialog({ list })}>Propriétés</button>}
        {list && <button className="btn danger icon" title="Supprimer la liste" onClick={async () => (await confirmAction({ title: 'Supprimer la liste', message: `Supprimer « ${list.name} » et ses ${list.cues.length} cue(s) ?`, confirmLabel: 'Supprimer' })) && void act({ type: 'cueList.remove', id: list.id })}><Trash2 size={14} /></button>}
        <button className="btn" onClick={() => setDialog({})}><Plus size={14} />Liste</button>
      </PageHead>
      {!list ? (
        <Empty icon={<ListOrdered size={32} />} title="Aucune liste de cues" action={<button className="btn primary" onClick={() => setDialog({})}>Créer une liste</button>} />
      ) : (
        <div className="col gap-lg">
          <Panel>
            <div className="row gap-lg">
              <button className="btn go-btn" data-testid="go" onClick={() => void act({ type: 'cue.go', listId: list.id })} disabled={!list.cues.length} title="GO (Espace)">GO</button>
              <button className="btn lg" onClick={() => void act({ type: 'cue.back', listId: list.id })} title="BACK (Maj+Espace)"><SkipBack size={16} />Back</button>
              {pb?.state === 'paused' ? (
                <button className="btn lg accent" onClick={() => void act({ type: 'cue.resume', listId: list.id })} title="Reprise (P)"><Play size={16} />Reprise</button>
              ) : (
                <button className="btn lg" onClick={() => void act({ type: 'cue.pause', listId: list.id })} disabled={!pb || pb.state === 'idle'} title="Pause (P)"><Pause size={16} />Pause</button>
              )}
              <button className="btn lg danger" onClick={() => void act({ type: 'cue.stop', listId: list.id })} disabled={!pb || pb.state === 'idle'} title="Arrêt : relâche la liste"><Square size={16} />Stop</button>
              <div className="col grow" style={{ gap: 4 }}>
                <div className="row between small">
                  <span data-testid="cue-state">{pb && pb.state !== 'idle' ? `${pb.cueName} — ${({ delay: 'délai', fading: 'transition', holding: 'maintien', paused: 'en pause', idle: '' })[pb.state]}` : 'À l’arrêt'}</span>
                  <span className="mono muted">{pb && pb.state !== 'idle' ? `reste ${pb.remaining.toFixed(1)} s` : ''}</span>
                </div>
                <div className="progress"><div style={{ width: `${(pb?.progress ?? 0) * 100}%` }} /></div>
                <span className="small dim">Suivant : {pb?.nextIndex !== null && pb?.nextIndex !== undefined ? list.cues[pb.nextIndex]?.name ?? '–' : list.cues[0]?.name ?? '–'} · Priorité {list.priority}{list.loop ? ' · boucle' : ''}</span>
              </div>
            </div>
          </Panel>
          <Panel flush title={`${list.cues.length} cue(s)`} actions={<button className="btn sm primary" onClick={addCue} disabled={!project.scenes.length} title={project.scenes.length ? '' : 'Créez d’abord une scène'}><Plus size={13} />Ajouter un cue</button>}>
            {list.cues.length === 0 ? <Empty title="Liste vide">{project.scenes.length ? 'Ajoutez un cue : il référence une scène et définit la transition.' : 'Créez d’abord une scène (Live Console › Enregistrer scène, ou assistant IA).'}</Empty> : (
              <table className="table" data-testid="cue-table">
                <thead><tr><th>N°</th><th>Nom</th><th>Scène</th><th>Fondu (s)</th><th>Délai (s)</th><th>Courbe</th><th>Déclenchement</th><th>Effets</th><th /></tr></thead>
                <tbody>
                  {list.cues.map((c, i) => (
                    <tr key={c.id} className={`${pb?.index === i && pb.state !== 'idle' ? 'active' : ''} ${pb?.nextIndex === i ? 'next' : ''}`}>
                      <td className="mono">{c.number}</td>
                      <td><input className="input" defaultValue={c.name} key={c.name} onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && update(i, { name: e.target.value.trim() })} /></td>
                      <td>
                        <select className="select" value={c.sceneId ?? ''} onChange={(e) => update(i, { sceneId: e.target.value || null })}>
                          <option value="">— (éteint la liste)</option>
                          {project.scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </td>
                      <td style={{ width: 80 }}><NumberInput value={c.fade} min={0} max={600} step={0.1} onChange={(v) => update(i, { fade: v })} /></td>
                      <td style={{ width: 80 }}><NumberInput value={c.delay} min={0} max={600} step={0.1} onChange={(v) => update(i, { delay: v })} /></td>
                      <td>
                        <select className="select" value={c.curve} onChange={(e) => update(i, { curve: e.target.value as Cue['curve'] })}>
                          {Object.entries(CURVES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                      </td>
                      <td>
                        <div className="row">
                          <select className="select" style={{ width: 96 }} value={c.trigger.type} onChange={(e) => update(i, { trigger: e.target.value === 'follow' ? { type: 'follow', wait: 0 } : { type: 'manual' } })}>
                            <option value="manual">GO manuel</option><option value="follow">Enchaîné</option>
                          </select>
                          {c.trigger.type === 'follow' && <div style={{ width: 70 }} title="Attente après la fin du cue précédent (s)"><NumberInput value={c.trigger.wait} min={0} max={3600} step={0.1} onChange={(v) => update(i, { trigger: { type: 'follow', wait: v } })} /></div>}
                        </div>
                      </td>
                      <td>
                        <select className="select" multiple style={{ height: 46, minWidth: 120 }} value={c.effectIds} onChange={(e) => update(i, { effectIds: [...e.target.selectedOptions].map((o) => o.value) })} title="Effets démarrés avec ce cue (Ctrl+clic pour plusieurs)">
                          {project.effects.map((fx) => <option key={fx.id} value={fx.id}>{fx.name}</option>)}
                        </select>
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn ghost sm" onClick={() => void act({ type: 'cue.goto', listId: list.id, index: i })} title="Aller à ce cue">Aller</button>
                        <button className="btn ghost sm icon" disabled={i === 0} onClick={() => move(i, -1)} title="Monter"><ArrowUp size={12} /></button>
                        <button className="btn ghost sm icon" disabled={i === list.cues.length - 1} onClick={() => move(i, 1)} title="Descendre"><ArrowDown size={12} /></button>
                        <button className="btn ghost sm icon" onClick={async () => (await confirmAction({ title: 'Supprimer le cue', message: `Supprimer « ${c.name} » ?`, confirmLabel: 'Supprimer' })) && save(list.cues.filter((_, k) => k !== i))} title="Supprimer"><Trash2 size={12} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      )}
      {dialog && <ListDialog list={dialog.list} onClose={() => setDialog(null)} />}
    </div>
  );
}
