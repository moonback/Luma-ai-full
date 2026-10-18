import { calibrate, lookAt, project, cameraCenter, stageCorners, type Camera, type Vec3 } from '../../src/core/vision/geometry';
import { gray, type Gray } from '../../src/core/vision/image';
import { analyzePatch, buildSequence, crossCheckRdm, decodeSequence, sequenceDuration, solvePositions, type PatchFixture } from '../../src/core/vision/locate';
import type { RdmDevice } from '../../src/core/protocols/rdm';

/* ---------------- Synthetic stage ---------------- */

const W = 10, D = 8; // stage metres
const IMG_W = 640, IMG_H = 480;

interface Phys { id: string; pos: Vec3; dead?: boolean; respondsAs?: string; garbled?: boolean }

/** 40 fixtures: 16 on a front truss (5 m), 16 on a back truss (6 m), 8 floor units (0.4 m). */
function rig(): Phys[] {
  const out: Phys[] = [];
  for (let i = 0; i < 16; i++) out.push({ id: `F${i + 1}`, pos: [-4.5 + i * 0.6, 2, 5] });
  for (let i = 0; i < 16; i++) out.push({ id: `B${i + 1}`, pos: [-4.5 + i * 0.6, 6.5, 6] });
  for (let i = 0; i < 8; i++) out.push({ id: `S${i + 1}`, pos: [-4.2 + i * 1.2, 7.5, 0.4] });
  return out;
}

let seed = 1;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

/** Camera image: ambient gradient, a permanent exit sign, sensor noise, a Gaussian spot per lit fixture. */
function render(cam: Camera, phys: Phys[], lit: Set<string>): Gray {
  const img = gray(IMG_W, IMG_H);
  for (let y = 0; y < IMG_H; y++) for (let x = 0; x < IMG_W; x++) img.data[y * IMG_W + x] = 0.08 + 0.06 * (y / IMG_H) + 0.01 * gauss();
  for (let y = 40; y < 52; y++) for (let x = 20; x < 44; x++) img.data[y * IMG_W + x] = 0.9; // exit sign
  for (const f of phys) {
    const id = f.respondsAs ?? f.id;
    // A wrong-mode unit reacts to neighbouring channels: lit in every frame except the dark reference.
    const on = f.garbled ? lit.size > 0 : lit.has(id);
    if (f.dead || !on) continue;
    const p = project(cam, f.pos);
    if (!p) continue;
    for (let y = Math.floor(p[1] - 6); y <= p[1] + 6; y++) for (let x = Math.floor(p[0] - 6); x <= p[0] + 6; x++) {
      if (x < 0 || y < 0 || x >= IMG_W || y >= IMG_H) continue;
      img.data[y * IMG_W + x] = Math.min(1, img.data[y * IMG_W + x]! + 0.7 * Math.exp(-((x - p[0]) ** 2 + (y - p[1]) ** 2) / (2 * 1.8 ** 2)));
    }
  }
  return img;
}

const FRONT = lookAt([0.3, -7, 1.7], [0, 4, 3], IMG_W, IMG_H, 62);
const SIDE = lookAt([-6.5, -4, 2.2], [0, 4, 3.2], IMG_W, IMG_H, 66);

/** The user's clicks on the 4 stage corners (± 1.5 px). */
function clickCalibration(cam: Camera) {
  return calibrate(stageCorners(W, D).map((c) => {
    const p = project(cam, c.world)!;
    return { world: c.world, image: [p[0] + (rnd() - 0.5) * 3, p[1] + (rnd() - 0.5) * 3] as [number, number] };
  }), IMG_W, IMG_H);
}

function capture(cam: Camera, phys: Phys[], mode: 'binary' | 'sequential') {
  const seq = buildSequence(rig().map((f) => f.id), mode);
  const images = seq.frames.map((fr) => render(cam, phys, new Set(fr.lit)));
  return { seq, images };
}

const patchOf = (phys: Phys[]): PatchFixture[] => phys.map((f, i) => ({ id: f.id, name: f.id, universe: 1, address: 1 + i * 8, channels: 8, position: { x: f.pos[0], y: f.pos[1] }, height: f.pos[2], manufacturer: 'Luma Demo', model: 'Spot' }));
const heightOf = (id: string) => rig().find((f) => f.id === id)!.pos[2];

describe('géométrie caméra', () => {
  it('calibration par les 4 coins du plateau (clics à ± 1,5 px)', () => {
    seed = 3;
    const cal = clickCalibration(FRONT);
    expect(cal.rms).toBeLessThan(2);
    const c = cameraCenter(cal.camera), truth = cameraCenter(FRONT);
    expect(Math.hypot(c[0] - truth[0], c[1] - truth[1], c[2] - truth[2])).toBeLessThan(0.4);
    expect(Math.abs(cal.camera.f - FRONT.f) / FRONT.f).toBeLessThan(0.08);
  });
});

