import { readFileSync } from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import { convertOflFixture } from '../../src/core/fixtures/ofl';
import { ProfileLibrary, resolveFixture, validateProfile } from '../../src/core/fixtures/profiles';
import { cellColors, colorCells, colorGroups, colorToAttributes, displayColor } from '../../src/core/fixtures/color';
import { findModule } from '../../src/core/fixtures/modules';
import { interpretLocally } from '../../src/core/ai/local/interpreter';
import { lookToValues } from '../../src/core/ai/director';
import { commandSchema } from '../../src/shared/commands';
import type { AiAction } from '../../src/core/ai/actions';
import { computeEffect } from '../../src/core/engine/effects';
import { ProjectIndex } from '../../src/core/engine/resolve';
import { effectSchema, profileSchema, type Fixture } from '../../src/core/model/schemas';
import { buildOpenDmxFrame, OpenDmxOutput, type BreakCapablePort } from '../../src/core/protocols/opendmx';
import { outputConfigSchema, type OutputConfig } from '../../src/core/protocols/types';
import { extractJson, parseModels, proposeWithOpenRouter } from '../../src/core/ai/providers/openrouter';
import { resolveShortcuts, settingsSchema, shortcutConflicts } from '../../src/core/settings/settings';
import { comboFromEvent } from '../../src/renderer/shortcuts';
import { buildVisualModel } from '../../src/core/visualizer/model';
import { demoProject, makeEngine, makeService, u1 } from '../helpers';

const ofl = (name: string) => JSON.parse(readFileSync(path.resolve('tests/fixtures/ofl', `${name}.json`), 'utf8')) as unknown;
const fixture = (over: Partial<Fixture>): Fixture => ({ id: 'f', name: 'F', profileId: 'demo-led-bar-4', mode: '14ch pixels', universe: 1, address: 1, tags: [], position: { x: 0, y: 0 }, rotation: 0, height: 4, notes: '', ...over });

