import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { convertMa2Fixture, mergeProfileModes } from '../../src/core/fixtures/ma2';
import { validateProfile } from '../../src/core/fixtures/profiles';
import { makeService } from '../helpers';

const SAMPLE = path.resolve('tests/fixtures/ma2/BeamZ@MHL1940@26Channels@MHL1940.xml');
const sample = () => readFileSync(SAMPLE, 'utf8');

describe('import grandMA2', () => {
  it('le MHL1940 26 canaux donne exactement le tableau 2.2 de la roadmap', () => {
    const r = convertMa2Fixture(sample());
    expect(r.errors).toEqual([]);
    const p = r.profile!;
    expect(validateProfile(p).ok).toBe(true);
    expect([p.id, p.name, p.manufacturer, p.type]).toEqual(['ma2-beamz-mhl1940', 'MHL1940', 'BeamZ', 'moving-head-wash']);
    const m = p.modes[0]!;
    expect(m.name).toBe('26Channels');
    expect(m.channels.map((c) => `${c.attribute}${c.cell ? `#${c.cell}` : ''}${c.fine ? ' fin' : ''}`)).toEqual([
      'pan', 'pan fin', 'tilt', 'tilt fin', 'panTiltMode', 'dimmer', 'shutter', 'red', 'green', 'blue', 'white',
      'zoom', 'effectWheel', 'zoomMode', 'colorMacroFade', 'colorTemperature', 'warmWhite',
      'dimmer#1', 'strobe#1', 'red#1', 'green#1', 'blue#1', 'colorMacroFade#1', 'macro#1', 'macroSpeed#1', 'control',
    ]);
    // Exact 16-bit default (21626.551 → 21627) and asymmetric tilt.
    expect(m.channels[0]).toMatchObject({ default16: 21627, default: 84 });
    expect(m.channels[1]!.default).toBe(21627 & 0xff);
    expect(p.physical).toMatchObject({ panRange: 540, tiltRange: 220, tiltMin: -110, tiltMax: 110, panTiltTime: 1.2, dimensions: { width: 0.4, height: 0.4, depth: 0.42 } });
    const shutter = m.channels[6]!;
    expect(shutter.default).toBe(255); // 254.999
    expect(shutter.ranges.map((x) => [x.from, x.to, x.kind])).toEqual([
      [0, 3, 'closed'], [4, 103, 'strobe'], [104, 107, 'open'], [108, 207, 'pulse'], [208, 212, 'open'], [213, 251, 'random'], [252, 255, 'open'],
    ]);
    expect(shutter.ranges[1]).toMatchObject({ hzFrom: 10, hzTo: 0.1 });
    expect(m.channels[16]!.emitterColor).toBe('#FFFFCC');
    const control = m.channels[25]!;
    expect(control.ranges.map((x) => [x.from, x.kind, x.dangerous])).toEqual([[52, 'reset', true], [57, 'reset', true], [62, 'reset', true], [72, 'reset', true]]);
    expect(control.ranges[3]!.label).toBe('Reset total (5 s)');
    expect(p.modules).toEqual([
      { name: 'Main Module', cells: [], beam: 'wash', geometry: 'lens' },
      { name: 'RGB Pix Ring', cells: [1], beam: 'led', angle: 12, geometry: 'ring' },
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('Ignite300LED (conversion GDTF → MA2) : attributs, roues, tilt inversé, control', () => {
    const r = convertMa2Fixture(readFileSync(path.resolve('tests/fixtures/ma2/BeamZ@Ignite300LED@Mode_1@Ignite300LED.xml'), 'utf8'));
    expect(r.errors).toEqual([]);
    const p = r.profile!;
    expect(p.type).toBe('moving-head-spot');
    expect(p.physical).toMatchObject({ panRange: 540, tiltRange: 280, tiltMin: 140, tiltMax: -140, beamAngle: 10 });
    const ch = p.modes[0]!.channels;
    expect(ch.map((c) => `${c.attribute}${c.fine ? ' fin' : ''}`)).toEqual([
      'pan', 'pan fin', 'tilt', 'tilt fin', 'panTiltSpeed', 'dimmer', 'shutter', 'colorWheel', 'colorWheel fin', 'zoom', 'focus', 'focus fin',
      'gobo', 'goboRotation', 'gobo2', 'frost', 'prism', 'prismIndex', 'prismRotation', 'control',
    ]);
    expect(r.warnings).toEqual([]);
    expect(ch[14]!.ranges.filter((x) => x.kind === 'gobo')).toHaveLength(9);
    const wheel = ch[7]!.ranges;
    expect(wheel[0]).toMatchObject({ from: 0, to: 19, kind: 'open' });
    expect(wheel[1]).toMatchObject({ from: 20, to: 39, kind: 'color', label: 'Blue', color: '#0D07E0' });
    expect(wheel).toHaveLength(9);
    const gobo = ch[12]!.ranges;
    expect(gobo.filter((x) => x.kind === 'gobo')).toHaveLength(7);
    expect(gobo.filter((x) => x.kind === 'shake')).toHaveLength(7);
    expect(ch[15]!.ranges.map((x) => [x.label, x.kind])).toEqual([['Frost out', 'open'], ['Frost into', 'other']]);
    expect(ch[16]!.ranges[0]).toMatchObject({ label: 'Prism all out', kind: 'open' });
    expect(ch[19]!.ranges.filter((x) => x.dangerous).map((x) => [x.from, x.to, x.kind])).toEqual([[200, 219, 'reset']]);
    expect(ch[5]!.ranges).toEqual([]); // continuous dimmer: no generic range
  });

  it('un XML malformé ou étranger renvoie une erreur lisible, jamais une exception', () => {
    const broken = convertMa2Fixture(sample().slice(0, 4000));
    expect(broken.profile).toBeNull();
    expect(broken.errors[0]).toMatch(/^XML invalide \(ligne \d+\)/);
    expect(convertMa2Fixture('<root><a/></root>').errors[0]).toMatch(/pas un export de projecteur grandMA2/);
    expect(convertMa2Fixture('').errors.length).toBe(1);
    expect(convertMa2Fixture('{"json": true}').errors.length).toBe(1);
  });

  it('attribut inconnu → canal générique + avertissement ; trous gardés pour les adresses', () => {
    const xml = `<MA><FixtureType name="X" mode="M"><manufacturer>Acme</manufacturer><Modules><Module index="0" name="Main" class="LED">
      <ChannelType attribute="DIM" coarse="1"/><ChannelType attribute="MYSTERY" coarse="4"/></Module></Modules></FixtureType></MA>`;
    const r = convertMa2Fixture(xml);
    expect(r.warnings).toEqual(['Attribut MA2 « MYSTERY » non reconnu, converti en canal générique']);
    expect(r.profile!.modes[0]!.channels.map((c) => c.attribute)).toEqual(['dimmer', 'custom:inutilise-2', 'custom:inutilise-3', 'custom:mystery']);
    expect(r.profile!.type).toBe('par');
  });

  it('courbe dimmer et macros (BTF100Z Fresnel) reconnus sans avertissement', () => {
    const xml = `<MA><FixtureType name="BTF100Z" mode="5 Channels"><manufacturer>BeamZ</manufacturer><Modules><Module name="Main" class="Conventional">
      <ChannelType coarse="1" attribute="DIM"/><ChannelType coarse="2" attribute="SHUTTER"/><ChannelType coarse="3" attribute="ZOOM"/>
      <ChannelType coarse="4" attribute="DIMMERCURVE"><ChannelFunction subattribute="DIMMERCURVE" min_dmx_24="0" max_dmx_24="16777215"/></ChannelType>
      <ChannelType coarse="5" attribute="MACROS"/></Module></Modules></FixtureType></MA>`;
    const r = convertMa2Fixture(xml);
    expect(r.warnings).toEqual([]);
    expect(r.profile!.modes[0]!.channels.map((c) => c.attribute)).toEqual(['dimmer', 'shutter', 'zoom', 'dimmerCurve', 'macro']);
  });

  it('roue de couleurs depuis <Wheels><Wheel><Slot>', () => {
    const xml = `<MA><FixtureType name="Spot" mode="M"><manufacturer>Acme</manufacturer><Modules><Module index="0" name="Main" class="Headmover" beamtype="Spot">
      <ChannelType attribute="COLOR1" coarse="1"><ChannelFunction wheel="1" min_dmx_24="0" max_dmx_24="16777215">
        <ChannelSet name="Open" from_dmx="0" to_dmx="9" slot_from="0"/><ChannelSet from_dmx="10" to_dmx="19" slot_from="1"/>
      </ChannelFunction></ChannelType></Module></Modules>
      <Wheels><Wheel index="1" name="Color"><Slot index="0" name="Open"/><Slot index="1" name="Rouge" color="ff0000"/></Wheel></Wheels></FixtureType></MA>`;
    const p = convertMa2Fixture(xml).profile!;
    expect(p.type).toBe('moving-head-spot');
    expect(p.modes[0]!.channels[0]).toMatchObject({ attribute: 'colorWheel', ranges: [{ from: 0, to: 9, kind: 'open' }, { from: 10, to: 19, kind: 'color', color: '#FF0000', label: 'Rouge' }] });
  });

  it('fusionne les modes de plusieurs XML du même projecteur', () => {
    const a = convertMa2Fixture(sample()).profile!;
    const b = convertMa2Fixture(sample().replace('mode="26Channels"', 'mode="Autre"')).profile!;
    const merged = mergeProfileModes(a, b);
    expect(merged.modes.map((m) => m.name)).toEqual(['26Channels', 'Autre']);
    expect(mergeProfileModes(merged, a).modes.map((m) => m.name)).toEqual(['Autre', '26Channels']);
    expect(validateProfile(merged).ok).toBe(true);
  });

  it('import via AppService : détection du XML, fusion des modes, GDTF refusé proprement', async () => {
    const { svc } = makeService();
    await svc.init();
    const dir = mkdtempSync(path.join(tmpdir(), 'luma-ma2-'));
    const second = path.join(dir, 'BeamZ@MHL1940@Autre.xml');
    writeFileSync(second, sample().replace('mode="26Channels"', 'mode="Autre"'));
    expect(await svc.execute({ type: 'profile.import', path: SAMPLE })).toEqual({ imported: ['MHL1940'], errors: [], warnings: [] });
    await svc.execute({ type: 'profile.import', path: second });
    const profiles = svc.projectState().project.profiles;
    expect(profiles.map((p) => [p.id, p.modes.map((m) => m.name)])).toEqual([['ma2-beamz-mhl1940', ['26Channels', 'Autre']]]);
    const gdtf = path.join(dir, 'x.gdtf');
    writeFileSync(gdtf, 'PK');
    await expect(svc.execute({ type: 'profile.import', path: gdtf })).rejects.toThrow(/GDTF pas encore pris en charge/);
    await svc.dispose();
  });
});
