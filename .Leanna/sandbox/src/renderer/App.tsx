import { useEffect, useRef, useState, type ComponentType } from 'react';
import {
  Activity, AudioLines, Bell, Bot, Box, Cable, ChartGantt, FilePlus, FolderOpen, LayoutDashboard, Lightbulb, ListOrdered, OctagonX, Palette,
  Music2, PanelLeftClose, PanelLeftOpen, Save, Settings as SettingsIcon, SlidersHorizontal, Sparkles, Terminal, Theater, X, Moon, Play,
} from 'lucide-react';
import { BRAND } from '../shared/brand';
import { PAGES, useStore, confirmAction, type PageId } from './store';
import { act, call } from './api';
import { ConfirmHost, Modal, Field } from './components/ui';
import { allowedWhileTyping, bindingsFrom, comboFromEvent } from './shortcuts';
import { resolveShortcuts, type ShortcutAction } from '../core/settings/settings';
import { Dashboard } from './features/Dashboard';
import { Fixtures } from './features/Fixtures';
import { LiveConsole } from './features/LiveConsole';
import { Programmer } from './features/Programmer';
import { Cues } from './features/Cues';
import { Effects } from './features/Effects';
import { TimelinePage } from './features/Timeline';
import { AiDirector } from './features/AiDirector';
import { StageVisualizer3D, Visualizer } from './features/Visualizer';
import { AudioPage } from './features/Audio';
import { MusicPage } from './features/Music';
import { OutputPage } from './features/Output';
import { SettingsPage } from './features/Settings';
import { externalControl } from './control';
import { HelpButton, OnboardingHost } from './features/Onboarding';

const ICONS: Record<PageId, ComponentType<{ size?: number }>> = {
  dashboard: LayoutDashboard, fixtures: Lightbulb, console: SlidersHorizontal, programmer: Palette, cues: ListOrdered, effects: Sparkles,
  timeline: ChartGantt, ai: Bot, visualizer: Theater, stage3d: Box, audio: AudioLines, music: Music2, output: Cable, settings: SettingsIcon,
};
const VIEWS: Record<PageId, ComponentType> = {
  dashboard: Dashboard, fixtures: Fixtures, console: LiveConsole, programmer: Programmer, cues: Cues, effects: Effects,
  timeline: TimelinePage, ai: AiDirector, visualizer: Visualizer, stage3d: StageVisualizer3D, audio: AudioPage, music: MusicPage, output: OutputPage, settings: SettingsPage,
};

export function newProjectFlow(): void {
  useStore.setState({ newProjectOpen: true });
}

async function guardUnsaved(): Promise<boolean> {
  if (!useStore.getState().project?.dirty) return true;
  return confirmAction({ title: 'Modifications non enregistrées', message: 'Le projet actuel contient des modifications non enregistrées. Continuer sans enregistrer ?', confirmLabel: 'Continuer sans enregistrer' });
}

export async function openProject(): Promise<void> {
  if (await guardUnsaved()) await act({ type: 'project.open' });
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('Nouveau show');
  const create = async () => {
    if (!(await guardUnsaved())) return;
    if (await act({ type: 'project.new', name: name.trim() || 'Nouveau show' })) onClose();
  };
  return (
    <Modal title="Nouveau projet" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Annuler</button><button className="btn primary" onClick={() => void create()}>Créer</button></>}>
      <Field label="Nom du projet"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} /></Field>
    </Modal>
  );
}

