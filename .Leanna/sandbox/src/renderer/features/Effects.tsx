import { useState } from 'react';
import { Copy, Pause, Play, Plus, Sparkles, Square, Trash2 } from 'lucide-react';
import { useStore, confirmAction, EMPTY_ARR } from '../store';
import { act, newId } from '../api';
import { Empty, Field, NumberInput, PageHead, Panel } from '../components/ui';
import { EFFECT_TYPES, effectParamsSchema, type Effect, type EffectType } from '../../core/model/schemas';

export const EFFECT_LABELS: Record<EffectType, string> = {
  fade: 'Fade', pulse: 'Pulse', chase: 'Chase', wave: 'Wave', rainbow: 'Rainbow', strobe: 'Strobe', dimmerWave: 'Dimmer wave',
  colorCycle: 'Color cycle', panTilt: 'Pan/Tilt', randomMove: 'Mouvement aléatoire',
};

function Editor({ effect }: { effect: Effect }) {
  const groups = useStore((s) => s.project!.project.groups);
  const selection = useStore((s) => s.selection);
  const [draft, setDraft] = useState(effect);
  const p = draft.params;
  const setP = (patch: Partial<Effect['params']>) => setDraft({ ...draft, params: { ...p, ...patch } });
  const dirty = JSON.stringify(draft) !== JSON.stringify(effect);
  const usesColors = draft.type === 'colorCycle';
  const usesShape = draft.type === 'panTilt';
  const usesAttr = ['fade', 'pulse', 'wave', 'chase'].includes(draft.type);
  return (
    <Panel title="Paramètres" actions={<button className="btn sm primary" disabled={!dirty} onClick={() => void act({ type: 'effect.upsert', effect: draft })}>Enregistrer</button>}>
      <div className="grid g2">
        <Field label="Nom"><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
        <Field label="Type">
          <select className="select" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as EffectType })}>
            {EFFECT_TYPES.map((t) => <option key={t} value={t}>{EFFECT_LABELS[t]}</option>)}
          </select>
        </Field>
        <Field label="Groupes cibles">
          <div className="chips">
            {groups.map((g) => (
              <button key={g.id} className={`chip ${draft.targets.groupIds.includes(g.id) ? 'on' : ''}`} onClick={() => setDraft({ ...draft, targets: { ...draft.targets, groupIds: draft.targets.groupIds.includes(g.id) ? draft.targets.groupIds.filter((x) => x !== g.id) : [...draft.targets.groupIds, g.id] } })}>{g.name}</button>
            ))}
            {groups.length === 0 && <span className="small dim">Aucun groupe</span>}
          </div>
        </Field>
        <Field label="Projecteurs individuels" hint={`${draft.targets.fixtureIds.length} projecteur(s)`}>
          <button className="btn sm" disabled={!selection.length} onClick={() => setDraft({ ...draft, targets: { ...draft.targets, fixtureIds: selection } })}>Utiliser la sélection ({selection.length})</button>
        </Field>
        <label className="check"><input type="checkbox" checked={p.bpmSync} onChange={(e) => setP({ bpmSync: e.target.checked })} />Synchronisé au BPM</label>
        {p.bpmSync && <label className="check" title="Avec une source audio, le cycle repart sur les premiers temps de mesure (phrases de 4, 8, 16 temps)"><input type="checkbox" checked={p.barSync} onChange={(e) => setP({ barSync: e.target.checked })} />Calé sur la mesure</label>}
        {p.bpmSync ? (
          <Field label="Temps par cycle"><NumberInput value={p.beatsPerCycle} min={0.25} max={64} step={0.25} onChange={(v) => setP({ beatsPerCycle: v })} /></Field>
        ) : (
          <Field label="Vitesse (cycles/s)" hint={draft.type === 'strobe' ? 'Plafonnée par la limite de sécurité strobe' : undefined}><NumberInput value={p.speed} min={0.01} max={30} step={0.05} onChange={(v) => setP({ speed: v })} /></Field>
        )}
        <Field label="Amplitude (0–1)"><NumberInput value={p.amplitude} min={0} max={1} step={0.05} onChange={(v) => setP({ amplitude: v })} /></Field>
        <Field label="Centre / niveau de base (0–1)"><NumberInput value={p.offset} min={0} max={1} step={0.05} onChange={(v) => setP({ offset: v })} /></Field>
        <Field label="Phase répartie (0–1)" hint="0 = tous ensemble, 1 = décalage sur tout le groupe"><NumberInput value={p.phaseSpread} min={0} max={1} step={0.05} onChange={(v) => setP({ phaseSpread: v })} /></Field>
        <Field label="Direction">
          <select className="select" value={p.direction} onChange={(e) => setP({ direction: e.target.value as typeof p.direction })}>
            <option value="forward">Avant</option><option value="reverse">Arrière</option><option value="pingpong">Aller-retour</option>
          </select>
        </Field>
        {usesAttr && (
          <Field label="Attribut">
            <select className="select" value={p.attribute} onChange={(e) => setP({ attribute: e.target.value })}>
              {['dimmer', 'red', 'green', 'blue', 'white', 'pan', 'tilt', 'zoom', 'focus'].map((a) => <option key={a}>{a}</option>)}
            </select>
          </Field>
        )}
        {draft.type === 'chase' && <Field label="Largeur (projecteurs allumés)"><NumberInput value={p.width} min={1} max={64} onChange={(v) => setP({ width: v })} /></Field>}
        {draft.type === 'strobe' && <Field label="Rapport cyclique"><NumberInput value={p.duty} min={0.05} max={0.95} step={0.05} onChange={(v) => setP({ duty: v })} /></Field>}
        {draft.type === 'randomMove' && <Field label="Graine aléatoire" hint="Même graine = même mouvement (reproductible)"><NumberInput value={p.seed} min={0} max={2 ** 31} onChange={(v) => setP({ seed: v })} /></Field>}
        {usesShape && (
          <Field label="Forme">
            <select className="select" value={p.shape} onChange={(e) => setP({ shape: e.target.value as typeof p.shape })}>
              <option value="circle">Cercle</option><option value="figure8">Huit</option><option value="pan">Balayage pan</option><option value="tilt">Balayage tilt</option>
            </select>
          </Field>
        )}
        {usesColors && (
          <Field label="Couleurs">
            <div className="row wrap">
              {p.colors.map((c, i) => <input key={i} type="color" value={c} onChange={(e) => setP({ colors: p.colors.map((x, k) => (k === i ? e.target.value.toUpperCase() : x)) })} />)}
              <button className="btn sm" onClick={() => setP({ colors: [...p.colors, '#FFFFFF'] })} disabled={p.colors.length >= 16}><Plus size={12} /></button>
              {p.colors.length > 0 && <button className="btn sm" onClick={() => setP({ colors: p.colors.slice(0, -1) })}>−</button>}
            </div>
          </Field>
        )}
        <Field label="Priorité (1–99)"><NumberInput value={draft.priority} min={1} max={99} onChange={(v) => setDraft({ ...draft, priority: v })} /></Field>
        <Field label="Mélange">
          <select className="select" value={draft.blend} onChange={(e) => setDraft({ ...draft, blend: e.target.value as Effect['blend'] })}>
            <option value="override">Remplace</option><option value="scale">Module (multiplie)</option>
          </select>
        </Field>
        <Field label="Durée (s)" hint="Vide = jusqu’à l’arrêt">
          <input className="input mono" value={draft.duration ?? ''} placeholder="∞" onChange={(e) => setDraft({ ...draft, duration: e.target.value === '' ? null : Math.max(0.1, Number(e.target.value) || 0.1) })} />
        </Field>
        <Field label="Déclenchement">
          <select className="select" value={draft.trigger} onChange={(e) => setDraft({ ...draft, trigger: e.target.value as Effect['trigger'] })}>
            <option value="manual">Manuel / cue</option><option value="beat">Recalé sur chaque beat audio</option>
          </select>
        </Field>
      </div>
    </Panel>
  );
}

