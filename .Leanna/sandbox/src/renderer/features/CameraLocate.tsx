import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera as CameraIcon, Check, Crosshair, Play, RotateCcw, Smartphone, Square, Video } from 'lucide-react';
import { useStore, confirmAction } from '../store';
import { act, call } from '../api';
import { Field, Modal, NumberInput, useResolved } from '../components/ui';
import { Webcam, grayToDataUrl, photoToGray, videoDevices } from '../vision/capture';
import { calibrate, stageCorners, type Calibration, type Vec2 } from '../../core/vision/geometry';
import type { Gray } from '../../core/vision/image';
import { analyzePatch, crossCheckRdm, decodeSequence, sequenceDuration, sideOf, solvePositions, type Detection, type Located, type PatchFixture, type PatchIssue, type Sequence } from '../../core/vision/locate';
import type { OutputConfig } from '../../core/protocols/config';

interface CapturedView {
  source: 'webcam' | 'photo';
  seq: Sequence;
  images: Gray[];
  clicks: Vec2[];
  calibration: Calibration | null;
}

type Step = 'source' | 'calib' | 'results';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ISSUE_ICON: Record<PatchIssue['kind'], string> = {
  'no-response': '⛔', 'shared-address': '⚠', unidentified: '❓', moved: '↔', swapped: '⇄', 'rdm-model': '🏷', 'rdm-footprint': '🔢', 'rdm-unpatched': '➕', 'rdm-missing': '∅',
};

