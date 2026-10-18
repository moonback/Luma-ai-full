import { Bot, Cable, FilePlus, Lightbulb, Palette, SlidersHorizontal, AlertTriangle } from 'lucide-react';
import type { ReactNode } from 'react';
import { useStore } from '../store';
import { newProjectFlow } from '../App';
import { PageHead, Panel } from '../components/ui';
import { FirstSteps } from './Onboarding';

const SRC: Record<string, string> = { persisted: 'persisté', measured: 'mesuré', computed: 'calculé', simulated: 'simulé', config: 'configuré', estimate: 'estimé' };

function Kpi({ label, value, sub, src, icon }: { label: string; value: ReactNode; sub?: ReactNode; src: keyof typeof SRC; icon?: ReactNode }) {
  return (
    <div className="panel kpi">
      <span className="k">{icon}{label}<span className="grow" /><span className="tag-src" title="Origine de la donnée">{SRC[src]}</span></span>
      <span className="v">{value}</span>
      {sub && <span className="s">{sub}</span>}
    </div>
  );
}

export function Dashboard() {
  const ps = useStore((s) => s.project)!;
  const rt = useStore((s) => s.runtime);
  const setPage = useStore((s) => s.setPage);
  const p = ps.project;
  const outputs = rt?.outputs ?? [];
  const real = outputs.filter((o) => o.real);
  const protocols = [...new Set(outputs.filter((o) => o.enabled).map((o) => ({ virtual: 'Virtuelle', artnet: 'Art-Net', sacn: 'sACN', 'enttec-pro': 'USB-DMX', 'open-dmx': 'Open DMX' })[o.kind]))];
  const active = rt?.engine.playbacks.filter((pb) => pb.state !== 'idle') ?? [];
  const universesUsed = new Set(p.patch.map((f) => f.universe)).size;
  const m = rt?.engine.metrics;
  const audio = rt?.audio;

  return (
    <div className="page">
      <PageHead title="Dashboard" subtitle={`${p.meta.name}${p.meta.show ? ` — ${p.meta.show}` : ''}`} />
      <FirstSteps />
      <div className="grid g4" style={{ marginBottom: 12 }}>
        <Kpi label="Projecteurs" src="persisted" value={p.patch.length} sub={`${p.groups.length} groupe(s) · ${ps.issues.length ? `${ps.issues.length} problème(s) de patch` : 'patch valide'}`} icon={<Lightbulb size={13} />} />
        <Kpi label="Univers" src="persisted" value={p.show.universes} sub={`${universesUsed} utilisé(s) par le patch`} />
        <Kpi label="Sortie" src="measured" value={rt?.liveMode ? 'LIVE' : 'Simulation'} sub={real.length ? `${real.filter((o) => o.armed).length}/${real.length} sortie(s) réelle(s) armée(s)` : 'Aucune sortie réelle configurée'} icon={<Cable size={13} />} />
        <Kpi label="Protocoles" src="config" value={protocols.length ? protocols.join(' · ') : '—'} sub={`${outputs.filter((o) => o.state === 'error').length} en erreur`} />
        <Kpi label="Cue actif" src="computed" value={active[0]?.cueName ?? '—'} sub={active.length ? `${p.cueLists.find((l) => l.id === active[0]!.cueListId)?.name ?? ''} · ${Math.round(active[0]!.progress * 100)} %` : `${p.cueLists.reduce((n, l) => n + l.cues.length, 0)} cue(s) programmé(s)`} />
        <Kpi label="BPM" src={rt?.engine.bpmSource === 'audio' ? 'estimate' : 'persisted'} value={rt?.engine.bpm.toFixed(0) ?? '–'} sub={rt?.engine.bpmSource === 'audio' ? `Estimation audio (confiance ${Math.round((audio?.bpmConfidence ?? 0) * 100)} %)` : 'Défini manuellement / tap tempo'} />
        <Kpi label="Charge moteur" src="measured" value={m ? `${(m.load * 100).toFixed(1)} %` : '–'} sub={m ? `${m.measuredHz} Hz mesurés · tick ${m.avgTickMs} ms · ${m.overruns} dépassement(s)` : ''} />
        <Kpi label="Assistant IA" src="config" value={rt?.ai.provider === 'openrouter' ? (rt.ai.hasKey ? 'OpenRouter' : 'OpenRouter (sans clé)') : 'Local'} sub={rt?.ai.lastError ? `Dernière erreur : ${rt.ai.lastError}` : rt?.ai.provider === 'local' ? 'Règles et modèles déterministes' : rt?.ai.model} icon={<Bot size={13} />} />
      </div>
      <div className="grid g2">
        <Panel title="Actions rapides">
          <div className="grid g3">
            <button className="btn lg" onClick={() => newProjectFlow()}><FilePlus size={16} />Créer un projet</button>
            <button className="btn lg" onClick={() => setPage('fixtures')}><Lightbulb size={16} />Ajouter des projecteurs</button>
            <button className="btn lg" onClick={() => setPage('output')}><Cable size={16} />Configurer la sortie</button>
            <button className="btn lg" onClick={() => setPage('programmer')}><Palette size={16} />Créer une scène</button>
            <button className="btn lg primary" onClick={() => setPage('ai')}><Bot size={16} />Générer avec l’IA</button>
            <button className="btn lg" onClick={() => setPage('console')}><SlidersHorizontal size={16} />Console live</button>
          </div>
          {audio?.active && <p className="small muted" style={{ marginBottom: 0 }}>Source audio active : {audio.source === 'simulated' ? 'SIMULÉE (aucun micro)' : 'entrée réelle'}.</p>}
        </Panel>
        <Panel title="Alertes et erreurs récentes" actions={<button className="btn ghost sm" onClick={() => useStore.getState().toggleDiag()}>Tout voir</button>}>
          {rt?.alerts.length ? (
            <div className="col" style={{ gap: 6, maxHeight: 240, overflow: 'auto' }}>
              {[...rt.alerts].reverse().slice(0, 12).map((a) => (
                <div key={a.id} className="row small" style={{ alignItems: 'flex-start' }}>
                  <AlertTriangle size={13} color={a.level === 'error' ? '#ef4444' : '#f59e0b'} style={{ flex: 'none', marginTop: 2 }} />
                  <span className="dim mono">{a.t.slice(11, 19)}</span>
                  <span>{a.message}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>Aucune alerte. Les erreurs réseau, déconnexions et refus de sécurité apparaissent ici.</p>
          )}
          {ps.issues.length > 0 && (
            <div className="col small" style={{ marginTop: 10 }}>
              {ps.issues.slice(0, 5).map((i, k) => <span key={k} className="badge err" style={{ height: 'auto', padding: '3px 8px', whiteSpace: 'normal' }}>{i.message}</span>)}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
