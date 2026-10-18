import { useEffect, useState } from 'react';
import { Plug, Plus, RefreshCw, Trash2, Unplug, Usb, Zap } from 'lucide-react';
import { useStore, confirmAction } from '../store';
import { act, call, newId } from '../api';
import { Field, NumberInput, PageHead, Panel, Tabs } from '../components/ui';
import { outputConfigSchema, type OutputConfig, type OutputKind } from '../../core/protocols/config';
import type { UniverseView } from '../../shared/commands';
import type { ChannelChange } from '../../core/protocols/virtual';
import type { SerialPortInfo } from '../../core/protocols/enttec';
import type { RdmDevice } from '../../core/protocols/rdm';

const KIND_LABEL: Record<OutputKind, string> = { virtual: 'Virtuelle', artnet: 'Art-Net', sacn: 'sACN / E1.31', 'enttec-pro': 'USB-DMX (Enttec Pro)', 'open-dmx': 'USB-DMX (Open DMX / FTDI)' };

function defaults(kind: OutputKind): OutputConfig {
  const base = { id: newId(), enabled: true, maxFps: 40 };
  switch (kind) {
    case 'virtual': return { ...base, kind, name: 'Sortie virtuelle', universes: [1] };
    case 'artnet': return { ...base, kind, name: 'Art-Net', host: '2.255.255.255', bindAddress: '', broadcast: true, universeMap: [{ local: 1, remote: 0 }] };
    case 'sacn': return { ...base, kind, name: 'sACN', mode: 'multicast', host: '', bindAddress: '', priority: 100, universeMap: [{ local: 1, remote: 1 }] };
    case 'enttec-pro': return { ...base, kind, name: 'Enttec DMX USB Pro', path: '', universe: 1 };
    case 'open-dmx': return { ...base, kind, name: 'Open DMX USB', maxFps: 30, path: '', universe: 1 };
  }
}

