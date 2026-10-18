import { useEffect, useLayoutEffect, useState } from 'react';
import { BookOpen, Check, ChevronLeft, ChevronRight, CircleHelp, Compass, Keyboard, ListChecks, Sparkles, X } from 'lucide-react';
import { useStore, confirmAction, type PageId } from '../store';
import { act } from '../api';
import { Modal } from '../components/ui';
import { DEMOS } from '../../core/demo/catalog';

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

async function finishOnboarding(): Promise<void> {
  await act({ type: 'onboarding.update', completed: true });
  const o = useStore.getState().onboarding;
  useStore.setState({ onboarding: { completed: true, checklistHidden: o?.checklistHidden ?? false } });
}

async function openDemo(id: string): Promise<boolean> {
  if (useStore.getState().project?.dirty && !(await confirmAction({ title: 'Modifications non enregistrées', message: 'Le projet actuel contient des modifications non enregistrées. Ouvrir le projet de démonstration quand même ?', confirmLabel: 'Ouvrir la démo' }))) return false;
  if (!(await act({ type: 'project.openDemo', id }))) return false;
  const d = DEMOS.find((x) => x.id === id)!;
  useStore.getState().setPage('dashboard');
  useStore.getState().toast({ kind: 'success', title: `Démo ouverte : ${d.name}`, detail: 'Projet fictif non enregistré : Ctrl+S pour en garder une copie.' });
  return true;
}

/* ------------------------------------------------------------------ */
/* Welcome (first run)                                                 */
/* ------------------------------------------------------------------ */

const PILLARS: [string, string][] = [
  ['Sécurité d’abord', 'L’application démarre en SIMULATION : aucune sortie réelle n’émet tant que vous ne l’avez pas armée. STOP (Maj+Échap) coupe tout à tout moment.'],
  ['Le manuel gagne toujours', 'Ce que vous réglez à la main dans la Live Console passe devant les cues, les effets, l’audio et l’IA. Échap rend la main.'],
  ['Du patch au show', 'Patchez vos projecteurs, enregistrez des scènes, construisez des cues et des timelines, ou laissez l’IA et Song-to-Show proposer.'],
  ['Tout fonctionne sans matériel', 'Sortie virtuelle, visualiseur 2D/3D et projets de démonstration : vous pouvez tout essayer avant d’aller en salle.'],
];

