import { useEffect, useMemo, useState } from 'react';
import { Camera, Copy, Lightbulb, Plus, Search, Trash2, Upload } from 'lucide-react';
import { useStore, confirmAction } from '../store';
import { act } from '../api';
import { Empty, Field, Modal, NumberInput, PageHead, Panel, useResolved } from '../components/ui';
import { channelCount, channelKey } from '../../core/fixtures/profiles';
import { findFreeAddress } from '../../core/fixtures/patch';
import { attributeLabel } from '../../core/fixtures/attributes';
import { CameraLocate } from './CameraLocate';

function AddDialog({ onClose }: { onClose: () => void }) {
  const { lib } = useResolved();
  const project = useStore((s) => s.project!.project);
  const profiles = lib.all();
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? '');
  const profile = lib.get(profileId);
  const [mode, setMode] = useState(profile?.modes[0]?.name ?? '');
  const [universe, setUniverse] = useState(1);
  const [auto, setAuto] = useState(true);
  const [address, setAddress] = useState(1);
  const [count, setCount] = useState(1);
  const [prefix, setPrefix] = useState(profile?.name ?? 'Projecteur');
  const [tags, setTags] = useState('');
  const chans = profile ? channelCount(profile, mode) : 0;
  const next = profile ? findFreeAddress(lib, project.patch, universe, chans) : undefined;

  const pick = (id: string) => {
    const p = lib.get(id);
    setProfileId(id);
    setMode(p?.modes[0]?.name ?? '');
    setPrefix(p?.name ?? 'Projecteur');
  };
  const submit = async () => {
    const r = await act({ type: 'fixture.add', profileId, mode, universe, address: auto ? null : address, count, namePrefix: prefix.trim() || 'Projecteur', tags: tags.split(',').map((t) => t.trim()).filter(Boolean) });
    if (r) {
      useStore.getState().toast({ kind: 'success', title: `${r.ids.length} projecteur(s) ajouté(s)` });
      onClose();
    }
  };
  return (
    <Modal title="Ajouter des projecteurs" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Annuler</button><button className="btn primary" data-testid="add-confirm" onClick={() => void submit()} disabled={!profile || !chans}>Ajouter</button></>}>
      <div className="grid g2">
        <Field label="Profil" hint={profile?.fictional ? 'Profil de démonstration FICTIF — non certifié pour un modèle commercial' : profile?.manufacturer}>
          <select className="select" data-testid="add-profile" value={profileId} onChange={(e) => pick(e.target.value)}>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}{p.fictional ? ' (fictif)' : ''}</option>)}
          </select>
        </Field>
        <Field label="Mode DMX" hint={`${chans} canaux`}>
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
            {profile?.modes.map((m) => <option key={m.name}>{m.name}</option>)}
          </select>
        </Field>
        <Field label="Univers"><NumberInput value={universe} min={1} max={project.show.universes} onChange={setUniverse} /></Field>
        <Field label="Adresse de départ" hint={auto ? (next ? `Automatique : première adresse libre ${next}` : 'Univers plein') : `Occupera ${address}–${address + chans * count - 1}`}>
          <div className="row">
            <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />Auto</label>
            {!auto && <NumberInput value={address} min={1} max={512} onChange={setAddress} />}
          </div>
        </Field>
        <Field label="Quantité"><NumberInput value={count} min={1} max={128} onChange={setCount} /></Field>
        <Field label="Préfixe du nom"><input className="input" value={prefix} onChange={(e) => setPrefix(e.target.value)} /></Field>
        <Field label="Tags" hint="Séparés par des virgules (ex : face, contre)"><input className="input" value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
      </div>
      {profile && (
        <p className="small" style={{ marginBottom: 0 }}>
          Canaux : {profile.modes.find((m) => m.name === mode)?.channels.map((c) => `${c.name}${c.fine ? ' (fin)' : ''}`).join(' · ')}
        </p>
      )}
    </Modal>
  );
}

function OflDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'online' | 'file'>('online');
  const [mans, setMans] = useState<{ key: string; name: string }[] | null>(null);
  const [man, setMan] = useState('');
  const [fixtures, setFixtures] = useState<string[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [manName, setManName] = useState('Open Fixture Library');
  const [result, setResult] = useState<{ imported: string | null; warnings: string[]; errors: string[] } | null>(null);
  useEffect(() => {
    if (tab === 'online' && !mans) void act({ type: 'ofl.manufacturers' }).then((m) => setMans(m ?? []));
  }, [tab, mans]);
  const pickMan = async (key: string) => {
    setMan(key);
    setFixtures(null);
    if (key) setFixtures((await act({ type: 'ofl.fixtures', manufacturer: key })) ?? []);
  };
  const run = async (source: { kind: 'online'; manufacturer: string; key: string } | { kind: 'file'; manufacturerName: string }) => {
    setBusy(true);
    const r = await act({ type: 'profile.importOfl', source });
    setBusy(false);
    if (r && (r.imported || r.errors.length)) setResult(r);
    if (r?.imported) useStore.getState().toast({ kind: r.warnings.length ? 'warn' : 'success', title: `Profil importé : ${r.imported}`, detail: r.warnings.length ? `${r.warnings.length} avertissement(s)` : undefined });
  };
  const shown = (fixtures ?? []).filter((k) => k.includes(q.toLowerCase()));
  return (
    <Modal title="Importer depuis Open Fixture Library" wide onClose={onClose} footer={<button className="btn" onClick={onClose}>Fermer</button>}>
      <div className="col">
        <div className="chips">
          <button className={`chip ${tab === 'online' ? 'on' : ''}`} onClick={() => setTab('online')}>Catalogue en ligne</button>
          <button className={`chip ${tab === 'file' ? 'on' : ''}`} onClick={() => setTab('file')}>Fichier .json OFL</button>
        </div>
        {tab === 'online' ? (
          <div className="grid g2">
            <Field label="Fabricant" hint={mans ? `${mans.length} fabricants` : 'Chargement du catalogue…'}>
              <select className="select" value={man} onChange={(e) => void pickMan(e.target.value)} data-testid="ofl-manufacturer">
                <option value="">— choisir —</option>
                {(mans ?? []).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
              </select>
            </Field>
            <Field label="Modèle" hint={fixtures ? `${fixtures.length} modèle(s)` : man ? 'Chargement…' : ''}>
              <input className="input" placeholder="Filtrer…" value={q} onChange={(e) => setQ(e.target.value)} disabled={!fixtures} />
            </Field>
            <div className="panel" style={{ gridColumn: '1 / -1', maxHeight: 240, overflow: 'auto' }}>
              {shown.map((k) => (
                <div key={k} className="row between" style={{ padding: '4px 10px', borderBottom: '1px solid var(--border)' }}>
                  <span className="mono small">{k}</span>
                  <button className="btn sm primary" disabled={busy} onClick={() => void run({ kind: 'online', manufacturer: man, key: k })}>Importer</button>
                </div>
              ))}
              {fixtures && !shown.length && <p className="muted small" style={{ padding: 10, margin: 0 }}>Aucun modèle.</p>}
            </div>
          </div>
        ) : (
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field label="Nom du fabricant"><input className="input" value={manName} onChange={(e) => setManName(e.target.value)} /></Field>
            <button className="btn primary" disabled={busy || !manName.trim()} onClick={() => void run({ kind: 'file', manufacturerName: manName.trim() })}><Upload size={14} />Choisir le fichier…</button>
          </div>
        )}
        {result && (
          <div className="col small">
            {result.imported && <span style={{ color: '#34d399' }}>✓ {result.imported} ajouté au projet</span>}
            {result.errors.map((e, i) => <span key={i} style={{ color: '#fca5a5' }}>✗ {e}</span>)}
            {result.warnings.slice(0, 8).map((w, i) => <span key={i} style={{ color: '#f59e0b' }}>⚠ {w}</span>)}
          </div>
        )}
        <p className="small dim" style={{ margin: 0 }}>Données Open Fixture Library (licence MIT), récupérées depuis le dépôt GitHub du projet. Les profils importés sont des conversions automatiques : vérifiez-les avec le manuel du projecteur avant un spectacle. Les canaux non représentables deviennent des canaux génériques (adresses conservées).</p>
      </div>
    </Modal>
  );
}

function Editor({ id }: { id: string }) {
  const { lib, byId } = useResolved();
  const rf = byId.get(id);
  const universes = useStore((s) => s.project!.project.show.universes);
  if (!rf) return null;
  const f = rf.fixture;
  const update = (patch: Record<string, unknown>) => void act({ type: 'fixture.update', id, patch });
  const count = rf.mode.channels.length;
  return (
    <Panel title="Propriétés" actions={rf.profile.fictional ? <span className="badge warn" title="Profil de démonstration">fictif</span> : null}>
      <div className="col">
        <Field label="Nom"><input className="input" key={f.name} defaultValue={f.name} onBlur={(e) => e.target.value.trim() && e.target.value !== f.name && update({ name: e.target.value.trim() })} /></Field>
        <div className="small muted">{rf.profile.manufacturer} · {rf.profile.name}</div>
        <Field label="Mode">
          <select className="select" value={f.mode} onChange={(e) => update({ mode: e.target.value })}>
            {lib.get(f.profileId)?.modes.map((m) => <option key={m.name}>{m.name}</option>)}
          </select>
        </Field>
        <div className="grid g2">
          <Field label="Univers"><NumberInput value={f.universe} min={1} max={universes} onChange={(v) => update({ universe: v })} /></Field>
          <Field label="Adresse" hint={`${f.address}–${f.address + count - 1} (${count} canaux)`}><NumberInput value={f.address} min={1} max={512} onChange={(v) => update({ address: v })} /></Field>
          <Field label="Position X (m)"><NumberInput value={f.position.x} min={-100} max={100} step={0.1} onChange={(v) => update({ position: { ...f.position, x: v } })} /></Field>
          <Field label="Position Y (m)"><NumberInput value={f.position.y} min={-100} max={100} step={0.1} onChange={(v) => update({ position: { ...f.position, y: v } })} /></Field>
          <Field label="Rotation (°)"><NumberInput value={f.rotation} min={-360} max={360} onChange={(v) => update({ rotation: v })} /></Field>
          <Field label="Hauteur (m)" hint="Accroche, pour la vue 3D"><NumberInput value={f.height} min={0} max={50} step={0.1} onChange={(v) => update({ height: v })} /></Field>
          <Field label="Tags"><input className="input" key={f.tags.join()} defaultValue={f.tags.join(', ')} onBlur={(e) => update({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} /></Field>
        </div>
        <Field label="Notes"><textarea className="textarea" rows={2} key={f.notes} defaultValue={f.notes} onBlur={(e) => e.target.value !== f.notes && update({ notes: e.target.value })} /></Field>
        <table className="table small">
          <thead><tr><th>Ch</th><th>Adr</th><th>Fonction</th></tr></thead>
          <tbody>
            {rf.mode.channels.map((c, i) => (
              <tr key={i}><td className="mono">{i + 1}</td><td className="mono">{f.address + i}</td><td>{c.name} <span className="dim">{attributeLabel(channelKey(c))}{c.fine ? ' · 16 bits (fin)' : ''}{c.ranges.some((r) => r.dangerous) ? ' · fonctions spéciales' : ''}</span></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function Fixtures() {
  const { fixtures } = useResolved();
  const ps = useStore((s) => s.project!);
  const selection = useStore((s) => s.selection);
  const setSelection = useStore((s) => s.setSelection);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [locating, setLocating] = useState(false);
  const [ofl, setOfl] = useState(false);
  const [universe, setUniverse] = useState<number | 'all'>('all');
  const issueIds = useMemo(() => new Set(ps.issues.flatMap((i) => i.fixtureIds)), [ps.issues]);
  const shown = fixtures.filter((rf) => {
    const t = `${rf.fixture.name} ${rf.profile.name} ${rf.fixture.tags.join(' ')} ${rf.profile.type}`.toLowerCase();
    return (universe === 'all' || rf.fixture.universe === universe) && t.includes(q.toLowerCase());
  });
  const toggle = (id: string, e: React.MouseEvent) => {
    if (e.shiftKey && selection.length) {
      const ids = shown.map((x) => x.fixture.id);
      const a = ids.indexOf(selection[selection.length - 1]!), b = ids.indexOf(id);
      setSelection([...new Set([...selection, ...ids.slice(Math.min(a, b), Math.max(a, b) + 1)])]);
    } else if (e.ctrlKey || e.metaKey) setSelection(selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id]);
    else setSelection([id]);
  };
  const remove = async () => {
    if (await confirmAction({ title: 'Supprimer des projecteurs', message: `Supprimer ${selection.length} projecteur(s) ? Ils seront aussi retirés des groupes, scènes et effets.`, confirmLabel: 'Supprimer' })) {
      await act({ type: 'fixture.remove', ids: selection });
    }
  };
  const importProfiles = async () => {
    const r = await act({ type: 'profile.import' });
    if (r && (r.imported.length || r.errors.length)) {
      useStore.getState().toast({ kind: r.errors.length ? 'warn' : 'success', title: `${r.imported.length} profil(s) importé(s)`, detail: r.errors.slice(0, 3).join('\n') || undefined });
    }
  };

  return (
    <div className="page">
      <PageHead title="Fixtures" subtitle="Patch DMX : profils, univers, adresses et positions">
        <button className="btn" onClick={() => void importProfiles()} title="Importer des profils au format JSON documenté (docs/PROFILE_FORMAT.md)"><Upload size={15} />Importer des profils</button>
        <button className="btn" onClick={() => setOfl(true)} title="Catalogue communautaire Open Fixture Library"><Upload size={15} />Open Fixture Library</button>
        <button className="btn" data-testid="locate-open" disabled={!ps.project.patch.length} onClick={() => setLocating(true)} title="Mesurer les positions réelles avec une caméra et détecter les erreurs de patch"><Camera size={15} />Localiser par caméra</button>
        <button className="btn primary" data-testid="add-fixture" onClick={() => setAdding(true)}><Plus size={15} />Ajouter</button>
      </PageHead>
      {locating && <CameraLocate onClose={() => setLocating(false)} />}
      {ps.issues.length > 0 && (
        <div className="panel" style={{ padding: 10, marginBottom: 12, borderColor: 'rgba(239,68,68,.5)' }}>
          {ps.issues.map((i, k) => <div key={k} className="small" style={{ color: '#fca5a5' }}>⚠ {i.message}</div>)}
        </div>
      )}
      <div className="split">
        <Panel
          flush
          title={`${fixtures.length} projecteur(s)`}
          actions={
            <div className="row">
              <div className="row" style={{ position: 'relative' }}>
                <Search size={14} style={{ position: 'absolute', left: 8 }} className="dim" />
                <input className="input" style={{ paddingLeft: 26, width: 200 }} placeholder="Rechercher, filtrer…" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <select className="select" style={{ width: 110 }} value={universe} onChange={(e) => setUniverse(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
                <option value="all">Tous univers</option>
                {Array.from({ length: ps.project.show.universes }, (_, i) => <option key={i} value={i + 1}>Univers {i + 1}</option>)}
              </select>
              <button className="btn sm" disabled={!selection.length} onClick={() => void act({ type: 'fixture.duplicate', ids: selection })} title="Dupliquer"><Copy size={13} /></button>
              <button className="btn sm danger" disabled={!selection.length} onClick={() => void remove()} title="Supprimer"><Trash2 size={13} /></button>
            </div>
          }
        >
          {fixtures.length === 0 ? (
            <Empty icon={<Lightbulb size={32} />} title="Aucun projecteur patché" action={<button className="btn primary" onClick={() => setAdding(true)}><Plus size={15} />Ajouter des projecteurs</button>}>
              Ajoutez des projecteurs à partir de la bibliothèque de profils. Les profils inclus sont des profils de démonstration fictifs.
            </Empty>
          ) : (
            <div style={{ maxHeight: 'calc(100vh - 230px)', overflow: 'auto' }}>
              <table className="table" data-testid="patch-table">
                <thead><tr><th>Nom</th><th>Profil</th><th>Mode</th><th>Univ.</th><th>Adresses</th><th>Tags</th></tr></thead>
                <tbody>
                  {shown.map((rf) => {
                    const n = rf.mode.channels.length;
                    return (
                      <tr key={rf.fixture.id} className={`clickable ${selection.includes(rf.fixture.id) ? 'sel' : ''}`} onClick={(e) => toggle(rf.fixture.id, e)}>
                        <td>{issueIds.has(rf.fixture.id) && <span title="Conflit" style={{ color: '#ef4444' }}>⚠ </span>}{rf.fixture.name}</td>
                        <td>{rf.profile.name} {rf.profile.fictional && <span className="badge" title="Profil de démonstration fictif">fictif</span>}</td>
                        <td className="muted">{rf.fixture.mode}</td>
                        <td className="mono">{rf.fixture.universe}</td>
                        <td className="mono">{rf.fixture.address}–{rf.fixture.address + n - 1}</td>
                        <td>{rf.fixture.tags.map((t) => <span key={t} className="badge" style={{ marginRight: 4 }}>{t}</span>)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        {selection.length === 1 ? <Editor id={selection[0]!} /> : (
          <Panel title="Propriétés"><p className="muted" style={{ margin: 0 }}>{selection.length ? `${selection.length} projecteurs sélectionnés (Maj/Ctrl+clic). Utilisez la console live pour les piloter ensemble.` : 'Sélectionnez un projecteur pour modifier son adressage, sa position et ses tags.'}</p></Panel>
        )}
      </div>
      {adding && <AddDialog onClose={() => setAdding(false)} />}
      {ofl && <OflDialog onClose={() => setOfl(false)} />}
    </div>
  );
}