function TopBar() {
  const project = useStore((s) => s.project);
  const rt = useStore((s) => s.runtime);
  const toggleDiag = useStore((s) => s.toggleDiag);
  const [showNew, setShowNew] = useState(false);
  const newOpen = useStore((s) => s.newProjectOpen);
  useEffect(() => {
    if (newOpen) {
      setShowNew(true);
      useStore.setState({ newProjectOpen: false });
    }
  }, [newOpen]);
  const taps = useRef<number[]>([]);
  const outputs = rt?.outputs ?? [];
  const errors = outputs.filter((o) => o.state === 'error').length;
  const ready = outputs.filter((o) => o.state === 'ready').length;
  const live = rt?.liveMode ?? false;
  const transmitting = rt?.transmitting ?? true;
  const pb = rt?.engine.playbacks.find((p) => p.state !== 'idle');
  const alerts = rt?.alerts.length ?? 0;

  const tap = () => {
    const now = performance.now();
    taps.current = [...taps.current.filter((t) => now - t < 3000), now];
    if (taps.current.length >= 3) {
      const iv = taps.current.slice(1).map((t, i) => t - taps.current[i]!);
      const bpm = Math.round(60000 / (iv.reduce((a, b) => a + b, 0) / iv.length));
      if (bpm >= 20 && bpm <= 300) void act({ type: 'engine.bpm', bpm });
    }
  };

  return (
    <header className="topbar">
      <div className="brand"><div className="brand-mark" />{BRAND.productName}</div>
      <div className="top-project" title={project?.path ?? 'Projet non enregistré'}>
        <b>{project?.project.meta.name ?? '…'}{project?.dirty ? ' •' : ''}</b>
        <span className="small muted">{project?.project.meta.show || (pb ? `Cue : ${pb.cueName ?? '–'}` : 'Aucun cue actif')}</span>
      </div>
      <div className="row">
        <button className="btn ghost icon" title="Nouveau projet (Ctrl+N)" onClick={() => setShowNew(true)}><FilePlus size={16} /></button>
        <button className="btn ghost icon" title="Ouvrir (Ctrl+O)" onClick={() => void openProject()}><FolderOpen size={16} /></button>
        <button className="btn ghost icon" title="Enregistrer (Ctrl+S)" data-testid="save" onClick={() => void act({ type: 'project.save' })}><Save size={16} /></button>
      </div>
      <div className="top-sep" />
      <span className={`mode-badge ${live ? 'live' : ''}`} data-testid="mode" title={live ? 'Au moins une sortie réelle est armée' : 'Aucune sortie réelle armée : rien n’est envoyé au matériel'}>{live ? 'LIVE' : 'SIMULATION'}</span>
      <div className="stat" title={outputs.map((o) => `${o.name} : ${o.state}`).join('\n')}>
        <span className="k">Sortie DMX</span>
        <span className="v row" style={{ gap: 6 }}><span className={`led ${errors ? 'err' : !transmitting ? 'warn' : ready ? 'ok' : ''}`} />{errors ? `${errors} erreur(s)` : !transmitting ? 'Arrêtée' : `${ready} active(s)`}</span>
      </div>
      <div className="stat" title={`Tick moyen ${rt?.engine.metrics.avgTickMs ?? 0} ms · gigue ${rt?.engine.metrics.jitterMs ?? 0} ms`}>
        <span className="k">Moteur</span>
        <span className="v row" style={{ gap: 6 }}><span className={`led ${rt?.engine.running ? 'ok' : 'err'}`} />{rt ? `${rt.engine.metrics.measuredHz} Hz` : '–'}</span>
      </div>
      <button className="stat btn ghost" style={{ height: 'auto', padding: '2px 6px', alignItems: 'flex-start' }} onClick={tap} title="Tapez 3 fois ou plus pour définir le BPM (tap tempo)">
        <span className="k">BPM {rt?.engine.bpmSource === 'audio' ? '· audio' : ''}</span>
        <span className="v">{rt ? rt.engine.bpm.toFixed(0) : '–'}</span>
      </button>
      <div className="stat" title={rt?.ai.lastError ?? ''}>
        <span className="k">Assistant IA</span>
        <span className="v row" style={{ gap: 6 }}><span className={`led ${rt?.ai.busy ? 'violet' : rt?.ai.lastError ? 'warn' : 'ok'}`} />{rt?.ai.provider === 'openrouter' && rt.ai.hasKey ? 'OpenRouter' : 'Local'}</span>
      </div>
      <div className="grow" />
      <HelpButton />
      <button className="btn ghost icon" title={`${alerts} alerte(s) — ouvrir la console de diagnostic`} onClick={toggleDiag} style={{ position: 'relative' }}>
        <Bell size={16} />
        {alerts > 0 && <span className="badge err" style={{ position: 'absolute', top: -4, right: -8, height: 16, padding: '0 4px' }}>{alerts}</span>}
      </button>
      <button className={`btn ${rt?.engine.blackout ? 'danger solid' : ''}`} data-testid="blackout" title="Blackout (B) — politique configurable dans Paramètres" onClick={() => void act({ type: 'engine.blackout', on: !rt?.engine.blackout })}>
        <Moon size={15} />Blackout
      </button>
      {transmitting ? (
        <button className="btn danger solid lg" data-testid="stop-output" title="STOP OUTPUT (Maj+Échap) : arrête immédiatement toute émission DMX réelle" onClick={() => void act({ type: 'output.transmit', on: false })}>
          <OctagonX size={18} />STOP
        </button>
      ) : (
        <button className="btn accent lg" title="Reprendre les émissions" onClick={() => void act({ type: 'output.transmit', on: true })}><Play size={16} />Reprendre</button>
      )}
      {showNew && <NewProjectDialog onClose={() => setShowNew(false)} />}
    </header>
  );
}

