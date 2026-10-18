import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectSchema, type Fixture, type FixtureProfile, type FixtureValues, type Project } from '../model/schemas';
import { ProjectIndex } from '../engine/resolve';
import { Engine, type EngineSettings } from '../engine/Engine';
import { OutputManager, createAdapter, type AdapterFactory } from '../protocols/OutputManager';
import { localIpv4Addresses } from '../protocols/artnet';
import { listSerialPorts } from '../protocols/enttec';
import { VirtualOutput } from '../protocols/virtual';
import type { OutputState } from '../protocols/types';
import { attributeClass } from '../fixtures/attributes';
import { colorToAttributes } from '../fixtures/color';
import { findModule } from '../fixtures/modules';
import { convertMa2Fixture, mergeProfileModes } from '../fixtures/ma2';
import { channelCount, parseProfileFile } from '../fixtures/profiles';
import { BUILTIN_PROFILES } from '../fixtures/builtinProfiles';
import { convertOflFixture, oflFetchFixture, oflFixtureKeys, oflManufacturers } from '../fixtures/ofl';
import { findFreeAddress, validatePatch } from '../fixtures/patch';
import { createProject, ProjectLoadError, serializeProject } from '../project/format';
import { buildDemo } from '../demo/projects';
import { listRecovery, loadProjectFile, saveProjectFile, writeFileAtomic } from '../project/store';
import { defaultSettings, settingsSchema, type Settings } from '../settings/settings';
import { Logger, type LogEntry } from '../log/logger';
import { AudioReactive } from '../audio/reactive';
import { hexToRgb } from '../util/math';
import type { AiProposal } from '../ai/actions';
import { buildProposal, executeProposal, guardProposalFlashes, interpreterContext, liveState, proposeLocally } from '../ai/director';
import { FlashDetector, stageLight, type FlashStatus } from '../safety/flashGuard';
import { buildVisualModel } from '../visualizer/model';
import { followTruss } from '../visualizer/truss';
import { OscServer, type OscMessage } from '../control/osc';
import { RemoteServer, type RemoteState } from '../control/remote';
import { ArtNetRdm } from '../protocols/rdm';
import { adjustSection, compileShow, planLocally, rigInfo } from '../music/songToShow';
import { KEY_NAMES, SECTION_NAMES } from '../music/analyze';
import type { MusicTrack, ShowPlan } from '../model/schemas';
import { buildSequence, FRAME_CAPTURE_MS, FRAME_SETTLE_MS, type Sequence } from '../vision/locate';
import { coarseChannel, rangeValue } from '../fixtures/profiles';
import { interpretLocally } from '../ai/local/interpreter';
import { DEFAULT_OPENROUTER_MODEL, describeRig, listOpenRouterModels, planShowWithOpenRouter, proposeWithOpenRouter, type OpenRouterModel } from '../ai/providers/openrouter';
import type { Alert, Command, CommandOf, CommandResults, CommandType, LocatePhoto, ProjectState, RuntimeState, UniverseView, ValuesFrame } from '../../shared/commands';

export interface Dialogs {
  openProject(): Promise<string | null>;
  saveProject(defaultName: string): Promise<string | null>;
  openProfile(): Promise<string | null>;
}

export interface SecretStore {
  get(name: string): string | null;
  set(name: string, value: string | null): void;
}

export interface AppServiceOptions {
  dataDir: string;
  dialogs: Dialogs;
  secrets: SecretStore;
  adapterFactory?: AdapterFactory;
  /** Start the real-time scheduler. Tests drive `engine.tick()` manually instead. */
  autoStart?: boolean;
  /** RDM over Art-Net ports (tests use a simulated node on other ports). */
  rdm?: { listenPort: number; nodePort: number; timeoutMs?: number };
}

export class UserError extends Error {}

/** Fixture fields that make up the scene layout (undone/redone together with the visualizer settings). */
const SCENE_FIELDS = ['position', 'height', 'rotation', 'mount', 'mountTilt', 'trussId'] as const;
type SceneFields = Pick<Fixture, (typeof SCENE_FIELDS)[number]>;
interface SceneSnapshot { visualizer: Project['visualizer']; fixtures: Record<string, SceneFields> }
const SCENE_HISTORY_MAX = 100;

const OPENROUTER_KEY = 'openrouter-api-key';

/**
 * Application service: owns the project document, the engine, the outputs, AI and audio.
 * Independent from Electron (dialogs and secrets are injected), so the whole workflow is testable headless.
 */
export class AppService extends EventEmitter<{ project: [ProjectState]; runtime: [RuntimeState]; values: [ValuesFrame]; log: [LogEntry]; locatePhoto: [LocatePhoto] }> {
  readonly logger = new Logger();
  readonly outputs: OutputManager;
  readonly engine: Engine;
  private readonly audio: AudioReactive;
  private project: Project;
  private index: ProjectIndex;
  private projectPath: string | null = null;
  private revision = 0;
  private savedRevision = 0;
  /** Scene-layout history: positions/mounting of the fixtures and the visualizer settings before each scene edit. */
  private sceneUndo: SceneSnapshot[] = [];
  private sceneRedo: SceneSnapshot[] = [];
  private settings: Settings = defaultSettings();
  private readonly proposals = new Map<string, AiProposal>();
  private aiBusy = false;
  private aiLastError: string | null = null;
  private lastAiApply = 0;
  private readonly alerts: Alert[] = [];
  private readonly timers: NodeJS.Timeout[] = [];
  private lastAutosave = Date.now();
  private lastValuesEmit = 0;
  private lastSourcesEmit = 0;
  private lastRuntimeEmit = 0;
  private readonly outputStates = new Map<string, OutputState>();
  private flashDetector = new FlashDetector();
  private flash: FlashStatus = { flashesPerSecond: 0, redFlashesPerSecond: 0, violation: false, reason: null };
  private lastFlashLog = 0;
  readonly osc = new OscServer();
  private oscConfig = '';
  readonly remote = new RemoteServer({
    state: () => this.remoteState(),
    execute: (cmd) => this.handle(cmd),
    listId: (i) => this.project.cueLists[i - 1]?.id,
    locatePhoto: (frame, jpeg) => this.onLocatePhoto(frame, jpeg),
  });
  private locate: { seq: Sequence; level: number; frame: number; photo: boolean; awaitingPhoto: boolean } | null = null;
  private remoteConfig = '';
  private timecodeAt = 0;