function OutputForm({ cfg, interfaces, ports, onSave, onCancel }: { cfg: OutputConfig; interfaces: string[]; ports: SerialPortInfo[]; onSave: (c: OutputConfig) => void; onCancel: () => void }) {
  const [d, setD] = useState<OutputConfig>(cfg);
  const parsed = outputConfigSchema.safeParse(d);
  const err = (path: string) => (parsed.success ? null : parsed.error.issues.find((i) => i.path.join('.').startsWith(path))?.message ?? null);
  const set = (patch: Partial<OutputConfig>) => setD({ ...d, ...patch } as OutputConfig);
  const map = d.kind === 'artnet' || d.kind === 'sacn' ? d.universeMap : null;
  return (
    <div className="col">
      <div className="grid g3">
        <Field label="Nom" error={err('name')}><input className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Images/s max" hint="DMX512 plafonne vers 44 Hz"><NumberInput value={d.maxFps} min={1} max={44} onChange={(v) => set({ maxFps: v })} /></Field>
        <label className="check"><input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />Activée</label>
        {d.kind === 'virtual' && <Field label="Univers simulés" hint="ex : 1, 2, 3"><input className="input mono" defaultValue={d.universes.join(', ')} onBlur={(e) => set({ universes: e.target.value.split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 64) })} /></Field>}
        {(d.kind === 'artnet' || d.kind === 'sacn') && (
          <Field label="Interface réseau" hint="Adresse locale d’émission">
            <select className="select" value={d.bindAddress} onChange={(e) => set({ bindAddress: e.target.value })}>
              <option value="">Automatique</option>
              {interfaces.map((i) => <option key={i}>{i}</option>)}
            </select>
          </Field>
        )}
        {d.kind === 'artnet' && <>
          <Field label="Destination (IPv4)" error={err('host')} hint="Nœud Art-Net ou broadcast (ex : 2.255.255.255)"><input className="input mono" value={d.host} onChange={(e) => set({ host: e.target.value.trim() })} /></Field>
          <label className="check"><input type="checkbox" checked={d.broadcast} onChange={(e) => set({ broadcast: e.target.checked })} />Autoriser le broadcast</label>
        </>}
        {d.kind === 'sacn' && <>
          <Field label="Mode">
            <select className="select" value={d.mode} onChange={(e) => set({ mode: e.target.value as 'multicast' | 'unicast' })}><option value="multicast">Multicast (239.255.x.y)</option><option value="unicast">Unicast</option></select>
          </Field>
          {d.mode === 'unicast' && <Field label="Destination (IPv4)" error={err('host')}><input className="input mono" value={d.host} onChange={(e) => set({ host: e.target.value.trim() })} /></Field>}
          <Field label="Priorité du flux (0–200)" hint="Défaut 100 ; le récepteur suit la source de plus haute priorité"><NumberInput value={d.priority} min={0} max={200} onChange={(v) => set({ priority: v })} /></Field>
        </>}
        {(d.kind === 'enttec-pro' || d.kind === 'open-dmx') && <>
          <Field label="Port série" error={err('path')} hint="FTDI détecté ≠ Enttec confirmé">
            <select className="select" value={d.path} onChange={(e) => set({ path: e.target.value })}>
              <option value="">— choisir —</option>
              {ports.map((p) => <option key={p.path} value={p.path}>{p.path} {p.manufacturer ?? ''}{p.ftdi ? ' (FTDI)' : ''}</option>)}
            </select>
          </Field>
          <Field label="Univers local"><NumberInput value={d.universe} min={1} max={64} onChange={(v) => set({ universe: v })} /></Field>
        </>}
      </div>
      {map && (
        <Field label={`Correspondance des univers (local → ${d.kind === 'artnet' ? 'Port-Address 0–32767' : 'univers sACN 1–63999'})`} error={err('universeMap')}>
          <div className="col" style={{ gap: 4 }}>
            {map.map((m, i) => (
              <div key={i} className="row">
                <span className="small muted">Local</span><div style={{ width: 70 }}><NumberInput value={m.local} min={1} max={64} onChange={(v) => set({ universeMap: map.map((x, k) => (k === i ? { ...x, local: v } : x)) } as Partial<OutputConfig>)} /></div>
                <span className="small muted">→</span><div style={{ width: 90 }}><NumberInput value={m.remote} min={d.kind === 'artnet' ? 0 : 1} max={d.kind === 'artnet' ? 32767 : 63999} onChange={(v) => set({ universeMap: map.map((x, k) => (k === i ? { ...x, remote: v } : x)) } as Partial<OutputConfig>)} /></div>
                <button className="btn ghost sm icon" disabled={map.length === 1} onClick={() => set({ universeMap: map.filter((_, k) => k !== i) } as Partial<OutputConfig>)}><Trash2 size={12} /></button>
              </div>
            ))}
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => set({ universeMap: [...map, { local: map.length + 1, remote: d.kind === 'artnet' ? map.length : map.length + 1 }] } as Partial<OutputConfig>)}><Plus size={12} />Univers</button>
          </div>
        </Field>
      )}
      <div className="row">
        <button className="btn primary" disabled={!parsed.success} onClick={() => parsed.success && onSave(parsed.data)}>Enregistrer</button>
        <button className="btn" onClick={onCancel}>Annuler</button>
        {!parsed.success && <span className="small" style={{ color: '#fca5a5' }}>Configuration invalide : {parsed.error.issues[0]?.message}</span>}
      </div>
    </div>
  );
}

