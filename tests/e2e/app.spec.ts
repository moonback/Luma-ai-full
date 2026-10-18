import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { demoSong } from '../music-synth';

const require = createRequire(import.meta.url);
const electronPath = require('electron') as unknown as string;
const shots = path.resolve('test-results/screens');

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await electron.launch({
    executablePath: electronPath,
    // Chromium's fake camera (test pattern) and auto-accepted media prompts, for the camera localisation flow.
    args: [path.resolve('out/main/index.js'), '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    env: { ...process.env, LUMA_USER_DATA: mkdtempSync(path.join(tmpdir(), 'luma-e2e-')), LUMA_E2E: '1' },
  });
  page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('mode')).toHaveText('SIMULATION');
  // First run on a fresh profile: the welcome screen is shown once; the other scenarios start without it.
  await expect(page.getByTestId('welcome')).toBeVisible();
  await page.screenshot({ path: `${shots}/00-accueil.png` });
  await page.getByTestId('welcome-skip').click();
  await expect(page.getByTestId('welcome')).toHaveCount(0);
});

test.afterAll(async () => {
  await app?.close();
});

const nav = (id: string) => page.getByTestId(`nav-${id}`).click();
/** Opens the scene panel unless it already is (it stays open while the page does not change). */
const openScenePanel = async () => { if (!(await page.getByTestId('stage-settings').isVisible())) await page.getByTestId('stage-settings-toggle').click(); };
const channel = (ch: number) => page.locator(`.dmx-cell[data-ch="${ch}"]`);

test('sécurité Electron : pas de Node dans le renderer, API minimale exposée', async () => {
  const exposed = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    api: Object.keys((window as unknown as { luma: object }).luma).sort(),
  }));
  expect(exposed).toEqual({ require: 'undefined', process: 'undefined', api: ['invoke', 'on'] });
  // Invalid commands are rejected by the main-process validator.
  const r = await page.evaluate(() => (window as unknown as { luma: { invoke: (c: unknown) => Promise<{ ok: boolean; error?: string }> } }).luma.invoke({ type: 'fixture.add', profileId: 'x', universe: 99 }));
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/Commande invalide/);
});

test('patch → console → sortie virtuelle → IA → rapport', async () => {
  await page.screenshot({ path: `${shots}/01-dashboard.png` });

  // Patch two RGBW PARs (6 ch each, auto addresses 1 and 7)
  await nav('fixtures');
  await page.getByTestId('add-fixture').click();
  await page.getByTestId('add-profile').selectOption('demo-par-rgbw');
  await page.locator('.modal input.input').nth(1).fill('2'); // quantity (universe, quantity, prefix, tags)
  await page.locator('.modal input.input').nth(1).blur();
  await page.getByTestId('add-confirm').click();
  await expect(page.getByTestId('patch-table').locator('tbody tr')).toHaveCount(2);
  await expect(page.getByTestId('patch-table')).toContainText('7–12');
  await page.screenshot({ path: `${shots}/02-fixtures.png` });

  // Live console: select first fixture, push the dimmer to full
  await nav('console');
  await page.getByTestId('fixture-tiles').locator('.fx-tile').first().click();
  await page.getByTestId('dimmer-fader').fill('255');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${shots}/03-console.png` });

  // DMX Output monitor: computed and transmitted states both show channel 1 = 255
  await nav('output');
  await page.getByRole('tab', { name: 'Moniteur 512 canaux' }).click();
  await expect(channel(1)).toHaveAttribute('data-v', '255');
  await expect(channel(7)).toHaveAttribute('data-v', '0');
  await page.getByTestId('monitor-source').selectOption({ label: 'Transmis : Sortie virtuelle' });
  await expect(channel(1)).toHaveAttribute('data-v', '255');
  await page.screenshot({ path: `${shots}/04-output-monitor.png` });

  // Release manual control (Escape), then let the AI build a look
  await page.keyboard.press('Escape');
  await nav('ai');
  await page.getByTestId('ai-prompt').fill('Crée une ambiance lounge violette et bleue.');
  await page.getByTestId('ai-send').click();
  await expect(page.getByTestId('proposal')).toContainText('Mode local déterministe');
  await expect(page.getByTestId('proposal')).toContainText('Ambiance lounge');
  await page.screenshot({ path: `${shots}/05-ai-proposal.png` });
  await page.getByTestId('ai-apply').click();
  await expect(page.getByTestId('ai-report')).toContainText('Vérification de l’état calculé');
  await page.waitForTimeout(3500); // AI fade (2 s) + output refresh
  await page.screenshot({ path: `${shots}/06-ai-report.png` });

  await nav('output');
  await page.getByRole('tab', { name: 'Moniteur 512 canaux' }).click();
  await expect(channel(1)).toHaveAttribute('data-v', String(Math.round(0.55 * 255))); // PAR 1 dimmer
  await expect(channel(4)).toHaveAttribute('data-v', '255'); // PAR 1 blue (violet)
  await expect(channel(10)).toHaveAttribute('data-v', '255'); // PAR 2 blue (bleu)

  // Visualizer reflects the look
  await nav('visualizer');
  await expect(page.getByTestId('stage-canvas')).toBeVisible();
  await page.screenshot({ path: `${shots}/07-visualizer.png` });

  // Scene created by the AI is listed in the programmer
  await nav('programmer');
  await expect(page.locator('body')).toContainText('Ambiance lounge');
  await page.screenshot({ path: `${shots}/08-programmer.png` });
});

test('blackout et STOP OUTPUT', async () => {
  await page.getByTestId('blackout').click();
  await nav('output');
  await page.getByRole('tab', { name: 'Moniteur 512 canaux' }).click();
  await expect(channel(1)).toHaveAttribute('data-v', '0');
  await page.getByTestId('blackout').click();
  await expect(channel(1)).not.toHaveAttribute('data-v', '0');
  await page.getByTestId('stop-output').click();
  await page.getByRole('tab', { name: 'Sorties' }).click();
  await expect(page.locator('body')).toContainText('STOP — émissions réelles arrêtées');
  await page.screenshot({ path: `${shots}/09-output-stop.png` });
  await page.getByRole('button', { name: 'Reprendre' }).first().click();
});

test('captures des autres espaces', async () => {
  for (const [id, n] of [['cues', '10'], ['effects', '11'], ['timeline', '12'], ['audio', '13'], ['settings', '14'], ['dashboard', '15']] as const) {
    await nav(id);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${shots}/${n}-${id}.png` });
  }
});

