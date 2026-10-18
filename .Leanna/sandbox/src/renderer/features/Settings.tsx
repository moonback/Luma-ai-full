import { useEffect, useState, useSyncExternalStore } from 'react';
import { FolderOpen, KeyRound } from 'lucide-react';
import { useStore, confirmAction } from '../store';
import { act } from '../api';
import { Field, NumberInput, PageHead, Panel, Tabs } from '../components/ui';
import { resolveShortcuts, SHORTCUT_ACTIONS, shortcutConflicts, type Settings } from '../../core/settings/settings';
import { comboFromEvent } from '../shortcuts';
import type { RecoveryEntry } from '../../core/project/store';
import type { OpenRouterModel } from '../../core/ai/providers/openrouter';
import { externalControl } from '../control';
import { audioEngine } from '../audioEngine';

const TABS = [
  { id: 'general', label: 'Général' }, { id: 'appearance', label: 'Apparence' }, { id: 'engine', label: 'Moteur & sécurité' },
  { id: 'network', label: 'Réseau / DMX' }, { id: 'ai', label: 'IA et fournisseurs' }, { id: 'audio', label: 'Audio' },
  { id: 'shortcuts', label: 'Raccourcis' }, { id: 'control', label: 'Contrôle externe' }, { id: 'logs', label: 'Logs & diagnostics' }, { id: 'backups', label: 'Sauvegardes' },
] as const;
type TabId = (typeof TABS)[number]['id'];