/** Clickable camera image (stage corners) with the detections overlaid. */
function FrameView({ img, gain, clicks, detections, names, onClick }: { img: Gray; gain: number; clicks: Vec2[]; detections?: Detection[]; names?: Map<string, string>; onClick?: (p: Vec2) => void }) {
  const url = useMemo(() => grayToDataUrl(img, gain), [img, gain]);
  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: 720, cursor: onClick ? 'crosshair' : 'default' }} data-testid="locate-frame"
      onClick={(e) => {
        if (!onClick) return;
        const r = e.currentTarget.getBoundingClientRect();
        onClick([((e.clientX - r.left) / r.width) * img.width, ((e.clientY - r.top) / r.height) * img.height]);
      }}>
      <img src={url} alt="Vue caméra" style={{ width: '100%', display: 'block', borderRadius: 6 }} />
      <svg viewBox={`0 0 ${img.width} ${img.height}`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        {clicks.map((c, i) => <g key={i}><circle cx={c[0]} cy={c[1]} r={6} fill="none" stroke="#22d3ee" strokeWidth={2} /><text x={c[0] + 8} y={c[1] - 6} fill="#22d3ee" fontSize={14}>{i + 1}</text></g>)}
        {clicks.length === 4 && <polygon points={clicks.map((c) => c.join(',')).join(' ')} fill="rgba(34,211,238,.08)" stroke="#22d3ee" strokeDasharray="4 4" />}
        {detections?.map((d, i) => (
          <g key={i}>
            <circle cx={d.pixel[0]} cy={d.pixel[1]} r={7} fill="none" stroke={d.fixtureId ? '#34d399' : '#f87171'} strokeWidth={2} />
            <text x={d.pixel[0] + 9} y={d.pixel[1] + 4} fill={d.fixtureId ? '#34d399' : '#f87171'} fontSize={12}>{d.fixtureId ? names?.get(d.fixtureId) ?? '?' : '?'}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export function CameraLocate({ onClose }: { onClose: () => void }) {
  const { fixtures } = useResolved();
  const project = useStore((s) => s.project!.project);
  const rt = useStore((s) => s.runtime);
  const [step, setStep] = useState<Step>('source');
  const [source, setSource] = useState<'webcam' | 'photo'>('webcam');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [mode, setMode] = useState<'binary' | 'sequential'>('binary');
  const [level, setLevel] = useState(0.4);
  const [heightMode, setHeightMode] = useState<'patch' | 'truss'>('patch');
  const [truss, setTruss] = useState(6);
  const [views, setViews] = useState<CapturedView[]>([]);
  const [progress, setProgress] = useState<{ frame: number; total: number; label: string } | null>(null);
  const [gain, setGain] = useState(3);
  const [showRef, setShowRef] = useState(false);
  const [outputs, setOutputs] = useState<Extract<OutputConfig, { kind: 'artnet' }>[]>([]);
  const [rdmTarget, setRdmTarget] = useState('');
  const [rdmIssues, setRdmIssues] = useState<PatchIssue[]>([]);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const videoRef = useRef<HTMLVideoElement>(null);
  const cam = useRef<Webcam | null>(null);
  const cancel = useRef(false);
  const view = views[views.length - 1];
  const names = useMemo(() => new Map(fixtures.map((f) => [f.fixture.id, f.fixture.name])), [fixtures]);
  const W = project.visualizer.stageWidth, D = project.visualizer.stageDepth;
  const corners = stageCorners(W, D);
  const binaryFrames = 2 + 2 * Math.ceil(Math.log2(fixtures.length + 1));

  useEffect(() => {
    void videoDevices().then(setDevices);
    void act({ type: 'settings.get' }).then((s) => {
      const a = (s?.outputs ?? []).filter((o): o is Extract<OutputConfig, { kind: 'artnet' }> => o.kind === 'artnet');
      setOutputs(a);
      if (a[0]) setRdmTarget(`${a[0].id}|${a[0].universeMap[0]?.local ?? 1}`);
    });
    return () => { cam.current?.stop(); cancel.current = true; void act({ type: 'locate.end' }); };
  }, []);

  const startPreview = async () => {
    if (!videoRef.current) return;
    cam.current ??= new Webcam(videoRef.current);
    try {
      await cam.current.start(deviceId || null);
      void videoDevices().then(setDevices);
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: 'Caméra indisponible', detail: (err as Error).message });
    }
  };

  const waitPhoto = (frame: number) => new Promise<Gray>((resolve, reject) => {
    const tick = setInterval(() => {
      if (!cancel.current) return;
      clearInterval(tick);
      off();
      reject(new Error('Séquence annulée'));
    }, 200);
    const off = window.luma.on((name, payload) => {
      if (name !== 'locatePhoto' || (payload as { frame: number }).frame !== frame) return;
      clearInterval(tick);
      off();
      void photoToGray((payload as { jpeg: string }).jpeg).then(resolve, reject);
    });
  });

  const run = async () => {
    if (source === 'webcam' && !cam.current?.active) {
      useStore.getState().toast({ kind: 'warn', title: 'Démarrez d’abord la caméra' });
      return;
    }
    const frames = mode === 'binary' ? binaryFrames : 2 + fixtures.length;
    const ok = await confirmAction({
      title: 'Lancer la séquence de localisation',
      message: `${fixtures.length} projecteurs vont s’allumer selon ${frames} motifs successifs (environ ${Math.ceil(sequenceDuration(frames))} s${source === 'photo' ? ', plus le temps des photos' : ''}).\n• Intensité limitée à ${Math.round(level * 100)} %, lumière blanche, aucun strobe.\n• Le programmeur est relâché ; cues, effets et IA sont masqués pendant la séquence.\n• Personne ne doit regarder les projecteurs de près. Les sorties armées émettent réellement.`,
      confirmLabel: 'Lancer',
    });
    if (!ok) return;
    cancel.current = false;
    let begin;
    try {
      begin = await call({ type: 'locate.begin', confirmed: true, mode, level, photo: source === 'photo' });
    } catch {
      return;
    }
    const images: Gray[] = [];
    try {
      for (let i = 0; i < begin.frames.length; i++) {
        if (cancel.current) throw new Error('Séquence annulée');
        setProgress({ frame: i, total: begin.frames.length, label: begin.frames[i]!.label });
        await call({ type: 'locate.frame', index: i });
        if (source === 'webcam') {
          await sleep(begin.settleMs);
          images.push(await cam.current!.grab(3));
        } else images.push(await waitPhoto(i));
      }
    } catch (err) {
      useStore.getState().toast({ kind: 'warn', title: 'Localisation interrompue', detail: (err as Error).message });
      return;
    } finally {
      await act({ type: 'locate.end' });
      setProgress(null);
    }
    const seq: Sequence = { mode: begin.mode, fixtureIds: begin.fixtureIds, frames: begin.frames, codes: begin.codes, bits: begin.bits };
    setViews((v) => [...v, { source, seq, images, clicks: [], calibration: null }]);
    setStep('calib');
  };

  const click = (p: Vec2) => {
    if (!view || view.clicks.length >= 4) return;
    const clicks = [...view.clicks, p];
    let calibration: Calibration | null = null;
    if (clicks.length === 4) {
      try {
        calibration = calibrate(corners.map((c, i) => ({ world: c.world, image: clicks[i]! })), view.images[0]!.width, view.images[0]!.height);
      } catch (err) {
        useStore.getState().toast({ kind: 'error', title: 'Calibration impossible', detail: (err as Error).message });
      }
    }
    setViews((vs) => vs.map((v, i) => (i === vs.length - 1 ? { ...v, clicks, calibration } : v)));
  };

  const patch: PatchFixture[] = useMemo(() => fixtures.map((rf) => ({
    id: rf.fixture.id, name: rf.fixture.name, universe: rf.fixture.universe, address: rf.fixture.address, channels: rf.mode.channels.length,
    position: rf.fixture.position, height: rf.fixture.height, manufacturer: rf.profile.manufacturer, model: rf.profile.name,
  })), [fixtures]);

  const result = useMemo(() => {
    const ready = views.filter((v) => v.calibration);
    if (step !== 'results' || !ready.length) return null;
    const solved = ready.map((v) => ({ camera: v.calibration!.camera, detections: decodeSequence(v.images, v.seq) }));
    const heightOf = (id: string) => {
      const f = patch.find((x) => x.id === id)!;
      return heightMode === 'truss' && f.height >= 1 ? truss : f.height;
    };
    const located = solvePositions(solved, heightOf);
    return { solved, located, issues: analyzePatch(patch, solved, located) };
  }, [views, step, patch, heightMode, truss]);

  const apply = async () => {
    if (!result) return;
    const updates = result.located.filter((l) => !skip.has(l.fixtureId)).map((l: Located) => ({
      fixtureId: l.fixtureId, x: l.position[0], y: l.position[1],
      height: l.method === 'triangulated' ? Math.max(0, l.position[2]) : heightMode === 'truss' ? l.position[2] : undefined,
    }));
    if (!updates.length) return;
    const r = await act({ type: 'locate.apply', updates });
    if (r) useStore.getState().toast({ kind: 'success', title: `${r.updated} position(s) mise(s) à jour`, detail: 'Les rotations ne sont pas mesurées par la caméra : vérifiez-les dans le patch.' });
  };

  const runRdm = async () => {
    const [outputId = '', u = '1'] = rdmTarget.split('|');
    const r = await act({ type: 'rdm.discover', outputId, universe: Number(u) });
    if (r) setRdmIssues(crossCheckRdm(patch, r.devices, Number(u)));
  };

  const footer = step === 'results' && result ? (
    <>
      <button className="btn" onClick={() => setStep('source')} title="Déplacez la caméra puis relancez : les positions seront triangulées (hauteurs mesurées)"><CameraIcon size={14} />Ajouter une vue</button>
      <button className="btn primary" disabled={!result.located.length} onClick={() => void apply()} data-testid="locate-apply"><Check size={14} />Appliquer au patch ({result.located.filter((l) => !skip.has(l.fixtureId)).length})</button>
    </>
  ) : <button className="btn" onClick={onClose}>Fermer</button>;

  return (
    <Modal title="Localiser les projecteurs par caméra" onClose={onClose} wide footer={footer}>
      <div className="row" style={{ gap: 6, marginBottom: 10 }}>
        {(['source', 'calib', 'results'] as const).map((s, i) => <span key={s} className={`badge ${step === s ? 'violet' : ''}`}>{i + 1}. {s === 'source' ? 'Caméra et séquence' : s === 'calib' ? 'Calibration' : 'Résultats'}</span>)}
        {views.length > 0 && <span className="small dim">{views.length} vue(s){views.length >= 2 ? ' — triangulation 3D' : ''}</span>}
      </div>

      {step === 'source' && (
        <div className="col gap-lg">
          <div className="chips">
            <button className={`chip ${source === 'webcam' ? 'on' : ''}`} onClick={() => setSource('webcam')}><Video size={12} /> Webcam</button>
            <button className={`chip ${source === 'photo' ? 'on' : ''}`} onClick={() => setSource('photo')}><Smartphone size={12} /> Smartphone (télécommande)</button>
          </div>
          {source === 'webcam' ? (
            <div className="col">
              <div className="row">
                <select className="select" style={{ width: 300 }} value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                  <option value="">Caméra par défaut</option>
                  {devices.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Caméra ${i + 1}`}</option>)}
                </select>
                <button className="btn" onClick={() => void startPreview()} data-testid="locate-preview"><Play size={13} />Démarrer la caméra</button>
              </div>
              <video ref={videoRef} muted playsInline style={{ width: '100%', maxWidth: 640, background: '#000', borderRadius: 6 }} />
              <p className="small dim" style={{ margin: 0 }}>Posez la caméra sur un pied, face au plateau : les 4 coins du plateau et tous les projecteurs doivent être dans le cadre. Elle ne doit plus bouger jusqu’à la fin.</p>
            </div>
          ) : (
            <p className="small" style={{ margin: 0 }}>Activez la télécommande (<i>Settings › Contrôle externe</i>) et ouvrez-la sur le téléphone. Pendant la séquence, elle demande une photo par image : gardez le téléphone immobile (pied ou appui) pour toutes les photos.</p>
          )}
          <div className="grid g3">
            <Field label="Méthode">
              <select className="select" value={mode} onChange={(e) => setMode(e.target.value as 'binary' | 'sequential')}>
                <option value="binary">Codage binaire ({binaryFrames} images)</option>
                <option value="sequential">Un par un ({2 + fixtures.length} images)</option>
              </select>
            </Field>
            <Field label="Intensité (max 60 %)"><NumberInput value={Math.round(level * 100)} min={5} max={60} onChange={(v) => setLevel(v / 100)} /></Field>
            <Field label="Hauteur (1 vue)" hint="Avec une seule vue, la hauteur doit être connue ; avec 2 vues elle est mesurée.">
              <div className="row">
                <select className="select" value={heightMode} onChange={(e) => setHeightMode(e.target.value as 'patch' | 'truss')}>
                  <option value="patch">Hauteurs du patch</option>
                  <option value="truss">Pont à hauteur fixe</option>
                </select>
                {heightMode === 'truss' && <div style={{ width: 70 }}><NumberInput value={truss} min={1} max={30} step={0.1} onChange={setTruss} /></div>}
              </div>
            </Field>
          </div>
          {progress ? (
            <div className="col">
              <div className="row">
                <span className="badge violet">Image {progress.frame + 1}/{progress.total}</span><span>{progress.label}</span>
                {source === 'photo' && rt?.locate?.awaitingPhoto && <span className="badge warn">Prenez la photo sur le téléphone</span>}
                <button className="btn sm" onClick={() => { cancel.current = true; }}><Square size={12} />Annuler</button>
              </div>
              <div className="meter"><div style={{ width: `${((progress.frame + 1) / progress.total) * 100}%` }} /></div>
            </div>
          ) : <button className="btn primary" onClick={() => void run()} data-testid="locate-run"><Crosshair size={14} />Lancer la séquence</button>}
        </div>
      )}

      {step === 'calib' && view && (
        <div className="col">
          <p style={{ margin: 0 }}>{view.clicks.length < 4 ? <>Cliquez sur : <b>{corners[view.clicks.length]!.label}</b> ({view.clicks.length + 1}/4)</> : view.calibration ? <>Calibration : erreur de reprojection <b>{view.calibration.rms.toFixed(1)} px</b>{view.calibration.rms > 4 ? ' — élevée : recommencez les clics' : ''}</> : 'Calibration impossible : recommencez.'}</p>
          <div className="row">
            <label className="check"><input type="checkbox" checked={showRef} onChange={(e) => setShowRef(e.target.checked)} />Image « tout allumé »</label>
            <span className="small muted">Luminosité</span><div style={{ width: 70 }}><NumberInput value={gain} min={1} max={10} onChange={setGain} /></div>
            <button className="btn sm" onClick={() => setViews((vs) => vs.map((v, i) => (i === vs.length - 1 ? { ...v, clicks: [], calibration: null } : v)))}><RotateCcw size={12} />Recommencer les clics</button>
            <button className="btn primary sm" disabled={!view.calibration} onClick={() => setStep('results')} data-testid="locate-solve">Calculer les positions</button>
          </div>
          <FrameView img={view.images[showRef ? 1 : 0]!} gain={showRef ? 1 : gain} clicks={view.clicks} onClick={click} />
          <p className="small dim" style={{ margin: 0 }}>Plateau du projet : {W} × {D} m (modifiable dans Stage Visualizer). Les coins cliqués doivent correspondre à ces dimensions.</p>
        </div>
      )}

      {step === 'results' && result && (
        <div className="col gap-lg">
          <FrameView img={views[views.length - 1]!.images[1]!} gain={1} clicks={[]} detections={result.solved[result.solved.length - 1]!.detections} names={names} />
          <div className="small" data-testid="locate-summary">{result.located.length}/{fixtures.length} projecteurs localisés · {result.solved.reduce((n, s) => n + s.detections.length, 0)} taches détectées</div>
          {(result.issues.length > 0 || rdmIssues.length > 0) && (
            <div className="panel" style={{ padding: 10 }} data-testid="locate-issues">
              {[...result.issues, ...rdmIssues].map((i, k) => <div key={k} className="small">{ISSUE_ICON[i.kind]} {i.message}</div>)}
            </div>
          )}
          <table className="table small" data-testid="locate-table">
            <thead><tr><th /><th>Projecteur</th><th>Adresse</th><th>Patch (x / y / h)</th><th>Mesuré</th><th>Écart</th><th>Incertitude</th></tr></thead>
            <tbody>
              {result.located.map((l) => {
                const f = patch.find((x) => x.id === l.fixtureId)!;
                const d = Math.hypot(l.position[0] - f.position.x, l.position[1] - f.position.y);
                return (
                  <tr key={l.fixtureId}>
                    <td><input type="checkbox" checked={!skip.has(l.fixtureId)} onChange={() => setSkip((s) => { const n = new Set(s); if (n.has(l.fixtureId)) n.delete(l.fixtureId); else n.add(l.fixtureId); return n; })} /></td>
                    <td>{f.name}</td>
                    <td className="mono">U{f.universe}.{f.address}</td>
                    <td className="mono">{f.position.x.toFixed(1)} / {f.position.y.toFixed(1)} / {f.height.toFixed(1)}</td>
                    <td className="mono">{l.position[0].toFixed(2)} / {l.position[1].toFixed(2)} / {l.position[2].toFixed(2)} <span className="dim">{sideOf(l.position[0])}</span>{l.method === 'triangulated' && <span className="badge cyan" style={{ marginLeft: 4 }}>{l.views} vues</span>}</td>
                    <td className="mono" style={d > 1 ? { color: '#fcd34d' } : undefined}>{d.toFixed(2)} m</td>
                    <td className="mono dim">± {(l.uncertainty * 100).toFixed(0)} cm</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="row">
            <span className="small muted">Croisement RDM</span>
            {outputs.length ? (
              <>
                <select className="select" value={rdmTarget} onChange={(e) => setRdmTarget(e.target.value)}>
                  {outputs.flatMap((o) => o.universeMap.map((m) => <option key={`${o.id}|${m.local}`} value={`${o.id}|${m.local}`}>{o.name} · univers {m.local}</option>))}
                </select>
                <button className="btn sm" onClick={() => void runRdm()}>Découvrir et comparer</button>
              </>
            ) : <span className="small dim">ajoutez une sortie Art-Net pour comparer modèle / adresse / position via RDM</span>}
          </div>
          <p className="small dim" style={{ margin: 0 }}>Les rotations de montage ne sont pas mesurables à partir d’un point lumineux : elles restent celles du patch (le focus automatique des lyres est prévu en 3.2).</p>
        </div>
      )}
    </Modal>
  );
}