test('vue 3D du visualiseur : kit réel, faisceaux animés, caméras, sélection', async () => {
  type Inv = (c: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  const inv = (cmd: unknown) => page.evaluate((x) => (window as unknown as { luma: { invoke: Inv } }).luma.invoke(x), cmd);
  const spots = (await inv({ type: 'fixture.add', profileId: 'demo-spot', mode: '13ch étendu', universe: 2, address: null, count: 4, namePrefix: 'Lyre', tags: [] })).data as { ids: string[] };
  const bars = (await inv({ type: 'fixture.add', profileId: 'demo-led-bar-4', mode: '14ch pixels', universe: 2, address: null, count: 2, namePrefix: 'Barre', tags: [] })).data as { ids: string[] };
  for (const [i, id] of bars.ids.entries()) await inv({ type: 'fixture.update', id, patch: { height: 0.2, position: { x: i ? 3 : -3, y: 7 } } });
  await inv({ type: 'programmer.set', fixtureIds: spots.ids, values: { dimmer: 1, tilt: 0.62, colorWheel: 65 / 255, gobo: 25 / 255, prism: 200 / 255 }, confirmSpecial: false });
  await inv({ type: 'programmer.set', fixtureIds: bars.ids, values: { dimmer: 1 }, confirmSpecial: false });
  const fx = (id: string, type: string, targets: string[], params: Record<string, unknown>) => inv({ type: 'effect.upsert', effect: { id, name: id, type, targets: { fixtureIds: targets, groupIds: [] }, params, priority: 50, blend: 'override', duration: null, trigger: 'manual', origin: 'user' } });
  await fx('mvt', 'panTilt', spots.ids, { speed: 0.2, amplitude: 0.5, phaseSpread: 0.5 });
  await fx('rbw', 'rainbow', bars.ids, { speed: 0.2, phaseSpread: 1 });
  await inv({ type: 'programmer.release', fixtureIds: spots.ids, attributes: ['pan'] });
  await inv({ type: 'effect.start', id: 'mvt' });
  await inv({ type: 'effect.start', id: 'rbw' });

  await nav('stage3d');
  await expect(page.getByTestId('stage-3d').locator('canvas')).toBeVisible();
  await expect(page.getByTestId('fps')).not.toHaveText('0 i/s', { timeout: 5000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${shots}/16-visualizer-3d-regie.png` });
  await page.getByTestId('cam-front').click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${shots}/16b-visualizer-3d-face.png` });
  await page.getByTestId('cam-top').click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${shots}/16c-visualizer-3d-dessus.png` });
  await page.getByTestId('cam-foh').click();
  // Select a moving head (shared selection with the console) → info panel shows its live data.
  await nav('console');
  await page.getByTestId('fixture-tiles').getByText('Lyre 1').click();
  await nav('stage3d');
  await expect(page.getByTestId('stage3d-info')).toContainText('Lyre 1');
  await expect(page.getByTestId('stage3d-info')).toContainText('prisme');
  await expect(page.getByTestId('stage3d-info')).toContainText('gobo 2');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${shots}/16d-visualizer-3d-selection.png` });
  // Detached second-screen window: chrome-less 3D view fed by the same live engine events.
  const [detached] = await Promise.all([app.waitForEvent('window'), page.getByTestId('stage3d-detach').click()]);
  await expect(detached.getByTestId('stage-3d').locator('canvas')).toBeVisible();
  await expect(detached.getByTestId('fps')).not.toHaveText('0 i/s', { timeout: 5000 });
  await expect(detached.getByTestId('nav-stage3d')).toHaveCount(0);
  await detached.screenshot({ path: `${shots}/16e-visualizer-3d-detache.png` });
  await detached.close();
  await inv({ type: 'effect.stopAll' });
});

