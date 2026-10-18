import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron';
import { AppService, UserError } from '../core/app/AppService';
import { commandSchema, type AppEvents } from '../shared/commands';
import { BRAND } from '../shared/brand';
import { createSecretStore } from './secrets';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.ELECTRON_RENDERER_URL;

// Isolated profile for automated tests.
if (process.env.LUMA_USER_DATA) app.setPath('userData', process.env.LUMA_USER_DATA);

app.setName(BRAND.productName);
if (!app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;
let service: AppService | null = null;
let quitting = false;

const projectFilters = [{ name: BRAND.productName, extensions: ['json'] }];

function isTrustedSender(url: string): boolean {
  if (DEV_URL) return url.startsWith(DEV_URL);
  return url.startsWith('file://');
}

async function createService(): Promise<AppService> {
  const dataDir = app.getPath('userData');
  const svc = new AppService({
    dataDir,
    secrets: createSecretStore(dataDir),
    dialogs: {
      openProject: async () => {
        const r = await dialog.showOpenDialog(win!, { title: 'Ouvrir un projet', filters: projectFilters, properties: ['openFile'] });
        return r.canceled ? null : r.filePaths[0] ?? null;
      },
      saveProject: async (name) => {
        const r = await dialog.showSaveDialog(win!, { title: 'Enregistrer le projet', defaultPath: `${name}.${BRAND.projectExtension}`, filters: projectFilters });
        return r.canceled ? null : r.filePath ?? null;
      },
      openProfile: async () => {
        const r = await dialog.showOpenDialog(win!, { title: 'Importer des profils', filters: [{ name: 'Profils JSON', extensions: ['json'] }], properties: ['openFile'] });
        return r.canceled ? null : r.filePaths[0] ?? null;
      },
    },
  });
  await svc.init();
  return svc;
}

const webPreferences = {
  preload: path.join(here, '../preload/index.cjs'),
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: false,
};

function guardNavigation(w: BrowserWindow): void {
  w.webContents.on('will-navigate', (e, url) => {
    if (!isTrustedSender(url)) e.preventDefault();
  });
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#0B0D12',
    title: BRAND.productName,
    autoHideMenuBar: true,
    webPreferences,
  });
  w.once('ready-to-show', () => w.show());
  // Navigation is restricted to the app itself; external https links open in the system browser.
  guardNavigation(w);
  w.webContents.setWindowOpenHandler(({ url }) => {
    // Detachable 3D stage view (second screen): same renderer, same locked-down preferences.
    if (isTrustedSender(url) && url.endsWith('#stage3d')) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1280, height: 720, backgroundColor: '#0B0D12', title: 'Stage 3D', autoHideMenuBar: true, webPreferences } };
    }
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('did-create-window', (child) => {
    guardNavigation(child);
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
  // Detached windows must not keep the app alive once the main window is gone.
  w.on('closed', () => app.quit());
  w.on('close', (e) => {
    if (quitting || !service?.dirty || process.env.LUMA_E2E) return;
    const choice = dialog.showMessageBoxSync(w, {
      type: 'warning',
      buttons: ['Enregistrer', 'Quitter sans enregistrer', 'Annuler'],
      defaultId: 0,
      cancelId: 2,
      title: BRAND.productName,
      message: 'Le projet contient des modifications non enregistrées.',
    });
    if (choice === 2) e.preventDefault();
    else if (choice === 0) {
      e.preventDefault();
      void service.execute({ type: 'project.save' }).then((r) => {
        if (r.path) {
          quitting = true;
          w.close();
        }
      });
    }
  });
  if (DEV_URL) void w.loadURL(DEV_URL);
  else void w.loadFile(path.join(here, '../renderer/index.html'));
  return w;
}

app.whenReady().then(async () => {
  // Only the microphone (audio-reactive input, LTC) and MIDI (controllers, MTC) may be requested by the renderer.
  const allowed = new Set(['media', 'midi', 'midiSysex']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  service = await createService();

  ipcMain.handle('luma:cmd', async (event, raw: unknown) => {
    if (!isTrustedSender(event.senderFrame?.url ?? '')) return { ok: false, error: 'Origine non autorisée' };
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `Commande invalide : ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join(' ; ')}` };
    try {
      return { ok: true, data: await service!.execute(parsed.data) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof UserError)) service!.logger.error('IPC', `${parsed.data.type} : ${message}`);
      return { ok: false, error: message };
    }
  });

  const forward = <K extends keyof AppEvents>(name: K) => (payload: AppEvents[K]) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('luma:event', name, payload);
  };
  service.on('project', forward('project'));
  service.on('runtime', forward('runtime'));
  service.on('values', forward('values'));
  service.on('log', forward('log'));
  service.on('locatePhoto', forward('locatePhoto'));

  win = createWindow();
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  quitting = true;
  app.quit();
});

let disposed = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (disposed || !service) return;
  e.preventDefault();
  // Clean shutdown: stop the engine, send sACN stream-terminated packets, close sockets/serial ports.
  void service.dispose().finally(() => {
    disposed = true;
    app.quit();
  });
});