// Rendering dozens of 640×480 frames is slow under a loaded parallel test run.
describe('localisation sur scène synthétique (plateau 10 m, 40 projecteurs)', { timeout: 30_000 }, () => {
  it('1 vue + hauteurs connues : tous trouvés à ± 30 cm, séquence < 2 min', () => {
    seed = 5;
    const phys = rig();
    const { seq, images } = capture(FRONT, phys, 'binary');
    expect(seq.frames.length).toBe(2 + 2 * 6); // 40 fixtures → 6 bits
    expect(sequenceDuration(seq.frames.length)).toBeLessThan(120);
    const t0 = performance.now();
    const detections = decodeSequence(images, seq);
    const cal = clickCalibration(FRONT);
    const located = solvePositions([{ camera: cal.camera, detections }], heightOf);
    console.info(`[vision] décodage + calcul ${(performance.now() - t0).toFixed(0)} ms, ${seq.frames.length} images`);
    expect(located).toHaveLength(40);
    const errors = located.map((l) => {
      const p = phys.find((f) => f.id === l.fixtureId)!.pos;
      return Math.hypot(l.position[0] - p[0], l.position[1] - p[1]);
    });
    console.info(`[vision] 1 vue : erreur max ${Math.max(...errors).toFixed(3)} m, moyenne ${(errors.reduce((a, b) => a + b, 0) / errors.length).toFixed(3)} m`);
    expect(Math.max(...errors)).toBeLessThan(0.3);
    expect(analyzePatch(patchOf(phys), [{ camera: cal.camera, detections }], located)).toEqual([]);
  });

  it('2 vues : triangulation 3D (hauteur inconnue) à ± 30 cm', () => {
    seed = 7;
    const phys = rig();
    const views = [FRONT, SIDE].map((cam) => {
      const { seq, images } = capture(cam, phys, 'binary');
      return { camera: clickCalibration(cam).camera, detections: decodeSequence(images, seq) };
    });
    const located = solvePositions(views, () => 0);
    const tri = located.filter((l) => l.method === 'triangulated');
    expect(tri.length).toBeGreaterThanOrEqual(36);
    const errors = tri.map((l) => {
      const p = phys.find((f) => f.id === l.fixtureId)!.pos;
      return Math.hypot(l.position[0] - p[0], l.position[1] - p[1], l.position[2] - p[2]);
    });
    console.info(`[vision] 2 vues : ${tri.length} triangulés, erreur 3D max ${Math.max(...errors).toFixed(3)} m`);
    expect(Math.max(...errors)).toBeLessThan(0.3);
  });

  it('mode séquentiel (un projecteur par image) : même résultat, < 2 min', () => {
    seed = 9;
    const { seq, images } = capture(FRONT, rig(), 'sequential');
    expect(sequenceDuration(seq.frames.length)).toBeLessThan(120);
    const detections = decodeSequence(images, seq);
    expect(new Set(detections.map((d) => d.fixtureId).filter(Boolean)).size).toBe(40);
  });

  it('erreurs de patch : muet, adresses croisées, adresse en double, réponse incohérente', () => {
    seed = 11;
    const phys = rig();
    phys.find((f) => f.id === 'F3')!.dead = true;
    // F5 and B10 sit at each other's place (crossed addresses).
    const f5 = phys.find((f) => f.id === 'F5')!, b10 = phys.find((f) => f.id === 'B10')!;
    [f5.pos, b10.pos] = [b10.pos, f5.pos];
    // A second unit set to S2's address, and one in a wrong DMX mode.
    phys.push({ id: 'X1', pos: [3.3, 7.5, 0.4], respondsAs: 'S2' });
    phys.push({ id: 'X2', pos: [-1.7, 4, 3], garbled: true });
    const seq = buildSequence(rig().map((f) => f.id), 'binary');
    const images = seq.frames.map((fr) => render(FRONT, phys, new Set(fr.lit)));
    const view = { camera: clickCalibration(FRONT).camera, detections: decodeSequence(images, seq) };
    // One view: the truss heights come from the rig (F5 is now on the 6 m truss, B10 on the 5 m one).
    const located = solvePositions([view], (id) => (id === 'F5' ? 6 : id === 'B10' ? 5 : heightOf(id)));
    const issues = analyzePatch(patchOf(rig()), [view], located);
    expect(issues.find((i) => i.kind === 'no-response')?.fixtureIds).toEqual(['F3']);
    const swap = issues.find((i) => i.kind === 'swapped');
    expect(swap?.fixtureIds.sort()).toEqual(['B10', 'F5']);
    expect(swap?.message).toMatch(/en réalité/);
    expect(issues.find((i) => i.kind === 'shared-address')?.fixtureIds).toEqual(['S2']);
    expect(issues.map((i) => i.kind)).toContain('unidentified');
  });

  it('croisement RDM : modèle, mode, appareil non patché, appareil absent', () => {
    const patch = patchOf(rig()).slice(0, 3);
    const dev = (address: number, model: string, footprint: number): RdmDevice => ({ uid: `4C55:${String(address).padStart(8, '0')}`, manufacturer: 'Luma Demo', model, label: null, softwareVersion: null, startAddress: address, footprint, personality: '1/1', deviceHours: null, lampHours: null, sensors: [], errors: [] });
    const issues = crossCheckRdm(patch, [dev(1, 'Spot', 8), dev(9, 'Wash 600', 8), dev(17, 'Spot', 12), dev(200, 'Spot', 8)], 1);
    expect(issues.map((i) => i.kind).sort()).toEqual(['rdm-footprint', 'rdm-model', 'rdm-unpatched']);
    expect(crossCheckRdm(patch, [dev(1, 'Spot', 8)], 1).filter((i) => i.kind === 'rdm-missing')).toHaveLength(2);
  });
});