test('scène : avancée, point de scène, fumée, vue enregistrée, vue projecteur, éblouissement, captures', async () => {
  type Inv = (c: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  const inv = (cmd: unknown) => page.evaluate((x) => (window as unknown as { luma: { invoke: Inv } }).luma.invoke(x), cmd);
  const shaderErrors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' && /shader|WebGLProgram|THREE/i.test(m.text())) shaderErrors.push(m.text()); });

  // Stage layout and stage point from the 2D settings panel.
  await nav('visualizer');
  await openScenePanel();
  await page.getByTestId('shape-thrust').click();
  await page.getByTestId('marker-add').click();
  await expect(page.getByTestId('marker-row')).toHaveCount(1);
  await page.screenshot({ path: `${shots}/17-scene-reglages-2d.png` });

  // Moving heads aimed into the house at eye level → glare badge.
  const state = (await inv({ type: 'project.get' })).data as { project: { patch: { id: string; name: string }[] } };
  const lyres = state.project.patch.filter((f) => f.name.startsWith('Lyre')).map((f) => f.id);
  await inv({ type: 'programmer.set', fixtureIds: lyres, values: { dimmer: 1, pan: 0.5, tilt: 0.78, prism: 0 }, confirmSpecial: false });
  // Lyre 1 may still be selected by the previous scenario: a tile click toggles, so only click when needed.
  await nav('stage3d');
  if (!(await page.getByTestId('stage3d-info').isVisible())) {
    await nav('console');
    await page.getByTestId('fixture-tiles').getByText('Lyre 1').click();
    await nav('stage3d');
  }
  await expect(page.getByTestId('stage3d-info')).toContainText('Lyre 1');
  await expect(page.getByTestId('glare')).toContainText('Éblouissement public');
  await page.getByTestId('render-menu').click(); // display settings live in the Rendu menu
  await page.getByTestId('smoke').click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${shots}/17b-scene-avancee-fumee.png` });

  // Saved view round trip.
  await page.getByTestId('cam-top').click();
  await page.waitForTimeout(900);
  await page.getByTestId('cam-save').click();
  await expect(page.getByTestId('cam-saved')).toHaveCount(1);
  await page.getByTestId('cam-foh').click();
  await page.getByTestId('cam-saved').getByText('Vue 1').click();

  // Beam's-eye view on the selected moving head.
  await page.getByTestId('beam-view').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${shots}/17c-scene-vue-projecteur.png` });
  await page.getByTestId('beam-view').click();

  // Captures: intercept the download link instead of opening the save dialog.
  await page.evaluate(() => {
    const w = window as unknown as { __downloads: string[]; __blobSize: number };
    w.__downloads = [];
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { w.__downloads.push(this.href); };
    // The app CSP forbids fetching blob: URLs, so measure the recording when its URL is created.
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (o: Blob | MediaSource) => { if (o instanceof Blob) w.__blobSize = o.size; return create(o); };
  });
  await page.getByTestId('capture').click();
  await page.getByTestId('record').click();
  await page.waitForTimeout(1500);
  await page.getByTestId('record').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __downloads: string[] }).__downloads.length)).toBe(2);
  const [png, webm] = await page.evaluate(() => {
    const w = window as unknown as { __downloads: string[]; __blobSize: number };
    return [w.__downloads[0]!.length, w.__blobSize];
  });
  expect(png).toBeGreaterThan(20_000); // a black frame would compress to a few KB
  expect(webm).toBeGreaterThan(0);
  expect(shaderErrors).toEqual([]);
  await inv({ type: 'programmer.release', fixtureIds: lyres });
});

