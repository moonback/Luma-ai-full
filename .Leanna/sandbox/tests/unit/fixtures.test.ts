import { BUILTIN_PROFILES } from '../../src/core/fixtures/builtinProfiles';
import { channelCount, parseProfileFile, ProfileLibrary, resolveFixture, validateProfile } from '../../src/core/fixtures/profiles';
import { findFreeAddress, validatePatch } from '../../src/core/fixtures/patch';
import { colorToAttributes } from '../../src/core/fixtures/color';
import { demoProject } from '../helpers';

describe('profils de projecteurs', () => {
  it('les 6 profils intégrés sont valides et marqués fictifs', () => {
    expect(BUILTIN_PROFILES).toHaveLength(6);
    for (const p of BUILTIN_PROFILES) {
      expect(validateProfile(p).ok).toBe(true);
      expect(p.fictional).toBe(true);
    }
  });

  it('compte les canaux par mode, fins inclus', () => {
    const lib = new ProfileLibrary();
    expect(channelCount(lib.get('demo-spot')!, '13ch étendu')).toBe(13);
    expect(channelCount(lib.get('demo-par-rgb')!, '3ch RGB')).toBe(3);
    expect(channelCount(lib.get('demo-par-rgb')!, 'inexistant')).toBe(0);
  });

  it('rejette un profil corrompu avec des messages explicites', () => {
    expect(validateProfile({ id: 'x' }).ok).toBe(false);
    const dup = validateProfile({ id: 'dup', name: 'D', manufacturer: 'M', type: 'par', modes: [{ name: 'm', channels: [{ name: 'a', attribute: 'red' }, { name: 'b', attribute: 'red' }] }] });
    expect(dup.ok).toBe(false);
    expect(dup.errors.join()).toMatch(/deux fois/);
    const fineAlone = validateProfile({ id: 'f', name: 'F', manufacturer: 'M', type: 'par', modes: [{ name: 'm', channels: [{ name: 'p', attribute: 'pan', fine: true }] }] });
    expect(fineAlone.ok).toBe(false);
    const overlap = validateProfile({ id: 'o', name: 'O', manufacturer: 'M', type: 'par', modes: [{ name: 'm', channels: [{ name: 's', attribute: 'shutter', ranges: [{ from: 0, to: 20, label: 'a' }, { from: 10, to: 30, label: 'b' }] }] }] });
    expect(overlap.errors.join()).toMatch(/chevauchent/);
    const outOfRange = validateProfile({ id: 'r', name: 'R', manufacturer: 'M', type: 'par', modes: [{ name: 'm', channels: [{ name: 'd', attribute: 'dimmer', default: 300 }] }] });
    expect(outOfRange.ok).toBe(false);
  });

  it('importe un fichier { profiles: [...] } en séparant valides et invalides', () => {
    const r = parseProfileFile({ profiles: [{ ...BUILTIN_PROFILES[0], id: 'custom-1' }, { id: 'bad' }] });
    expect(r.profiles.map((p) => p.id)).toEqual(['custom-1']);
    expect(r.errors[0]).toMatch(/Profil #2/);
  });
});

describe('patch DMX', () => {
  const lib = new ProfileLibrary();
  it('accepte le patch de démonstration sans conflit', () => {
    expect(validatePatch(lib, demoProject().patch)).toEqual([]);
  });

  it('détecte chevauchements, dépassement de 512 et profil inconnu', () => {
    const p = demoProject().patch;
    p[1]!.address = 3; // PAR 2 at 3..5 overlaps PAR 1 at 1..3
    p.push({ ...p[0]!, id: 'late', name: 'Late', address: 510 }); // 510..512 ok
    p.push({ ...p[3]!, id: 'over', name: 'Over', universe: 2, address: 501 }); // 501..513 → out of range
    p.push({ ...p[0]!, id: 'ghost', name: 'Ghost', profileId: 'nope' });
    const kinds = validatePatch(lib, p).map((i) => i.kind).sort();
    expect(kinds).toEqual(['out-of-range', 'overlap', 'unknown-profile']);
  });

  it('détecte un chevauchement imbriqué', () => {
    const p = demoProject().patch;
    p.push({ ...p[0]!, id: 'nested', name: 'Nested', address: 25 }); // inside Spot 1 (20..33)
    expect(validatePatch(lib, p).some((i) => i.kind === 'overlap' && i.fixtureIds.includes('nested'))).toBe(true);
  });

  it('trouve la prochaine adresse libre', () => {
    const p = demoProject().patch;
    expect(findFreeAddress(lib, p, 1, 3)).toBe(7);
    expect(findFreeAddress(lib, p, 1, 14, 7)).toBe(53);
    expect(findFreeAddress(lib, p, 2, 14)).toBe(1);
    expect(findFreeAddress(lib, p, 1, 600)).toBeUndefined();
  });
});

describe('conversion couleur selon les capacités', () => {
  const lib = new ProfileLibrary();
  const p = demoProject();
  it('RGB, RGBW (extraction du blanc) et roue de couleurs', () => {
    const rgb = resolveFixture(lib, p.patch[0]!)!;
    const rgbw = resolveFixture(lib, p.patch[2]!)!;
    const spot = resolveFixture(lib, p.patch[3]!)!;
    expect(colorToAttributes(rgb, { r: 1, g: 0, b: 0.5 })).toEqual({ red: 1, green: 0, blue: 0.5 });
    expect(colorToAttributes(rgbw, { r: 1, g: 1, b: 1 })).toEqual({ red: 0, green: 0, blue: 0, white: 1 });
    // Pure blue → wheel slot "Bleu" (60..69 → centre 64.5 → 65/255)
    expect(colorToAttributes(spot, { r: 0.1, g: 0.2, b: 1 }).colorWheel).toBeCloseTo(65 / 255, 3);
  });
});