function Sidebar() {
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  const collapsed = useStore((s) => s.collapsed);
  const toggle = useStore((s) => s.toggleCollapsed);
  const keys = resolveShortcuts(useStore((s) => s.shortcuts));
  return (
    <nav className="sidebar" aria-label="Espaces de travail">
      {PAGES.map((p) => {
        const Icon = ICONS[p.id];
        const k = keys[`page:${p.id}` as ShortcutAction];
        return (
          <button key={p.id} className={`nav-item ${page === p.id ? 'active' : ''}`} onClick={() => setPage(p.id)} title={`${p.label}${k ? ` (${k})` : ''}`} data-testid={`nav-${p.id}`}>
            <Icon size={17} /><span>{p.label}</span>{k && <span className="kbd">{k.replace('Ctrl+', '^')}</span>}
          </button>
        );
      })}
      <div className="grow" />
      <button className="nav-item" onClick={toggle} title={collapsed ? 'Déplier' : 'Replier'}>
        {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}<span>Replier</span>
      </button>
    </nav>
  );
}

function StatusBar() {
  const rt = useStore((s) => s.runtime);
  const project = useStore((s) => s.project);
  const toggleDiag = useStore((s) => s.toggleDiag);
  const m = rt?.engine.metrics;
  return (
    <footer className="statusbar">
      <span className="item"><Activity size={12} />{m ? `${m.measuredHz}/${m.rateHz} Hz · tick ${m.avgTickMs.toFixed(2)} ms · charge ${(m.load * 100).toFixed(1)} %` : 'Moteur…'}</span>
      <span className="item">{project?.project.patch.length ?? 0} projecteurs · {project?.project.show.universes ?? 0} univers</span>
      <span className="item">Programmeur : {rt?.engine.programmerCount ?? 0}</span>
      {rt?.engine.aiActive && <span className="item"><span className="led violet" />Couche IA active</span>}
      {rt?.safety.violation && <span className="item" data-testid="flash-alert" title={rt.safety.reason ?? ''}><span className="led warn" />Flashs dangereux{rt.safety.flashGuard === 'limit' ? ' · limités' : ''}</span>}
      {rt?.audio.active && <span className="item"><AudioLines size={12} />Audio {rt.audio.source === 'simulated' ? '(simulé)' : ''}</span>}
      <div className="grow" />
      <span className="item">Master {Math.round((rt?.engine.master ?? 1) * 100)} %</span>
      <button className="btn ghost sm" onClick={toggleDiag} title="Console de diagnostic (Ctrl+`)"><Terminal size={12} />Diagnostic</button>
    </footer>
  );
}