function ShortcutEditor({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const [capturing, setCapturing] = useState<string | null>(null);
  const bindings = resolveShortcuts(value);
  const conflicts = shortcutConflicts(bindings);
  const conflicted = new Set(conflicts.flat());
  useEffect(() => {
    useStore.setState({ capturingShortcut: capturing !== null });
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      const combo = comboFromEvent(e);
      if (!combo) return;
      e.preventDefault();
      e.stopPropagation();
      onChange({ ...value, [capturing]: combo });
      setCapturing(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, value, onChange]);
  useEffect(() => () => useStore.setState({ capturingShortcut: false }), []);
  const label = (id: string) => SHORTCUT_ACTIONS.find((a) => a.id === id)?.label ?? id;
  return (
    <div>
      {conflicts.length > 0 && (
        <div className="small" style={{ padding: '8px 12px', color: '#fca5a5' }}>
          Conflits : {conflicts.map((ids) => `« ${bindings[ids[0] as keyof typeof bindings]} » → ${ids.map(label).join(' / ')}`).join(' ; ')}. Seule la première action reçoit le raccourci.
        </div>
      )}
      <table className="table" data-testid="shortcut-table">
        <tbody>
          {SHORTCUT_ACTIONS.map((a) => {
            const combo = bindings[a.id];
            const custom = value[a.id] !== undefined;
            return (
              <tr key={a.id}>
                <td>{a.label}</td>
                <td style={{ width: 170 }}>
                  {capturing === a.id ? <span className="badge violet">Appuyez sur une combinaison…</span> : combo ? <span className={`badge mono ${conflicted.has(a.id) ? 'err' : custom ? 'cyan' : ''}`}>{combo}</span> : <span className="dim small">non attribué</span>}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {capturing === a.id ? (
                    <button className="btn ghost sm" onClick={() => setCapturing(null)}>Annuler</button>
                  ) : (
                    <button className="btn ghost sm" data-testid={`rebind-${a.id}`} onClick={() => setCapturing(a.id)}>Modifier</button>
                  )}
                  <button className="btn ghost sm" disabled={!combo} onClick={() => onChange({ ...value, [a.id]: '' })}>Effacer</button>
                  <button className="btn ghost sm" disabled={!custom} onClick={() => { const { [a.id]: _, ...rest } = value; onChange(rest); }}>Défaut</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row" style={{ padding: 12 }}>
        <button className="btn" disabled={!Object.keys(value).length} onClick={() => onChange({})}>Rétablir tous les raccourcis par défaut</button>
        <span className="small dim">Les raccourcis sans Ctrl/Alt sont ignorés pendant la saisie dans un champ. Annuler/rétablir de la timeline : Ctrl+Z / Ctrl+Y.</span>
      </div>
    </div>
  );
}

function ModelPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [models, setModels] = useState<OpenRouterModel[] | null>(null);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const load = async (refresh = false) => {
    setLoading(true);
    const m = await act({ type: 'ai.listModels', refresh });
    setLoading(false);
    if (m) setModels(m);
  };
  const shown = (models ?? []).filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
  const current = models?.find((m) => m.id === value);
  const price = (v: number | null) => (v === null ? '?' : v === 0 ? 'gratuit' : `${v} $`);
  return (
    <Field label="Modèle" hint={current ? `${current.name} · contexte ${current.contextLength ?? '?'} · entrée ${price(current.promptPrice)} / sortie ${price(current.completionPrice)} par million de jetons${current.structuredOutputs ? ' · sortie structurée' : current.jsonMode ? ' · mode JSON' : ' · JSON par consigne uniquement'}` : 'Identifiant OpenRouter « fournisseur/modèle ». « openrouter/auto » laisse OpenRouter choisir.'}>
      <div className="col">
        <div className="row">
          <input className="input mono" data-testid="ai-model" value={value} onChange={(e) => onChange(e.target.value.trim())} />
          <button className="btn" onClick={() => void load(models !== null)} disabled={loading}>{loading ? 'Chargement…' : models ? 'Actualiser la liste' : 'Charger la liste des modèles'}</button>
        </div>
        {models && (
          <div className="panel" style={{ maxHeight: 260, overflow: 'auto' }}>
            <div style={{ padding: 8, position: 'sticky', top: 0, background: 'var(--panel)' }}><input className="input" placeholder={`Rechercher parmi ${models.length} modèles…`} value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <table className="table small">
              <thead><tr><th>Modèle</th><th>Contexte</th><th>$ / M jetons (entrée · sortie)</th><th>Format</th></tr></thead>
              <tbody>
                {shown.map((m) => (
                  <tr key={m.id} className={`clickable ${m.id === value ? 'sel' : ''}`} onClick={() => onChange(m.id)}>
                    <td>{m.name}<div className="dim mono">{m.id}</div></td>
                    <td className="mono">{m.contextLength ?? '?'}</td>
                    <td className="mono">{price(m.promptPrice)} · {price(m.completionPrice)}</td>
                    <td>{m.structuredOutputs ? <span className="badge ok">structuré</span> : m.jsonMode ? <span className="badge cyan">JSON</span> : <span className="badge">consigne</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Field>
  );
}

const OSC_ADDRESSES: [string, string][] = [
  ['/luma/go [liste]', 'GO (liste de cues, 1 = première)'], ['/luma/back [liste]', 'BACK'], ['/luma/goto <cue> [liste]', 'Aller au cue n'],
  ['/luma/pause [liste] · /luma/resume [liste]', 'Pause / reprise'], ['/luma/blackout [0|1]', 'Blackout (bascule sans argument)'],
  ['/luma/master <0..1>', 'Grand master'], ['/luma/bpm <bpm>', 'Tempo'], ['/luma/release', 'Relâcher le programmeur'],
  ['/luma/stop', 'STOP OUTPUT'], ['/luma/timecode <secondes>', 'Position de timecode (la timeline suit)'],
];

function ControlTab({ value, onChange }: { value: Settings['control']; onChange: (v: Settings['control']) => void }) {
  const status = useSyncExternalStore((l) => externalControl.subscribe(l), () => externalControl.status);
  const [learnFor, setLearnFor] = useState<string | null>(null);
  const [newAction, setNewAction] = useState('go');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [ips, setIps] = useState<string[]>([]);
  useEffect(() => { void audioEngine.devices().then(setDevices); void act({ type: 'output.interfaces' }).then((x) => setIps(x ?? [])); }, []);
  const r = value.remote;
  useEffect(() => () => { externalControl.learn = null; }, []);
  const learn = async () => {
    setLearnFor(newAction);
    externalControl.learn = (key) => {
      setLearnFor(null);
      onChange({ ...value, midi: { ...value.midi, mappings: [...value.midi.mappings.filter((m) => m.key !== key), { key, action: newAction }] } });
    };
    await externalControl.ensureMidi();
  };
  const actionLabel = (id: string) => (id === 'master' ? 'Grand master (fader)' : SHORTCUT_ACTIONS.find((a) => a.id === id)?.label ?? id);
  return (
    <>
      <Panel title="MIDI">
        <label className="check"><input type="checkbox" checked={value.midi.enabled} onChange={(e) => onChange({ ...value, midi: { ...value.midi, enabled: e.target.checked } })} />Activer les contrôleurs MIDI</label>
        <p className="small dim">Entrées détectées : {status.midiInputs.length ? status.midiInputs.join(', ') : 'aucune'}{status.error ? <span className="badge err" style={{ marginLeft: 6 }}>{status.error}</span> : null}</p>
        <table className="table small" data-testid="midi-mappings"><tbody>
          {value.midi.mappings.map((m) => (
            <tr key={m.key}><td className="mono">{m.key}</td><td>{actionLabel(m.action)}</td>
              <td style={{ textAlign: 'right' }}><button className="btn ghost sm" onClick={() => onChange({ ...value, midi: { ...value.midi, mappings: value.midi.mappings.filter((x) => x.key !== m.key) } })}>Retirer</button></td></tr>
          ))}
        </tbody></table>
        <div className="row">
          <select className="select" style={{ width: 320 }} value={newAction} onChange={(e) => setNewAction(e.target.value)}>
            <option value="master">Grand master (fader)</option>
            {SHORTCUT_ACTIONS.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
          {learnFor ? <span className="badge violet">Actionnez une touche ou un fader…</span> : <button className="btn" onClick={() => void learn()} data-testid="midi-learn">Apprendre</button>}
        </div>
      </Panel>
      <Panel title="OSC (UDP)">
        <div className="grid g2">
          <label className="check"><input type="checkbox" checked={value.osc.enabled} onChange={(e) => onChange({ ...value, osc: { ...value.osc, enabled: e.target.checked } })} />Recevoir des commandes OSC</label>
          <Field label="Port UDP"><NumberInput value={value.osc.port} min={1024} max={65535} onChange={(port) => onChange({ ...value, osc: { ...value.osc, port } })} /></Field>
          <Field label="Écoute" hint="Réseau local : sans authentification, à réserver à un réseau de régie de confiance. Aucune commande OSC ne peut armer une sortie.">
            <select className="select" value={value.osc.bind} onChange={(e) => onChange({ ...value, osc: { ...value.osc, bind: e.target.value as Settings['control']['osc']['bind'] } })}>
              <option value="127.0.0.1">Cette machine uniquement (127.0.0.1)</option>
              <option value="0.0.0.0">Réseau local (0.0.0.0)</option>
            </select>
          </Field>
        </div>
        <table className="table small"><tbody>{OSC_ADDRESSES.map(([a, d]) => <tr key={a}><td className="mono">{a}</td><td>{d}</td></tr>)}</tbody></table>
        <p className="small dim" style={{ marginBottom: 0 }}>Chaque message reçoit une réponse <span className="mono">/luma/ack &lt;adresse&gt; &lt;ok&gt;</span> vers l’expéditeur.</p>
      </Panel>
      <Panel title="Télécommande (tablette / téléphone)">
        <div className="grid g2">
          <label className="check"><input type="checkbox" data-testid="remote-enabled" checked={r.enabled} onChange={(e) => onChange({ ...value, remote: { ...r, enabled: e.target.checked } })} />Activer la télécommande sur le réseau local</label>
          <Field label="Port HTTP"><NumberInput value={r.port} min={1024} max={65535} onChange={(port) => onChange({ ...value, remote: { ...r, port } })} /></Field>
        </div>
        <p className="small dim">GO, BACK, pause, blackout, grand master, relâcher et STOP OUTPUT. L’armement des sorties et la reprise des émissions restent réservés à la régie. Toute personne qui a l’adresse complète (jeton inclus) peut piloter le show : régénérez le jeton pour révoquer les accès.</p>
        {r.enabled && r.token && (
          <table className="table small" data-testid="remote-urls"><tbody>
            {(ips.length ? ips : ['<adresse-ip>']).map((ip) => <tr key={ip}><td className="mono">{`http://${ip}:${r.port}/?t=${r.token}`}</td></tr>)}
          </tbody></table>
        )}
        <button className="btn" onClick={() => onChange({ ...value, remote: { ...r, token: crypto.randomUUID() } })}>Régénérer le jeton</button>
      </Panel>
      <Panel title="Timecode">
        <div className="grid g2">
          <Field label="Source" hint="La timeline chargée (ou la première du projet) suit la position reçue ; elle se met en pause 0,5 s après la perte du signal.">
            <select className="select" value={value.timecode.source} onChange={(e) => onChange({ ...value, timecode: { ...value.timecode, source: e.target.value as Settings['control']['timecode']['source'] } })}>
              <option value="off">Désactivé</option><option value="mtc">MTC (MIDI Time Code)</option><option value="ltc">LTC (entrée audio)</option>
            </select>
          </Field>
          {value.timecode.source === 'ltc' && (
            <Field label="Entrée audio LTC">
              <select className="select" value={value.timecode.ltcDeviceId ?? ''} onChange={(e) => onChange({ ...value, timecode: { ...value.timecode, ltcDeviceId: e.target.value || null } })}>
                <option value="">Entrée par défaut</option>
                {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>)}
              </select>
            </Field>
          )}
        </div>
        <p className="small">Dernier timecode reçu : <span className="mono">{status.timecode ?? '—'}</span></p>
      </Panel>
    </>
  );
}

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [tab, setTab] = useState<TabId>('general');
  const [key, setKey] = useState('');
  const [recovery, setRecovery] = useState<RecoveryEntry[]>([]);
  const rt = useStore((st) => st.runtime);
  const project = useStore((st) => st.project!);
  useEffect(() => { void act({ type: 'settings.get' }).then((x) => { if (x) { setS(x); setSaved(x); } }); }, []);
  useEffect(() => { if (tab === 'backups') void act({ type: 'project.listRecovery' }).then((x) => setRecovery(x ?? [])); }, [tab]);
  const reduced = !!s?.appearance.reducedMotion;
  const scale = s?.appearance.uiScale ?? 1;
  useEffect(() => { document.documentElement.classList.toggle('reduced-motion', reduced); document.documentElement.style.zoom = String(scale); }, [reduced, scale]);
  if (!s) return <div className="page">Chargement…</div>;
  const dirty = JSON.stringify(s) !== JSON.stringify(saved);
  const set = <K extends keyof Settings>(k: K, v: Partial<Settings[K]>) => setS({ ...s, [k]: { ...(s[k] as object), ...v } });
  const save = async () => { if (await act({ type: 'settings.update', settings: s })) { setSaved(s); useStore.setState({ shortcuts: s.shortcuts }); void externalControl.configure(s.control); useStore.getState().toast({ kind: 'success', title: 'Paramètres enregistrés' }); } };

  return (
    <div className="page">
      <PageHead title="Settings" subtitle="Paramètres de l’application (enregistrés sur cette machine, hors projet)">
        <button className="btn" disabled={!dirty} onClick={() => setS(saved)}>Annuler les modifications</button>
        <button className="btn primary" disabled={!dirty} onClick={() => void save()} data-testid="settings-save">Enregistrer</button>
      </PageHead>
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      <div style={{ maxWidth: 860 }}>
        {tab === 'general' && (
          <Panel title="Général">
            <div className="grid g2">
              <Field label="Sauvegarde automatique de récupération (minutes)" hint="0 = désactivée. Écrite dans le dossier de données, sans écraser votre fichier."><NumberInput value={s.general.autosaveMinutes} min={0} max={60} onChange={(v) => set('general', { autosaveMinutes: v })} /></Field>
              <label className="check"><input type="checkbox" checked={s.general.confirmDangerous} onChange={(e) => set('general', { confirmDangerous: e.target.checked })} />Confirmer les actions dangereuses</label>
              <Field label="Projets récents">
                <div className="col small">{s.general.recentProjects.length ? s.general.recentProjects.map((p) => <button key={p} className="btn ghost sm" style={{ justifyContent: 'flex-start' }} onClick={async () => (!project.dirty || (await confirmAction({ title: 'Modifications non enregistrées', message: 'Ouvrir sans enregistrer le projet actuel ?', confirmLabel: 'Ouvrir' }))) && void act({ type: 'project.open', path: p })}><FolderOpen size={12} />{p}</button>) : <span className="dim">Aucun</span>}</div>
              </Field>
            </div>
          </Panel>
        )}
        {tab === 'appearance' && (
          <Panel title="Apparence">
            <div className="grid g2">
              <label className="check"><input type="checkbox" checked={s.appearance.reducedMotion} onChange={(e) => set('appearance', { reducedMotion: e.target.checked })} />Réduire les animations</label>
              <Field label="Échelle de l’interface"><NumberInput value={s.appearance.uiScale} min={0.8} max={1.4} step={0.05} onChange={(v) => set('appearance', { uiScale: v })} /></Field>
            </div>
          </Panel>
        )}
        {tab === 'engine' && (
          <Panel title="Moteur et sécurité">
            <div className="grid g2">
              <Field label="Fréquence du moteur (Hz)" hint="10–44 Hz. Mesurée en direct dans la barre d’état."><NumberInput value={s.engine.rateHz} min={10} max={44} onChange={(v) => set('engine', { rateHz: v })} /></Field>
              <Field label="Politique de blackout" hint="Le blackout n’est pas universellement sûr : choisissez selon vos appareils.">
                <select className="select" value={s.engine.blackoutPolicy} onChange={(e) => set('engine', { blackoutPolicy: e.target.value as Settings['engine']['blackoutPolicy'] })}>
                  <option value="intensity">Intensités à 0 (positions et couleurs maintenues)</option>
                  <option value="intensity-shutter">Intensités à 0 + shutter fermé (si le profil le déclare)</option>
                  <option value="all-zero">Tous les canaux à 0 (attention : pan/tilt et fonctions bougent)</option>
                </select>
              </Field>
              <Field label="Fréquence strobe maximale (Hz)" hint="Plafond appliqué à tous les effets strobe (sécurité photosensible)."><NumberInput value={s.engine.maxStrobeHz} min={1} max={25} onChange={(v) => set('engine', { maxStrobeHz: v })} /></Field>
              <Field label="Garde-fou photosensible" hint="Estimation des flashs vus par le public (> 3 flashs/s ou strobe rapide sur une large part du kit). Les propositions IA dangereuses sont refusées sauf en mode Désactivé. Estimation, pas une certification.">
                <select className="select" data-testid="flash-guard" value={s.engine.flashGuard} onChange={(e) => set('engine', { flashGuard: e.target.value as Settings['engine']['flashGuard'] })}>
                  <option value="off">Désactivé</option>
                  <option value="warn">Avertir (alerte uniquement)</option>
                  <option value="limit">Limiter (atténue les flashs, hors programmeur)</option>
                </select>
              </Field>
              <Field label="Priorité couche IA"><NumberInput value={s.engine.priorities.ai} min={1} max={99} onChange={(v) => set('engine', { priorities: { ...s.engine.priorities, ai: v } })} /></Field>
              <Field label="Priorité timeline"><NumberInput value={s.engine.priorities.timeline} min={1} max={99} onChange={(v) => set('engine', { priorities: { ...s.engine.priorities, timeline: v } })} /></Field>
              <Field label="Priorité audio réactif"><NumberInput value={s.engine.priorities.audio} min={1} max={99} onChange={(v) => set('engine', { priorities: { ...s.engine.priorities, audio: v } })} /></Field>
            </div>
            <p className="small dim" style={{ marginBottom: 0 }}>Politique de fusion : le contrôle manuel est toujours prioritaire. Entre sources de même priorité : intensité = HTP, autres attributs = LTP. Une priorité supérieure remplace. Les listes de cues et effets ont leur propre priorité.</p>
          </Panel>
        )}
        {tab === 'network' && (
          <Panel title="Réseau, Art-Net, sACN, USB-DMX">
            <p className="muted" style={{ marginTop: 0 }}>La configuration détaillée des sorties (destinations, univers, interfaces, priorité sACN, port USB) se fait dans <button className="btn sm" onClick={() => useStore.getState().setPage('output')}>DMX Output</button>.</p>
            <table className="table small"><tbody>
              <tr><td>Sorties configurées</td><td>{s.outputs.map((o) => o.name).join(', ')}</td></tr>
              <tr><td>Identifiant sACN (CID)</td><td className="mono">{s.sacn?.cid ?? '—'}</td></tr>
              <tr><td>Armement au démarrage</td><td>Jamais : les sorties réelles démarrent désarmées à chaque lancement.</td></tr>
            </tbody></table>
          </Panel>
        )}
        {tab === 'ai' && (
          <Panel title="IA et fournisseurs">
            <div className="grid g2">
              <Field label="Fournisseur">
                <select className="select" value={s.ai.provider} data-testid="ai-provider" onChange={(e) => set('ai', { provider: e.target.value as Settings['ai']['provider'] })}>
                  <option value="local">Local déterministe (sans réseau)</option>
                  <option value="openrouter">OpenRouter (choix du modèle)</option>
                </select>
              </Field>
              <Field label="Délai maximal (s)"><NumberInput value={s.ai.timeoutSec} min={5} max={300} onChange={(v) => set('ai', { timeoutSec: v })} /></Field>
              <label className="check"><input type="checkbox" checked={s.ai.fallbackToLocal} onChange={(e) => set('ai', { fallbackToLocal: e.target.checked })} />Repli sur le mode local si le fournisseur est indisponible</label>
              <label className="check" title="Protection photosensible"><input type="checkbox" checked={s.ai.allowStrobe} onChange={(e) => set('ai', { allowStrobe: e.target.checked })} />Autoriser l’IA à proposer des effets strobe</label>
            </div>
            {s.ai.provider === 'openrouter' && (
              <div className="col" style={{ marginTop: 14 }}>
                <ModelPicker value={s.ai.model} onChange={(model) => set('ai', { model })} />
                <Field label="Effort de raisonnement" hint="Transmis uniquement aux modèles qui prennent en charge le raisonnement">
                  <select className="select" style={{ maxWidth: 260 }} value={s.ai.effort} onChange={(e) => set('ai', { effort: e.target.value as Settings['ai']['effort'] })}>
                    <option value="low">Faible (rapide)</option><option value="medium">Moyen</option><option value="high">Élevé</option>
                  </select>
                </Field>
                <Field label="Clé API OpenRouter" hint="Chiffrée par le système (safeStorage) dans le processus principal. Jamais renvoyée à l’interface, jamais écrite dans un projet.">
                  <div className="row">
                    <input className="input mono" type="password" autoComplete="off" placeholder={rt?.ai.hasKey ? '•••••••• (enregistrée)' : 'sk-or-v1-…'} value={key} onChange={(e) => setKey(e.target.value)} />
                    <button className="btn primary" disabled={key.trim().length < 10} onClick={() => void act({ type: 'ai.setKey', key: key.trim() }).then((r) => r && setKey(''))}><KeyRound size={13} />Enregistrer</button>
                    <button className="btn danger" disabled={!rt?.ai.hasKey} onClick={() => void act({ type: 'ai.setKey', key: null })}>Supprimer</button>
                  </div>
                </Field>
                <span className="small">État : {rt?.ai.hasKey ? <span className="badge ok">clé configurée</span> : <span className="badge warn">aucune clé — le mode local sera utilisé</span>}{rt?.ai.lastError ? <span className="badge err" style={{ marginLeft: 6 }}>{rt.ai.lastError}</span> : null}</span>
                <p className="small dim" style={{ margin: 0 }}>Les demandes sont envoyées à OpenRouter (openrouter.ai), qui les transmet au fournisseur du modèle choisi. Seuls la demande et une description du kit (noms, types, capacités, groupes, scènes) sont envoyés.</p>
              </div>
            )}
          </Panel>
        )}
        {tab === 'audio' && (
          <Panel title="Audio">
            <p className="muted" style={{ margin: 0 }}>Source, sensibilité, lissage et réactions se règlent dans <button className="btn sm" onClick={() => useStore.getState().setPage('audio')}>Audio Reactive</button>. Les réglages d’analyse sont enregistrés dans le projet.</p>
          </Panel>
        )}
        {tab === 'shortcuts' && (
          <Panel title="Raccourcis clavier" flush>
            <ShortcutEditor value={s.shortcuts} onChange={(shortcuts) => setS({ ...s, shortcuts })} />
          </Panel>
        )}
        {tab === 'control' && <ControlTab value={s.control} onChange={(control) => setS({ ...s, control })} />}
        {tab === 'logs' && (
          <Panel title="Logs et diagnostics">
            <div className="grid g2">
              <Field label="Niveau de journalisation">
                <select className="select" value={s.logs.level} onChange={(e) => set('logs', { level: e.target.value as Settings['logs']['level'] })}>
                  <option value="debug">Debug</option><option value="info">Info</option><option value="warn">Avertissements</option><option value="error">Erreurs</option>
                </select>
              </Field>
              <div className="row"><button className="btn" onClick={() => useStore.getState().toggleDiag()}>Ouvrir la console de diagnostic</button></div>
            </div>
          </Panel>
        )}
        {tab === 'backups' && (
          <Panel title="Sauvegardes et récupération">
            <p className="small muted" style={{ marginTop: 0 }}>Chaque enregistrement conserve la version précédente (.bak). La sauvegarde automatique écrit une copie de récupération séparée.</p>
            {recovery.length === 0 ? <p className="muted">Aucune copie de récupération.</p> : (
              <table className="table small"><tbody>
                {recovery.map((r) => (
                  <tr key={r.file}><td>{r.kind === 'backup' ? <span className="badge">.bak</span> : <span className="badge cyan">auto</span>}</td><td className="mono">{r.name}</td><td>{new Date(r.modifiedAt).toLocaleString()}</td>
                    <td><button className="btn sm" onClick={async () => (!project.dirty || (await confirmAction({ title: 'Ouvrir une copie de récupération', message: 'Le projet actuel contient des modifications non enregistrées. Continuer ?', confirmLabel: 'Ouvrir' }))) && void act({ type: 'project.openRecovery', file: r.file })}>Ouvrir</button></td></tr>
                ))}
              </tbody></table>
            )}
            <div className="row"><button className="btn" onClick={() => void act({ type: 'project.export' })}>Exporter une copie du projet…</button></div>
          </Panel>
        )}
      </div>
    </div>
  );
}