test('structures : accroche, suivi, annuler / rétablir, édition directe au gizmo', async () => {
  type Inv = (c: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  type Fx = { id: string; name: string; position: { x: number; y: number }; height: number; trussId?: string | null };
  const inv = (cmd: unknown) => page.evaluate((x) => (window as unknown as { luma: { invoke: Inv } }).luma.invoke(x), cmd);
  const lyre1 = async () => ((await inv({ type: 'project.get' })).data as { project: { patch: Fx[] } }).project.patch.find((f) => f.name === 'Lyre 1')!;

  // A straight truss from the scene panel (10 m, 4 m upstage, 6 m high).
  await nav('visualizer');
  await openScenePanel();
  await page.getByTestId('truss-add').click();
  await expect(page.getByTestId('truss-row')).toHaveCount(1);

  // Hang Lyre 1 on it from the 3D info panel.
  await nav('stage3d');
  if (!(await page.getByTestId('stage3d-info').isVisible())) {
    await nav('console');
    await page.getByTestId('fixture-tiles').getByText('Lyre 1').click();
    await nav('stage3d');
  }
  await page.getByTestId('fixture-truss').selectOption({ label: 'Structure 1' });
  await expect.poll(async () => (await lyre1()).trussId).toBeTruthy();
  const hung = await lyre1();
  expect(hung.position.y).toBe(4);
  expect(hung.height).toBeCloseTo(5.8);

  // Moving the truss carries the fixture; undo / redo walk it back and forth.
  await nav('visualizer');
  await openScenePanel();
  const yField = page.getByTestId('truss-row').locator('input.mono').nth(2); // L, X, Y, H, rotation
  await yField.fill('5');
  await yField.press('Enter');
  await expect.poll(async () => (await lyre1()).position.y).toBe(5);
  await page.screenshot({ path: `${shots}/18-structures-2d.png` });
  await page.getByTestId('scene-undo').click();
  await expect.poll(async () => (await lyre1()).position.y).toBe(4);
  await page.getByTestId('scene-redo').click();
  await expect.poll(async () => (await lyre1()).position.y).toBe(5);

  // Direct editing: top view, drag the gizmo centre of Lyre 1 sideways along its truss.
  // Editing the truss card selected the truss (one selection at a time): select Lyre 1 again.
  await nav('stage3d');
  if (!(await page.getByTestId('stage3d-info').isVisible())) {
    await nav('console');
    await page.getByTestId('fixture-tiles').getByText('Lyre 1').click();
    await nav('stage3d');
  }
  await expect(page.getByTestId('stage3d-info')).toContainText('Lyre 1');
  await page.getByTestId('edit3d').click();
  await page.getByTestId('grid').selectOption('0.25');
  await page.getByTestId('cam-top').click();
  await page.waitForTimeout(1000);
  const box = (await page.getByTestId('stage-3d').locator('canvas').boundingBox())!;
  const before = await lyre1();
  // Top camera (see viewPose): above the centre of deck + 4 m thrust, fov 48°.
  const camH = 12 * 1.6, tz = 4 - 6, k = Math.tan((24 * Math.PI) / 180) * (camH - before.height);
  const toPx = (x: number, z: number) => ({ x: box.x + box.width / 2 + (x / (k * (box.width / box.height))) * (box.width / 2), y: box.y + box.height / 2 - ((tz - z) / k) * (box.height / 2) });
  const c = toPx(before.position.x, -before.position.y);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 40, c.y, { steps: 5 });
  await page.mouse.move(c.x + 80, c.y, { steps: 5 });
  await expect(page.getByTestId('dims')).toContainText('accroche : Structure 1');
  await page.screenshot({ path: `${shots}/18b-structures-gizmo.png` });
  await page.mouse.up();
  await expect.poll(async () => (await lyre1()).position.x).toBeGreaterThan(before.position.x + 0.5);
  const moved = await lyre1();
  expect(moved).toMatchObject({ trussId: before.trussId, position: { y: 5 } });
  expect(Number.isInteger(moved.position.x * 4)).toBe(true); // 0,25 m grid
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await lyre1()).position.x).toBe(before.position.x);
  await page.getByTestId('edit3d').click();
  await page.getByTestId('cam-foh').click();
});

