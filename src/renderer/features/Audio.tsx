import { useEffect, useState } from 'react';
import { Crosshair, Mic, Radio, Square, Target as TargetIcon } from 'lucide-react';
import { useStore } from '../store';
import { act } from '../api';
import { Field, NumberInput, PageHead, Panel } from '../components/ui';
import { audioEngine } from '../audioEngine';
import type { AudioFeatures } from '../../core/audio/analyzer';
import type { AudioConfig, Target } from '../../core/model/schemas';

function TargetPicker({ value, onChange }: { value: Target; onChange: (t: Target) => void }) {
  const groups = useStore((s) => s.project!.project.groups);
  if (!groups.length) return <span className="small dim">Créez un groupe pour cibler cette réaction</span>;
  return (
    <div className="chips">
      {groups.map((g) => (
        <button key={g.id} className={`chip ${value.groupIds.includes(g.id) ? 'on' : ''}`} onClick={() => onChange({ ...value, groupIds: value.groupIds.includes(g.id) ? value.groupIds.filter((x) => x !== g.id) : [...value.groupIds, g.id] })}>{g.name}</button>
      ))}
    </div>
  );
}

export function AudioPage() {
  const cfg = useStore((s) => s.project!.project.audio);
  const cueLists = useStore((s) => s.project!.project.cueLists);
  const rt = useStore((s) => s.runtime);
  const [f, setF] = useState<AudioFeatures | null>(audioEngine.last);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>('');
  const [simBpm, setSimBpm] = useState(audioEngine.simBpm);
  const [, force] = useState(0);
  const [beatFlash, setBeatFlash] = useState(false);
  useEffect(() => audioEngine.subscribe((x) => {
    setF(x);
    if (x?.onset) { setBeatFlash(true); setTimeout(() => setBeatFlash(false), 90); }
  }), []);
  useEffect(() => { void audioEngine.devices().then(setDevices); }, []);
  useEffect(() => audioEngine.configure(cfg), [cfg]);
  const save = (next: AudioConfig) => void act({ type: 'audio.config', config: next });
  const r = cfg.reactions;
  const setR = <K extends keyof AudioConfig['reactions']>(k: K, patch: Partial<AudioConfig['reactions'][K]>) => save({ ...cfg, reactions: { ...r, [k]: { ...r[k], ...patch } } });
  const src = audioEngine.source;
  const armed = rt?.audio.dropArmed ?? false;
  const setFl = <K extends keyof AudioConfig['reactions']['followers']>(k: K, patch: Partial<AudioConfig['reactions']['followers'][K]>) => save({ ...cfg, reactions: { ...r, followers: { ...r.followers, [k]: { ...r.followers[k], ...patch } } } });

  return (
    <div className="page">
      <PageHead title="Audio Reactive" subtitle="Analyse du signal audio et réactions lumineuses — chaque réaction est désactivable et désactivée par défaut" />
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <div className="col gap-lg">
          <Panel title="Source">
            <div className="col">
              <div className="row wrap">
                <select className="select" style={{ width: 260 }} value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                  <option value="">Entrée audio par défaut</option>
                  {devices.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Entrée ${i + 1}`}</option>)}
                </select>
                <button className={`btn ${src === 'live' ? 'on' : ''}`} onClick={() => void audioEngine.startLive(deviceId || null).then(() => { force((x) => x + 1); void audioEngine.devices().then(setDevices); })}><Mic size={14} />Écouter</button>
              </div>
              <div className="row">
                <span className="small muted">Simulation</span>
                <div style={{ width: 80 }} title="BPM de la piste simulée"><NumberInput value={simBpm} min={60} max={200} onChange={setSimBpm} /></div>
                <button className={`btn ${src === 'simulated' ? 'on' : ''}`} onClick={() => { audioEngine.startSimulated(simBpm); force((x) => x + 1); }}><Radio size={14} />Simuler une piste</button>
                <button className="btn" disabled={src === 'none'} onClick={() => { audioEngine.stop(); force((x) => x + 1); }}><Square size={14} />Arrêter</button>
              </div>
              {audioEngine.error && <div className="small" style={{ color: '#fca5a5' }}>{audioEngine.error}</div>}
              <div className="small muted">État : {src === 'none' ? 'aucune source' : src === 'simulated' ? <span className="badge warn">SIMULÉ — aucune entrée réelle</span> : src === 'track' ? <span className="badge cyan">morceau analysé (lecteur Musique)</span> : <span className="badge ok">entrée réelle</span>}</div>
            </div>
          </Panel>
          <Panel title="Mesures">
            <div className="col">
              <div className="ctl-row"><span className="lbl">Niveau (mesuré)</span><div className="meter"><div style={{ width: `${(f?.level ?? 0) * 100}%` }} /></div><span className="mono small">{f ? `${f.levelDb.toFixed(0)} dB` : '–'}</span></div>
              <div className="ctl-row"><span className="lbl">Énergie (lissée)</span><div className="meter"><div style={{ width: `${(f?.energy ?? 0) * 100}%` }} /></div><span className="mono small">{f ? f.energy.toFixed(2) : '–'}</span></div>
              <div className="ctl-row"><span className="lbl">Transitoires</span><span className={`led ${beatFlash ? 'ok' : ''}`} style={{ width: 14, height: 14 }} /><span className="mono small">{f ? f.onsetStrength.toFixed(1) : '–'}</span></div>
              <div className="ctl-row" title="Suivi par autocorrélation des attaques dans la plage de tempo du genre (filtre de Kalman). Estimation."><span className="lbl">Tempo (suivi)</span><span className="mono" style={{ fontSize: 18 }} data-testid="audio-bpm">{f?.bpm ?? '—'}</span><span className="small muted">confiance {Math.round((f?.bpmConfidence ?? 0) * 100)} %</span>{f?.tempoLocked && <span className="badge ok">verrouillé</span>}</div>
              <div className="ctl-row"><span className="lbl">Mesure</span>
                <span className="row" style={{ gap: 6 }} data-testid="bar-position">{[0, 1, 2, 3].map((k) => <span key={k} className={`led ${f?.barPosition === k ? (k === 0 ? 'violet' : 'ok') : ''}`} style={{ width: 12, height: 12 }} />)}</span>
                <button className="btn sm" disabled={!f?.bpm} onClick={() => audioEngine.tap()} title="Appuyez exactement sur le 1 d’une mesure : la grille des temps et le premier temps sont recalés"><Crosshair size={12} />Recaler sur le 1</button>
              </div>
              <div className="ctl-row"><span className="lbl">Prédiction</span>
                {f?.prediction ? <span data-testid="prediction"><span className={`badge ${f.prediction.confidence >= 0.8 ? 'violet' : 'warn'}`}>{f.prediction.kind === 'drop' ? 'Drop' : 'Refrain'} dans {f.prediction.inBeats.toFixed(1)} temps</span> <span className="small muted">confiance {Math.round(f.prediction.confidence * 100)} %{f.prediction.source === 'track' ? ' · morceau connu' : ''}</span></span> : <span className="small dim">aucune</span>}
              </div>
              <div className="row">
                <button className="btn sm" disabled={!f?.bpm} onClick={() => f?.bpm && void act({ type: 'engine.bpm', bpm: f.bpm })}>Utiliser comme BPM</button>
                <span className="small dim">BPM moteur : {rt?.engine.bpm.toFixed(0)} ({rt?.engine.bpmSource === 'audio' ? 'suivi audio' : 'manuel'})</span>
              </div>
              <p className="small dim" style={{ margin: 0 }}>La prédiction de drop/refrain combine creux de basse, montée des aigus et fin de phrase de 4 mesures : c’est une estimation (exacte seulement pour un morceau analysé joué par le lecteur Musique).</p>
            </div>
          </Panel>
          <Panel title="Analyse">
            <div className="grid g3">
              <Field label="Sensibilité"><NumberInput value={cfg.sensitivity} min={0.1} max={10} step={0.1} onChange={(v) => save({ ...cfg, sensitivity: v })} /></Field>
              <Field label="Lissage (0–1)"><NumberInput value={cfg.smoothing} min={0} max={1} step={0.05} onChange={(v) => save({ ...cfg, smoothing: v })} /></Field>
              <Field label="Seuil d’attaque"><NumberInput value={cfg.onsetThreshold} min={1} max={5} step={0.1} onChange={(v) => save({ ...cfg, onsetThreshold: v })} /></Field>
              <Field label="Tempo min (genre)" hint="Le suivi ne propose jamais de tempo hors de cette plage (évite les erreurs ×2)."><NumberInput value={cfg.bpmRange.min} min={40} max={250} onChange={(v) => v * 1.2 <= cfg.bpmRange.max && save({ ...cfg, bpmRange: { ...cfg.bpmRange, min: v } })} /></Field>
              <Field label="Tempo max (genre)"><NumberInput value={cfg.bpmRange.max} min={50} max={300} onChange={(v) => v >= cfg.bpmRange.min * 1.2 && save({ ...cfg, bpmRange: { ...cfg.bpmRange, max: v } })} /></Field>
            </div>
          </Panel>
        </div>
        <Panel title="Réactions">
          <div className="col gap-lg">
            <div className="col">
              <label className="check"><input type="checkbox" checked={r.bpmFollow.enabled} onChange={(e) => setR('bpmFollow', { enabled: e.target.checked })} />Suivre le BPM estimé (effets synchronisés)</label>
              <Field label="Confiance minimale"><NumberInput value={r.bpmFollow.minConfidence} min={0} max={1} step={0.05} onChange={(v) => setR('bpmFollow', { minConfidence: v })} /></Field>
            </div>
            <div className="col">
              <label className="check"><input type="checkbox" checked={r.beatFlash.enabled} onChange={(e) => setR('beatFlash', { enabled: e.target.checked })} />Flash d’intensité sur chaque attaque</label>
              <Field label="Décroissance (s)"><NumberInput value={r.beatFlash.decay} min={0.02} max={2} step={0.05} onChange={(v) => setR('beatFlash', { decay: v })} /></Field>
              <TargetPicker value={r.beatFlash.targets} onChange={(t) => setR('beatFlash', { targets: t })} />
            </div>
            <div className="col">
              <label className="check"><input type="checkbox" checked={r.levelToIntensity.enabled} onChange={(e) => setR('levelToIntensity', { enabled: e.target.checked })} />Intensité modulée par l’énergie</label>
              <Field label="Plancher (0–1)"><NumberInput value={r.levelToIntensity.floor} min={0} max={1} step={0.05} onChange={(v) => setR('levelToIntensity', { floor: v })} /></Field>
              <TargetPicker value={r.levelToIntensity.targets} onChange={(t) => setR('levelToIntensity', { targets: t })} />
            </div>
            <div className="col">
              <label className="check"><input type="checkbox" checked={r.energyToColor.enabled} onChange={(e) => setR('energyToColor', { enabled: e.target.checked })} />Couleur selon l’énergie</label>
              <div className="row"><input type="color" value={r.energyToColor.lowColor} onChange={(e) => setR('energyToColor', { lowColor: e.target.value.toUpperCase() })} /><span className="small muted">calme → intense</span><input type="color" value={r.energyToColor.highColor} onChange={(e) => setR('energyToColor', { highColor: e.target.value.toUpperCase() })} /></div>
              <TargetPicker value={r.energyToColor.targets} onChange={(t) => setR('energyToColor', { targets: t })} />
            </div>
            <div className="col">
              <span className="small muted">Suiveurs de bande</span>
              <label className="check"><input type="checkbox" checked={r.followers.intensityFromBass.enabled} onChange={(e) => setFl('intensityFromBass', { enabled: e.target.checked })} />Intensité suivant les basses</label>
              <Field label="Profondeur (0–1)"><NumberInput value={r.followers.intensityFromBass.amount} min={0} max={1} step={0.05} onChange={(v) => setFl('intensityFromBass', { amount: v })} /></Field>
              <TargetPicker value={r.followers.intensityFromBass.targets} onChange={(t) => setFl('intensityFromBass', { targets: t })} />
              <label className="check"><input type="checkbox" checked={r.followers.colorFromBrightness.enabled} onChange={(e) => setFl('colorFromBrightness', { enabled: e.target.checked })} />Couleur suivant la brillance du son</label>
              <div className="row"><input type="color" value={r.followers.colorFromBrightness.darkColor} onChange={(e) => setFl('colorFromBrightness', { darkColor: e.target.value.toUpperCase() })} /><span className="small muted">sourd → brillant</span><input type="color" value={r.followers.colorFromBrightness.brightColor} onChange={(e) => setFl('colorFromBrightness', { brightColor: e.target.value.toUpperCase() })} /></div>
              <TargetPicker value={r.followers.colorFromBrightness.targets} onChange={(t) => setFl('colorFromBrightness', { targets: t })} />
              <label className="check"><input type="checkbox" checked={r.followers.moveFromOnsets.enabled} onChange={(e) => setFl('moveFromOnsets', { enabled: e.target.checked })} />Mouvement suivant la densité d’attaques (lyres)</label>
              <Field label="Amplitude (0–1)"><NumberInput value={r.followers.moveFromOnsets.amount} min={0} max={1} step={0.05} onChange={(v) => setFl('moveFromOnsets', { amount: v })} /></Field>
              <TargetPicker value={r.followers.moveFromOnsets.targets} onChange={(t) => setFl('moveFromOnsets', { targets: t })} />
            </div>
            <div className="col">
              <label className="check"><input type="checkbox" checked={r.dropGo.enabled} onChange={(e) => setR('dropGo', { enabled: e.target.checked })} />GO sur drop / refrain prédit</label>
              <div className="grid g2">
                <Field label="Liste de cues">
                  <select className="select" value={r.dropGo.cueListId ?? ''} onChange={(e) => setR('dropGo', { cueListId: e.target.value || null })}>
                    <option value="">—</option>
                    {cueLists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </Field>
                <Field label="Confiance minimale"><NumberInput value={r.dropGo.minConfidence} min={0.5} max={1} step={0.05} onChange={(v) => setR('dropGo', { minConfidence: v })} /></Field>
              </div>
              <div className="chips">
                {(['drop', 'chorus'] as const).map((k) => <button key={k} className={`chip ${r.dropGo.kinds.includes(k) ? 'on' : ''}`} onClick={() => { const kinds = r.dropGo.kinds.includes(k) ? r.dropGo.kinds.filter((x) => x !== k) : [...r.dropGo.kinds, k]; if (kinds.length) setR('dropGo', { kinds }); }}>{k === 'drop' ? 'Drops' : 'Refrains'}</button>)}
              </div>
              <div className="row">
                <button className={`btn ${armed ? 'danger solid' : ''}`} disabled={!r.dropGo.enabled || !r.dropGo.cueListId} onClick={() => void act({ type: 'audio.armDrop', on: !armed })} data-testid="arm-drop"><TargetIcon size={13} />{armed ? 'Désarmer' : 'Armer (un déclenchement)'}</button>
                {armed && <span className="badge violet">{rt?.audio.dropFiresInMs != null ? `GO dans ${(rt.audio.dropFiresInMs / 1000).toFixed(1)} s` : 'en attente d’une prédiction'}</span>}
              </div>
              <p className="small dim" style={{ margin: 0 }}>Jamais armé au démarrage. Après un déclenchement, la réaction se désarme : réarmez pour le drop suivant.</p>
            </div>
            <div className="col">
              <label className="check"><input type="checkbox" checked={r.energyRiseGo.enabled} onChange={(e) => setR('energyRiseGo', { enabled: e.target.checked })} />GO automatique sur montée d’énergie</label>
              <div className="grid g2">
                <Field label="Liste de cues">
                  <select className="select" value={r.energyRiseGo.cueListId ?? ''} onChange={(e) => setR('energyRiseGo', { cueListId: e.target.value || null })}>
                    <option value="">—</option>
                    {cueLists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </Field>
                <Field label="Rapport d’énergie"><NumberInput value={r.energyRiseGo.ratio} min={1.1} max={5} step={0.1} onChange={(v) => setR('energyRiseGo', { ratio: v })} /></Field>
              </div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