describe('Open Fixture Library', () => {
  it('convertit une lyre réelle : modes, canaux fins 16 bits, roues, maintenance dangereuse', () => {
    const r = convertOflFixture(ofl('eurolite-led-tmh-17'), { manufacturer: 'Eurolite', key: 'led-tmh-17' });
    expect(r.errors).toEqual([]);
    const p = r.profile!;
    expect(p.id).toBe('ofl-eurolite-led-tmh-17');
    expect(p.type).toBe('moving-head-spot');
    expect(p.physical.beamAngle).toBe(12);
    expect(p.modes.map((m) => [m.name, m.channels.length])).toEqual([['9-channel', 9], ['11-channel', 11]]);
    const m11 = p.modes[1]!.channels;
    expect(m11.slice(0, 4).map((c) => [c.attribute, c.fine])).toEqual([['pan', false], ['pan', true], ['tilt', false], ['tilt', true]]);
    const wheel = m11.find((c) => c.attribute === 'colorWheel')!;
    expect(wheel.ranges.some((x) => x.kind === 'color' && x.color === '#FF0000')).toBe(true);
    expect(m11.find((c) => c.attribute === 'control')!.ranges.filter((x) => x.dangerous).length).toBeGreaterThan(0);
    expect(validateProfile(p).ok).toBe(true);
    expect(p.physical).toMatchObject({ dimensions: { width: 0.17, height: 0.24, depth: 0.145 }, weight: 2.65, power: 50, connector: '3-pin' });
  });

  it('couleur d’émetteur du profil utilisée par l’affichage', () => {
    const p = convertOflFixture(ofl('synthetic-rgbww-par'), { manufacturer: 'Test', key: 'rgbww' }).profile!;
    p.modes[0]!.channels[4]!.emitterColor = '#FFFFCC';
    const rf = resolveFixture(new ProfileLibrary([p]), fixture({ profileId: p.id, mode: '7-channel' }))!;
    expect(displayColor(rf, { warmWhite: 1 }).color).toEqual({ r: 1, g: 1, b: 0.8 });
  });

  it('convertit une barre pixel : matrice → cellules, groupe Master → fixture entière', () => {
    const p = convertOflFixture(ofl('eurolite-led-pix-12-hcl'), { manufacturer: 'Eurolite', key: 'led-pix-12-hcl' }).profile!;
    expect(p.type).toBe('led-bar');
    const m74 = p.modes.find((m) => m.name === '74-channel')!;
    expect(m74.channels).toHaveLength(74);
    expect(m74.channels[2]).toMatchObject({ attribute: 'red', cell: 1 });
    expect(m74.channels[73]).toMatchObject({ attribute: 'uv', cell: 12 });
    const m36 = p.modes.find((m) => m.name === '36-channel')!;
    expect(new Set(m36.channels.map((c) => c.cell))).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    const m6 = p.modes.find((m) => m.name === '6-channel')!;
    expect(m6.channels.map((c) => c.attribute)).toEqual(['red', 'green', 'blue', 'white', 'amber', 'uv']);
    expect(m6.channels.every((c) => c.cell === undefined)).toBe(true);
  });

  it('un profil OFL importé pilote correctement le DMX (pan 16 bits, cellules)', () => {
    const spot = convertOflFixture(ofl('eurolite-led-tmh-17'), { manufacturer: 'Eurolite', key: 'led-tmh-17' }).profile!;
    const bar = convertOflFixture(ofl('eurolite-led-pix-12-hcl'), { manufacturer: 'Eurolite', key: 'led-pix-12-hcl' }).profile!;
    const p = demoProject();
    p.profiles = [spot, bar];
    p.patch = [fixture({ id: 's', profileId: spot.id, mode: '11-channel', address: 1 }), fixture({ id: 'b', profileId: bar.id, mode: '74-channel', address: 20 })];
    const { engine } = makeEngine(p);
    engine.setProgrammer(['s'], { pan: 0.75 });
    engine.setProgrammer(['b'], colorToAttributes(new ProjectIndex(p).fixtures.get('b')!, { r: 1, g: 0, b: 0 }, 12));
    engine.setProgrammer(['b'], { dimmer: 1 });
    engine.tick(25);
    const v16 = Math.round(0.75 * 65535);
    expect([u1(engine)[0], u1(engine)[1]]).toEqual([v16 >> 8, v16 & 255]);
    // bar @20: dimmer, strobe, then 12 × 6 channels; cell 12 red = channel 20 + 2 + 11*6 = 88
    expect(u1(engine)[87]).toBe(255);
    expect(u1(engine)[21]).toBe(0);
  });

  it('convertit un RGBWW : blancs chaud/froid et lime en attributs dédiés, pas en génériques', () => {
    const r = convertOflFixture(ofl('synthetic-rgbww-par'), { manufacturer: 'Test', key: 'rgbww' });
    expect(r.warnings).toEqual([]);
    const p = r.profile!;
    expect(p.modes[0]!.channels.map((c) => c.attribute)).toEqual(['dimmer', 'red', 'green', 'blue', 'warmWhite', 'coldWhite', 'lime']);
    expect(validateProfile(p).ok).toBe(true);
    const lib = new ProfileLibrary([p]);
    const rf = resolveFixture(lib, fixture({ profileId: p.id, mode: '7-channel' }))!;
    // White extraction goes to both whites (neutral mix), lime untouched.
    expect(colorToAttributes(rf, { r: 1, g: 1, b: 0.5 })).toEqual({ red: 0.5, green: 0.5, blue: 0, warmWhite: 0.5, coldWhite: 0.5 });
    expect(displayColor(rf, { warmWhite: 1 }).color.b).toBeLessThan(displayColor(rf, { coldWhite: 1 }).color.b);
  });

  it('refuse un fichier qui n’est pas au format OFL', () => {
    const r = convertOflFixture({ hello: 'world' }, { manufacturer: 'X', key: 'y' });
    expect(r.profile).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('import par fichier via AppService, profil ajouté au projet', async () => {
    const { svc } = makeService();
    await svc.init();
    const r = await svc.execute({ type: 'profile.importOfl', source: { kind: 'file', path: path.resolve('tests/fixtures/ofl/cameo-flat-pro-18.json'), manufacturerName: 'Cameo' } });
    expect(r.imported).toBe('Cameo Flat Pro 18');
    expect(svc.projectState().project.profiles.map((p) => p.id)).toEqual(['ofl-cameo-cameo-flat-pro-18']);
    const add = await svc.execute({ type: 'fixture.add', profileId: 'ofl-cameo-cameo-flat-pro-18', mode: '5-channel', universe: 1, address: null, count: 2, namePrefix: 'Flat', tags: [] });
    expect(add.ids).toHaveLength(2);
    await svc.dispose();
  });
});

describe('projecteurs multi-cellules', () => {
  const lib = new ProfileLibrary();
  const rf = resolveFixture(lib, fixture({}))!;

  it('le schéma accepte un attribut par cellule mais refuse les doublons', () => {
    const base = { id: 'x', name: 'X', manufacturer: 'M', type: 'led-bar' };
    expect(validateProfile({ ...base, modes: [{ name: 'm', channels: [{ name: 'r1', attribute: 'red', cell: 1 }, { name: 'r2', attribute: 'red', cell: 2 }] }] }).ok).toBe(true);
    expect(validateProfile({ ...base, modes: [{ name: 'm', channels: [{ name: 'r1', attribute: 'red', cell: 1 }, { name: 'r1b', attribute: 'red', cell: 1 }] }] }).ok).toBe(false);
  });

  it('couleur sur toutes les cellules ou sur une seule', () => {
    expect(colorCells(rf)).toEqual([1, 2, 3, 4]);
    expect(Object.keys(colorToAttributes(rf, { r: 1, g: 0, b: 0 }))).toHaveLength(12);
    expect(colorToAttributes(rf, { r: 0, g: 1, b: 0 }, 3)).toEqual({ 'red#3': 0, 'green#3': 1, 'blue#3': 0 });
  });

  it('rendu DMX, couleurs par cellule et visualiseur', () => {
    const p = demoProject();
    p.patch = [fixture({ address: 101 })];
    const { engine } = makeEngine(p);
    engine.setProgrammer(['f'], { dimmer: 1, ...colorToAttributes(rf, { r: 0, g: 0, b: 1 }, 2), ...colorToAttributes(rf, { r: 1, g: 0, b: 0 }, 4) });
    engine.tick(25);
    const u = u1(engine);
    expect(u[100]).toBe(255); // dimmer
    expect([u[105], u[106], u[107]]).toEqual([0, 0, 255]); // cell 2 = channels 6..8 of the fixture
    expect([u[111], u[112], u[113]]).toEqual([255, 0, 0]); // cell 4
    expect(cellColors(rf, engine.values.f!).map((c) => c.color.b)).toEqual([0, 1, 0, 0]);
    expect(displayColor(rf, engine.values.f!).intensity).toBe(1);
    expect(buildVisualModel([rf], engine.values)[0]!.cells).toEqual(['#000000', '#0000ff', '#000000', '#ff0000']);
  });

  it('le rainbow se répartit pixel par pixel', () => {
    const e = effectSchema.parse({ id: 'e', name: 'r', type: 'rainbow', targets: { fixtureIds: ['f'], groupIds: [] }, params: { phaseSpread: 1 } });
    const out = computeEffect(e, 0, [rf]).f!;
    const hues = [1, 2, 3, 4].map((c) => `${out[`red#${c}`]},${out[`green#${c}`]},${out[`blue#${c}`]}`);
    expect(new Set(hues).size).toBe(4);
  });
});

describe('Open DMX (FTDI)', () => {
  function fakePort() {
    const calls: string[] = [];
    let written: Buffer = Buffer.alloc(0);
    const port: BreakCapablePort = {
      isOpen: true,
      set: (o, cb) => { calls.push(`brk:${o.brk}`); cb(null); },
      write: (d, cb) => { calls.push(`write:${d.length}`); written = d; cb(null); },
      drain: (cb) => { calls.push('drain'); cb(null); },
      close: (cb) => cb(null),
      on: () => undefined,
    };
    return { port, calls, written: () => written };
  }

  it('trame : code de départ 0 + 512 canaux', () => {
    const f = buildOpenDmxFrame(Uint8Array.from({ length: 512 }, (_, i) => i & 255));
    expect(f.length).toBe(513);
    expect([f[0], f[1], f[512]]).toEqual([0, 0, 511 & 255]);
  });

  it('séquence BREAK → MAB → données → drain, trames ignorées si la liaison est occupée', async () => {
    const fp = fakePort();
    const cfg = outputConfigSchema.parse({ id: 'o', name: 'O', kind: 'open-dmx', path: 'COM9', universe: 1 }) as Extract<OutputConfig, { kind: 'open-dmx' }>;
    expect(cfg.maxFps).toBe(30);
    const out = new OpenDmxOutput(cfg, async () => fp.port);
    await out.open();
    expect(out.state).toBe('ready');
    out.send(1, new Uint8Array(512).fill(7));
    out.send(1, new Uint8Array(512).fill(9)); // still busy → dropped
    await new Promise((r) => setTimeout(r, 20));
    expect(fp.calls).toEqual(['brk:true', 'brk:false', 'write:513', 'drain']);
    expect(fp.written()[1]).toBe(7);
    expect(out.dropped).toBe(1);
    await out.close();
  });

  it('erreur à l’ouverture signalée (port absent)', async () => {
    const cfg = outputConfigSchema.parse({ id: 'o', name: 'O', kind: 'open-dmx', path: 'COM99', universe: 1 }) as Extract<OutputConfig, { kind: 'open-dmx' }>;
    const out = new OpenDmxOutput(cfg, async () => { throw new Error('File not found: COM99'); });
    await out.open();
    expect(out.state).toBe('error');
    expect(out.stats.lastError).toMatch(/COM99/);
    await out.close();
  });
});

describe('OpenRouter', () => {
  it('lit le catalogue de modèles (prix par million, capacités)', () => {
    const models = parseModels({ data: [
      { id: 'b/model-b', name: 'B', context_length: 1000, pricing: { prompt: '0.000002', completion: '0.00001' }, supported_parameters: ['structured_outputs', 'response_format'] },
      { id: 'a/model-a', name: 'A', pricing: { prompt: '0', completion: '0' }, supported_parameters: [] },
      { broken: true },
    ] });
    expect(models.map((m) => m.id)).toEqual(['a/model-a', 'b/model-b']);
    expect(models[1]).toMatchObject({ promptPrice: 2, completionPrice: 10, structuredOutputs: true });
    expect(models[0]!.promptPrice).toBe(0);
  });

  it('envoie le modèle choisi avec sortie structurée et relit le plan', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({
      model: 'b/model-b',
      choices: [{ finish_reason: 'stop', message: { content: '```json\n{"understanding":"ok","actions":[{"type":"setIntensity","target":{"all":true},"level":0.5,"fade":null}]}\n```' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Echo': String(init?.body ?? '') } }));
    const r = await proposeWithOpenRouter('monte', '{}', { apiKey: 'sk-or-v1-x', model: 'b/model-b', effort: 'low', timeoutMs: 5000, capabilities: { structuredOutputs: true, jsonMode: true, reasoning: false }, fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-v1-x');
    const body = JSON.parse(String(init!.body)) as { model: string; response_format: { type: string }; reasoning?: unknown };
    expect(body.model).toBe('b/model-b');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.reasoning).toBeUndefined();
    expect(r.actions).toEqual([{ type: 'setIntensity', target: { all: true }, level: 0.5 }]); // nulls stripped
  });

  it('traduit les erreurs HTTP en messages clairs', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: 'Insufficient credits' } }), { status: 402 })) as unknown as typeof fetch;
    await expect(proposeWithOpenRouter('x', '{}', { apiKey: 'k', model: 'a/b', effort: 'low', timeoutMs: 1000, fetchImpl })).rejects.toThrow(/Crédits OpenRouter insuffisants/);
    expect(() => extractJson('pas de json')).toThrow(/JSON/);
    expect(extractJson('Voici : {"a":1} fin')).toEqual({ a: 1 });
  });

  it('migre les anciens paramètres Anthropic vers OpenRouter', () => {
    const s = settingsSchema.parse({ ai: { provider: 'anthropic', model: 'claude-opus-5-5' } });
    expect(s.ai.provider).toBe('openrouter');
    expect(s.ai.model).toBe('openrouter/auto');
    expect(settingsSchema.parse({ ai: { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct' } }).ai.model).toBe('meta-llama/llama-3.3-70b-instruct');
  });
});

describe('raccourcis personnalisables', () => {
  const ev = (key: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({ key, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });
  it('normalise les combinaisons clavier', () => {
    expect(comboFromEvent(ev(' '))).toBe('Space');
    expect(comboFromEvent(ev(' ', { shiftKey: true }))).toBe('Shift+Space');
    expect(comboFromEvent(ev('s', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+S');
    expect(comboFromEvent(ev('Escape', { shiftKey: true }))).toBe('Shift+Escape');
    expect(comboFromEvent(ev('F5'))).toBe('F5');
    expect(comboFromEvent(ev('Shift', { shiftKey: true }))).toBeNull();
  });

  it('surcharges, désattribution et conflits', () => {
    const b = resolveShortcuts({ go: 'Enter', blackout: '' });
    expect(b.go).toBe('Enter');
    expect(b.blackout).toBe('');
    expect(b.back).toBe('Shift+Space');
    expect(shortcutConflicts(resolveShortcuts({ blackout: 'P' }))).toEqual([['pause', 'blackout']]);
  });
});

describe('projecteurs multi-têtes (modules)', () => {
  const mhl = profileSchema.parse(JSON.parse(readFileSync(path.resolve('tests/fixtures/profiles/beamz-mhl1940.json'), 'utf8')));
  const project = () => {
    const p = demoProject();
    p.profiles = [mhl];
    p.patch = [...p.patch.slice(0, 1), fixture({ id: 'm', name: 'Lyre 1', profileId: mhl.id, mode: '26Channels', address: 200 })];
    return p;
  };

  it('le MHL1940 a deux groupes de couleur nommés, l’anneau se trouve par son nom générique', () => {
    expect(validateProfile(mhl).ok).toBe(true);
    const rf = new ProjectIndex(project()).fixtures.get('m')!;
    expect(colorGroups(rf).map((g) => [g.cell, g.module])).toEqual([[undefined, 'Main Module'], [1, 'RGB Pix Ring']]);
    expect(findModule(mhl, 'l’anneau'.slice(2))?.name).toBe('RGB Pix Ring');
    expect(findModule(mhl, 'Tête principale')?.name).toBe('Main Module');
    expect(colorToAttributes(rf, { r: 0, g: 0, b: 1 }, undefined, findModule(mhl, 'anneau'))).toEqual({ 'red#1': 0, 'green#1': 0, 'blue#1': 1 });
  });

  it('la console peut régler le dimmer d’une tête (clé attribut#cellule)', () => {
    const set = (values: Record<string, number>) => commandSchema.safeParse({ type: 'programmer.set', fixtureIds: ['m'], values }).success;
    expect(set({ 'dimmer#1': 1, dimmer: 0.5 })).toBe(true);
    expect(set({ 'inconnu#1': 1 })).toBe(false);
    expect(set({ 'dimmer#0': 1 })).toBe(false);
    const { engine } = makeEngine(project());
    expect(engine.setProgrammer(['m'], { 'dimmer#1': 1 }).applied).toBe(1);
  });

  it('refuse une cellule rattachée à deux modules', () => {
    const bad = { ...mhl, modules: [...mhl.modules, { name: 'Doublon', cells: [1], beam: 'led', geometry: 'pixel' }] };
    expect(validateProfile(bad).errors?.join(' ')).toMatch(/Cellule 1 rattachée/);
  });

  it('le visualiseur dessine l’anneau comme un anneau, éclairé par son propre dimmer', () => {
    const rf = new ProjectIndex(project()).fixtures.get('m')!;
    const [f] = buildVisualModel([rf], { m: { dimmer: 0, 'dimmer#1': 1, 'red#1': 1 } });
    expect(f!.cells).toEqual([]);
    expect(f!.rings).toEqual(['#ff0000']);
    expect(f!.intensity).toBe(0);
  });

  it('l’IA locale vise « l’anneau » sans toucher la tête principale', () => {
    const index = new ProjectIndex(project());
    const ctx = { fixtures: [...index.fixtures.values()].map((rf) => ({ id: rf.fixture.id, name: rf.fixture.name, type: rf.profile.type, attributes: rf.attributes, modules: rf.profile.modules.map((m) => m.name) })), groups: [], current: {}, allowStrobe: false };
    const r = interpretLocally('mets l’anneau en bleu à 50 %', ctx);
    const color = r.actions.find((a) => a.type === 'setColor') as Extract<AiAction, { type: 'setColor' }>;
    expect(color.target.module).toBe('anneau');
    const look = lookToValues(index, [{ target: color.target, color: '#0000FF', level: 0.5 }]);
    expect(Object.keys(look)).toEqual(['m']); // the PAR has no ring
    expect(look.m).toEqual({ 'dimmer#1': 0.5, 'red#1': 0, 'green#1': 0, 'blue#1': 1 });
  });
});