test('interprètes, écrans LED, éclairage réel avec ombres, ambiances et sol', async () => {
  const renderErrors: string[] = [];
  const onConsole = (m: { type: () => string; text: () => string }) => { if (m.type() === 'error' && /shader|WebGL|THREE/i.test(m.text())) renderErrors.push(m.text()); };
  page.on('console', onConsole);

  // Two performers (one on the stage point), a drum kit and a pixel-mapped LED screen, from the scene panel.
  await nav('visualizer');
  await openScenePanel();
  await page.getByTestId('performer-add').click();
  await page.getByTestId('performer-add').click();
  await expect(page.getByTestId('performer-row')).toHaveCount(2);
  await page.getByTestId('performer-marker').first().selectOption({ label: 'Sur « Point 1 »' });
  await page.getByTestId('performer-row').nth(1).locator('select').first().selectOption('drums');
  await page.getByTestId('screen-add').click();
  await page.getByTestId('screen-source').selectOption('pixels');
  await expect(page.getByTestId('screen-row')).toHaveCount(1);
  await page.screenshot({ path: `${shots}/19-interpretes-ecrans-2d.png` });

  // Light the rig: every fixture full, moving heads straight down (tilt 0,5 = 0°).
  type Inv = (c: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  const inv = (cmd: unknown) => page.evaluate((x) => (window as unknown as { luma: { invoke: Inv } }).luma.invoke(x), cmd);
  const patch = ((await inv({ type: 'project.get' })).data as { project: { patch: { id: string; name: string }[] } }).project.patch;
  const ids = patch.map((f) => f.id);
  await inv({ type: 'programmer.set', fixtureIds: ids, values: { dimmer: 1 }, confirmSpecial: false });
  await inv({ type: 'programmer.set', fixtureIds: patch.filter((f) => f.name.startsWith('Lyre')).map((f) => f.id), values: { tilt: 0.5, pan: 0.5, gobo: 0, prism: 0 }, confirmSpecial: false });
  await inv({ type: 'effect.start', id: 'rbw' }); // rainbow on the LED bars → pixel-mapped screen
  await nav('stage3d');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${shots}/19b-interpretes-ecrans-3d.png` });

  // Real lighting: shadow-casting spot lights, budget shown on the chip, switch without reloading.
  await page.getByTestId('render-menu').click();
  await page.getByTestId('real-lights').click();
  await expect(page.getByTestId('real-lights')).toContainText(/Ombres · \d+/, { timeout: 5000 });
  await page.waitForTimeout(5000); // first frames compile the shadow shaders
  console.log(`éclairage réel : ${await page.getByTestId('fps').textContent()} · ${await page.getByTestId('real-lights').textContent()}`);
  await page.screenshot({ path: `${shots}/19c-eclairage-reel.png` });

  // Ambience and reflective floor.
  await page.getByTestId('ambience').selectOption('club');
  await page.getByTestId('floor').selectOption('wet');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${shots}/19d-club-sol-mouille.png` });
  await page.getByTestId('ambience').selectOption('work');
  await page.getByTestId('floor').selectOption('lacquer');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${shots}/19e-service-sol-laque.png` });

  // Back to the defaults (preferences persist per viewer).
  await page.getByTestId('real-lights').click();
  await page.getByTestId('ambience').selectOption('black');
  await page.getByTestId('floor').selectOption('matte');
  await expect(page.getByTestId('fps')).not.toHaveText('0 i/s');
  page.off('console', onConsole);
  expect(renderErrors).toEqual([]);
  await inv({ type: 'effect.stopAll' });
  await inv({ type: 'programmer.release', fixtureIds: ids });
});

test('création rapide : équiper les structures, poser au clic, dupliquer, supprimer', async () => {
  type Inv = (c: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  type Fx = { name: string; trussId?: string | null; mount?: string };
  const inv = (cmd: unknown) => page.evaluate((x) => (window as unknown as { luma: { invoke: Inv } }).luma.invoke(x), cmd);
  const patch = async () => ((await inv({ type: 'project.get' })).data as { project: { patch: Fx[] } }).project.patch;
  await nav('visualizer');
  await openScenePanel();

  // Equip without a selection (a click on an empty corner clears it): the hung fixtures spread over the trusses,
  // floor-standing ones stay put; one undoable step.
  const box = (await page.getByTestId('stage-canvas').boundingBox())!;
  await page.mouse.click(box.x + 6, box.y + 6);
  await expect(page.getByTestId('equip')).toHaveText('Équiper les structures');
  const hungBefore = (await patch()).filter((f) => f.trussId).length;
  await page.getByTestId('equip').click();
  await expect.poll(async () => (await patch()).filter((f) => f.trussId).length).toBeGreaterThan(hungBefore);
  await page.screenshot({ path: `${shots}/20-equiper-structures.png` });
  await page.getByTestId('scene-undo').click();
  await expect.poll(async () => (await patch()).filter((f) => f.trussId).length).toBe(hungBefore);

  // Click placement on the 2D plan; the new point is selected, Ctrl+D duplicates it, Suppr deletes the copy.
  const rows = page.getByTestId('marker-row');
  const before = await rows.count();
  await page.getByTestId('marker-add-place').click();
  await expect(page.getByTestId('placing')).toBeVisible();
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await expect(rows).toHaveCount(before + 1);
  await expect(page.getByTestId('placing')).toHaveCount(0);
  await expect(rows.last()).toHaveClass(/on/);
  await page.keyboard.press('Control+d');
  await expect(rows).toHaveCount(before + 2);
  await expect(rows.last().locator('input').first()).toHaveValue(/\(copie\)$/);
  await page.screenshot({ path: `${shots}/20b-poser-dupliquer.png` });
  await page.keyboard.press('Delete');
  await expect(rows).toHaveCount(before + 1);

  // Échap cancels a placement without releasing anything else.
  await page.getByTestId('truss-add-place').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('placing')).toHaveCount(0);
});

test('bibliothèque : totems, pièces de truss et décor, au clic ou glissés en 2D et en 3D', async () => {
  type Inv = (c: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  type Vis = { trusses: { id: string; shape: string; height: number; x: number; y: number }[]; props: { kind: string }[] };
  const inv = (cmd: unknown) => page.evaluate((x) => (window as unknown as { luma: { invoke: Inv } }).luma.invoke(x), cmd);
  const vis = async () => ((await inv({ type: 'project.get' })).data as { project: { visualizer: Vis } }).project.visualizer;
  await nav('visualizer');
  await openScenePanel();

  // Library tile then a click on the plan: a 3 m totem lands there.
  const trusses = (await vis()).trusses.length;
  await page.getByTestId('lib-totem-3').click();
  await expect(page.getByTestId('placing')).toContainText('Totem 3 m');
  const box = (await page.getByTestId('stage-canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.3);
  await expect.poll(async () => (await vis()).trusses.length).toBe(trusses + 1);
  expect((await vis()).trusses.at(-1)).toMatchObject({ shape: 'totem', height: 3 });

  // Set pieces dragged from the library onto the 2D plan, then onto the 3D view.
  const props = (await vis()).props.length;
  await page.getByTestId('lib-group-decor').click();
  await page.getByTestId('lib-riser-2x1').dragTo(page.getByTestId('stage-canvas'), { targetPosition: { x: box.width * 0.4, y: box.height * 0.5 } });
  await expect.poll(async () => (await vis()).props.length).toBe(props + 1);
  await expect(page.getByTestId('prop-row')).toHaveCount(props + 1);
  await page.screenshot({ path: `${shots}/21-bibliotheque-2d.png` });

  await nav('stage3d');
  await openScenePanel();
  await page.getByTestId('lib-group-decor').click();
  const box3 = (await page.getByTestId('stage-3d').boundingBox())!;
  await page.getByTestId('lib-speaker').dragTo(page.getByTestId('stage-3d'), { targetPosition: { x: box3.width * 0.35, y: box3.height * 0.75 } });
  await expect.poll(async () => (await vis()).props.at(-1)?.kind).toBe('speaker');

  // An assembled gantry (two totems, a 6 m straight resting on them, corners) renders without shader errors.
  const errors: string[] = [];
  const onConsole = (m: { type: () => string; text: () => string }) => { if (m.type() === 'error' && /shader|WebGL|THREE/i.test(m.text())) errors.push(m.text()); };
  page.on('console', onConsole);
  const piece = (id: string, shape: string, x: number, length = 0.5, rotation = 0) => ({ id, name: id, shape, x, y: 6, height: 3, length, rotation, support: 'none' });
  const current = (await vis()).trusses;
  await inv({ type: 'project.update', visualizer: { trusses: [...current, piece('portique-g', 'totem', -3), piece('portique-d', 'totem', 3), piece('portique', 'line', 0, 6), piece('angle', 'corner', 3, 0.5, 90), piece('croix', 'cross', -3)] } });
  await page.getByTestId('cam-foh').click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${shots}/21b-bibliotheque-3d.png` });
  page.off('console', onConsole);
  expect(errors).toEqual([]);
});

