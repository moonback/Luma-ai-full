import { useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Eye, Palette as PaletteIcon, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { useStore, confirmAction } from '../store';
import { act, newId } from '../api';
import { Empty, Field, Modal, PageHead, Panel, useResolved } from '../components/ui';
import type { Group, Palette, Scene } from '../../core/model/schemas';

function NameDialog({ title, initial, onSubmit, onClose, children }: { title: string; initial: string; onSubmit: (name: string) => void; onClose: () => void; children?: React.ReactNode }) {
  const [name, setName] = useState(initial);
  const ok = () => { if (name.trim()) { onSubmit(name.trim()); onClose(); } };
  return (
    <Modal title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Annuler</button><button className="btn primary" onClick={ok}>Valider</button></>}>
      <div className="col">
        <Field label="Nom"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ok()} /></Field>
        {children}
      </div>
    </Modal>
  );
}

function Groups() {
  const groups = useStore((s) => s.project!.project.groups);
  const selection = useStore((s) => s.selection);
  const setSelection = useStore((s) => s.setSelection);
  const [dialog, setDialog] = useState<{ group?: Group } | null>(null);
  const move = (i: number, d: -1 | 1) => {
    const ids = groups.map((g) => g.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    void act({ type: 'group.reorder', ids });
  };
  return (
    <Panel title="Groupes" actions={<button className="btn sm primary" disabled={!selection.length} title={selection.length ? 'Créer un groupe depuis la sélection' : 'Sélectionnez des projecteurs (Fixtures ou Live Console)'} onClick={() => setDialog({})}><Plus size={13} />Depuis la sélection</button>}>
      {groups.length === 0 ? <p className="muted" style={{ margin: 0 }}>Aucun groupe. Sélectionnez des projecteurs puis créez un groupe.</p> : (
        <table className="table">
          <tbody>
            {groups.map((g, i) => (
              <tr key={g.id}>
                <td style={{ width: 14 }}><span className="led" style={{ background: g.color }} /></td>
                <td>{g.name}</td>
                <td className="muted small">{g.fixtureIds.length} proj.</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn ghost sm" onClick={() => setSelection(g.fixtureIds)}>Sélectionner</button>
                  <button className="btn ghost sm icon" title="Remplacer par la sélection" disabled={!selection.length} onClick={() => void act({ type: 'group.upsert', group: { ...g, fixtureIds: selection } })}><Upload size={12} /></button>
                  <button className="btn ghost sm icon" title="Renommer / couleur" onClick={() => setDialog({ group: g })}><Pencil size={12} /></button>
                  <button className="btn ghost sm icon" title="Monter" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={12} /></button>
                  <button className="btn ghost sm icon" title="Descendre" disabled={i === groups.length - 1} onClick={() => move(i, 1)}><ArrowDown size={12} /></button>
                  <button className="btn ghost sm icon" title="Dupliquer" onClick={() => void act({ type: 'group.upsert', group: { ...g, id: newId(), name: `${g.name} (copie)`.slice(0, 80) } })}><Copy size={12} /></button>
                  <button className="btn ghost sm icon" title="Supprimer" onClick={async () => (await confirmAction({ title: 'Supprimer le groupe', message: `Supprimer « ${g.name} » ? Les projecteurs ne sont pas supprimés.`, confirmLabel: 'Supprimer' })) && void act({ type: 'group.remove', id: g.id })}><Trash2 size={12} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {dialog && <GroupDialog group={dialog.group} onClose={() => setDialog(null)} />}
    </Panel>
  );
}

function GroupDialog({ group, onClose }: { group?: Group; onClose: () => void }) {
  const selection = useStore((s) => s.selection);
  const [color, setColor] = useState(group?.color ?? '#8B5CF6');
  return (
    <NameDialog title={group ? 'Modifier le groupe' : 'Nouveau groupe'} initial={group?.name ?? `Groupe ${selection.length}`} onClose={onClose}
      onSubmit={(name) => void act({ type: 'group.upsert', group: { id: group?.id ?? newId(), name, color: color.toUpperCase(), fixtureIds: group?.fixtureIds ?? selection } })}>
      <Field label="Couleur d’identification"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></Field>
    </NameDialog>
  );
}

function Palettes() {
  const palettes = useStore((s) => s.project!.project.palettes);
  const selection = useStore((s) => s.selection);
  const [creating, setCreating] = useState<null | 'color' | 'record'>(null);
  const [kind, setKind] = useState<Palette['kind']>('position');
  const [color, setColor] = useState('#8B00FF');
  return (
    <Panel title="Palettes" actions={<>
      <button className="btn sm" onClick={() => setCreating('color')}><PaletteIcon size={13} />Couleur</button>
      <button className="btn sm" disabled={!selection.length} title="Enregistre les valeurs du programmeur du premier projecteur sélectionné" onClick={() => setCreating('record')}><Plus size={13} />Depuis le programmeur</button>
    </>}>
      {palettes.length === 0 ? <p className="muted" style={{ margin: 0 }}>Les palettes sont converties selon les capacités de chaque projecteur (RGB, RGBW, roue de couleurs…).</p> : (
        <table className="table">
          <tbody>
            {palettes.map((p) => (
              <tr key={p.id}>
                <td style={{ width: 14 }}>{p.color ? <span className="led" style={{ background: p.color }} /> : null}</td>
                <td>{p.name}</td>
                <td><span className="badge">{({ color: 'couleur', position: 'position', intensity: 'intensité', beam: 'faisceau' })[p.kind]}</span></td>
                <td style={{ textAlign: 'right' }}>
                  <button className="btn ghost sm" disabled={!selection.length} onClick={() => void act({ type: 'palette.apply', id: p.id, fixtureIds: selection })}>Appliquer</button>
                  <button className="btn ghost sm icon" title="Dupliquer" onClick={() => void act({ type: 'palette.upsert', palette: { ...p, id: newId(), name: `${p.name} (copie)`.slice(0, 80) } })}><Copy size={12} /></button>
                  <button className="btn ghost sm icon" title="Supprimer" onClick={async () => (await confirmAction({ title: 'Supprimer la palette', message: `Supprimer « ${p.name} » ?`, confirmLabel: 'Supprimer' })) && void act({ type: 'palette.remove', id: p.id })}><Trash2 size={12} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {creating === 'color' && (
        <NameDialog title="Nouvelle palette de couleur" initial="Couleur" onClose={() => setCreating(null)} onSubmit={(name) => void act({ type: 'palette.upsert', palette: { id: newId(), name, kind: 'color', color: color.toUpperCase(), values: {} } })}>
          <Field label="Couleur"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></Field>
        </NameDialog>
      )}
      {creating === 'record' && (
        <NameDialog title="Palette depuis le programmeur" initial="Palette" onClose={() => setCreating(null)} onSubmit={(name) => void act({ type: 'palette.recordFromProgrammer', name, kind, fixtureId: selection[0]! })}>
          <Field label="Type" hint="Seuls les attributs de ce type sont enregistrés">
            <select className="select" value={kind} onChange={(e) => setKind(e.target.value as Palette['kind'])}>
              <option value="position">Position</option><option value="intensity">Intensité</option><option value="beam">Faisceau</option><option value="color">Couleur (valeurs brutes)</option>
            </select>
          </Field>
        </NameDialog>
      )}
    </Panel>
  );
}

export function SceneList() {
  const scenes = useStore((s) => s.project!.project.scenes);
  const { byId } = useResolved();
  const setPreview = useStore((s) => s.setPreview);
  const [renaming, setRenaming] = useState<Scene | null>(null);
  const preview = async (s: Scene) => {
    const r = await act({ type: 'scene.preview', id: s.id });
    if (r) {
      setPreview({ label: `Prévisualisation : ${s.name}`, values: r.values });
      useStore.getState().setPage('visualizer');
    }
  };
  return (
    <Panel title="Scènes" flush>
      {scenes.length === 0 ? (
        <Empty title="Aucune scène">Réglez des projecteurs dans la Live Console puis « Enregistrer scène », ou demandez-en une à l’assistant IA.</Empty>
      ) : (
        <table className="table">
          <thead><tr><th>Nom</th><th>Projecteurs</th><th>Origine</th><th /></tr></thead>
          <tbody>
            {scenes.map((s) => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td className="muted small">{Object.keys(s.values).map((id) => byId.get(id)?.fixture.name ?? '?').slice(0, 4).join(', ')}{Object.keys(s.values).length > 4 ? '…' : ''}</td>
                <td>{s.origin === 'ai' ? <span className="badge violet">IA</span> : <span className="badge">manuel</span>}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn ghost sm" title="Prévisualiser dans le visualiseur (sans sortie DMX)" onClick={() => void preview(s)}><Eye size={12} />Prévisualiser</button>
                  <button className="btn ghost sm" title="Charger dans le programmeur pour modification (prioritaire, envoyé en sortie)" onClick={() => void act({ type: 'scene.load', id: s.id })}>Charger</button>
                  <button className="btn ghost sm icon" title="Renommer" onClick={() => setRenaming(s)}><Pencil size={12} /></button>
                  <button className="btn ghost sm icon" title="Dupliquer" onClick={() => void act({ type: 'scene.duplicate', id: s.id })}><Copy size={12} /></button>
                  <button className="btn ghost sm icon" title="Supprimer" onClick={async () => (await confirmAction({ title: 'Supprimer la scène', message: `Supprimer « ${s.name} » ? Les cues qui l’utilisent deviendront des cues vides.`, confirmLabel: 'Supprimer' })) && void act({ type: 'scene.remove', id: s.id })}><Trash2 size={12} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {renaming && <NameDialog title="Renommer la scène" initial={renaming.name} onClose={() => setRenaming(null)} onSubmit={(name) => void act({ type: 'scene.upsert', scene: { ...renaming, name } })} />}
    </Panel>
  );
}

export function Programmer() {
  return (
    <div className="page">
      <PageHead title="Programmer" subtitle="Groupes, palettes et scènes du projet" />
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <div className="col gap-lg"><Groups /><Palettes /></div>
        <SceneList />
      </div>
    </div>
  );
}