function Monitor() {
  const universes = useStore((s) => s.project!.project.show.universes);
  const [u, setU] = useState(1);
  const [view, setView] = useState<UniverseView | null>(null);
  const [src, setSrc] = useState<string>('computed');
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const v = await call({ type: 'output.universe', universe: u });
        if (alive) setView(v);
      } catch { /* toast already shown */ }
    };
    void tick();
    const t = setInterval(() => void tick(), 150);
    return () => { alive = false; clearInterval(t); };
  }, [u]);
  const tx = view?.transmitted.find((t) => t.outputId === src);
  const data = src === 'computed' ? view?.computed : tx?.data;
  return (
    <Panel title="Moniteur DMX — 512 canaux" actions={<>
      <select className="select" style={{ width: 110 }} value={u} onChange={(e) => setU(Number(e.target.value))}>{Array.from({ length: universes }, (_, i) => <option key={i} value={i + 1}>Univers {i + 1}</option>)}</select>
      <select className="select" style={{ width: 230 }} value={src} onChange={(e) => setSrc(e.target.value)} data-testid="monitor-source">
        <option value="computed">État calculé par le moteur</option>
        {view?.transmitted.map((t) => <option key={t.outputId} value={t.outputId}>Transmis : {t.outputName}</option>)}
      </select>
    </>}>
      {src !== 'computed' && !tx && <p className="small" style={{ color: '#f59e0b' }}>Aucune trame transmise par cette sortie pour cet univers.</p>}
      {tx && <p className="small dim">Dernière trame remise au transport à {new Date(tx.at).toLocaleTimeString()} — les cases orange diffèrent de l’état calculé. Une trame transmise ne prouve pas la réception par le projecteur.</p>}
      <div className="dmx-grid" data-testid="dmx-grid">
        {Array.from({ length: 512 }, (_, i) => {
          const v = data?.[i] ?? 0;
          const diff = src !== 'computed' && view && view.computed[i] !== v;
          return (
            <div key={i} className={`dmx-cell ${diff ? 'diff' : ''}`} title={`Canal ${i + 1} = ${v}`} data-ch={i + 1} data-v={v}>
              <div className="bar" style={{ height: `${(v / 255) * 100}%` }} />
              <span className="ch">{i + 1}</span><span>{v}</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function History() {
  const [rows, setRows] = useState<ChannelChange[]>([]);
  const refresh = async () => setRows((await act({ type: 'output.virtualHistory', limit: 200 })) ?? []);
  useEffect(() => { void refresh(); }, []);
  return (
    <Panel title="Historique de la sortie virtuelle" actions={<button className="btn sm" onClick={() => void refresh()}><RefreshCw size={12} />Actualiser</button>}>
      {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>Aucun changement enregistré.</p> : (
        <div style={{ maxHeight: 360, overflow: 'auto' }}>
          <table className="table small mono">
            <thead><tr><th>Heure</th><th>Univ.</th><th>Canal</th><th>Avant</th><th>Après</th></tr></thead>
            <tbody>{[...rows].reverse().map((r, i) => <tr key={i}><td>{new Date(r.t).toLocaleTimeString()}.{String(r.t % 1000).padStart(3, '0')}</td><td>{r.universe}</td><td>{r.channel}</td><td>{r.from}</td><td>{r.to}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function Rdm({ outputs }: { outputs: OutputConfig[] }) {
  const artnet = outputs.filter((o): o is Extract<OutputConfig, { kind: 'artnet' }> => o.kind === 'artnet');
  const [target, setTarget] = useState(artnet[0] ? `${artnet[0].id}|${artnet[0].universeMap[0]?.local ?? 1}` : '');
  const [devices, setDevices] = useState<RdmDevice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [identified, setIdentified] = useState<string | null>(null);
  const [outputId = '', u = '1'] = target.split('|');
  const universe = Number(u);
  const discover = async () => {
    setBusy(true);
    const r = await act({ type: 'rdm.discover', outputId, universe });
    setBusy(false);
    if (r) setDevices(r.devices);
  };
  const identify = async (uid: string) => {
    const on = identified !== uid;
    if (identified && on) await act({ type: 'rdm.identify', outputId, universe, uid: identified, on: false });
    if (await act({ type: 'rdm.identify', outputId, universe, uid, on })) setIdentified(on ? uid : null);
  };
  const readdress = async (d: RdmDevice) => {
    const v = window.prompt(`Nouvelle adresse DMX pour ${d.model ?? d.uid} (1–512)`, String(d.startAddress ?? 1));
    const address = Number(v);
    if (!v || !Number.isInteger(address) || address < 1 || address > 512) return;
    if (!(await confirmAction({ title: 'Changer l’adresse DMX', message: `L’appareil ${d.uid} passera à l’adresse ${address}. Le patch du projet n’est pas modifié : mettez-le à jour pour qu’il corresponde.`, confirmLabel: 'Changer l’adresse' }))) return;
    if (await act({ type: 'rdm.setAddress', outputId, universe, uid: d.uid, address, confirmed: true })) await discover();
  };
  if (!artnet.length) return <Panel title="RDM"><p className="muted" style={{ margin: 0 }}>Ajoutez une sortie Art-Net : le RDM passe par le nœud (découverte et requêtes ArtRdm). Le RDM via Enttec n’est pas encore pris en charge.</p></Panel>;
  return (
    <Panel title="RDM — découverte et état des appareils" actions={
      <div className="row">
        <select className="select" value={target} onChange={(e) => { setTarget(e.target.value); setDevices(null); }}>
          {artnet.flatMap((o) => o.universeMap.map((m) => <option key={`${o.id}|${m.local}`} value={`${o.id}|${m.local}`}>{o.name} · univers {m.local} → Port-Address {m.remote}</option>))}
        </select>
        <button className="btn primary" disabled={busy} onClick={() => void discover()} data-testid="rdm-discover"><RefreshCw size={13} />{busy ? 'Découverte…' : 'Découvrir'}</button>
      </div>
    } flush>
      {devices === null ? <p className="small dim" style={{ padding: 12, margin: 0 }}>La découverte interroge le nœud Art-Net (table des appareils) puis lit chaque appareil. Le port UDP 6454 doit être libre sur cette machine pour recevoir les réponses.</p>
        : devices.length === 0 ? <p className="small muted" style={{ padding: 12, margin: 0 }}>Aucun appareil RDM signalé par le nœud.</p> : (
        <table className="table small"><thead><tr><th>UID</th><th>Appareil</th><th>Adresse</th><th>Canaux</th><th>Mode</th><th>Heures</th><th>Capteurs</th><th /></tr></thead><tbody>
          {devices.map((d) => (
            <tr key={d.uid} title={d.errors.join('\n')}>
              <td className="mono">{d.uid}</td>
              <td>{[d.manufacturer, d.model].filter(Boolean).join(' ') || <span className="dim">inconnu</span>}{d.label ? <div className="dim">{d.label}</div> : null}</td>
              <td className="mono">{d.startAddress ?? '—'}</td><td className="mono">{d.footprint ?? '—'}</td><td className="mono">{d.personality ?? '—'}</td>
              <td className="mono">{d.deviceHours ?? '—'}{d.lampHours !== null ? ` · lampe ${d.lampHours}` : ''}</td>
              <td>{d.sensors.map((s) => `${s.name} ${s.value} ${s.unit}`).join(' · ') || '—'}{d.errors.length ? <span className="badge warn" style={{ marginLeft: 6 }}>{d.errors.length} lecture(s) en échec</span> : null}</td>
              <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                <button className={`btn sm ${identified === d.uid ? 'on' : ''}`} onClick={() => void identify(d.uid)}>Identify</button>
                <button className="btn sm" onClick={() => void readdress(d)}>Adresse…</button>
              </td>
            </tr>
          ))}
        </tbody></table>
      )}
    </Panel>
  );
}

export function OutputPage() {
  const rt = useStore((s) => s.runtime);
  const [settingsOutputs, setOutputs] = useState<OutputConfig[]>([]);
  const [editing, setEditing] = useState<OutputConfig | null>(null);
  const [interfaces, setInterfaces] = useState<string[]>([]);
  const [ports, setPorts] = useState<{ ports: SerialPortInfo[]; error: string | null }>({ ports: [], error: null });
  const [tab, setTab] = useState<'outputs' | 'monitor' | 'history' | 'rdm' | 'diag'>('outputs');
  const load = async () => {
    const s = await act({ type: 'settings.get' });
    if (s) setOutputs(s.outputs);
  };
  useEffect(() => {
    void load();
    void act({ type: 'output.interfaces' }).then((x) => setInterfaces(x ?? []));
    void act({ type: 'output.listSerial' }).then((x) => x && setPorts(x));
  }, []);
  const saveAll = async (list: OutputConfig[]) => {
    if (await act({ type: 'output.configure', outputs: list })) { setOutputs(list); setEditing(null); }
  };
  const arm = async (id: string, name: string) => {
    if (await confirmAction({ title: 'Armer une sortie réelle', message: `« ${name} » va émettre les valeurs DMX vers le matériel ou le réseau.\nVérifiez que personne n’est exposé aux projecteurs (strobe, mouvements) avant de continuer.`, confirmLabel: 'Armer la sortie' })) {
      await act({ type: 'output.arm', id, confirmed: true });
    }
  };
  const status = rt?.outputs ?? [];
  const m = rt?.engine.metrics;
  return (
    <div className="page">
      <PageHead title="DMX Output" subtitle="Sorties Art-Net, sACN, USB-DMX et virtuelle. Les sorties réelles démarrent toujours désarmées.">
        {rt?.transmitting ? <span className="badge ok">Émission active</span> : <><span className="badge err">STOP — émissions réelles arrêtées</span><button className="btn accent" onClick={() => void act({ type: 'output.transmit', on: true })}>Reprendre</button></>}
      </PageHead>
      <Tabs tabs={[{ id: 'outputs', label: 'Sorties' }, { id: 'monitor', label: 'Moniteur 512 canaux' }, { id: 'history', label: 'Historique virtuel' }, { id: 'rdm', label: 'RDM' }, { id: 'diag', label: 'Diagnostics' }] as const} value={tab} onChange={setTab} />
      {tab === 'outputs' && (
        <div className="col gap-lg">
          <Panel title="Sorties configurées" flush actions={<div className="row">{(['virtual', 'artnet', 'sacn', 'enttec-pro', 'open-dmx'] as const).map((k) => <button key={k} className="btn sm" onClick={() => setEditing(defaults(k))}><Plus size={12} />{KIND_LABEL[k]}</button>)}</div>}>
            <table className="table">
              <thead><tr><th>Sortie</th><th>Type</th><th>État</th><th>Statistiques (mesurées)</th><th /></tr></thead>
              <tbody>
                {settingsOutputs.map((c) => {
                  const s = status.find((x) => x.id === c.id);
                  const real = c.kind !== 'virtual';
                  return (
                    <tr key={c.id} data-testid={`output-${c.kind}`}>
                      <td><b>{c.name}</b><div className="small dim">{c.kind === 'artnet' ? `→ ${c.host}` : c.kind === 'sacn' ? (c.mode === 'unicast' ? `→ ${c.host}` : 'multicast') : c.kind === 'enttec-pro' || c.kind === 'open-dmx' ? c.path || 'port non choisi' : `univers ${c.universes.join(', ')}`}</div></td>
                      <td>{KIND_LABEL[c.kind]} {real ? <span className="badge warn">réelle</span> : <span className="badge">simulée</span>}</td>
                      <td>
                        <span className="row"><span className={`led ${s?.state === 'ready' ? 'ok' : s?.state === 'error' ? 'err' : s?.state === 'connecting' ? 'warn' : ''}`} />{s ? ({ ready: 'Prête', error: 'Erreur', connecting: 'Connexion…', disarmed: 'Désarmée', disabled: 'Désactivée' })[s.state] : '–'}</span>
                        {s?.detail && s.state !== 'ready' && <div className="small" style={{ color: s.state === 'error' ? '#fca5a5' : undefined }}>{s.detail}</div>}
                      </td>
                      <td className="small mono">{s ? `${s.stats.measuredFps} fps · ${s.stats.packetsSent} paquets · ${s.stats.errors} erreur(s)` : ''}{s?.stats.lastError && <div className="dim" style={{ whiteSpace: 'normal' }}>Dernière erreur : {s.stats.lastError}</div>}</td>
                      <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                        {real && (s?.armed ? <button className="btn sm" onClick={() => void act({ type: 'output.disarm', id: c.id })}><Unplug size={12} />Désarmer</button> : <button className="btn sm danger" disabled={!c.enabled} onClick={() => void arm(c.id, c.name)} data-testid="arm"><Plug size={12} />Armer</button>)}
                        <button className="btn ghost sm" onClick={() => setEditing(c)}>Modifier</button>
                        <button className="btn ghost sm icon" onClick={async () => (await confirmAction({ title: 'Supprimer la sortie', message: `Supprimer « ${c.name} » ?`, confirmLabel: 'Supprimer' })) && void saveAll(settingsOutputs.filter((x) => x.id !== c.id))}><Trash2 size={12} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
          {editing && (
            <Panel title={`${settingsOutputs.some((x) => x.id === editing.id) ? 'Modifier' : 'Nouvelle sortie'} — ${KIND_LABEL[editing.kind]}`}>
              <OutputForm key={editing.id} cfg={editing} interfaces={interfaces} ports={ports.ports} onCancel={() => setEditing(null)} onSave={(c) => void saveAll(settingsOutputs.some((x) => x.id === c.id) ? settingsOutputs.map((x) => (x.id === c.id ? c : x)) : [...settingsOutputs, c])} />
            </Panel>
          )}
          <Panel title="Interfaces USB-DMX détectées" actions={<button className="btn sm" onClick={() => void act({ type: 'output.listSerial' }).then((x) => x && setPorts(x))}><Usb size={12} />Rechercher</button>}>
            {ports.error ? <p className="small" style={{ color: '#f59e0b', margin: 0 }}>{ports.error}</p> : ports.ports.length === 0 ? <p className="muted" style={{ margin: 0 }}>Aucun port série détecté.</p> : (
              <table className="table small"><tbody>{ports.ports.map((p) => <tr key={p.path}><td className="mono">{p.path}</td><td>{p.manufacturer ?? '—'}</td><td>{p.ftdi ? <span className="badge cyan">puce FTDI (compatible Enttec possible)</span> : <span className="badge">autre</span>}</td></tr>)}</tbody></table>
            )}
            <p className="small dim" style={{ marginBottom: 0 }}>Pilotes implémentés : Enttec DMX USB Pro (protocole « label 6 ») et interfaces « Open DMX » FTDI sans microcontrôleur (break généré par le logiciel, 250 kbaud 8N2, cadence conseillée ≤ 30 i/s). Non vérifiés sur matériel dans ce dépôt ; le timing Open DMX dépend du système et du pilote FTDI.</p>
          </Panel>
        </div>
      )}
      {tab === 'monitor' && <Monitor />}
      {tab === 'history' && <History />}
      {tab === 'rdm' && <Rdm outputs={settingsOutputs} />}
      {tab === 'diag' && (
        <div className="grid g2">
          <Panel title="Moteur (mesuré)">
            <table className="table small"><tbody>
              <tr><td>Fréquence configurée</td><td className="mono">{m?.rateHz} Hz</td></tr>
              <tr><td>Fréquence mesurée</td><td className="mono">{m?.measuredHz} Hz</td></tr>
              <tr><td>Durée moyenne d’un tick</td><td className="mono">{m?.avgTickMs} ms</td></tr>
              <tr><td>Durée max (dernière seconde)</td><td className="mono">{m?.maxTickMs} ms</td></tr>
              <tr><td>Gigue moyenne de l’ordonnanceur</td><td className="mono">{m?.jitterMs} ms</td></tr>
              <tr><td>Dépassements de période</td><td className="mono">{m?.overruns}</td></tr>
              <tr><td>Ticks</td><td className="mono">{m?.ticks}</td></tr>
            </tbody></table>
            <p className="small dim" style={{ marginBottom: 0 }}>Ces valeurs sont mesurées dans le processus principal ; elles n’incluent pas la latence réseau ni celle des interfaces.</p>
          </Panel>
          <Panel title="Tests de défaillance (sortie virtuelle)">
            <div className="row wrap">
              <button className="btn" onClick={() => void act({ type: 'output.inject', injection: { type: 'fail-next', count: 5 } })}><Zap size={13} />5 erreurs d’envoi</button>
              <button className="btn danger" onClick={() => void act({ type: 'output.inject', injection: { type: 'disconnect' } })}><Unplug size={13} />Simuler une déconnexion</button>
              <button className="btn" onClick={() => void act({ type: 'output.inject', injection: { type: 'reconnect' } })}><Plug size={13} />Reconnecter</button>
            </div>
            <p className="small dim" style={{ marginBottom: 0 }}>En cas d’erreur, une sortie passe à l’état Erreur, l’alerte est journalisée et une reconnexion est tentée avec un délai croissant (1 s → 10 s max).</p>
          </Panel>
        </div>
      )}
    </div>
  );
}