export function Effects() {
  const effects = useStore((s) => s.project!.project.effects);
  const running = useStore((s) => s.runtime?.engine.effects ?? EMPTY_ARR);
  const groups = useStore((s) => s.project!.project.groups);
  const [sel, setSel] = useState<string | null>(effects[0]?.id ?? null);
  const current = effects.find((e) => e.id === sel);
  const create = async (type: EffectType) => {
    const id = newId();
    const e: Effect = { id, name: `${EFFECT_LABELS[type]} ${effects.length + 1}`, type, targets: { fixtureIds: [], groupIds: groups[0] ? [groups[0].id] : [] }, params: effectParamsSchema.parse({ phaseSpread: type === 'chase' || type === 'rainbow' || type === 'dimmerWave' ? 1 : 0 }), priority: 50, blend: 'override', duration: null, trigger: 'manual', origin: 'user' };
    if (await act({ type: 'effect.upsert', effect: e })) setSel(id);
  };
  const [newType, setNewType] = useState<EffectType>('chase');
  return (
    <div className="page">
      <PageHead title="Effects" subtitle="Moteur d’effets déterministe, calculé dans la boucle du moteur (aucun timer par effet)">
        <select className="select" style={{ width: 170 }} value={newType} onChange={(e) => setNewType(e.target.value as EffectType)}>
          {EFFECT_TYPES.map((t) => <option key={t} value={t}>{EFFECT_LABELS[t]}</option>)}
        </select>
        <button className="btn primary" onClick={() => void create(newType)}><Plus size={14} />Nouvel effet</button>
        <button className="btn danger" disabled={!running.length} onClick={() => void act({ type: 'effect.stopAll' })}><Square size={14} />Tout arrêter</button>
      </PageHead>
      {effects.length === 0 ? (
        <Empty icon={<Sparkles size={32} />} title="Aucun effet">Créez un effet (chase, wave, rainbow…) et ciblez un groupe. Les effets démarrent manuellement, depuis un cue ou une timeline.</Empty>
      ) : (
        <div className="split left" style={{ gridTemplateColumns: '360px minmax(0,1fr)' }}>
          <Panel flush title="Bibliothèque">
            <table className="table">
              <tbody>
                {effects.map((e) => {
                  const inst = running.filter((r) => r.effectId === e.id);
                  return (
                    <tr key={e.id} className={`clickable ${sel === e.id ? 'sel' : ''}`} onClick={() => setSel(e.id)}>
                      <td>{inst.length > 0 && <span className="led ok" style={{ marginRight: 6 }} />}{e.name} {e.origin === 'ai' && <span className="badge violet">IA</span>}<div className="small dim">{EFFECT_LABELS[e.type]}{e.params.bpmSync ? ' · BPM' : ''}</div></td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(ev) => ev.stopPropagation()}>
                        {inst.length ? (
                          <>
                            <button className="btn ghost sm icon" title={inst[0]!.paused ? 'Reprendre' : 'Pause'} onClick={() => void act({ type: 'effect.pause', instanceId: inst[0]!.instanceId, paused: !inst[0]!.paused })}>{inst[0]!.paused ? <Play size={12} /> : <Pause size={12} />}</button>
                            <button className="btn ghost sm icon" title="Arrêter" onClick={() => inst.forEach((i) => void act({ type: 'effect.stop', instanceId: i.instanceId }))}><Square size={12} /></button>
                          </>
                        ) : (
                          <button className="btn ghost sm icon" title="Démarrer" onClick={() => void act({ type: 'effect.start', id: e.id })}><Play size={12} /></button>
                        )}
                        <button className="btn ghost sm icon" title="Dupliquer" onClick={() => void act({ type: 'effect.upsert', effect: { ...e, id: newId(), name: `${e.name} (copie)`.slice(0, 80) } })}><Copy size={12} /></button>
                        <button className="btn ghost sm icon" title="Supprimer" onClick={async () => (await confirmAction({ title: 'Supprimer l’effet', message: `Supprimer « ${e.name} » ? Il sera retiré des cues et timelines.`, confirmLabel: 'Supprimer' })) && void act({ type: 'effect.remove', id: e.id })}><Trash2 size={12} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
          <div className="col gap-lg">
            {current && <Editor key={current.id + JSON.stringify(current)} effect={current} />}
            <Panel title="Instances en cours">
              {running.length === 0 ? <p className="muted" style={{ margin: 0 }}>Aucun effet en cours.</p> : (
                <table className="table small">
                  <thead><tr><th>Effet</th><th>Origine</th><th>Écoulé</th><th>État</th></tr></thead>
                  <tbody>{running.map((r) => <tr key={r.instanceId}><td>{r.name}</td><td>{r.owner === 'ai' ? 'IA' : r.owner === 'manual' ? 'Manuel' : 'Cue'}</td><td className="mono">{r.elapsed.toFixed(1)} s{r.duration ? ` / ${r.duration} s` : ''}</td><td>{r.paused ? <span className="badge warn">pause</span> : <span className="badge ok">actif</span>}</td></tr>)}</tbody>
                </table>
              )}
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
