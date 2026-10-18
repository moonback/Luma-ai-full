import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Lock, LockOpen, Music2, Play, RefreshCw, Shuffle, Sparkles, Square, Upload, Wand2 } from 'lucide-react';
import { useStore } from '../store';
import { act } from '../api';
import { Empty, PageHead, Panel } from '../components/ui';
import { musicPlayer } from '../musicPlayer';
import { KEY_NAMES, SECTION_NAMES } from '../../core/music/analyze';
import { SECTION_LABELS, type MusicTrack, type SectionLabel } from '../../core/model/schemas';

const LABEL_COLOR: Record<SectionLabel, string> = {
  intro: '#475569', verse: '#2563eb', prechorus: '#7c3aed', build: '#a855f7', chorus: '#db2777', drop: '#e11d48', break: '#0f766e', bridge: '#ca8a04', outro: '#334155',
};
const EFFECT_NAMES = { none: '—', wave: 'Vague', pulse: 'Pulsation', chase: 'Chase', rainbow: 'Arc-en-ciel', strobe: 'Strobe' } as const;
const MOVE_NAMES = { none: 'fixe', slow: 'lent', sweep: 'balayage', fast: 'rapide' } as const;
const BEAM_NAMES = { open: '', gobo: 'gobo', prism: 'gobo + prisme', frost: 'frost' } as const;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function usePlayback() {
  useSyncExternalStore((l) => musicPlayer.subscribe(l), () => musicPlayer.playing);
  const [pos, setPos] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPos(musicPlayer.position()), 100);
    return () => clearInterval(id);
  }, []);
  return { playing: musicPlayer.playing, pos };
}

function SectionStrip({ track, selected, onSelect, pos }: { track: MusicTrack; selected: number; onSelect: (i: number) => void; pos: number | null }) {
  const a = track.analysis;
  return (
    <div style={{ position: 'relative' }}>
      <div className="row" style={{ gap: 2, height: 46 }} data-testid="section-strip">
        {a.sections.map((s, i) => (
          <button key={i} title={`${SECTION_NAMES[s.label]} · ${fmt(s.start)}–${fmt(s.end)} · énergie ${Math.round(s.energy * 100)} %`} onClick={() => onSelect(i)}
            style={{ flex: `${s.end - s.start} 0 0`, height: '100%', minWidth: 6, border: i === selected ? '2px solid #fff' : '1px solid transparent', borderRadius: 4, background: LABEL_COLOR[s.label], opacity: 0.45 + 0.55 * s.energy, color: '#fff', fontSize: 11, overflow: 'hidden', padding: '0 4px', cursor: 'pointer' }}>
            {SECTION_NAMES[s.label]}
          </button>
        ))}
      </div>
      {a.events.filter((e) => e.kind !== 'silence').map((e, i) => (
        <span key={i} title={e.kind === 'impact' ? 'Impact' : 'Montée'} style={{ position: 'absolute', top: -6, left: `${(e.t / a.duration) * 100}%`, width: e.kind === 'riser' ? `${(e.duration / a.duration) * 100}%` : 2, height: 4, background: e.kind === 'impact' ? '#fde047' : '#22d3ee', borderRadius: 2 }} />
      ))}
      {pos !== null && <span style={{ position: 'absolute', top: -4, bottom: -4, width: 2, background: '#fff', left: `${Math.min(100, (pos / a.duration) * 100)}%` }} />}
    </div>
  );
}