  constructor(private readonly opts: AppServiceOptions) {
    super();
    this.project = createProject('Nouveau projet');
    this.index = new ProjectIndex(this.project);
    this.outputs = new OutputManager(opts.adapterFactory ?? ((c) => createAdapter(c, this.settings.sacn?.cid)));
    this.engine = new Engine(this.index, this.outputs, this.engineSettings());
    this.audio = new AudioReactive(this.engine, () => this.index, () => this.project.audio, () => this.settings.engine.priorities.audio);
    this.audio.onDropFired = (id) => this.logger.info('Audio', `Drop prédit : GO sur « ${this.project.cueLists.find((l) => l.id === id)?.name ?? id} » (désarmé)`);
    this.logger.on('entry', (e) => {
      if (e.level === 'warn' || e.level === 'error') {
        this.alerts.push({ id: e.id, t: e.t, level: e.level, message: `${e.source} : ${e.message}` });
        if (this.alerts.length > 30) this.alerts.shift();
      }
      this.emit('log', e);
    });
    this.engine.on('error', (err) => this.logger.error('Moteur', err.message));
    this.engine.on('frame', () => this.onFrame());
    this.outputs.on('status', () => this.onOutputStatus());
    this.osc.on('message', (m, ack) => void this.onOsc(m).then(ack, (err: Error) => { this.logger.warn('OSC', `${m.address} : ${err.message}`); ack(false); }));
    this.osc.on('error', (err) => this.logger.warn('OSC', err.message));
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  private get settingsFile() { return path.join(this.opts.dataDir, 'settings.json'); }
  private get autosaveDir() { return path.join(this.opts.dataDir, 'autosave'); }

  async init(): Promise<void> {
    await fs.mkdir(this.opts.dataDir, { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(this.settingsFile, 'utf8')) as unknown;
      const parsed = settingsSchema.safeParse(raw);
      if (parsed.success) this.settings = parsed.data;
      else {
        await fs.copyFile(this.settingsFile, `${this.settingsFile}.invalid`).catch(() => undefined);
        this.logger.warn('Paramètres', `Fichier de paramètres invalide, valeurs par défaut utilisées (copie : settings.json.invalid) — ${parsed.error.issues[0]?.message ?? ''}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.logger.warn('Paramètres', `Lecture impossible : ${(err as Error).message}`);
    }
    if (!this.settings.sacn) this.settings.sacn = { cid: randomUUID() };
    this.settings.control.remote.token ??= randomUUID();
    await this.persistSettings();
    this.logger.level = this.settings.logs.level;
    this.engine.updateSettings(this.engineSettings());
    await this.outputs.configure(this.settings.outputs);
    await this.applyControl();
    if (this.opts.autoStart !== false) this.engine.start();
    this.timers.push(setInterval(() => void this.autosave(), 15000));
    this.logger.info('Application', 'Démarrage terminé — sorties réelles désarmées par défaut');
    this.emitProject();
  }

  async dispose(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.engine.stop();
    this.endLocate();
    await this.osc.stop();
    await this.remote.stop();
    await this.outputs.closeAll();
  }

  get dirty(): boolean {
    return this.revision !== this.savedRevision;
  }

  private engineSettings(): EngineSettings {
    const e = this.settings.engine;
    return { rateHz: e.rateHz, blackoutPolicy: e.blackoutPolicy, maxStrobeHz: e.maxStrobeHz, flashGuard: e.flashGuard, priorities: e.priorities };
  }

  private async persistSettings(): Promise<void> {
    await writeFileAtomic(this.settingsFile, JSON.stringify(this.settings, null, 2), false);
  }

  getSettings(): Settings {
    return structuredClone(this.settings);
  }

  /* ------------------------------------------------------------------ */
  /* State & events                                                      */
  /* ------------------------------------------------------------------ */

  projectState(): ProjectState {
    return {
      project: this.project, path: this.projectPath, dirty: this.dirty, revision: this.revision, issues: validatePatch(this.index.lib, this.project.patch),
      sceneHistory: { undo: this.sceneUndo.length, redo: this.sceneRedo.length },
    };
  }

  runtimeState(): RuntimeState {
    return {
      engine: this.engine.snapshot(),
      outputs: this.outputs.status(),
      transmitting: this.outputs.transmitting,
      liveMode: this.outputs.liveMode,
      ai: { provider: this.settings.ai.provider, hasKey: !!this.opts.secrets.get(OPENROUTER_KEY), busy: this.aiBusy, lastError: this.aiLastError, model: this.settings.ai.model },
      audio: this.audio.status(),
      alerts: [...this.alerts],
      safety: { flashGuard: this.settings.engine.flashGuard, ...this.flash },
      locate: this.locate ? { active: true, frame: this.locate.frame, total: this.locate.seq.frames.length, label: this.locate.seq.frames[this.locate.frame]?.label ?? '', awaitingPhoto: this.locate.awaitingPhoto } : null,
      programmer: this.engine.getProgrammer(),
    };
  }

  private emitProject(): void {
    this.emit('project', this.projectState());
  }

  private onFrame(): void {
    const now = Date.now();
    this.watchFlashes(now);
    // Timecode lost for 0.5 s: freewheel stops, the timeline pauses where it is.
    if (this.timecodeAt && now - this.timecodeAt > 500) {
      this.timecodeAt = 0;
      this.engine.timelinePause();
    }
    if (now - this.lastValuesEmit >= 40) {
      this.lastValuesEmit = now;
      const frame: ValuesFrame = { values: this.engine.values };
      if (now - this.lastSourcesEmit >= 200) {
        this.lastSourcesEmit = now;
        frame.sources = this.engine.sources;
      }
      this.emit('values', frame);
    }
    if (now - this.lastRuntimeEmit >= 100) {
      this.lastRuntimeEmit = now;
      this.emit('runtime', this.runtimeState());
    }
  }

  /** Live photosensitive monitoring of the computed state (every engine frame). */
  private watchFlashes(now: number): void {
    if (this.settings.engine.flashGuard === 'off') return;
    const was = this.flash.violation;
    this.flash = this.flashDetector.push(this.engine.time / 1000, stageLight(buildVisualModel([...this.index.fixtures.values()], this.engine.values)));
    if (this.flash.violation && !was && now - this.lastFlashLog > 5000) {
      this.lastFlashLog = now;
      this.logger.warn('Sécurité', `Garde-fou photosensible : ${this.flash.reason}${this.settings.engine.flashGuard === 'limit' ? ' — limitation active' : ' — passez le garde-fou en mode « Limiter » pour l’atténuer automatiquement'}`);
    }
  }

  private onOutputStatus(): void {
    for (const s of this.outputs.status()) {
      const prev = this.outputStates.get(s.id);
      if (prev === s.state) continue;
      this.outputStates.set(s.id, s.state);
      if (s.state === 'error') this.logger.error(`Sortie ${s.name}`, `${s.detail} — reconnexion automatique programmée`);
      else if (s.state === 'ready' && prev === 'error') this.logger.info(`Sortie ${s.name}`, 'Connexion rétablie');
      else if (s.state === 'ready' && s.real) this.logger.warn(`Sortie ${s.name}`, 'Sortie réelle ARMÉE : les valeurs DMX sont émises vers le matériel');
      else if (s.state === 'disarmed' && s.real && prev === 'ready') this.logger.info(`Sortie ${s.name}`, 'Sortie réelle désarmée');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Project mutation                                                    */
  /* ------------------------------------------------------------------ */

  /** Applies a mutation on a draft, re-validates the whole document, then swaps it in. Invalid drafts are rejected. */
  private mutate(fn: (draft: Project) => void): void {
    const draft = structuredClone(this.project);
    fn(draft);
    draft.meta.modifiedAt = new Date().toISOString();
    const parsed = projectSchema.safeParse(draft);
    if (!parsed.success) throw new UserError(`Modification refusée : ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join(' ; ')}`);
    this.setProject(parsed.data, false);
  }

  private setProject(p: Project, reset: boolean): void {
    this.project = p;
    this.index = new ProjectIndex(p);
    if (reset) {
      this.sceneUndo = [];
      this.sceneRedo = [];
      this.engine.stopAllPlaybacks();
      this.engine.stopAllEffects();
      this.engine.timelineStop();
      this.engine.releaseAi();
      this.engine.releaseProgrammer();
      this.engine.bpm = p.show.bpm;
      this.proposals.clear();
    }
    this.engine.setIndex(this.index);
    this.revision++;
    if (reset) this.savedRevision = this.revision;
    this.emitProject();
  }

  private sceneSnapshot(): SceneSnapshot {
    const fixtures: SceneSnapshot['fixtures'] = {};
    for (const f of this.project.patch) fixtures[f.id] = structuredClone(Object.fromEntries(SCENE_FIELDS.map((k) => [k, f[k]])) as SceneFields);
    return { visualizer: structuredClone(this.project.visualizer), fixtures };
  }

  /** Mutation recorded in the scene history (undoable); the history is untouched when the mutation is refused. */
  private sceneMutate(fn: (draft: Project) => void): void {
    const undo = this.sceneUndo, redo = this.sceneRedo;
    this.sceneUndo = [...undo, this.sceneSnapshot()].slice(-SCENE_HISTORY_MAX);
    this.sceneRedo = [];
    try {
      this.mutate(fn);
    } catch (err) {
      this.sceneUndo = undo;
      this.sceneRedo = redo;
      throw err;
    }
  }

  /** Restores a scene snapshot; fixtures added since keep their placement, removed ones are ignored. */
  private restoreScene(snap: SceneSnapshot): void {
    this.mutate((d) => {
      d.visualizer = structuredClone(snap.visualizer);
      for (const f of d.patch) {
        const prev = snap.fixtures[f.id];
        if (!prev) continue;
        for (const k of SCENE_FIELDS) {
          if (prev[k] === undefined) delete f[k];
          else Object.assign(f, { [k]: structuredClone(prev[k]) });
        }
        if (f.trussId && !d.visualizer.trusses.some((t) => t.id === f.trussId)) f.trussId = null;
      }
    });
  }

  getProject(): Project {
    return this.project;
  }

  /* ------------------------------------------------------------------ */
  /* Commands                                                            */
  /* ------------------------------------------------------------------ */

  async execute<T extends CommandType>(cmd: CommandOf<T>): Promise<CommandResults[T]> {
    return (await this.handle(cmd as Command)) as CommandResults[T];
  }

  private async handle(cmd: Command): Promise<unknown> {
    const ok = { ok: true } as const;
    const e = this.engine;
    switch (cmd.type) {
      /* ---------- project ---------- */
      case 'project.get': return this.projectState();
      case 'project.new':
        this.setProject(createProject(cmd.name), true);
        this.projectPath = null;
        this.logger.info('Projet', `Nouveau projet « ${cmd.name} »`);
        this.emitProject();
        return ok;
      case 'project.open':
      case 'project.openRecovery': {
        const file = cmd.type === 'project.open' ? cmd.path ?? (await this.opts.dialogs.openProject()) : cmd.file;
        if (!file) return { opened: false, migratedFrom: null };
        try {
          const { project, migratedFrom } = await loadProjectFile(file);
          this.setProject(project, true);
          this.projectPath = cmd.type === 'project.open' ? file : null;
          if (cmd.type === 'project.open') this.addRecent(file);
          this.logger.info('Projet', `Ouvert : ${path.basename(file)}${migratedFrom ? ` (migré depuis le format v${migratedFrom})` : ''}`);
          if (cmd.type === 'project.openRecovery') this.revision++; // recovered data is unsaved until saved explicitly
          this.emitProject();
          return { opened: true, migratedFrom };
        } catch (err) {
          if (err instanceof ProjectLoadError) {
            this.logger.error('Projet', `${err.message}${err.details.length ? ` — ${err.details.slice(0, 3).join(' ; ')}` : ''}`);
            throw new UserError(`${err.message}${err.kind === 'corrupt-json' || err.kind === 'invalid-format' ? '. Une copie de récupération est peut-être disponible (Paramètres › Sauvegardes).' : ''}`);
          }
          throw err;
        }
      }
      case 'project.save':
        if (!this.projectPath) return this.handle({ type: 'project.saveAs' });
        await saveProjectFile(this.projectPath, this.project);
        this.savedRevision = this.revision;
        await this.clearAutosave();
        this.logger.info('Projet', `Enregistré : ${path.basename(this.projectPath)}`);
        this.emitProject();
        return { path: this.projectPath };
      case 'project.saveAs':
      case 'project.export': {
        const file = cmd.path ?? (await this.opts.dialogs.saveProject(this.project.meta.name));
        if (!file) return { path: null };
        await saveProjectFile(file, this.project);
        if (cmd.type === 'project.saveAs') {
          this.projectPath = file;
          this.savedRevision = this.revision;
          this.addRecent(file);
          await this.clearAutosave();
        }
        this.logger.info('Projet', `${cmd.type === 'project.export' ? 'Exporté' : 'Enregistré'} : ${path.basename(file)}`);
        this.emitProject();
        return { path: file };
      }
      case 'scene.undo':
      case 'scene.redo': {
        const from = cmd.type === 'scene.undo' ? this.sceneUndo : this.sceneRedo;
        const to = cmd.type === 'scene.undo' ? this.sceneRedo : this.sceneUndo;
        const snap = from.pop();
        if (!snap) return ok;
        to.push(this.sceneSnapshot());
        this.restoreScene(snap);
        return ok;
      }
      case 'project.update':
        (cmd.visualizer ? this.sceneMutate.bind(this) : this.mutate.bind(this))((d) => {
          if (cmd.visualizer?.trusses) {
            // Hung fixtures follow their truss; fixtures of a removed truss stay in place, detached.
            const next = new Map(cmd.visualizer.trusses.map((t) => [t.id, t]));
            for (const before of d.visualizer.trusses) {
              const after = next.get(before.id);
              for (const f of d.patch) {
                if (f.trussId !== before.id) continue;
                if (!after) f.trussId = null;
                else Object.assign(f, followTruss(before, after, f));
              }
            }
          }
          if (cmd.meta) Object.assign(d.meta, Object.fromEntries(Object.entries(cmd.meta).filter(([, v]) => v !== undefined)));
          if (cmd.show) Object.assign(d.show, Object.fromEntries(Object.entries(cmd.show).filter(([, v]) => v !== undefined)));
          if (cmd.visualizer) Object.assign(d.visualizer, Object.fromEntries(Object.entries(cmd.visualizer).filter(([, v]) => v !== undefined)));
        });
        if (cmd.show?.bpm) e.bpm = cmd.show.bpm;
        return ok;
      case 'project.openDemo': {
        let demo: Project;
        try {
          demo = buildDemo(cmd.id);
        } catch (err) {
          throw new UserError((err as Error).message);
        }
        this.setProject(demo, true);
        this.projectPath = null;
        this.revision++; // an unsaved copy: « Enregistrer » asks for a file name
        this.logger.info('Projet', `Projet de démonstration ouvert : « ${demo.meta.name} » (fictif)`);
        this.emitProject();
        return ok;
      }
      case 'onboarding.update':
        this.settings.onboarding = { ...this.settings.onboarding, ...Object.fromEntries(Object.entries({ completed: cmd.completed, checklistHidden: cmd.checklistHidden }).filter(([, v]) => v !== undefined)) };
        await this.persistSettings();
        return ok;
      case 'project.listRecovery':
        return listRecovery(this.autosaveDir, this.projectPath);

      /* ---------- profiles ---------- */
      case 'profile.import': {
        const file = cmd.path ?? (await this.opts.dialogs.openProfile());
        if (!file) return { imported: [], errors: [], warnings: [] };
        const ext = path.extname(file).toLowerCase();
        if (ext === '.gdtf') throw new UserError('Format GDTF pas encore pris en charge : importez l’export grandMA2 (.xml), un profil Luma (.json) ou passez par Open Fixture Library.');
        if (ext === '.qxf') throw new UserError('Format QLC+ (.qxf) pas encore pris en charge : importez l’export grandMA2 (.xml), un profil Luma (.json) ou passez par Open Fixture Library.');
        let text: string;
        try {
          text = await fs.readFile(file, 'utf8');
        } catch (err) {
          throw new UserError(`Fichier de profil illisible : ${(err as Error).message}`);
        }
        let warnings: string[] = [];
        let parsed: { profiles: FixtureProfile[]; errors: string[] };
        if (ext === '.xml' || text.trimStart().startsWith('<')) {
          // grandMA2 export: one file = one mode, merged into the existing profile of the same fixture.
          const r = convertMa2Fixture(text);
          warnings = r.warnings;
          const existing = r.profile ? this.project.profiles.find((x) => x.id === r.profile!.id) : undefined;
          parsed = { profiles: r.profile ? [existing ? mergeProfileModes(existing, r.profile) : r.profile] : [], errors: r.errors };
          for (const w of warnings) this.logger.warn('grandMA2', `${path.basename(file)} : ${w}`);
        } else {
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch (err) {
            throw new UserError(`Fichier de profil illisible : ${(err as Error).message}`);
          }
          const j = json as Record<string, unknown> | null;
          if (j && typeof j === 'object' && 'availableChannels' in j && !('profiles' in j)) {
            throw new UserError('Fichier Open Fixture Library : utilisez « Open Fixture Library › Importer un fichier » pour préciser le fabricant.');
          }
          parsed = parseProfileFile(json);
        }
        const { profiles, errors } = parsed;
        const accepted = profiles.filter((p) => {
          if (BUILTIN_PROFILES.some((b) => b.id === p.id)) {
            errors.push(`Profil « ${p.id} » : identifiant réservé à un profil intégré`);
            return false;
          }
          return true;
        });
        if (accepted.length) this.mutate((d) => {
          for (const p of accepted) d.profiles = [...d.profiles.filter((x) => x.id !== p.id), p];
        });
        for (const er of errors) this.logger.warn('Profils', er);
        if (accepted.length) this.logger.info('Profils', `${accepted.length} profil(s) importé(s)`);
        return { imported: accepted.map((p) => p.name), errors, warnings };
      }
      case 'ofl.manufacturers':
        return oflManufacturers().catch((err: Error) => { throw new UserError(`Open Fixture Library inaccessible : ${err.message}`); });
      case 'ofl.fixtures':
        return oflFixtureKeys(cmd.manufacturer).catch((err: Error) => { throw new UserError(`Open Fixture Library inaccessible : ${err.message}`); });
      case 'profile.importOfl': {
        let json: unknown;
        let manufacturer: string;
        let key: string;
        if (cmd.source.kind === 'online') {
          const src = cmd.source;
          try {
            json = await oflFetchFixture(src.manufacturer, src.key);
            manufacturer = (await oflManufacturers().catch(() => [])).find((m) => m.key === src.manufacturer)?.name ?? src.manufacturer;
          } catch (err) {
            throw new UserError(`Téléchargement impossible : ${(err as Error).message}`);
          }
          key = src.key;
        } else {
          const file = cmd.source.path ?? (await this.opts.dialogs.openProfile());
          if (!file) return { imported: null, profileId: null, warnings: [], errors: [] };
          try {
            json = JSON.parse(await fs.readFile(file, 'utf8'));
          } catch (err) {
            throw new UserError(`Fichier OFL illisible : ${(err as Error).message}`);
          }
          manufacturer = cmd.source.manufacturerName;
          key = path.basename(file).replace(/.json$/i, '');
        }
        const r = convertOflFixture(json, { manufacturer, key });
        for (const w of r.warnings) this.logger.warn('OFL', `${key} : ${w}`);
        if (!r.profile) {
          this.logger.error('OFL', `${key} : conversion impossible — ${r.errors.join(' ; ')}`);
          return { imported: null, profileId: null, warnings: r.warnings, errors: r.errors };
        }
        const profile = r.profile;
        this.mutate((d) => { d.profiles = [...d.profiles.filter((x) => x.id !== profile.id), profile]; });
        this.logger.info('OFL', `Profil importé : ${profile.manufacturer} ${profile.name} (${profile.modes.length} mode(s))`);
        return { imported: `${profile.manufacturer} ${profile.name}`, profileId: profile.id, warnings: r.warnings, errors: r.errors };
      }
      case 'profile.remove': {
        const used = this.project.patch.filter((f) => f.profileId === cmd.id);
        if (used.length) throw new UserError(`Profil utilisé par ${used.length} projecteur(s)`);
        this.mutate((d) => { d.profiles = d.profiles.filter((p) => p.id !== cmd.id); });
        return ok;
      }

      /* ---------- patch ---------- */
      case 'fixture.add': {
        const profile = this.index.lib.get(cmd.profileId);
        if (!profile) throw new UserError('Profil inconnu');
        const count = channelCount(profile, cmd.mode);
        if (!count) throw new UserError(`Mode « ${cmd.mode} » inconnu pour ce profil`);
        const ids: string[] = [];
        const existingNames = new Set(this.project.patch.map((f) => f.name));
        this.mutate((d) => {
          let next = cmd.address ?? 1;
          const moving = profile.type.startsWith('moving');
          let n = 1;
          for (let i = 0; i < cmd.count; i++) {
            const addr = cmd.address !== null && i === 0 ? cmd.address : findFreeAddress(this.index.lib, d.patch, cmd.universe, count, next);
            if (addr === undefined || addr + count - 1 > 512) throw new UserError(`Plus de place dans l’univers ${cmd.universe} pour ${count} canaux (projecteur ${i + 1}/${cmd.count})`);
            while (existingNames.has(`${cmd.namePrefix} ${n}`)) n++;
            const name = `${cmd.namePrefix} ${n}`;
            existingNames.add(name);
            const id = randomUUID();
            ids.push(id);
            const w = d.visualizer.stageWidth;
            d.patch.push({
              id, name, profileId: profile.id, mode: cmd.mode, universe: cmd.universe, address: addr, tags: cmd.tags,
              position: { x: Math.round((-w / 2 + ((i + 0.5) * w) / cmd.count) * 10) / 10, y: moving ? d.visualizer.stageDepth * 0.7 : d.visualizer.stageDepth * 0.25 },
              rotation: 0, height: moving ? 6 : 4, notes: '',
            });
            next = addr + count;
          }
          const overlaps = validatePatch(this.index.lib, d.patch).filter((iss) => iss.kind === 'overlap' && iss.fixtureIds.some((x) => ids.includes(x)));
          if (overlaps.length) throw new UserError(overlaps[0]!.message);
        });
        this.logger.info('Patch', `${ids.length} × ${profile.name} ajouté(s) (univers ${cmd.universe})`);
        return { ids };
      }
      case 'fixture.update':
        (SCENE_FIELDS.some((k) => cmd.patch[k] !== undefined) ? this.sceneMutate.bind(this) : this.mutate.bind(this))((d) => {
          const f = d.patch.find((x) => x.id === cmd.id);
          if (!f) throw new UserError('Projecteur introuvable');
          Object.assign(f, Object.fromEntries(Object.entries(cmd.patch).filter(([, v]) => v !== undefined)));
          if (f.trussId && !d.visualizer.trusses.some((t) => t.id === f.trussId)) throw new UserError('Structure introuvable');
          const profile = this.index.lib.get(f.profileId);
          if (!profile || !profile.modes.some((m) => m.name === f.mode)) throw new UserError('Profil ou mode invalide');
          const issues = validatePatch(this.index.lib, d.patch).filter((i) => i.fixtureIds.includes(f.id));
          if (issues.length) throw new UserError(issues[0]!.message);
        });
        return ok;
      case 'fixture.remove': {
        const ids = new Set(cmd.ids);
        this.engine.releaseProgrammer(cmd.ids);
        this.mutate((d) => {
          d.patch = d.patch.filter((f) => !ids.has(f.id));
          for (const g of d.groups) g.fixtureIds = g.fixtureIds.filter((x) => !ids.has(x));
          for (const s of d.scenes) for (const id of ids) delete s.values[id];
          for (const ef of d.effects) ef.targets.fixtureIds = ef.targets.fixtureIds.filter((x) => !ids.has(x));
        });
        return ok;
      }
      case 'fixture.place':
        this.sceneMutate((d) => {
          for (const p of cmd.placements) {
            const f = d.patch.find((x) => x.id === p.id);
            if (!f) throw new UserError('Projecteur introuvable');
            if (p.trussId && !d.visualizer.trusses.some((t) => t.id === p.trussId)) throw new UserError('Structure introuvable');
            Object.assign(f, { position: p.position, height: p.height, trussId: p.trussId }, p.mount ? { mount: p.mount } : {});
          }
        });
        return ok;
      case 'fixture.duplicate': {
        const out: string[] = [];
        this.mutate((d) => {
          for (const id of cmd.ids) {
            const src = d.patch.find((f) => f.id === id);
            if (!src) continue;
            const profile = this.index.lib.get(src.profileId)!;
            const addr = findFreeAddress(this.index.lib, d.patch, src.universe, channelCount(profile, src.mode), src.address);
            if (addr === undefined) throw new UserError(`Plus de place dans l’univers ${src.universe}`);
            const nid = randomUUID();
            out.push(nid);
            d.patch.push({ ...structuredClone(src), id: nid, name: `${src.name} (copie)`.slice(0, 80), address: addr, position: { x: src.position.x + 0.5, y: src.position.y } });
          }
        });
        return { ids: out };
      }

      /* ---------- groups & palettes ---------- */
      case 'group.upsert':
        this.mutate((d) => {
          const g = { ...cmd.group, fixtureIds: cmd.group.fixtureIds.filter((id) => this.index.fixtures.has(id)) };
          d.groups = d.groups.some((x) => x.id === g.id) ? d.groups.map((x) => (x.id === g.id ? g : x)) : [...d.groups, g];
        });
        return ok;
      case 'group.remove':
        this.mutate((d) => {
          d.groups = d.groups.filter((g) => g.id !== cmd.id);
          for (const ef of d.effects) ef.targets.groupIds = ef.targets.groupIds.filter((x) => x !== cmd.id);
        });
        return ok;
      case 'group.reorder':
        this.mutate((d) => {
          const rank = new Map(cmd.ids.map((id, i) => [id, i]));
          d.groups.sort((x, y) => (rank.get(x.id) ?? 1e9) - (rank.get(y.id) ?? 1e9));
        });
        return ok;
      case 'palette.upsert':
        this.mutate((d) => { d.palettes = d.palettes.some((x) => x.id === cmd.palette.id) ? d.palettes.map((x) => (x.id === cmd.palette.id ? cmd.palette : x)) : [...d.palettes, cmd.palette]; });
        return ok;
      case 'palette.remove':
        this.mutate((d) => { d.palettes = d.palettes.filter((p) => p.id !== cmd.id); });
        return ok;
      case 'palette.apply': {
        const pal = this.project.palettes.find((p) => p.id === cmd.id);
        if (!pal) throw new UserError('Palette introuvable');
        let applied = 0;
        for (const fid of cmd.fixtureIds) {
          const rf = this.index.fixtures.get(fid);
          if (!rf) continue;
          const vals: Record<string, number> = {};
          if (pal.color) Object.assign(vals, colorToAttributes(rf, hexToRgb(pal.color)));
          for (const [a, v] of Object.entries(pal.values)) if (a === 'dimmer' || rf.attributes.includes(a)) vals[a] = v;
          applied += e.setProgrammer([fid], vals).applied;
        }
        return { applied };
      }
      case 'palette.recordFromProgrammer': {
        const prog = e.getProgrammer()[cmd.fixtureId];
        if (!prog) throw new UserError('Ce projecteur n’a aucune valeur dans le programmeur');
        const cls = cmd.kind === 'color' ? ['color'] : cmd.kind === 'position' ? ['position'] : cmd.kind === 'intensity' ? ['intensity'] : ['beam'];
        const values = Object.fromEntries(Object.entries(prog).filter(([a]) => cls.includes(attributeClass(a))));
        if (!Object.keys(values).length) throw new UserError('Aucune valeur de ce type dans le programmeur pour ce projecteur');
        const id = randomUUID();
        this.mutate((d) => { d.palettes.push({ id, name: cmd.name, kind: cmd.kind, values }); });
        return { id };
      }

      /* ---------- programmer ---------- */
      case 'programmer.set':
        return e.setProgrammer(cmd.fixtureIds, cmd.values, { confirmSpecial: cmd.confirmSpecial });
      case 'programmer.setColor': {
        let applied = 0;
        for (const fid of cmd.fixtureIds) {
          const rf = this.index.fixtures.get(fid);
          // A fixture without the requested head (module) is left untouched.
          const mod = cmd.module !== undefined && rf ? findModule(rf.profile, cmd.module) : undefined;
          if (rf && (cmd.module === undefined || mod)) applied += e.setProgrammer([fid], colorToAttributes(rf, hexToRgb(cmd.color), cmd.cell, mod)).applied;
        }
        return { applied };
      }
      case 'programmer.release':
        e.releaseProgrammer(cmd.fixtureIds, cmd.attributes);
        return ok;

      /* ---------- scenes ---------- */
      case 'scene.record': {
        const prog = e.getProgrammer();
        const values: FixtureValues = cmd.fixtureIds ? Object.fromEntries(Object.entries(prog).filter(([id]) => cmd.fixtureIds!.includes(id))) : prog;
        if (!Object.keys(values).length) throw new UserError('Le programmeur est vide : réglez des projecteurs dans la Live Console avant d’enregistrer.');
        const id = randomUUID();
        this.mutate((d) => { d.scenes.push({ id, name: cmd.name, notes: '', values, origin: 'user' }); });
        this.logger.info('Scènes', `Scène « ${cmd.name} » enregistrée (${Object.keys(values).length} projecteurs)`);
        return { id };
      }
      case 'scene.upsert':
        this.mutate((d) => { d.scenes = d.scenes.some((s) => s.id === cmd.scene.id) ? d.scenes.map((s) => (s.id === cmd.scene.id ? cmd.scene : s)) : [...d.scenes, cmd.scene]; });
        return ok;
      case 'scene.remove':
        this.mutate((d) => {
          d.scenes = d.scenes.filter((s) => s.id !== cmd.id);
          for (const l of d.cueLists) for (const c of l.cues) if (c.sceneId === cmd.id) c.sceneId = null;
          for (const t of d.timelines) t.events = t.events.filter((ev) => !(ev.kind === 'scene' && ev.refId === cmd.id));
        });
        return ok;
      case 'scene.duplicate': {
        const src = this.project.scenes.find((s) => s.id === cmd.id);
        if (!src) throw new UserError('Scène introuvable');
        const id = randomUUID();
        this.mutate((d) => { d.scenes.push({ ...structuredClone(src), id, name: `${src.name} (copie)`.slice(0, 80) }); });
        return { id };
      }
      case 'scene.load': {
        const s = this.index.scenes.get(cmd.id);
        if (!s) throw new UserError('Scène introuvable');
        for (const [fid, vals] of Object.entries(s.values)) e.setProgrammer([fid], vals);
        return ok;
      }
      case 'scene.preview': {
        const s = this.index.scenes.get(cmd.id);
        if (!s) throw new UserError('Scène introuvable');
        return { values: e.compute(s.values).values };
      }

      /* ---------- cues ---------- */
      case 'cueList.upsert':
        for (const c of cmd.cueList.cues) {
          if (c.sceneId && !this.index.scenes.has(c.sceneId)) throw new UserError(`Cue « ${c.name} » : scène inconnue`);
          for (const fx of c.effectIds) if (!this.index.effects.has(fx)) throw new UserError(`Cue « ${c.name} » : effet inconnu`);
        }
        this.mutate((d) => { d.cueLists = d.cueLists.some((l) => l.id === cmd.cueList.id) ? d.cueLists.map((l) => (l.id === cmd.cueList.id ? cmd.cueList : l)) : [...d.cueLists, cmd.cueList]; });
        return ok;
      case 'cueList.remove':
        e.cueStop(cmd.id);
        this.mutate((d) => {
          d.cueLists = d.cueLists.filter((l) => l.id !== cmd.id);
          for (const t of d.timelines) t.events = t.events.filter((ev) => !(ev.kind === 'cue' && ev.refId === cmd.id));
        });
        return ok;
      case 'cue.go': return { ok: e.cueGo(cmd.listId) };
      case 'cue.back': return { ok: e.cueBack(cmd.listId) };
      case 'cue.goto': return { ok: e.cueGoto(cmd.listId, cmd.index) };
      case 'cue.pause': e.cuePause(cmd.listId); return ok;
      case 'cue.resume': e.cueResume(cmd.listId); return ok;
      case 'cue.stop': e.cueStop(cmd.listId); return ok;

      /* ---------- effects ---------- */
      case 'effect.upsert':
        this.mutate((d) => { d.effects = d.effects.some((x) => x.id === cmd.effect.id) ? d.effects.map((x) => (x.id === cmd.effect.id ? cmd.effect : x)) : [...d.effects, cmd.effect]; });
        return ok;
      case 'effect.remove':
        e.stopEffectById(cmd.id);
        this.mutate((d) => {
          d.effects = d.effects.filter((x) => x.id !== cmd.id);
          for (const l of d.cueLists) for (const c of l.cues) c.effectIds = c.effectIds.filter((x) => x !== cmd.id);
          for (const t of d.timelines) t.events = t.events.filter((ev) => !(ev.kind === 'effect' && ev.refId === cmd.id));
          if (d.audio.reactions.energyRiseGo.cueListId && !d.cueLists.some((l) => l.id === d.audio.reactions.energyRiseGo.cueListId)) d.audio.reactions.energyRiseGo.cueListId = null;
        });
        return ok;
      case 'effect.start': {
        const id = e.startEffect(cmd.id, 'manual');
        if (!id) throw new UserError('Effet introuvable');
        return { instanceId: id };
      }
      case 'effect.stop': e.stopEffect(cmd.instanceId); return ok;
      case 'effect.pause': e.setEffectPaused(cmd.instanceId, cmd.paused); return ok;
      case 'effect.stopAll': e.stopAllEffects(); return ok;

      /* ---------- timeline ---------- */
      case 'timeline.upsert':
        for (const ev of cmd.timeline.events) {
          const exists = ev.kind === 'marker' || (ev.kind === 'scene' ? this.index.scenes.has(ev.refId!) : ev.kind === 'effect' ? this.index.effects.has(ev.refId!) : this.index.cueLists.has(ev.refId!));
          if (!exists) throw new UserError(`Événement « ${ev.label || ev.kind} » : référence inconnue`);
        }
        this.mutate((d) => { d.timelines = d.timelines.some((t) => t.id === cmd.timeline.id) ? d.timelines.map((t) => (t.id === cmd.timeline.id ? cmd.timeline : t)) : [...d.timelines, cmd.timeline]; });
        return ok;
      case 'timeline.remove':
        e.timelineStop();
        this.mutate((d) => { d.timelines = d.timelines.filter((t) => t.id !== cmd.id); });
        return ok;
      case 'timeline.play':
        if (!e.timelinePlay(cmd.id)) throw new UserError('Timeline introuvable');
        return ok;
      case 'timeline.pause': e.timelinePause(); return ok;
      case 'timeline.stop': e.timelineStop(); return ok;
      case 'timeline.seek': e.timelineSeek(cmd.seconds); return ok;
      case 'timeline.timecode': {
        const id = cmd.timelineId ?? e.snapshot().timeline.timelineId ?? this.project.timelines[0]?.id;
        const chasing = !!id && e.timelineChase(id, cmd.seconds);
        if (chasing) this.timecodeAt = Date.now();
        return { chasing };
      }

      /* ---------- camera localisation ---------- */
      case 'locate.begin': {
        if (e.blackout) throw new UserError('Désactivez le blackout : la caméra doit voir les projecteurs');
        const ids = (cmd.fixtureIds ?? [...this.index.fixtures.keys()]).filter((id) => this.index.fixtures.has(id));
        if (!ids.length) throw new UserError('Aucun projecteur à localiser');
        // Manual control would win over the localisation pattern: release it (stated in the confirmation dialog).
        e.releaseProgrammer();
        const seq = buildSequence(ids, cmd.mode);
        this.locate = { seq, level: cmd.level, frame: 0, photo: cmd.photo, awaitingPhoto: false };
        this.showLocateFrame(0);
        this.logger.warn('Localisation', `Séquence caméra démarrée : ${ids.length} projecteurs, ${seq.frames.length} images (${cmd.mode === 'binary' ? 'codage binaire' : 'un par un'}), intensité ${Math.round(cmd.level * 100)} %, sans strobe${cmd.photo ? ', photos smartphone' : ''}`);
        return { fixtureIds: ids, frames: seq.frames, codes: seq.codes, mode: seq.mode, bits: seq.bits, settleMs: FRAME_SETTLE_MS, captureMs: FRAME_CAPTURE_MS };
      }
      case 'locate.frame':
        if (!this.locate) throw new UserError('Aucune séquence de localisation en cours');
        if (cmd.index >= this.locate.seq.frames.length) throw new UserError('Image hors séquence');
        this.showLocateFrame(cmd.index);
        return ok;
      case 'locate.end':
        if (this.locate) this.logger.info('Localisation', 'Séquence caméra terminée — projecteurs rendus aux autres sources');
        this.endLocate();
        return ok;
      case 'locate.apply': {
        const ids = new Set(this.project.patch.map((f) => f.id));
        const updates = cmd.updates.filter((u) => ids.has(u.fixtureId));
        this.mutate((d) => {
          for (const u of updates) {
            const f = d.patch.find((x) => x.id === u.fixtureId)!;
            f.position = { x: Math.round(u.x * 100) / 100, y: Math.round(u.y * 100) / 100 };
            if (u.height !== undefined) f.height = Math.round(u.height * 100) / 100;
          }
        });
        this.logger.info('Localisation', `${updates.length} position(s) de projecteur mise(s) à jour depuis la caméra`);
        return { updated: updates.length };
      }

      /* ---------- music (Song-to-Show) ---------- */
      case 'music.addTrack': {
        const existing = this.project.music.tracks.find((t) => t.hash === cmd.hash);
        if (existing) return { id: existing.id, cached: true };
        const id = randomUUID();
        this.mutate((d) => { d.music.tracks.push({ id, name: cmd.name, hash: cmd.hash, analysis: cmd.analysis, plan: null, created: { sceneIds: [], effectIds: [], timelineId: null } }); });
        const a = cmd.analysis;
        this.logger.info('Musique', `« ${cmd.name} » analysé : ${a.bpm.toFixed(1)} BPM, ${KEY_NAMES[a.key.tonic]} ${a.key.mode === 'major' ? 'majeur' : 'mineur'}, ${a.sections.length} sections`);
        return { id, cached: false };
      }
      case 'music.removeTrack': {
        const t = this.track(cmd.id);
        this.mutate((d) => {
          this.removeGenerated(d, t);
          d.music.tracks = d.music.tracks.filter((x) => x.id !== cmd.id);
        });
        return ok;
      }
      case 'music.setSection':
        this.mutate((d) => {
          const t = d.music.tracks.find((x) => x.id === cmd.trackId);
          const s = t?.analysis.sections[cmd.index];
          if (!t || !s) throw new UserError('Section introuvable');
          if (cmd.label) s.label = cmd.label;
          const p = t.plan?.sections[cmd.index];
          if (cmd.locked !== undefined && p) p.locked = cmd.locked;
        });
        return ok;
      case 'music.generate': {
        const t = this.track(cmd.trackId);
        const variant = cmd.nextVariant ? (t.plan?.variant ?? 0) + 1 : t.plan?.variant ?? 0;
        const { plan, notices } = await this.planShow(t, cmd.intent, variant);
        return this.applyShow(t, plan, notices);
      }
      case 'music.regenerateSection': {
        const t = this.track(cmd.trackId);
        if (!t.plan) throw new UserError('Générez d’abord le show de ce morceau');
        const rig = rigInfo(this.index, this.settings.ai.allowStrobe);
        const plan: ShowPlan = structuredClone(t.plan);
        const s = plan.sections[cmd.index];
        if (!s) throw new UserError('Section introuvable');
        if (cmd.instruction.trim()) plan.sections[cmd.index] = adjustSection(s, cmd.instruction, rig);
        else {
          // No instruction: a new variant of this section only.
          const fresh = planLocally(t.analysis, plan.intent, rig, plan.variant + 1 + cmd.index);
          plan.sections[cmd.index] = { ...fresh.sections[cmd.index]!, locked: s.locked };
        }
        return this.applyShow(t, plan, []);
      }

      /* ---------- engine ---------- */
      case 'engine.master': e.master = cmd.value; return ok;
      case 'engine.blackout':
        e.blackout = cmd.on;
        this.logger.info('Moteur', cmd.on ? `Blackout activé (politique : ${this.settings.engine.blackoutPolicy})` : 'Blackout désactivé');
        return ok;
      case 'engine.bpm':
        e.bpm = cmd.bpm;
        e.bpmSource = 'manual';
        return ok;
      case 'engine.releaseAll':
        e.releaseProgrammer();
        e.releaseAi();
        e.stopAllEffects();
        e.stopAllPlaybacks();
        e.timelineStop();
        this.logger.info('Moteur', 'Tout relâché (programmeur, IA, effets, playbacks, timeline)');
        return ok;

      /* ---------- outputs ---------- */
      case 'output.configure':
        this.settings.outputs = cmd.outputs;
        await this.persistSettings();
        await this.outputs.configure(cmd.outputs);
        this.logger.info('Sorties', 'Configuration des sorties mise à jour');
        return ok;
      case 'output.arm':
        await this.outputs.arm(cmd.id);
        return ok;
      case 'output.disarm':
        await this.outputs.disarm(cmd.id);
        return ok;
      case 'output.transmit':
        this.outputs.setTransmitting(cmd.on);
        if (!cmd.on) this.logger.warn('Sorties', 'STOP OUTPUT : émissions réelles arrêtées. Les projecteurs appliquent leur propre comportement de perte de signal (maintien ou extinction selon le modèle).');
        else this.logger.info('Sorties', 'Émissions reprises');
        return ok;
      case 'output.universe': {
        const view: UniverseView = { universe: cmd.universe, computed: Array.from(e.universes.get(cmd.universe) ?? new Uint8Array(512)), transmitted: [] };
        for (const s of this.outputs.status()) {
          const fr = this.outputs.transmitted.get(s.id)?.get(cmd.universe);
          if (fr) view.transmitted.push({ outputId: s.id, outputName: s.name, at: fr.at, data: Array.from(fr.data) });
        }
        return view;
      }
      case 'output.virtualHistory':
        return (this.outputs.virtual()?.history ?? []).slice(-cmd.limit);
      case 'output.inject': {
        let v: VirtualOutput | undefined;
        for (const s of this.outputs.status()) {
          const a = this.outputs.get(s.id);
          if (a instanceof VirtualOutput) v = a;
        }
        if (!v) throw new UserError('Aucune sortie virtuelle configurée');
        v.inject(cmd.injection);
        if (cmd.injection.type === 'reconnect') await v.open();
        this.logger.warn('Diagnostic', `Injection de test sur la sortie virtuelle : ${cmd.injection.type}`);
        return ok;
      }
      case 'output.listSerial': return listSerialPorts();
      case 'rdm.discover':
        return this.withRdm(cmd.outputId, cmd.universe, async (rdm) => {
          const uids = await rdm.discover();
          const devices = [];
          for (const uid of uids) devices.push(await rdm.readDevice(uid));
          this.logger.info('RDM', `${devices.length} appareil(s) découvert(s) sur l’univers ${cmd.universe}`);
          return { devices };
        });
      case 'rdm.identify':
        return this.withRdm(cmd.outputId, cmd.universe, async (rdm) => { await rdm.identify(cmd.uid, cmd.on); return ok; });
      case 'rdm.setAddress':
        return this.withRdm(cmd.outputId, cmd.universe, async (rdm) => {
          await rdm.setStartAddress(cmd.uid, cmd.address);
          this.logger.warn('RDM', `Adresse DMX de ${cmd.uid} changée à ${cmd.address} (univers ${cmd.universe})`);
          return ok;
        });
      case 'output.interfaces': return localIpv4Addresses();

      /* ---------- AI ---------- */
      case 'ai.propose': return this.aiPropose(cmd.prompt);
      case 'ai.revise': {
        const prev = this.proposals.get(cmd.proposalId);
        if (!prev) throw new UserError('Proposition expirée');
        const p = buildProposal({ prompt: prev.prompt, provider: prev.provider, model: prev.model, understanding: `${prev.understanding} (modifiée par l’utilisateur)`, notices: [], rawActions: cmd.actions, ctx: this.validationCtx() });
        this.guardFlashes(p);
        this.storeProposal(p);
        return p;
      }
      case 'ai.apply': {
        const p = this.proposals.get(cmd.proposalId);
        if (!p) throw new UserError('Proposition expirée ou inconnue');
        if (Date.now() - this.lastAiApply < 300) throw new UserError('Applications IA trop rapprochées (protection anti-boucle)');
        this.lastAiApply = Date.now();
        this.proposals.delete(cmd.proposalId); // a proposal is applied at most once
        const report = executeProposal(p, { index: () => this.index, mutate: (fn) => this.mutate(fn), engine: e, maxStrobeHz: this.settings.engine.maxStrobeHz });
        this.logger.info('IA', `Proposition appliquée : ${report.executed.length} action(s) exécutée(s), ${report.skipped.length} ignorée(s)`);
        for (const s of report.skipped) this.logger.warn('IA', `Ignorée — ${s.summary} : ${s.reason}`);
        return report;
      }
      case 'ai.release':
        e.releaseAi();
        for (const fx of e.snapshot().effects) if (fx.owner === 'ai') e.stopEffect(fx.instanceId);
        return ok;
      case 'ai.listModels':
        if (cmd.refresh) this.modelCache = null;
        return this.openRouterModels();
      case 'ai.setKey':
        this.opts.secrets.set(OPENROUTER_KEY, cmd.key);
        this.logger.info('IA', cmd.key ? 'Clé API enregistrée (stockage chiffré du système)' : 'Clé API supprimée');
        return ok;

      /* ---------- audio ---------- */
      case 'audio.features':
        this.audio.push(cmd.features, cmd.source);
        return ok;
      case 'audio.armDrop':
        this.audio.armDrop(cmd.on);
        this.logger.info('Audio', cmd.on ? 'GO sur drop prédit ARMÉ (un seul déclenchement)' : 'GO sur drop prédit désarmé');
        return ok;
      case 'audio.config':
        this.mutate((d) => { d.audio = cmd.config; });
        return ok;

      /* ---------- settings / logs ---------- */
      case 'settings.get': return this.getSettings();
      case 'settings.update': {
        const outputsChanged = JSON.stringify(cmd.settings.outputs) !== JSON.stringify(this.settings.outputs);
        this.settings = { ...cmd.settings, sacn: this.settings.sacn };
        this.settings.control.remote.token ??= randomUUID();
        await this.persistSettings();
        this.logger.level = this.settings.logs.level;
        this.engine.updateSettings(this.engineSettings());
        if (outputsChanged) await this.outputs.configure(this.settings.outputs);
        await this.applyControl();
        this.logger.info('Paramètres', 'Paramètres enregistrés');
        return ok;
      }
      case 'logs.recent': return this.logger.recent();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Music (Song-to-Show)                                                */
  /* ------------------------------------------------------------------ */

  private track(id: string): MusicTrack {
    const t = this.project.music.tracks.find((x) => x.id === id);
    if (!t) throw new UserError('Morceau introuvable');
    return t;
  }

  private removeGenerated(d: Project, t: MusicTrack): void {
    const scenes = new Set(t.created.sceneIds), effects = new Set(t.created.effectIds);
    d.scenes = d.scenes.filter((s) => !scenes.has(s.id));
    d.effects = d.effects.filter((e) => !effects.has(e.id));
    if (t.created.timelineId) d.timelines = d.timelines.filter((x) => x.id !== t.created.timelineId);
  }

  /** Plan with OpenRouter when configured (validated, local fallback), else with the local rules. */
  private async planShow(t: MusicTrack, intent: string, variant: number): Promise<{ plan: ShowPlan; notices: string[] }> {
    const rig = rigInfo(this.index, this.settings.ai.allowStrobe);
    const local = planLocally(t.analysis, intent, rig, variant, t.plan);
    const ai = this.settings.ai;
    const key = this.opts.secrets.get(OPENROUTER_KEY);
    if (ai.provider !== 'openrouter' || !key) return { plan: local, notices: ai.provider === 'openrouter' ? ['Aucune clé API : plan généré par les règles locales.'] : [] };
    if (this.aiBusy) throw new UserError('Une demande IA est déjà en cours');
    this.aiBusy = true;
    try {
      const a = t.analysis;
      // Only the symbolic structure leaves the machine: no audio.
      const structure = [
        `Tempo ${a.bpm.toFixed(1)} BPM, key ${KEY_NAMES[a.key.tonic]} ${a.key.mode}, duration ${a.duration.toFixed(0)} s.`,
        `Rig: ${rig.wash} wash/PAR, ${rig.moving} moving heads, ${rig.bars} LED bars; strobeAllowed: ${rig.allowStrobe}.`,
        'Sections (index, label, start s, duration s, measured energy 0..1, repeat group):',
        ...a.sections.map((s, i) => `${i}. ${s.label} (${SECTION_NAMES[s.label]}) start ${s.start.toFixed(1)} dur ${(s.end - s.start).toFixed(1)} energy ${s.energy.toFixed(2)} group ${s.cluster}`),
      ].join('\n');
      const model = ai.model || DEFAULT_OPENROUTER_MODEL;
      const caps = (await this.openRouterModels().catch(() => [] as OpenRouterModel[])).find((m) => m.id === model);
      const r = await planShowWithOpenRouter(intent, structure, { apiKey: key, model, effort: ai.effort, timeoutMs: ai.timeoutSec * 1000, capabilities: caps }, local.sections);
      this.aiLastError = null;
      // Locked sections are kept from the previous plan.
      const sections = r.sections.map((s, i) => (t.plan?.sections[i]?.locked && t.plan.sections.length === r.sections.length ? t.plan.sections[i]! : s));
      return { plan: { intent: intent.slice(0, 500), provider: 'openrouter', model: r.model, variant, summary: r.summary, sections }, notices: r.notices };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.aiLastError = msg;
      this.logger.error('Musique', `Planification OpenRouter indisponible : ${msg}`);
      if (!ai.fallbackToLocal) throw new UserError(`Fournisseur IA indisponible : ${msg}`);
      return { plan: local, notices: [`OpenRouter indisponible (${msg}) : plan généré par les règles locales.`] };
    } finally {
      this.aiBusy = false;
    }
  }

  /** Compiles the plan, replaces the track's previously generated objects and stores the plan. */
  private applyShow(t: MusicTrack, plan: ShowPlan, notices: string[]) {
    const c = compileShow(this.index, t.name, t.analysis, plan, { maxStrobeHz: this.settings.engine.maxStrobeHz, allowStrobe: this.settings.ai.allowStrobe });
    if (this.engine.snapshot().timeline.timelineId === t.created.timelineId) this.engine.timelineStop();
    this.mutate((d) => {
      const track = d.music.tracks.find((x) => x.id === t.id)!;
      this.removeGenerated(d, track);
      d.scenes.push(...c.scenes);
      d.effects.push(...c.effects);
      d.timelines.push(c.timeline);
      track.plan = plan;
      track.created = { sceneIds: c.scenes.map((s) => s.id), effectIds: c.effects.map((e) => e.id), timelineId: c.timeline.id };
    });
    const all = [...notices, ...c.notices];
    this.logger.info('Musique', `Show généré pour « ${t.name} » (${plan.provider === 'openrouter' ? `OpenRouter · ${plan.model}` : 'règles locales'}) : ${c.scenes.length} scènes, ${c.effects.length} effets, timeline « ${c.timeline.name} »`);
    for (const n of c.notices) this.logger.warn('Musique', n);
    return { timelineId: c.timeline.id, notices: all, provider: plan.provider };
  }

  /* ------------------------------------------------------------------ */
  /* External control (OSC)                                              */
  /* ------------------------------------------------------------------ */

  private async applyControl(): Promise<void> {
    await this.applyRemote();
    const o = this.settings.control.osc;
    const conf = o.enabled ? `${o.bind}:${o.port}` : '';
    if (conf === this.oscConfig) return;
    this.oscConfig = conf;
    if (!o.enabled) {
      await this.osc.stop();
      return;
    }
    try {
      await this.osc.start(o.port, o.bind);
      this.logger.info('OSC', `Écoute UDP ${o.bind}:${o.port}${o.bind === '0.0.0.0' ? ' (réseau local, sans authentification)' : ''}`);
    } catch (err) {
      this.oscConfig = '';
      this.logger.error('OSC', `Impossible d’écouter sur ${o.bind}:${o.port} : ${(err as Error).message}`);
    }
  }

  /** Opens an RDM session on an Art-Net output for one local universe, runs `fn`, always closes the socket. */
  private async withRdm<T>(outputId: string, universe: number, fn: (rdm: ArtNetRdm) => Promise<T>): Promise<T> {
    const o = this.settings.outputs.find((x) => x.id === outputId);
    if (!o) throw new UserError('Sortie introuvable');
    if (o.kind !== 'artnet') throw new UserError('RDM disponible uniquement via Art-Net pour l’instant (RDM Enttec non implémenté)');
    const map = o.universeMap.find((m) => m.local === universe);
    if (!map) throw new UserError(`L’univers ${universe} n’est pas routé vers cette sortie`);
    const rdm = new ArtNetRdm({ host: o.host, portAddress: map.remote, bindAddress: o.bindAddress, listenPort: this.opts.rdm?.listenPort, nodePort: this.opts.rdm?.nodePort, timeoutMs: this.opts.rdm?.timeoutMs });
    try {
      await rdm.open();
    } catch (err) {
      throw new UserError(`Port Art-Net 6454 indisponible pour les réponses RDM : ${(err as Error).message}`);
    }
    try {
      return await fn(rdm);
    } catch (err) {
      throw new UserError(`RDM : ${(err as Error).message}`);
    } finally {
      await rdm.close();
    }
  }

  /**
   * Localisation pattern: a top-priority layer that darkens every fixture except the lit ones, which get white light at
   * the capped level with shutter/strobe forced open (never strobing). Pan/tilt are left untouched.
   */
  private showLocateFrame(index: number): void {
    const s = this.locate!;
    s.frame = index;
    const lit = new Set(s.seq.frames[index]!.lit);
    const values: FixtureValues = {};
    for (const [id, rf] of this.index.fixtures) {
      const on = lit.has(id);
      const v: Record<string, number> = { dimmer: on ? s.level : 0 };
      if (on) Object.assign(v, colorToAttributes(rf, { r: 1, g: 1, b: 1 }));
      for (const a of ['shutter', 'strobe']) {
        const ch = coarseChannel(rf.mode, a);
        if (ch) v[a] = rangeValue(ch, 'open') ?? ch.default / 255;
      }
      values[id] = v;
    }
    this.engine.setExternal('locate', { layer: { id: 'locate', label: 'Localisation caméra', kind: 'locate', priority: 1000, order: 0, values } });
    s.awaitingPhoto = s.photo;
    this.emit('runtime', this.runtimeState());
  }

  private endLocate(): void {
    this.engine.setExternal('locate', null);
    this.locate = null;
  }

  private onLocatePhoto(frame: number, jpeg: Buffer): boolean {
    const s = this.locate;
    if (!s?.photo || !s.awaitingPhoto || frame !== s.frame) return false;
    s.awaitingPhoto = false;
    this.emit('locatePhoto', { frame, jpeg: jpeg.toString('base64') });
    return true;
  }

  private async applyRemote(): Promise<void> {
    const r = this.settings.control.remote;
    const conf = r.enabled ? `${r.port}|${r.token}` : '';
    if (conf === this.remoteConfig) return;
    this.remoteConfig = conf;
    if (!r.enabled || !r.token) {
      await this.remote.stop();
      return;
    }
    try {
      await this.remote.start(r.port, '0.0.0.0', r.token);
      this.logger.info('Télécommande', `Serveur actif sur le port ${r.port} (réseau local, accès par jeton)`);
    } catch (err) {
      this.remoteConfig = '';
      this.logger.error('Télécommande', `Impossible d’écouter sur le port ${r.port} : ${(err as Error).message}`);
    }
  }

  private remoteState(): RemoteState {
    const snap = this.engine.snapshot();
    return {
      master: this.engine.master,
      blackout: this.engine.blackout,
      transmitting: this.outputs.transmitting,
      bpm: this.engine.bpm,
      locate: this.locate?.photo && this.locate.awaitingPhoto ? { frame: this.locate.frame, total: this.locate.seq.frames.length, label: this.locate.seq.frames[this.locate.frame]!.label } : null,
      lists: this.project.cueLists.map((l, i) => {
        const pb = snap.playbacks.find((p) => p.cueListId === l.id);
        return { index: i + 1, name: l.name, state: pb?.state ?? 'idle', cue: pb?.cueName ?? null };
      }),
    };
  }

  /**
   * OSC address map. Deliberately limited to show control: nothing can arm an output or resume transmission remotely.
   * Lists and cues are 1-based; the cue list defaults to the first one.
   */
  private async onOsc(m: OscMessage): Promise<boolean> {
    const num = (i: number) => (typeof m.args[i] === 'number' ? (m.args[i] as number) : typeof m.args[i] === 'boolean' ? Number(m.args[i]) : undefined);
    const list = (i: number) => {
      const l = this.project.cueLists[(num(i) ?? 1) - 1];
      if (!l) throw new UserError('Liste de cues introuvable');
      return l.id;
    };
    const run = async (c: Command) => (await this.handle(c) as { ok?: boolean } | undefined)?.ok !== false;
    switch (m.address) {
      case '/luma/go': return run({ type: 'cue.go', listId: list(0) });
      case '/luma/back': return run({ type: 'cue.back', listId: list(0) });
      case '/luma/pause': return run({ type: 'cue.pause', listId: list(0) });
      case '/luma/resume': return run({ type: 'cue.resume', listId: list(0) });
      case '/luma/goto': return run({ type: 'cue.goto', listId: list(1), index: Math.max(0, (num(0) ?? 1) - 1) });
      case '/luma/blackout': return run({ type: 'engine.blackout', on: num(0) === undefined ? !this.engine.blackout : num(0)! > 0 });
      case '/luma/master': return run({ type: 'engine.master', value: Math.min(1, Math.max(0, num(0) ?? 1)) });
      case '/luma/bpm': return run({ type: 'engine.bpm', bpm: Math.min(300, Math.max(20, num(0) ?? 120)) });
      case '/luma/release': return run({ type: 'programmer.release' });
      case '/luma/stop': return run({ type: 'output.transmit', on: false });
      case '/luma/timecode': return (await this.handle({ type: 'timeline.timecode', seconds: Math.max(0, num(0) ?? 0) }) as { chasing: boolean }).chasing;
      default:
        this.logger.debug('OSC', `Adresse inconnue ${m.address}`);
        return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* AI                                                                  */
  /* ------------------------------------------------------------------ */

  private modelCache: { at: number; models: Promise<OpenRouterModel[]> } | null = null;

  /** OpenRouter catalogue, cached 10 min (public endpoint, no key needed). */
  private openRouterModels(): Promise<OpenRouterModel[]> {
    if (!this.modelCache || Date.now() - this.modelCache.at > 600_000) {
      const models = listOpenRouterModels({ timeoutMs: 15_000 });
      this.modelCache = { at: Date.now(), models };
      models.catch(() => { this.modelCache = null; });
    }
    return this.modelCache.models;
  }

  private validationCtx() {
    return { index: this.index, allowStrobe: this.settings.ai.allowStrobe, maxStrobeHz: this.settings.engine.maxStrobeHz };
  }

  private guardFlashes(p: AiProposal): void {
    if (this.settings.engine.flashGuard === 'off') return;
    const n = guardProposalFlashes(p, this.index, this.engine, this.settings.engine.maxStrobeHz);
    if (n) p.notices.push(`${n} effet(s) refusé(s) par le garde-fou photosensible (Paramètres › Moteur & sécurité).`);
  }

  private storeProposal(p: AiProposal): void {
    this.proposals.set(p.id, p);
    while (this.proposals.size > 20) this.proposals.delete(this.proposals.keys().next().value!);
  }

  private async aiPropose(prompt: string): Promise<AiProposal> {
    if (this.aiBusy) throw new UserError('Une demande IA est déjà en cours');
    this.aiBusy = true;
    try {
      const ctx = this.validationCtx();
      const ai = this.settings.ai;
      const key = this.opts.secrets.get(OPENROUTER_KEY);
      let proposal: AiProposal;
      if (ai.provider === 'openrouter' && key) {
        try {
          const model = ai.model || DEFAULT_OPENROUTER_MODEL;
          const caps = (await this.openRouterModels().catch(() => [] as OpenRouterModel[])).find((m) => m.id === model);
          const r = await proposeWithOpenRouter(prompt, describeRig(this.index, ai.allowStrobe, this.engine.bpm, liveState(this.index, this.engine)), { apiKey: key, model, effort: ai.effort, timeoutMs: ai.timeoutSec * 1000, capabilities: caps });
          proposal = buildProposal({ prompt, provider: 'openrouter', model: r.model, understanding: r.understanding, notices: r.notices, rawActions: r.actions, ctx });
          this.aiLastError = null;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.aiLastError = msg;
          this.logger.error('IA', `Fournisseur OpenRouter indisponible : ${msg}`);
          if (!ai.fallbackToLocal) throw new UserError(`Fournisseur IA indisponible : ${msg}`);
          proposal = proposeLocally(prompt, ctx, this.engine);
          proposal.notices.unshift(`Fournisseur OpenRouter indisponible (${msg}) : proposition générée par le mode local déterministe.`);
        }
      } else {
        proposal = proposeLocally(prompt, ctx, this.engine);
        if (ai.provider === 'openrouter') proposal.notices.unshift('Aucune clé API configurée : mode local déterministe utilisé.');
      }
      this.guardFlashes(proposal);
      this.storeProposal(proposal);
      this.mutate((d) => { d.ai.recentPrompts = [prompt.slice(0, 500), ...d.ai.recentPrompts.filter((x) => x !== prompt)].slice(0, 20); });
      return proposal;
    } finally {
      this.aiBusy = false;
    }
  }

  /** Exposed for tests: local interpretation without storing a proposal. */
  interpretForTest(prompt: string) {
    return interpretLocally(prompt, interpreterContext(this.index, this.engine, this.settings.ai.allowStrobe));
  }

  /* ------------------------------------------------------------------ */
  /* Files                                                               */
  /* ------------------------------------------------------------------ */

  private addRecent(file: string): void {
    this.settings.general.recentProjects = [file, ...this.settings.general.recentProjects.filter((f) => f !== file)].slice(0, 10);
    void this.persistSettings().catch((err: Error) => this.logger.warn('Paramètres', err.message));
  }

  private autosaveFile(): string {
    return path.join(this.autosaveDir, `${this.project.id}.luma.json`);
  }

  async autosave(force = false): Promise<void> {
    const minutes = this.settings.general.autosaveMinutes;
    if (!this.dirty || (!force && (minutes === 0 || Date.now() - this.lastAutosave < minutes * 60000))) return;
    this.lastAutosave = Date.now();
    try {
      await writeFileAtomic(this.autosaveFile(), serializeProject(this.project), false);
      this.logger.debug('Projet', 'Sauvegarde automatique de récupération écrite');
    } catch (err) {
      this.logger.error('Projet', `Sauvegarde automatique impossible : ${(err as Error).message}`);
    }
  }

  private async clearAutosave(): Promise<void> {
    await fs.rm(this.autosaveFile(), { force: true });
  }
}