function Welcome() {
  const setHelp = useStore((s) => s.setHelp);
  const close = () => { void finishOnboarding(); setHelp(null); };
  return (
    <Modal title="Bienvenue dans Luma AI DMX" onClose={close} wide footer={<button className="btn ghost" onClick={close} data-testid="welcome-skip">Commencer avec un projet vide</button>}>
      <div className="col gap-lg" data-testid="welcome">
        <p style={{ margin: 0 }}>Une console d’éclairage DMX complète, assistée par une IA qui ne pilote jamais le matériel directement : elle propose, vous validez.</p>
        <div className="grid g2">
          {PILLARS.map(([t, d]) => <div key={t} className="panel" style={{ padding: 12 }}><b>{t}</b><p className="small muted" style={{ margin: '6px 0 0' }}>{d}</p></div>)}
        </div>
        <div className="grid g2">
          <button className="btn lg primary" onClick={() => setHelp('tour')} data-testid="welcome-tour"><Compass size={18} />Visite guidée (3 min)</button>
          <button className="btn lg" onClick={() => setHelp('demos')} data-testid="welcome-demos"><Sparkles size={18} />Explorer un projet de démonstration</button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Demo gallery                                                        */
/* ------------------------------------------------------------------ */

function DemoGallery() {
  const setHelp = useStore((s) => s.setHelp);
  const [filter, setFilter] = useState<string | null>(null);
  const categories = [...new Set(DEMOS.map((d) => d.category))];
  const shown = DEMOS.filter((d) => !filter || d.category === filter);
  const close = () => { void finishOnboarding(); setHelp(null); };
  return (
    <Modal title="Projets de démonstration" onClose={close} wide>
      <div className="col gap-lg" data-testid="demo-gallery">
        <p className="small muted" style={{ margin: 0 }}>Dix projets fictifs (lieux, artistes et événements inventés) construits avec les profils intégrés « Luma Demo ». Ouvrez-en un pour explorer patch, groupes, scènes, cues, effets et timeline, puis jouez-le en sortie virtuelle et dans la vue 3D.</p>
        <div className="chips">
          <button className={`chip ${!filter ? 'on' : ''}`} onClick={() => setFilter(null)}>Tous ({DEMOS.length})</button>
          {categories.map((c) => <button key={c} className={`chip ${filter === c ? 'on' : ''}`} onClick={() => setFilter(c)}>{c}</button>)}
        </div>
        <div className="grid g2" style={{ maxHeight: '60vh', overflow: 'auto' }}>
          {shown.map((d) => {
            const fixtures = d.rigs.reduce((n, r) => n + r.count, 0);
            const cues = d.cueLists.reduce((n, l) => n + l.cues.length, 0);
            return (
              <div key={d.id} className="panel" style={{ padding: 12 }} data-testid={`demo-${d.id}`}>
                <div className="row between"><span className="badge violet">{d.category}</span><span className="small dim">{fixtures} projecteurs · {cues} cues{d.timeline ? ' · timeline' : ''}</span></div>
                <h3 style={{ margin: '8px 0 2px', fontSize: 15 }}>{d.name}</h3>
                <div className="small muted">{d.venue}</div>
                <p className="small" style={{ margin: '8px 0' }}>{d.description}</p>
                <ul className="small muted" style={{ margin: '0 0 10px', paddingLeft: 18 }}>{d.highlights.map((h) => <li key={h}>{h}</li>)}</ul>
                <button className="btn primary sm" onClick={() => void openDemo(d.id).then((ok) => { if (ok) close(); })}>Ouvrir</button>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Guided tour                                                         */
/* ------------------------------------------------------------------ */

interface Step { target?: string; page?: PageId; title: string; body: string }

export const TOUR: Step[] = [
  { title: 'Bienvenue à bord', body: 'Cette visite présente chaque espace de travail en 18 étapes. Naviguez avec les flèches ←/→ du clavier ou les boutons ; Échap pour quitter. Elle est relançable à tout moment depuis le bouton d’aide (?).' },
  { target: 'mode', title: 'Simulation ou LIVE', body: 'Ce badge indique en permanence si une sortie réelle est armée. En SIMULATION, rien ne part vers le matériel : idéal pour programmer. Il passe en LIVE dès qu’une sortie Art-Net, sACN ou USB est armée.' },
  { target: 'stop-output', title: 'STOP OUTPUT', body: 'Le bouton d’urgence : il coupe immédiatement toutes les émissions réelles (raccourci Maj+Échap, actif même pendant une saisie). Chaque projecteur applique ensuite son propre comportement de perte de signal.' },
  { target: 'blackout', title: 'Blackout', body: 'Éteint les intensités (touche B) selon la politique choisie dans Settings › Moteur & sécurité. Le blackout n’est pas un état universellement sûr : vérifiez le comportement de vos appareils.' },
  { target: 'save', title: 'Projet et sauvegardes', body: 'Ctrl+N nouveau projet, Ctrl+O ouvrir, Ctrl+S enregistrer. Un point « • » après le nom signale des modifications non enregistrées ; une copie de récupération est écrite automatiquement.' },
  { target: 'nav-fixtures', page: 'fixtures', title: 'Fixtures : le patch', body: 'Ajoutez vos projecteurs (profil, mode, univers, adresse automatique), importez des profils Open Fixture Library, rangez-les en groupes et positionnez-les. « Localiser par caméra » mesure les positions réelles et détecte les erreurs d’adressage.' },
  { target: 'nav-console', page: 'console', title: 'Live Console', body: 'Sélectionnez des projecteurs ou un groupe : les contrôles (intensité, couleur, pan/tilt, gobo…) sont générés depuis leur profil. Le manuel est toujours prioritaire. « Enregistrer scène » fige l’état du programmeur.' },
  { target: 'nav-programmer', page: 'programmer', title: 'Programmer', body: 'Palettes de couleurs, de positions et de faisceau réutilisables, et édition fine des valeurs : la base de scènes propres et cohérentes.' },
  { target: 'nav-cues', page: 'cues', title: 'Cues & Sequences', body: 'La conduite : chaque cue appelle une scène avec un fondu, un délai, une courbe et, si besoin, un enchaînement automatique. Espace = GO, Maj+Espace = BACK, P = pause.' },
  { target: 'nav-effects', page: 'effects', title: 'Effets', body: 'Chase, vague, arc-en-ciel, pulse, mouvements, strobe plafonné… synchronisés au BPM et, avec une source audio, calés sur la mesure.' },
  { target: 'nav-timeline', page: 'timeline', title: 'Timeline', body: 'Placez scènes, effets et cues sur une ligne de temps, jouez-la à la main ou faites-lui suivre un timecode MTC/LTC.' },
  { target: 'nav-ai', page: 'ai', title: 'AI Lighting Director', body: 'Décrivez une ambiance (« lounge violet et bleu, très doux »). L’IA propose des actions typées avec aperçu ; rien n’est appliqué sans votre validation, et le garde-fou photosensible refuse les effets dangereux.' },
  { target: 'nav-stage3d', page: 'stage3d', title: 'Visualiseur 3D', body: 'Faisceaux volumétriques, gobos et lyres articulées, en direct. « Détacher » ouvre la vue dans une fenêtre pour un second écran (F11 : plein écran).' },
  { target: 'nav-audio', page: 'audio', title: 'Audio Reactive', body: 'Suivi du tempo en direct, premiers temps, prédiction de drop/refrain, suiveurs de bande. Le GO sur drop prédit ne part qu’après un armement explicite, une seule fois.' },
  { target: 'nav-music', page: 'music', title: 'Musique (Song-to-Show)', body: 'Importez un morceau : il est analysé localement (tempo, sections, tonalité) puis l’application génère une timeline complète calée sur la structure, retouchable section par section.' },
  { target: 'nav-output', page: 'output', title: 'DMX Output', body: 'Configurez Art-Net, sACN ou USB-DMX. Les sorties réelles démarrent toujours désarmées : « Armer » demande une confirmation. Moniteur 512 canaux, diagnostics et RDM sont ici.' },
  { target: 'nav-settings', page: 'settings', title: 'Settings', body: 'Sécurité (garde-fou photosensible, strobe maximal, blackout), fournisseur IA, raccourcis, MIDI/OSC/timecode et télécommande tablette.' },
  { target: 'help', title: 'Toujours là pour vous', body: 'Le bouton d’aide relance cette visite, ouvre les 10 projets de démonstration et réaffiche la liste « Premiers pas » du Dashboard. Bon show !' },
];

function Tour() {
  const setHelp = useStore((s) => s.setHelp);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = TOUR[i]!;
  const last = i === TOUR.length - 1;
  const end = () => { void finishOnboarding(); setHelp(null); };

  useEffect(() => { if (step.page) useStore.getState().setPage(step.page); }, [step.page]);
  useLayoutEffect(() => {
    const measure = () => {
      const el = step.target ? document.querySelector(`[data-testid="${step.target}"]`) : null;
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    const t = setTimeout(measure, 120); // after the page switch has rendered
    window.addEventListener('resize', measure);
    return () => { clearTimeout(t); window.removeEventListener('resize', measure); };
  }, [step.target, i]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setI((x) => Math.min(TOUR.length - 1, x + 1));
      else if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
      else if (e.key === 'Escape') { void finishOnboarding(); setHelp(null); }
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [setHelp]);

  const pad = 6;
  const cardWidth = 360;
  let pos: React.CSSProperties = { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };
  if (rect) {
    const below = rect.bottom + 14 + 220 < window.innerHeight;
    const left = Math.min(window.innerWidth - cardWidth - 16, Math.max(16, rect.left + rect.width / 2 - cardWidth / 2));
    pos = rect.left < 240 && rect.width < 260
      ? { left: rect.right + 18, top: Math.min(window.innerHeight - 260, Math.max(16, rect.top - 10)) } // sidebar item: card on its right
      : below ? { left, top: rect.bottom + 14 } : { left, top: Math.max(16, rect.top - 234) };
  }
  return (
    <div data-testid="tour" style={{ position: 'fixed', inset: 0, zIndex: 1000 }}>
      {rect ? (
        <div style={{ position: 'fixed', left: rect.left - pad, top: rect.top - pad, width: rect.width + 2 * pad, height: rect.height + 2 * pad, borderRadius: 8, boxShadow: '0 0 0 9999px rgba(5,7,12,.72)', outline: '2px solid var(--violet)', pointerEvents: 'none', transition: 'all .2s ease' }} />
      ) : <div style={{ position: 'fixed', inset: 0, background: 'rgba(5,7,12,.72)' }} />}
      <div className="panel" role="dialog" aria-label={step.title} style={{ position: 'fixed', ...pos, width: cardWidth, padding: 16, boxShadow: '0 12px 40px rgba(0,0,0,.5)' }}>
        <div className="row between"><span className="small dim">Étape {i + 1}/{TOUR.length}</span><button className="btn ghost sm icon" onClick={end} title="Quitter la visite (Échap)"><X size={14} /></button></div>
        <h3 style={{ margin: '6px 0' }} data-testid="tour-title">{step.title}</h3>
        <p className="small" style={{ margin: 0, lineHeight: 1.5 }}>{step.body}</p>
        <div className="meter" style={{ margin: '12px 0' }}><div style={{ width: `${((i + 1) / TOUR.length) * 100}%` }} /></div>
        <div className="row between">
          <button className="btn sm" disabled={i === 0} onClick={() => setI(i - 1)}><ChevronLeft size={13} />Précédent</button>
          {last
            ? <button className="btn primary sm" onClick={end} data-testid="tour-finish"><Check size={13} />Terminer</button>
            : <button className="btn primary sm" onClick={() => setI(i + 1)} data-testid="tour-next">Suivant<ChevronRight size={13} /></button>}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* First steps checklist (Dashboard)                                   */
/* ------------------------------------------------------------------ */

export function FirstSteps() {
  const ps = useStore((s) => s.project);
  const rt = useStore((s) => s.runtime);
  const onboarding = useStore((s) => s.onboarding);
  const setPage = useStore((s) => s.setPage);
  const setHelp = useStore((s) => s.setHelp);
  if (!ps || !onboarding || onboarding.checklistHidden) return null;
  const p = ps.project;
  const items: { label: string; hint: string; done: boolean; action: () => void; cta: string }[] = [
    { label: 'Faire la visite guidée', hint: 'Découvrir chaque espace en 3 minutes', done: onboarding.completed, action: () => setHelp('tour'), cta: 'Lancer' },
    { label: 'Patcher des projecteurs', hint: 'Fixtures › Ajouter, ou ouvrir une démo', done: p.patch.length > 0, action: () => setPage('fixtures'), cta: 'Patcher' },
    { label: 'Créer un groupe', hint: 'Sélectionner plusieurs projecteurs d’un coup', done: p.groups.length > 0, action: () => setPage('fixtures'), cta: 'Ouvrir' },
    { label: 'Enregistrer une scène', hint: 'Live Console › Enregistrer scène', done: p.scenes.length > 0, action: () => setPage('console'), cta: 'Console' },
    { label: 'Construire un cue', hint: 'Cues & Sequences › ajouter un cue', done: p.cueLists.some((l) => l.cues.length > 0), action: () => setPage('cues'), cta: 'Cues' },
    { label: 'Essayer l’assistant IA', hint: 'Décrire une ambiance et prévisualiser', done: p.ai.recentPrompts.length > 0, action: () => setPage('ai'), cta: 'IA' },
    { label: 'Configurer une sortie réelle', hint: 'Art-Net, sACN ou USB-DMX (désarmée par défaut)', done: (rt?.outputs ?? []).some((o) => o.real), action: () => setPage('output'), cta: 'Sorties' },
    { label: 'Enregistrer le projet', hint: 'Ctrl+S', done: !!ps.path && !ps.dirty, action: () => void act({ type: 'project.save' }), cta: 'Enregistrer' },
  ];
  const done = items.filter((x) => x.done).length;
  const hide = () => {
    void act({ type: 'onboarding.update', checklistHidden: true });
    useStore.setState({ onboarding: { ...onboarding, checklistHidden: true } });
  };
  return (
    <div className="panel" style={{ padding: 14, marginBottom: 12 }} data-testid="first-steps">
      <div className="row between">
        <b><ListChecks size={15} style={{ verticalAlign: -3 }} /> Premiers pas — {done}/{items.length}</b>
        <div className="row">
          <button className="btn sm" onClick={() => setHelp('demos')}><Sparkles size={12} />Projets de démonstration</button>
          <button className="btn ghost sm" onClick={hide}>Masquer</button>
        </div>
      </div>
      <div className="meter" style={{ margin: '10px 0' }}><div style={{ width: `${(done / items.length) * 100}%` }} /></div>
      <div className="grid g4">
        {items.map((x) => (
          <div key={x.label} className="row" style={{ alignItems: 'flex-start', gap: 8, opacity: x.done ? 0.6 : 1 }}>
            <span className={`led ${x.done ? 'ok' : ''}`} style={{ marginTop: 4, flex: 'none' }} />
            <div className="grow">
              <div className="small" style={{ textDecoration: x.done ? 'line-through' : 'none' }}>{x.label}</div>
              <div className="small dim">{x.hint}</div>
              {!x.done && <button className="btn ghost sm" style={{ padding: '0 4px' }} onClick={x.action}>{x.cta} →</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Help menu + host                                                    */
/* ------------------------------------------------------------------ */

export function HelpButton() {
  const [open, setOpen] = useState(false);
  const setHelp = useStore((s) => s.setHelp);
  const pick = (fn: () => void) => { setOpen(false); fn(); };
  const showChecklist = () => {
    void act({ type: 'onboarding.update', checklistHidden: false });
    useStore.setState({ onboarding: { completed: useStore.getState().onboarding?.completed ?? false, checklistHidden: false } });
    useStore.getState().setPage('dashboard');
  };
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn ghost icon" title="Aide, visite guidée et projets de démonstration" onClick={() => setOpen(!open)} data-testid="help"><CircleHelp size={16} /></button>
      {open && (
        <div className="panel col" style={{ position: 'absolute', right: 0, top: 38, zIndex: 50, width: 270, padding: 6, gap: 2 }} onMouseLeave={() => setOpen(false)}>
          <button className="btn ghost" style={{ justifyContent: 'flex-start' }} onClick={() => pick(() => setHelp('tour'))} data-testid="help-tour"><Compass size={14} />Visite guidée</button>
          <button className="btn ghost" style={{ justifyContent: 'flex-start' }} onClick={() => pick(() => setHelp('demos'))} data-testid="help-demos"><Sparkles size={14} />Projets de démonstration</button>
          <button className="btn ghost" style={{ justifyContent: 'flex-start' }} onClick={() => pick(showChecklist)}><ListChecks size={14} />Liste « Premiers pas »</button>
          <button className="btn ghost" style={{ justifyContent: 'flex-start' }} onClick={() => pick(() => setHelp('welcome'))}><BookOpen size={14} />Écran d’accueil</button>
          <button className="btn ghost" style={{ justifyContent: 'flex-start' }} onClick={() => pick(() => useStore.getState().setPage('settings'))}><Keyboard size={14} />Raccourcis clavier (Settings)</button>
        </div>
      )}
    </div>
  );
}

export function OnboardingHost() {
  const help = useStore((s) => s.help);
  const ready = useStore((s) => !!s.project);
  if (!ready) return null;
  if (help === 'welcome') return <Welcome />;
  if (help === 'demos') return <DemoGallery />;
  if (help === 'tour') return <Tour />;
  return null;
}