test('raccourci reconfiguré : Blackout sur K', async () => {
  await nav('settings');
  await page.getByRole('tab', { name: 'Raccourcis' }).click();
  await page.getByTestId('rebind-blackout').click();
  await page.keyboard.press('k');
  await expect(page.getByTestId('shortcut-table')).toContainText('K');
  await page.screenshot({ path: `${shots}/17-shortcuts.png` });
  await page.getByTestId('settings-save').click();
  await nav('dashboard');
  await page.keyboard.press('k');
  await expect(page.getByTestId('blackout')).toHaveClass(/solid/);
  await page.keyboard.press('b'); // old binding no longer active
  await expect(page.getByTestId('blackout')).toHaveClass(/solid/);
  await page.keyboard.press('k');
  await expect(page.getByTestId('blackout')).not.toHaveClass(/solid/);
});

test('fournisseur OpenRouter sélectionnable avec choix du modèle', async () => {
  await nav('settings');
  await page.getByRole('tab', { name: 'IA et fournisseurs' }).click();
  await page.getByTestId('ai-provider').selectOption('openrouter');
  await expect(page.getByTestId('ai-model')).toHaveValue('openrouter/auto');
  await page.getByTestId('ai-model').fill('mistralai/mistral-small');
  await page.screenshot({ path: `${shots}/18-openrouter.png` });
});