export function MusicPage() {
  const project = useStore((s) => s.project!.project);
  const tracks = project.music.tracks;
  const [trackId, setTrackId] = useState<string | null>(tracks[0]?.id ?? null);
  const [progress, setProgress] = useState<{ p: number; step: string } | null>(null);
  const [intent, setIntent] = useState('');
  const [busy, setBusy] = useState(false);
  const [notices, setNotices] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);
  const [instr, setInstr] = useState<Record<number, string>>({});
  const file = useRef<HTMLInputElement>(null);
  const { playing, pos } = usePlayback();
  const track = tracks.find((t) => t.id === trackId) ?? tracks[0] ?? null;
  const planIntent = track?.plan?.intent ?? '';
  useEffect(() => { if (planIntent) setIntent(planIntent); }, [track?.id, planIntent]);

  const importFile = async (f: File) => {
    try {
      const r = await musicPlayer.load(f, { bpmRange: project.audio.bpmRange, known: (h) => tracks.some((t) => t.hash === h), onProgress: (p, step) => setProgress({ p, step }) });
      if (r.analysis) {
        const added = await act({ type: 'music.addTrack', name: r.name, hash: r.hash, analysis: r.analysis });
        if (added) setTrackId(added.id);
      } else {
        const known = tracks.find((t) => t.hash === r.hash);
        if (known) setTrackId(known.id);
        useStore.getState().toast({ kind: 'info', title: 'Morceau déjà analysé', detail: 'Analyse reprise du projet ; le fichier audio est chargé pour la lecture.' });
      }
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: 'Import impossible', detail: err instanceof Error ? err.message : String(err) });
    } finally {
      setProgress(null);
    }
  };
  const generate = async (nextVariant: boolean) => {
    if (!track) return;
    setBusy(true);
    const r = await act({ type: 'music.generate', trackId: track.id, intent, nextVariant });
    setBusy(false);
    if (r) setNotices(r.notices);
  };
  const regenerate = async (index: number) => {
    if (!track) return;
    setBusy(true);
    const r = await act({ type: 'music.regenerateSection', trackId: track.id, index, instruction: instr[index] ?? '' });
    setBusy(false);
    if (r) setNotices(r.notices);
  };
  const play = (t: MusicTrack) => {
    try {
      musicPlayer.play(t, t.analysis.sections[selected]?.start ?? 0);
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: 'Lecture impossible', detail: (err as Error).message });
    }
  };

  return (
    <div className="page">
      <PageHead title="Musique — Song-to-Show" subtitle="Analyse d’un morceau (tempo, premiers temps, sections, tonalité) puis programmation automatique d’un show calé sur la structure">
        <input ref={file} type="file" accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a" style={{ display: 'none' }} data-testid="music-file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
        <button className="btn primary" disabled={!!progress} onClick={() => file.current?.click()} data-testid="music-import"><Upload size={14} />Importer un morceau</button>
      </PageHead>
      {progress && (
        <Panel title={`${progress.step}…`}>
          <div className="meter" data-testid="music-progress"><div style={{ width: `${Math.round(progress.p * 100)}%` }} /></div>
        </Panel>
      )}
      {!track ? (
        <Empty icon={<Music2 size={32} />} title="Aucun morceau">Importez un fichier audio (WAV, MP3, FLAC…). Il est analysé sur cette machine ; seule l’analyse est enregistrée dans le projet, jamais le son.</Empty>
      ) : (
        <div className="col gap-lg">
          {tracks.length > 1 && (
            <div className="chips">{tracks.map((t) => <button key={t.id} className={`chip ${t.id === track.id ? 'on' : ''}`} onClick={() => { setTrackId(t.id); setSelected(0); setNotices([]); }}>{t.name}</button>)}</div>
          )}
          <Panel title={track.name} actions={
            <div className="row">
              {musicPlayer.hasAudio(track.hash) ? (
                playing?.trackId === track.id
                  ? <button className="btn" onClick={() => musicPlayer.stop()} data-testid="music-stop"><Square size={13} />Stop {fmt(pos)}</button>
                  : <button className="btn accent" onClick={() => play(track)} data-testid="music-play"><Play size={13} />Lecture synchronisée</button>
              ) : <span className="small dim">Réimportez le fichier pour la lecture (le son n’est pas enregistré dans le projet)</span>}
              <button className="btn ghost sm" onClick={() => void act({ type: 'music.removeTrack', id: track.id })}>Retirer</button>
            </div>
          }>
            <div className="row wrap" style={{ gap: 18, marginBottom: 12 }} data-testid="music-summary">
              <span><span className="small muted">Tempo </span><b className="mono">{track.analysis.bpm.toFixed(1)}</b> BPM {track.analysis.tempoStable ? '' : <span className="badge warn">variable</span>}</span>
              <span><span className="small muted">Tonalité </span><b>{KEY_NAMES[track.analysis.key.tonic]} {track.analysis.key.mode === 'major' ? 'majeur' : 'mineur'}</b> <span className="small dim">({Math.round(track.analysis.key.confidence * 100)} %)</span></span>
              <span><span className="small muted">Durée </span><b className="mono">{fmt(track.analysis.duration)}</b></span>
              <span><span className="small muted">Sections </span><b>{track.analysis.sections.length}</b></span>
              <span className="small dim">{track.analysis.events.filter((e) => e.kind === 'impact').length} impacts · {track.analysis.events.filter((e) => e.kind === 'riser').length} montées</span>
            </div>
            <SectionStrip track={track} selected={selected} onSelect={setSelected} pos={playing?.trackId === track.id ? pos : null} />
            <p className="small dim" style={{ marginBottom: 0 }}>Étiquettes estimées par répétition et énergie (pas de modèle entraîné) : corrigez-les dans le tableau si besoin, le show suivra.</p>
          </Panel>

          <Panel title="Intention" actions={track.plan ? <span className={`badge ${track.plan.provider === 'openrouter' ? 'violet' : ''}`}>{track.plan.provider === 'openrouter' ? `OpenRouter · ${track.plan.model}` : 'Règles locales'} · variante {track.plan.variant}</span> : null}>
            <div className="col">
              <textarea className="input" rows={2} value={intent} onChange={(e) => setIntent(e.target.value)} placeholder="Ex. : concert pop, sobre sur les couplets, explosion sur les refrains, pas de strobe" data-testid="music-intent" />
              <div className="row">
                <button className="btn primary" disabled={busy} onClick={() => void generate(false)} data-testid="music-generate"><Wand2 size={14} />{track.plan ? 'Régénérer le show' : 'Générer le show'}</button>
                <button className="btn" disabled={busy || !track.plan} onClick={() => void generate(true)} title="Nouvelle variante des sections non verrouillées"><Shuffle size={14} />Variante</button>
                {track.created.timelineId && <button className="btn ghost" onClick={() => useStore.getState().setPage('timeline')}>Ouvrir la timeline</button>}
              </div>
              {track.plan && <p className="small" style={{ margin: 0 }} data-testid="music-plan-summary"><Sparkles size={12} /> {track.plan.summary}</p>}
              {notices.map((n, i) => <div key={i} className="small" style={{ color: '#fcd34d' }}>{n}</div>)}
              <p className="small dim" style={{ margin: 0 }}>Avec OpenRouter, seule la structure symbolique est envoyée (sections, durées, énergie, tempo, tonalité, composition du kit) : jamais le son.</p>
            </div>
          </Panel>

          <Panel title="Sections" flush>
            <table className="table small" data-testid="music-sections">
              <thead><tr><th>#</th><th>Section</th><th>Début</th><th>Énergie</th><th>Plan lumière</th><th>Consigne</th><th /></tr></thead>
              <tbody>
                {track.analysis.sections.map((s, i) => {
                  const p = track.plan?.sections[i];
                  return (
                    <tr key={i} className={i === selected ? 'selected' : ''} onClick={() => setSelected(i)}>
                      <td className="mono">{i + 1}</td>
                      <td>
                        <select className="select" value={s.label} onChange={(e) => void act({ type: 'music.setSection', trackId: track.id, index: i, label: e.target.value as SectionLabel })}>
                          {SECTION_LABELS.map((l) => <option key={l} value={l}>{SECTION_NAMES[l]}</option>)}
                        </select>
                      </td>
                      <td className="mono">{fmt(s.start)}</td>
                      <td style={{ width: 90 }}><div className="meter"><div style={{ width: `${s.energy * 100}%` }} /></div></td>
                      <td>
                        {p ? (
                          <span className="row" style={{ gap: 6 }}>
                            <span className="mono" title="Énergie du plan (0–5)">{'●'.repeat(p.energy)}{'○'.repeat(5 - p.energy)}</span>
                            {p.palette.map((c) => <span key={c} style={{ width: 12, height: 12, borderRadius: 3, background: c, display: 'inline-block' }} />)}
                            <span>{EFFECT_NAMES[p.effect]}{p.effect !== 'none' ? ` ${p.effectBeats} t` : ''}</span>
                            <span className="dim">· {MOVE_NAMES[p.movement]}{BEAM_NAMES[p.beam] ? ` · ${BEAM_NAMES[p.beam]}` : ''}</span>
                            {p.note && <span className="badge">{p.note}</span>}
                          </span>
                        ) : <span className="dim">—</span>}
                      </td>
                      <td style={{ width: 200 }}>
                        <input className="input" disabled={!p} placeholder="plus chaud, plus calme, en rouge, prisme…" value={instr[i] ?? ''} onChange={(e) => setInstr({ ...instr, [i]: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void regenerate(i)} />
                      </td>
                      <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                        <button className="btn ghost sm icon" disabled={!p || busy} title="Régénérer cette section (avec la consigne si elle est remplie)" onClick={() => void regenerate(i)}><RefreshCw size={12} /></button>
                        <button className={`btn ghost sm icon ${p?.locked ? 'on' : ''}`} disabled={!p} title={p?.locked ? 'Déverrouiller' : 'Verrouiller (conservée lors des régénérations)'} onClick={() => void act({ type: 'music.setSection', trackId: track.id, index: i, locked: !p?.locked })}>{p?.locked ? <Lock size={12} /> : <LockOpen size={12} />}</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        </div>
      )}
    </div>
  );
}
