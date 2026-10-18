import { useState } from 'react';
import { Bot, Check, Eye, RotateCcw, Send, Wand2, X } from 'lucide-react';
import { useStore } from '../store';
import { act } from '../api';
import { PageHead, Panel, useResolved } from '../components/ui';
import type { AiExecutionReport, AiProposal } from '../../core/ai/actions';
import { StageCanvas } from './Visualizer';

const EXAMPLES = [
  'Crée une ambiance lounge violette et bleue.',
  'Fais monter progressivement l’intensité sur huit secondes.',
  'Crée un chase sur les quatre lyres.',
  'Prépare un drop énergique pour le refrain.',
  'Génère un show de deux minutes pour de la musique électronique.',
  'Rends l’ambiance plus chaude et moins agressive.',
  'Fais des mouvements synchronisés au BPM.',
  'Crée trois variantes de cette scène.',
];

interface Exchange {
  prompt: string;
  proposal: AiProposal;
  excluded: Set<number>;
  report?: AiExecutionReport;
}

function ActionCard({ ex, i, onToggle, onEdit }: { ex: Exchange; i: number; onToggle: () => void; onEdit: (raw: unknown) => void }) {
  const v = ex.proposal.actions[i]!;
  const { byId } = useResolved();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(JSON.stringify(v.action ?? v.raw, null, 2));
  const excluded = ex.excluded.has(i);
  return (
    <div className={`action-card ${v.status} ${excluded ? 'excluded' : ''}`}>
      <div className="row">
        <input type="checkbox" checked={!excluded && v.status !== 'rejected'} disabled={v.status === 'rejected' || !!ex.report} onChange={onToggle} title="Inclure / exclure cette action" />
        <b className="grow">{v.summary}</b>
        <span className={`badge ${v.status === 'ok' ? 'ok' : v.status === 'warning' ? 'warn' : 'err'}`}>{v.status === 'ok' ? 'valide' : v.status === 'warning' ? 'avertissement' : 'refusée'}</span>
        {!ex.report && <button className="btn ghost sm" onClick={() => setEditing(!editing)}>Modifier</button>}
      </div>
      {v.fixtureIds.length > 0 && <div className="small muted" style={{ marginTop: 4 }}>Cibles : {v.fixtureIds.slice(0, 10).map((id) => byId.get(id)?.fixture.name ?? id).join(', ')}{v.fixtureIds.length > 10 ? ` (+${v.fixtureIds.length - 10})` : ''}</div>}
      {v.messages.map((m, k) => <div key={k} className="small" style={{ color: v.status === 'rejected' ? '#fca5a5' : '#f59e0b' }}>• {m}</div>)}
      {editing && (
        <div className="col" style={{ marginTop: 6 }}>
          <textarea className="textarea" rows={8} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
          <div className="row">
            <button className="btn sm primary" onClick={() => { try { onEdit(JSON.parse(text)); setEditing(false); } catch { useStore.getState().toast({ kind: 'error', title: 'JSON invalide' }); } }}>Revalider</button>
            <span className="small dim">L’action modifiée est revalidée par le moteur avant toute exécution.</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ProposalView({ ex, onChange }: { ex: Exchange; onChange: (e: Exchange) => void }) {
  const preview = useStore((s) => s.preview);
  const setPreview = useStore((s) => s.setPreview);
  const p = ex.proposal;
  const runnable = p.actions.filter((a, i) => a.status !== 'rejected' && !ex.excluded.has(i));
  const showingPreview = preview?.label === p.id;
  const revise = async (actions: unknown[]) => {
    const np = await act({ type: 'ai.revise', proposalId: p.id, actions });
    if (np) onChange({ ...ex, proposal: np, excluded: new Set() });
  };
  const apply = async () => {
    let target = p;
    if (ex.excluded.size) {
      const np = await act({ type: 'ai.revise', proposalId: p.id, actions: p.actions.filter((_, i) => !ex.excluded.has(i)).map((a) => a.action ?? a.raw) });
      if (!np) return;
      target = np;
    }
    const report = await act({ type: 'ai.apply', proposalId: target.id });
    if (report) {
      setPreview(null);
      onChange({ ...ex, proposal: target, report });
      useStore.getState().toast({ kind: report.skipped.length ? 'warn' : 'success', title: `${report.executed.length} action(s) exécutée(s)`, detail: report.skipped.length ? `${report.skipped.length} ignorée(s)` : undefined });
    }
  };
  return (
    <div className="bubble col" data-testid="proposal">
      <div className="row">
        <Bot size={16} />
        {p.provider === 'local' ? <span className="badge cyan" title="Règles et modèles déterministes — aucun modèle de langage n’est utilisé">Mode local déterministe</span> : <span className="badge violet">OpenRouter · {p.model}</span>}
        <span className="grow" />
        <span className="small dim">{new Date(p.createdAt).toLocaleTimeString()}</span>
      </div>
      <div><b>Compréhension :</b> {p.understanding}</div>
      {p.notices.map((n, i) => <div key={i} className="small" style={{ color: '#f59e0b' }}>⚠ {n}</div>)}
      {p.actions.length > 0 && (
        <>
          <div className="col" style={{ gap: 6 }}>
            {p.actions.map((_, i) => (
              <ActionCard key={`${p.id}-${i}`} ex={ex} i={i}
                onToggle={() => { const s = new Set(ex.excluded); if (s.has(i)) s.delete(i); else s.add(i); onChange({ ...ex, excluded: s }); }}
                onEdit={(raw) => void revise(p.actions.map((a, k) => (k === i ? raw : a.action ?? a.raw)))} />
            ))}
          </div>
          {!ex.report ? (
            <div className="row">
              <button className="btn" disabled={!Object.keys(p.preview).length} onClick={() => setPreview(showingPreview ? null : { label: p.id, values: p.preview })} title="Affiche l’état cible dans le visualiseur, sans rien envoyer aux sorties"><Eye size={14} />{showingPreview ? 'Masquer l’aperçu' : 'Prévisualiser'}</button>
              <button className="btn primary" data-testid="ai-apply" disabled={!runnable.length} onClick={() => void apply()}><Check size={14} />Appliquer {runnable.length} action(s)</button>
              <span className="small dim">Rien n’est exécuté avant votre confirmation.</span>
            </div>
          ) : (
            <div className="col small" data-testid="ai-report">
              <b>Rapport d’exécution</b>
              {ex.report.executed.map((e) => <div key={e.index} style={{ color: '#34d399' }}>✓ {e.summary} — {e.detail}</div>)}
              {ex.report.skipped.map((e) => <div key={e.index} style={{ color: '#fca5a5' }}>✗ {e.summary} — {e.reason}</div>)}
              {ex.report.verification.checked > 0 && (
                <div className="muted">
                  Vérification de l’état calculé : {ex.report.verification.matched}/{ex.report.verification.checked} valeurs contrôlées par l’IA
                  {ex.report.verification.overriddenByManual ? ` · ${ex.report.verification.overriddenByManual} masquée(s) par le contrôle manuel (prioritaire)` : ''}
                  {ex.report.verification.mismatches.length ? ` · ${ex.report.verification.mismatches.slice(0, 3).join(' ; ')}` : ''}
                  . La transmission effective est visible dans DMX Output.
                </div>
              )}
              {(ex.report.created.scenes.length > 0 || ex.report.created.cueLists.length > 0) && <div className="muted">Créé : {[...ex.report.created.scenes.map((s) => `scène « ${s} »`), ...ex.report.created.cueLists.map((s) => `liste « ${s} »`)].join(', ')}</div>}
            </div>
          )}
        </>
      )}
      {showingPreview && <div style={{ height: 260 }}><StageCanvas values={p.preview} compact /></div>}
    </div>
  );
}

export function AiDirector() {
  const rt = useStore((s) => s.runtime);
  const [prompt, setPrompt] = useState('');
  const [history, setHistory] = useState<Exchange[]>([]);
  const busy = rt?.ai.busy ?? false;
  const send = async (text = prompt) => {
    if (!text.trim() || busy) return;
    setPrompt('');
    const proposal = await act({ type: 'ai.propose', prompt: text.trim() });
    if (proposal) setHistory((h) => [...h, { prompt: text.trim(), proposal, excluded: new Set() }]);
  };
  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column' }}>
      <PageHead title="AI Lighting Director" subtitle={rt?.ai.provider === 'openrouter' && rt.ai.hasKey ? `Fournisseur : OpenRouter (${rt.ai.model}) — repli local si indisponible` : 'Mode local déterministe : règles et modèles intégrés, sans modèle de langage (configurable dans Paramètres › IA)'}>
        <button className="btn" onClick={() => void act({ type: 'ai.release' })} disabled={!rt?.engine.aiActive && !rt?.engine.effects.some((e) => e.owner === 'ai')} title="Retire la couche IA et arrête les effets lancés par l’IA"><RotateCcw size={14} />Relâcher l’IA</button>
      </PageHead>
      <div className="split" style={{ flex: 1, minHeight: 0 }}>
        <div className="col" style={{ minHeight: 0 }}>
          <div className="chat" style={{ flex: 1, overflow: 'auto', paddingRight: 4 }}>
            {history.length === 0 && (
              <Panel title="Exemples de demandes">
                <div className="chips">{EXAMPLES.map((e) => <button key={e} className="chip" onClick={() => void send(e)}><Wand2 size={11} /> {e}</button>)}</div>
                <p className="small muted" style={{ marginBottom: 0 }}>L’assistant produit uniquement des actions structurées (intensité, couleur, position, effets, scènes, cues, séquences). Elles sont validées contre le patch et les capacités des profils, prévisualisées, puis exécutées par le moteur après votre confirmation. Le contrôle manuel reste prioritaire.</p>
              </Panel>
            )}
            {history.map((ex, i) => (
              <div key={ex.proposal.id + i} className="col">
                <div className="bubble user">{ex.prompt}</div>
                <ProposalView ex={ex} onChange={(n) => setHistory((h) => h.map((x, k) => (k === i ? n : x)))} />
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <input className="input" style={{ height: 40 }} data-testid="ai-prompt" placeholder="Décrivez l’ambiance ou l’action souhaitée…" value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void send()} disabled={busy} />
            <button className="btn primary lg" data-testid="ai-send" onClick={() => void send()} disabled={busy || !prompt.trim()}><Send size={15} />{busy ? 'Analyse…' : 'Envoyer'}</button>
            {history.length > 0 && <button className="btn ghost lg icon" title="Effacer la conversation" onClick={() => setHistory([])}><X size={15} /></button>}
          </div>
        </div>
        <Panel title="Scène en direct">
          <div style={{ height: 300 }}><StageCanvas compact /></div>
          <p className="small dim" style={{ marginBottom: 0 }}>Représentation approximative de l’état calculé (non photométrique).</p>
        </Panel>
      </div>
    </div>
  );
}