test('fiabilisation : garde-fou, contrôle externe, télécommande et RDM', async () => {
  await nav('settings');
  await page.getByRole('tab', { name: 'Moteur & sécurité' }).click();
  await page.getByTestId('flash-guard').selectOption('limit');
  await page.getByRole('tab', { name: 'Contrôle externe' }).click();
  await page.getByTestId('remote-enabled').check();
  await page.getByTestId('settings-save').click();
  const url = (await page.getByTestId('remote-urls').locator('td').first().textContent())!.replace(/^http:\/\/[^:]+/, 'http://127.0.0.1');
  await page.screenshot({ path: `${shots}/19-controle-externe.png` });
  const remote = await (await fetch(url)).text();
  expect(remote).toContain('Télécommande');
  expect((await fetch(url.replace(/t=[^&]+/, 't=mauvais'))).status).toBe(403);
  const r = await fetch(url.replace('/?', '/cmd?'), { method: 'POST', body: JSON.stringify({ type: 'engine.blackout', on: true }) });
  expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
  await expect(page.getByTestId('blackout')).toHaveClass(/solid/);
  await page.getByTestId('blackout').click();
  await page.getByTestId('remote-enabled').uncheck();
  await page.getByTestId('settings-save').click();
  await nav('output');
  await page.getByRole('tab', { name: 'RDM' }).click();
  await expect(page.getByText('Ajoutez une sortie Art-Net')).toBeVisible();
});

/** 16-bit PCM mono WAV. */
function wav(samples: Float32Array, sr: number): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return b;
}