function DiagnosticsDrawer() {
  const open = useStore((s) => s.diagOpen);
  const logs = useStore((s) => s.logs);
  const toggle = useStore((s) => s.toggleDiag);
  const end = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState<'all' | 'warn'>('all');
  useEffect(() => end.current?.scrollIntoView(), [logs.length, open]);
  if (!open) return null;
  const shown = level === 'all' ? logs : logs.filter((l) => l.level === 'warn' || l.level === 'error');
  return (
    <div className="drawer" data-testid="diagnostics">
      <div className="panel-head">
        <h2>Console de diagnostic</h2>
        <div className="chips">
          <button className={`chip ${level === 'all' ? 'on' : ''}`} onClick={() => setLevel('all')}>Tout</button>
          <button className={`chip ${level === 'warn' ? 'on' : ''}`} onClick={() => setLevel('warn')}>Alertes</button>
        </div>
        <div className="grow" />
        <button className="btn ghost sm icon" onClick={toggle} title="Fermer"><X size={14} /></button>
      </div>
      <div style={{ overflow: 'auto', flex: 1, padding: '6px 0' }}>
        {shown.length === 0 && <div className="empty small">Aucun événement.</div>}
        {shown.map((l) => (
          <div key={l.id} className={`log-line ${l.level}`}>
            <span className="dim">{l.t.slice(11, 19)}</span><span>{l.level.toUpperCase()}</span><span className="muted">{l.source}</span><span>{l.message}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismiss);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <div className="grow"><div style={{ fontWeight: 600 }}>{t.title}</div>{t.detail && <div className="small muted">{t.detail}</div>}</div>
          <button className="btn ghost sm icon" onClick={() => dismiss(t.id)}><X size={12} /></button>
        </div>
      ))}
    </div>
  );
}

export function runShortcut(action: ShortcutAction): boolean {
  const s = useStore.getState();
  const list = s.cueListId;
  if (action.startsWith('page:')) {
    s.setPage(action.slice(5) as PageId);
    return true;
  }
  switch (action) {
    case 'go': if (list) void act({ type: 'cue.go', listId: list }); return !!list;
    case 'back': if (list) void act({ type: 'cue.back', listId: list }); return !!list;
    case 'pause': {
      if (!list) return false;
      const st = s.runtime?.engine.playbacks.find((p) => p.cueListId === list)?.state;
      void act({ type: st === 'paused' ? 'cue.resume' : 'cue.pause', listId: list });
      return true;
    }
    case 'blackout': void act({ type: 'engine.blackout', on: !s.runtime?.engine.blackout }); return true;
    case 'stopOutput': void act({ type: 'output.transmit', on: false }); return true;
    case 'release': void act({ type: 'programmer.release' }); return true;
    case 'save': void act({ type: 'project.save' }); return true;
    case 'saveAs': void act({ type: 'project.saveAs' }); return true;
    case 'open': void openProject(); return true;
    case 'new': newProjectFlow(); return true;
    case 'diagnostics': s.toggleDiag(); return true;
    default: return false;
  }
}

function useShortcuts() {
  const overrides = useStore((s) => s.shortcuts);
  useEffect(() => {
    const bindings = bindingsFrom(overrides);
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (s.capturingShortcut) return;
      const combo = comboFromEvent(e);
      if (!combo) return;
      const action = bindings.get(combo);
      if (!action) return;
      const el = e.target as HTMLElement;
      const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
      if (typing && !allowedWhileTyping(combo)) return;
      if (s.confirm && action !== 'stopOutput') return;
      if (runShortcut(action)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [overrides]);
}

export function App() {
  const page = useStore((s) => s.page);
  const collapsed = useStore((s) => s.collapsed);
  const ready = useStore((s) => !!s.project);
  useShortcuts();
  const View = VIEWS[page];
  return (
    <div className={`app ${collapsed ? 'collapsed' : ''}`}>
      <TopBar />
      <Sidebar />
      <main className="main">{ready ? <View key={page} /> : <div className="empty">Connexion au moteur…</div>}</main>
      <StatusBar />
      <DiagnosticsDrawer />
      <Toasts />
      <OnboardingHost />
      <ConfirmHost />
    </div>
  );
}

export async function bootstrap(): Promise<void> {
  const [project, logs, settings] = await Promise.all([call({ type: 'project.get' }), call({ type: 'logs.recent' }), call({ type: 'settings.get' })]);
  document.documentElement.classList.toggle('reduced-motion', settings.appearance.reducedMotion);
  document.documentElement.style.zoom = String(settings.appearance.uiScale);
  useStore.setState({ shortcuts: settings.shortcuts, onboarding: settings.onboarding, help: settings.onboarding.completed ? null : 'welcome' });
  void externalControl.configure(settings.control);
  useStore.setState({ project, logs, cueListId: project.project.cueLists[0]?.id ?? null });
}