test('intelligence musicale : import, analyse, Song-to-Show, lecture synchronisée', async () => {
  const song = demoSong(124);
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'luma-song-')), 'Demo pop.wav');
  writeFileSync(file, wav(song.samples, song.sr));
  await nav('music');
  await page.getByTestId('music-file').setInputFiles(file);
  await expect(page.getByTestId('music-summary')).toContainText('124', { timeout: 30_000 });
  await expect(page.getByTestId('section-strip')).toContainText('Refrain');
  await page.getByTestId('music-intent').fill('concert pop, sobre sur les couplets, explosion sur les refrains, pas de strobe');
  await page.getByTestId('music-generate').click();
  await expect(page.getByTestId('music-plan-summary')).toContainText('sections');
  await expect(page.getByTestId('music-sections')).toContainText('Chase');
  await page.screenshot({ path: `${shots}/20-musique-song-to-show.png` });
  // Synchronised playback (the timeline chase itself is covered by the timecode unit tests).
  await page.getByTestId('music-play').click();
  await expect(page.getByTestId('music-stop')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.querySelector('[data-testid="music-stop"]')?.textContent ?? ''), { timeout: 5000 }).toMatch(/0:0[1-9]/);
  await nav('audio');
  await expect(page.getByTestId('audio-bpm')).not.toHaveText('—', { timeout: 10_000 });
  await page.screenshot({ path: `${shots}/21-audio-tempo-prediction.png` });
  await nav('music');
  await page.getByTestId('music-stop').click();
  await expect(page.getByTestId('music-play')).toBeVisible();
});

test('localisation par caméra : séquence sûre, calibration, résultats (caméra factice)', async () => {
  await nav('fixtures');
  await page.getByTestId('locate-open').click();
  await page.getByTestId('locate-preview').click();
  await page.getByTestId('locate-run').click();
  await page.getByRole('button', { name: 'Lancer', exact: true }).click();
  // Sequence runs through the engine, then asks for the 4 stage corners.
  await expect(page.getByTestId('locate-frame')).toBeVisible({ timeout: 30_000 });
  const frame = page.getByTestId('locate-frame');
  const box = (await frame.boundingBox())!;
  for (const [fx, fy] of [[0.15, 0.85], [0.85, 0.85], [0.75, 0.45], [0.25, 0.45]] as [number, number][]) await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
  await page.getByTestId('locate-solve').click();
  await expect(page.getByTestId('locate-summary')).toContainText('projecteurs localisés');
  // The test pattern contains no fixture: every fixture is reported as not answering.
  await expect(page.getByTestId('locate-issues')).toContainText('ne répond pas');
  await page.screenshot({ path: `${shots}/22-localisation-camera.png` });
  await page.keyboard.press('Escape');
});

test('onboarding : visite guidée complète, premiers pas, projet de démonstration', async () => {
  await nav('dashboard');
  await expect(page.getByTestId('first-steps')).toBeVisible();
  await page.getByTestId('help').click();
  await page.getByTestId('help-tour').click();
  await expect(page.getByTestId('tour-title')).toHaveText('Bienvenue à bord');
  const titles: string[] = [];
  for (let i = 0; i < 17; i++) {
    await page.getByTestId('tour-next').click();
    titles.push((await page.getByTestId('tour-title').textContent()) ?? '');
    if (titles.at(-1) === 'Visualiseur 3D') {
      await page.waitForTimeout(400); // let the spotlight transition settle
      await page.screenshot({ path: `${shots}/23-visite-guidee.png` });
    }
  }
  expect(titles).toContain('STOP OUTPUT');
  expect(titles).toContain('Musique (Song-to-Show)');
  await expect(page.getByTestId('nav-settings')).toHaveClass(/active/); // the tour opened the pages it describes
  await page.getByTestId('tour-finish').click();
  await expect(page.getByTestId('tour')).toHaveCount(0);

  await page.getByTestId('help').click();
  await page.getByTestId('help-demos').click();
  await expect(page.getByTestId('demo-gallery').locator('[data-testid^="demo-"]')).toHaveCount(10);
  await page.screenshot({ path: `${shots}/24-projets-demo.png` });
  await page.getByTestId('demo-gala-danse').getByRole('button', { name: 'Ouvrir' }).click();
  const confirm = page.getByRole('button', { name: 'Ouvrir la démo' });
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await expect(page.locator('.top-project')).toContainText('Gala');
  await expect(page.getByTestId('first-steps')).toContainText('Premiers pas');
  await page.screenshot({ path: `${shots}/25-premiers-pas.png` });
  // The demo is playable: GO on its first cue list.
  await page.keyboard.press('Space');
  await nav('stage3d');
  await expect(page.getByTestId('stage-3d').locator('canvas')).toBeVisible();
});
