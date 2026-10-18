import * as THREE from 'three';
import { audienceGlare, beamDirection, beamHit, flickerOn, mountSign, onStage, poolShape, rigAngles, rotateY, beamLength } from '../../src/core/visualizer/beam';
import { followTruss, hangHeight, nearestOnTruss, snapToTrusses, snapTrussEnds, trussEnds, trussSegments, trussSupports } from '../../src/core/visualizer/truss';
import { LIBRARY } from '../../src/core/visualizer/library';
import type { Performer, StageMarker, StageProp, Truss } from '../../src/core/model/schemas';
import { buildVisualModel, goboIndex, mountOf, strobeFrequency, tiltDegrees, zoomedAngle, type VisualFixture } from '../../src/core/visualizer/model';
import { createProject, parseProject } from '../../src/core/project/format';
import { SCENE_TEMPLATES, hasSceneContent, sceneTemplate } from '../../src/core/visualizer/templates';
import { cloneElement, equipTrusses, newElement, parseElement, serializeElement, withElement, withoutElement } from '../../src/core/visualizer/sceneEdit';
import { projectSchema } from '../../src/core/model/schemas';
import { DARK_LEVEL, FACE_HEIGHT, floorAt, lightAt, performerLight, performerSpot, toHex } from '../../src/core/visualizer/lighting';
import { commandSchema } from '../../src/shared/commands';
import { ProjectIndex } from '../../src/core/engine/resolve';
import { ProfileLibrary, coarseChannel } from '../../src/core/fixtures/profiles';
import { demoProject, makeService } from '../helpers';

const stage = { width: 12, depth: 8, wallHeight: 6 };
const close = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => {
  expect(a.x).toBeCloseTo(b.x, 5);
  expect(a.y).toBeCloseTo(b.y, 5);
  expect(a.z).toBeCloseTo(b.z, 5);
};
const mover = { movable: true, panDeg: 0, tiltDeg: 0, rotation: 0, mount: 'hanging' as const };

describe('géométrie des faisceaux', () => {
  it('lyre accrochée : tilt 0 = vers le sol, tilt +90° = vers le public, pan tourne autour de la verticale', () => {
    close(beamDirection(mover), { x: 0, y: -1, z: 0 });
    close(beamDirection({ ...mover, tiltDeg: 90 }), { x: 0, y: 0, z: 1 });
    close(beamDirection({ ...mover, tiltDeg: 90, panDeg: 90 }), { x: 1, y: 0, z: 0 });
    close(beamDirection({ ...mover, mount: 'floor' }), { x: 0, y: 1, z: 0 });
  });

  it('projecteurs fixes : accrochés vers l’avant-scène, au sol vers le cyclorama', () => {
    const hung = beamDirection({ ...mover, movable: false });
    expect(hung.y).toBeLessThan(0);
    expect(hung.z).toBeGreaterThan(0);
    const floor = beamDirection({ ...mover, movable: false, mount: 'floor' });
    expect(floor.y).toBeGreaterThan(0);
    expect(floor.z).toBeLessThan(0);
  });

  it('impact au sol puis sur le cyclorama, avec la bonne distance', () => {
    const down = beamHit({ x: 0, y: 6, z: -3 }, { x: 0, y: -1, z: 0 }, stage)!;
    expect(down.surface).toBe('floor');
    expect(down.distance).toBeCloseTo(6);
    const back = beamHit({ x: 0, y: 0.3, z: -7.5 }, beamDirection({ ...mover, movable: false, mount: 'floor' }), stage)!;
    expect(back.surface).toBe('wall');
    expect(back.point.z).toBe(-8);
    expect(back.point.y).toBeGreaterThan(0.3);
    expect(beamHit({ x: 0, y: 6, z: -3 }, { x: 0, y: 1, z: 0 }, stage)).toBeNull(); // pointing at the ceiling
    expect(beamLength(null)).toBe(30);
  });

  it('tache : rayon selon l’angle, étirée en incidence rasante, atténuée avec la distance', () => {
    const hit = beamHit({ x: 0, y: 6, z: -3 }, { x: 0, y: -1, z: 0 }, stage)!;
    const straight = poolShape(hit, { x: 0, y: -1, z: 0 }, 20);
    expect(straight.radius).toBeCloseTo(6 * Math.tan((10 * Math.PI) / 180));
    expect(straight.stretch).toBeCloseTo(1);
    const d = { x: 0, y: -Math.cos(1.2), z: Math.sin(1.2) };
    const grazing = poolShape(beamHit({ x: 0, y: 6, z: -8 }, d, stage)!, d, 20);
    expect(grazing.stretch).toBeGreaterThan(2);
    expect(grazing.falloff).toBeLessThan(straight.falloff);
  });

  it('prisme : rotation autour de la verticale', () => {
    close(rotateY({ x: 0, y: 0, z: 1 }, Math.PI / 2), { x: 1, y: 0, z: 0 });
  });

  it('strobe : éclairs brefs à la fréquence donnée, continu sinon', () => {
    expect(flickerOn(1.234, 0)).toBe(true);
    const on = Array.from({ length: 1000 }, (_, i) => flickerOn(i / 1000, 10)).filter(Boolean).length;
    expect(on).toBeGreaterThan(250);
    expect(on).toBeLessThan(350);
  });
});

describe('modèle visuel enrichi', () => {
  const lib = new ProfileLibrary();
  const spotMode = lib.get('demo-spot')!.modes[0]!;

  it('fréquence strobe, gobo et zoom à partir des plages du profil', () => {
    const shutter = coarseChannel(spotMode, 'shutter')!;
    expect(strobeFrequency(shutter, 8 / 255)).toBe(0); // open
    expect(strobeFrequency(shutter, 16 / 255)).toBeCloseTo(1);
    expect(strobeFrequency(shutter, 131 / 255)).toBeCloseTo(20);
    const gobo = coarseChannel(spotMode, 'gobo')!;
    expect(goboIndex(gobo, 0)).toBe(0);
    expect(goboIndex(gobo, 25 / 255)).toBe(2);
    expect(zoomedAngle(25, undefined)).toBe(25);
    expect(zoomedAngle(25, 0)).toBe(10);
    expect(zoomedAngle(25, 1)).toBe(40);
  });

  it('utilise les valeurs physiques exactes du profil : Hz, zoom et tilt asymétrique', () => {
    const strobe = { name: 'S', attribute: 'strobe', fine: false, default: 0, ranges: [{ from: 10, to: 250, label: 'Strobe', kind: 'strobe' as const, dangerous: false, hzFrom: 0.5, hzTo: 25 }] };
    expect(strobeFrequency(strobe, 10 / 255)).toBeCloseTo(0.5);
    expect(strobeFrequency(strobe, 250 / 255)).toBeCloseTo(25);
    expect(zoomedAngle(25, 0, { zoomMin: 4, zoomMax: 40 })).toBe(4);
    expect(zoomedAngle(25, 1, { zoomMin: 4, zoomMax: 40 })).toBe(40);
    const phys = { panRange: 540, tiltRange: 270, beamAngle: 15 };
    expect(tiltDegrees(phys, 0)).toBe(-135);
    expect(tiltDegrees({ ...phys, tiltMin: -45, tiltMax: 225 }, 0)).toBe(-45);
    expect(tiltDegrees({ ...phys, tiltMin: -45, tiltMax: 225 }, 1)).toBe(225);
  });

  it('accroche selon la hauteur, gobo et prisme lus depuis les valeurs calculées', () => {
    const p = demoProject();
    p.patch[3]!.height = 6;
    p.patch[4]!.height = 0.2;
    const index = new ProjectIndex(p);
    const m = buildVisualModel([...index.fixtures.values()], { spot1: { gobo: 15 / 255, prism: 200 / 255, dimmer: 1 } });
    const s1 = m.find((f) => f.id === 'spot1')!;
    const s2 = m.find((f) => f.id === 'spot2')!;
    expect(s1).toMatchObject({ mount: 'hanging', gobo: 1, prism: true, movable: true });
    expect(s2.mount).toBe('floor');
    expect(s2.prism).toBe(false);
  });
});

describe('forme de plateau, points de scène et éblouissement', () => {
  const vf = (o: Partial<VisualFixture>): VisualFixture => ({
    id: 'f', name: 'Lyre', type: 'moving-head', x: 0, y: 1, rotation: 0, color: '#ffffff', intensity: 1, movable: true, panDeg: 0, tiltDeg: 0,
    beamAngle: 15, height: 4, mount: 'hanging', cells: [], rings: [], strobeHz: 0, gobo: 0, prism: false, ...o,
  } as VisualFixture);

  it('sans cyclo ou en arène, le faisceau traverse le fond de scène', () => {
    const o = { x: 0, y: 0.3, z: -7.5 }, d = beamDirection({ ...mover, movable: false, mount: 'floor' });
    expect(beamHit(o, d, stage)!.surface).toBe('wall');
    expect(beamHit(o, d, { ...stage, wall: false })).toBeNull();
    expect(beamHit(o, d, { ...stage, arena: true })).toBeNull();
    // Arena: the audience floor also exists behind the deck.
    expect(beamHit({ x: 0, y: 4, z: -10 }, { x: 0, y: -1, z: 0 }, { ...stage, arena: true })!.surface).toBe('floor');
  });

  it('l’avancée fait partie du plateau, pas de la salle', () => {
    const thrust = { ...stage, thrust: { width: 3, depth: 4 } };
    expect(onStage(0, 2, thrust)).toBe(true);
    expect(onStage(0, 2, stage)).toBe(false);
    expect(onStage(3, 2, thrust)).toBe(false);
  });

  it('signale une lyre pointée dans la salle à hauteur des yeux, pas une lyre vers le sol ni un projecteur fixe', () => {
    const intoHouse = vf({ id: 'a', tiltDeg: 70 });
    expect(audienceGlare([intoHouse], stage).map((f) => f.id)).toEqual(['a']);
    expect(audienceGlare([vf({ tiltDeg: 0 })], stage)).toEqual([]);
    expect(audienceGlare([vf({ tiltDeg: 70, intensity: 0 })], stage)).toEqual([]);
    expect(audienceGlare([vf({ tiltDeg: 70, movable: false })], stage)).toEqual([]);
    // Same beam over a long thrust: it lands on performers, not on the audience.
    expect(audienceGlare([intoHouse], { ...stage, thrust: { width: 6, depth: 12 } })).toEqual([]);
    // Arena: aiming upstage over the back edge also reaches spectators.
    expect(audienceGlare([vf({ y: 7, tiltDeg: 70, rotation: 180 })], { ...stage, arena: true })).toHaveLength(1);
  });

  it('un ancien projet reçoit les valeurs par défaut, une mise à jour partielle ne remet rien à zéro', async () => {
    const old = { ...demoProject(), visualizer: { stageWidth: 10, stageDepth: 6 } };
    const { project } = parseProject(JSON.stringify(old));
    expect(project.visualizer).toEqual({ stageWidth: 10, stageDepth: 6, shape: 'rect', thrust: { width: 3, depth: 4 }, cyclo: true, markers: [], views: [], trusses: [], performers: [], screens: [], props: [] });

    const { svc } = makeService();
    await svc.init();
    await svc.execute({ type: 'project.new', name: 'Scène' });
    const markers = [{ id: 'chant', name: 'Chanteur', x: 0, y: 2, height: 1.7 }];
    await svc.execute(commandSchema.parse({ type: 'project.update', visualizer: { markers, shape: 'thrust' } }) as never);
    await svc.execute(commandSchema.parse({ type: 'project.update', visualizer: { stageWidth: 14 } }) as never);
    expect(svc.projectState().project.visualizer).toMatchObject({ stageWidth: 14, shape: 'thrust', markers });
    expect(() => commandSchema.parse({ type: 'project.update', visualizer: { markers: [{ id: 'x', name: '', x: 0, y: 0, height: 1 }] } })).toThrow();
  });
});

describe('structures, accroches et historique de scène', () => {
  const truss = (o: Partial<Truss> = {}): Truss => ({ id: 't1', name: 'Face', shape: 'line', x: 0, y: 4, height: 6, length: 8, rotation: 0, support: 'towers', ...o });

  it('géométrie des truss : segments, appuis, point le plus proche, aimantation', () => {
    expect(trussSegments(truss())).toHaveLength(1);
    expect(trussSegments(truss({ shape: 'square' }))).toHaveLength(4);
    expect(trussSegments(truss({ shape: 'circle' }))).toHaveLength(24);
    expect(trussSupports(truss())).toEqual([{ x: -4, y: 4 }, { x: 4, y: 4 }]);
    // Rotation counter-clockwise seen from above: a 90° line runs upstage.
    const [a, b] = trussSegments(truss({ rotation: 90 }))[0]!;
    expect(a.x).toBeCloseTo(0); expect(a.y).toBeCloseTo(0); expect(b.y).toBeCloseTo(8);
    expect(nearestOnTruss(truss(), 1, 4.3)).toMatchObject({ x: 1, y: 4 });
    expect(nearestOnTruss(truss(), 1, 4.3).dist).toBeCloseTo(0.3);
    expect(snapToTrusses([truss()], 9, 4)).toBeNull(); // beyond the end
    expect(snapToTrusses([truss(), truss({ id: 't2', y: 4.5, height: 8 })], 2, 4.4)).toMatchObject({ truss: { id: 't2' }, x: 2, y: 4.5, height: 7.8 });
    expect(hangHeight(truss())).toBeCloseTo(5.8);
  });

  it('un projecteur accroché suit sa structure (translation, rotation, hauteur)', () => {
    const before = truss();
    const f = { position: { x: 2, y: 4 }, height: 5.8, rotation: 10 };
    expect(followTruss(before, { ...before, x: 1, y: 5, height: 7 }, f)).toEqual({ position: { x: 3, y: 5 }, height: 6.8, rotation: 10 });
    const turned = followTruss(before, { ...before, rotation: 90 }, f);
    expect(turned.position.x).toBeCloseTo(0);
    expect(turned.position.y).toBeCloseTo(6);
    expect(turned.rotation).toBe(100);
  });

  it('accroche explicite, murale et inclinée ; même direction que la hiérarchie three.js', () => {
    expect(mountOf({ height: 0.5 })).toBe('floor');
    expect(mountOf({ height: 0.5, mount: 'auto' })).toBe('floor');
    expect(mountOf({ height: 0.5, mount: 'hanging' })).toBe('hanging');
    expect(mountOf({ height: 5, mount: 'wall' })).toBe('wall');
    const fixed = { ...mover, movable: false };
    close(beamDirection({ ...fixed, mount: 'wall' }), { x: 0, y: 0, z: 1 }); // out of the wall, towards the audience
    expect(beamDirection({ ...fixed, mount: 'wall', mountTilt: 30 }).y).toBeCloseTo(-0.5);
    close(beamDirection({ ...mover, mountTilt: 90 }), { x: 0, y: 0, z: 1 }); // hung, base tilted towards the audience

    // The rig applies root (yaw, then mount tilt) → yoke (pan) → head (tilt) to a lens along s·Y.
    for (const f of [
      { ...mover, rotation: 30, panDeg: 40, tiltDeg: 25, mountTilt: 20 },
      { ...mover, mount: 'floor' as const, rotation: -60, panDeg: 10, tiltDeg: -35, mountTilt: -15 },
      { ...mover, mount: 'wall' as const, rotation: 45, panDeg: -20, tiltDeg: 30, mountTilt: 10 },
    ]) {
      const a = rigAngles(f);
      const root = new THREE.Object3D(); root.rotation.order = 'YXZ'; root.rotation.set(a.tilt, a.yaw, 0);
      const yoke = new THREE.Object3D(); yoke.rotation.y = a.pan; root.add(yoke);
      const head = new THREE.Object3D(); head.rotation.x = a.head; yoke.add(head);
      root.updateMatrixWorld(true);
      const q = head.getWorldQuaternion(new THREE.Quaternion());
      const d = new THREE.Vector3(0, mountSign(f.mount), 0).applyQuaternion(q);
      close(beamDirection(f), { x: d.x, y: d.y, z: d.z });
    }
  });

  it('service : suivi des truss, détachement, validation et annuler / rétablir de la scène', async () => {
    const { svc } = makeService();
    await svc.init();
    await svc.execute({ type: 'project.new', name: 'Structures' });
    const { ids } = await svc.execute({ type: 'fixture.add', profileId: 'demo-spot', mode: '13ch étendu', universe: 1, address: null, count: 2, namePrefix: 'Lyre', tags: [] });
    const [a, b] = ids as [string, string];
    const fx = (id: string) => svc.projectState().project.patch.find((f) => f.id === id)!;
    const update = (cmd: unknown) => svc.execute(commandSchema.parse(cmd) as never);

    await update({ type: 'project.update', visualizer: { trusses: [truss()] } });
    await update({ type: 'fixture.update', id: a, patch: { trussId: 't1', position: { x: 2, y: 4 }, height: 5.8 } });
    await expect(update({ type: 'fixture.update', id: b, patch: { trussId: 'absente' } })).rejects.toThrow('Structure introuvable');
    // Partial update: the other fixture fields are not reset by the new optional ones.
    await update({ type: 'fixture.update', id: a, patch: { mount: 'hanging', mountTilt: 10 } });
    expect(fx(a)).toMatchObject({ trussId: 't1', mount: 'hanging', mountTilt: 10, height: 5.8 });

    const bBefore = structuredClone(fx(b).position);
    await update({ type: 'project.update', visualizer: { trusses: [truss({ x: 1, height: 7 })] } });
    expect(fx(a)).toMatchObject({ position: { x: 3, y: 4 }, height: 6.8 });
    expect(fx(b).position).toEqual(bBefore); // not attached: untouched

    // Undo / redo walk the scene layout back and forth; a rename in between is kept.
    const h0 = svc.projectState().sceneHistory.undo;
    await update({ type: 'fixture.update', id: a, patch: { name: 'Lyre jardin' } });
    expect(svc.projectState().sceneHistory.undo).toBe(h0); // not a scene edit
    await update({ type: 'scene.undo' });
    expect(fx(a)).toMatchObject({ position: { x: 2, y: 4 }, height: 5.8, name: 'Lyre jardin' });
    expect(svc.projectState().project.visualizer.trusses[0]!.x).toBe(0);
    await update({ type: 'scene.redo' });
    expect(fx(a)).toMatchObject({ position: { x: 3, y: 4 }, height: 6.8 });
    expect(svc.projectState().sceneHistory).toEqual({ undo: h0, redo: 0 });

    // Removing the truss detaches its fixtures, which stay in place.
    await update({ type: 'project.update', visualizer: { trusses: [] } });
    expect(fx(a)).toMatchObject({ trussId: null, position: { x: 3, y: 4 } });
    await update({ type: 'scene.undo' });
    expect(fx(a).trussId).toBe('t1');

    // A refused edit leaves the history untouched; a new project clears it.
    const h1 = svc.projectState().sceneHistory;
    await expect(update({ type: 'fixture.update', id: 'inconnu', patch: { height: 3 } })).rejects.toThrow();
    expect(svc.projectState().sceneHistory).toEqual(h1);
    await svc.execute({ type: 'project.new', name: 'Autre' });
    expect(svc.projectState().sceneHistory).toEqual({ undo: 0, redo: 0 });
  });
});

describe('interprètes, éclairement estimé et écrans', () => {
  const spot = (o: Partial<VisualFixture> = {}): VisualFixture => ({
    id: 's', name: 'Douche', type: 'moving-head', x: 0, y: 3, rotation: 0, color: '#ff0000', intensity: 1, movable: true, panDeg: 0, tiltDeg: 0,
    beamAngle: 30, height: 6, mount: 'hanging', mountTilt: 0, trussId: null, cells: [], rings: [], strobeHz: 0, gobo: 0, prism: false, ...o,
  } as VisualFixture);
  const singer = { id: 'p', name: 'Chant', kind: 'standing' as const, x: 0, y: 3, rotation: 0, markerId: null };

  it('dans le cône : couleur et niveau du faisceau ; hors cône ou éteint : dans le noir', () => {
    const lit = performerLight(singer, [], [spot()]);
    expect(lit.level).toBeGreaterThan(0.5);
    expect(lit.g).toBe(0);
    expect(lit.r).toBeCloseTo(lit.level);
    expect(performerLight({ ...singer, x: 3 }, [], [spot()]).level).toBeLessThan(DARK_LEVEL); // 3 m aside of a 30° beam
    expect(performerLight(singer, [], [spot({ intensity: 0 })]).level).toBe(0);
    // Two colours add up; the level saturates at 1.
    const mix = lightAt({ x: 0, y: 1.6, z: -3 }, [spot(), spot({ id: 'b', color: '#0000ff' })]);
    expect(mix.r).toBeGreaterThan(0.5);
    expect(mix.b).toBeGreaterThan(0.5);
    expect(toHex({ r: 1, g: 0.5, b: 0 })).toBe('#ff8000');
    // Soft edge: a little dimmer just outside the nominal half angle than on the axis.
    const edgeX = 4.4 * Math.tan((15 * Math.PI) / 180) * 1.05;
    const edge = performerLight({ ...singer, x: edgeX }, [], [spot()]).level;
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(lit.level);
  });

  it('un interprète posé sur un point de scène le suit ; le visage assis est plus bas', () => {
    const marker = { id: 'm', name: 'Centre', x: 2, y: 5, height: 1.7 };
    expect(performerSpot({ ...singer, markerId: 'm' }, [marker])).toEqual({ x: 2, y: 5 });
    expect(performerSpot({ ...singer, markerId: 'absent' }, [marker])).toEqual({ x: 0, y: 3 });
    expect(FACE_HEIGHT.seated).toBeLessThan(FACE_HEIGHT.standing);
  });

  it('schéma : écrans et interprètes validés, image limitée à une data URL', () => {
    const base = createProject('Écrans');
    const screen = { id: 'e1', name: 'Fond', x: 0, y: 7, elevation: 1, width: 6, height: 3, rotation: 0, source: 'image', color: '#000000', glow: 0.5 };
    const ok = (v: unknown) => projectSchema.safeParse({ ...base, visualizer: { ...base.visualizer, ...(v as object) } }).success;
    expect(ok({ screens: [{ ...screen, image: 'data:image/jpeg;base64,AAAA' }], performers: [singer] })).toBe(true);
    expect(ok({ screens: [{ ...screen, image: 'file:///C:/secret.png' }] })).toBe(false);
    expect(ok({ screens: [{ ...screen, color: 'red' }] })).toBe(false);
    expect(ok({ performers: [{ ...singer, kind: 'danseur' }] })).toBe(false);
  });
});

describe('modèles de scène', () => {
  it('chaque modèle est un projet valide, interprètes posés sur des points existants', () => {
    let n = 0;
    const id = () => `t${n++}`;
    for (const t of SCENE_TEMPLATES) {
      const layout = sceneTemplate(t.id, id);
      const p = createProject('Modèle');
      const parsed = projectSchema.parse({ ...p, visualizer: { ...p.visualizer, ...layout } });
      expect(parsed.visualizer.trusses.length).toBeGreaterThan(0);
      for (const pf of parsed.visualizer.performers) expect(parsed.visualizer.markers.some((m) => m.id === pf.markerId)).toBe(true);
      expect(hasSceneContent(parsed.visualizer)).toBe(true);
    }
    expect(hasSceneContent(createProject('Vide').visualizer)).toBe(false);
  });
});

describe('édition de scène : ajout, copie, presse-papiers, équipement', () => {
  const vis = () => createProject('Édition').visualizer;
  let n = 0;
  const id = () => `e${n++}`;
  const line = (o: Partial<Truss>): Truss => ({ id: 'x', name: 'T', shape: 'line', x: 0, y: 4, height: 6, length: 8, rotation: 0, support: 'hung', ...o });

  it('les ajouts successifs ne s’empilent pas ; un clic pose à l’endroit demandé', () => {
    let v = vis();
    for (let i = 0; i < 3; i++) v = { ...v, ...withElement(v, 'marker', newElement(v, 'marker', id)) };
    expect(v.markers.map((m) => m.x)).toEqual([0, 1, -1]);
    expect(newElement(v, 'screen', id, { x: 2.345, y: -3 })).toMatchObject({ x: 2.35, y: -3 });
  });

  it('copie décalée, suppression d’un point (l’interprète reste en place), presse-papiers validé', () => {
    const m = newElement(vis(), 'marker', id) as StageMarker;
    const pf = { ...newElement(vis(), 'performer', id), markerId: m.id, x: m.x, y: m.y } as Performer;
    const v = { ...vis(), markers: [m], performers: [pf] };
    const copy = cloneElement(v, 'performer', pf, id);
    expect(copy).toMatchObject({ x: m.x + 1, markerId: null, name: `${pf.name} (copie)` });
    expect(withoutElement(v, { kind: 'marker', id: m.id }).performers![0]).toMatchObject({ markerId: null, x: m.x, y: m.y });
    expect(parseElement(serializeElement('marker', m))).toEqual({ kind: 'marker', el: m });
    expect(parseElement('luma-scene:{"kind":"marker","el":{"id":"a","name":"x","x":500,"y":0,"height":1}}')).toBeNull();
    expect(parseElement('luma-scene:{"kind":"__proto__","el":{}}')).toBeNull();
    expect(parseElement('autre chose')).toBeNull();
  });

  it('équiper : lyres en contre, fixes en face, répartis régulièrement', () => {
    const front = line({ id: 'face', y: 1 }), back = line({ id: 'contre', y: 6, height: 7 });
    const out = equipTrusses([{ id: 'l1', movable: true }, { id: 'l2', movable: true }, { id: 'p1', movable: false }], [back, front]);
    expect(out.find((p) => p.id === 'l1')).toMatchObject({ trussId: 'contre', position: { x: -2, y: 6 }, height: 6.8 });
    expect(out.find((p) => p.id === 'l2')).toMatchObject({ trussId: 'contre', position: { x: 2, y: 6 } });
    expect(out.find((p) => p.id === 'p1')).toMatchObject({ trussId: 'face', position: { x: 0, y: 1 } });
    expect(equipTrusses([{ id: 'a', movable: false }], [])).toEqual([]);
  });

  it('équiper une seule structure : lyres et fixes partagent une répartition régulière, sans superposition', () => {
    const fx = [...['l1', 'l2', 'l3'].map((id) => ({ id, movable: true })), ...['p1', 'p2', 'p3'].map((id) => ({ id, movable: false }))];
    const out = equipTrusses(fx, [line({ id: 's', y: 5 })]);
    const xs = out.map((p) => p.position.x).sort((a, b) => a - b);
    expect(new Set(xs).size).toBe(6);
    const gaps = xs.slice(1).map((x, i) => x - xs[i]!);
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0]!, 1);
    // Families alternate along the truss instead of being bunched by patch order.
    const order = [...out].sort((a, b) => a.position.x - b.position.x).map((p) => p.id[0]).join('');
    expect(order).toBe('lplplp');
  });

  it('équiper plusieurs structures : chacune a un pas régulier et centré, les jonctions restent libres', () => {
    // Two front trusses (10 m and 5 m) side by side, joined by a corner piece.
    const a = line({ id: 'a', x: -5, y: 1, length: 10 }), b = line({ id: 'b', x: 7.5, y: 1, length: 5 });
    const corner = { ...line({ id: 'c', x: 0, y: 1 }), shape: 'corner' as const, length: 1 };
    const out = equipTrusses(Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, movable: false })), [a, corner, b]);
    expect(out.some((p) => p.trussId === 'c')).toBe(false);
    const on = (id: string) => out.filter((p) => p.trussId === id).map((p) => p.position.x).sort((x, y) => x - y);
    // Shares proportional to length: 4 on the 10 m truss, 2 on the 5 m one, each centred with a constant pitch.
    expect(on('a')).toEqual([-8.75, -6.25, -3.75, -1.25]);
    expect(on('b')).toEqual([6.25, 8.75]);
  });

  it('service : fixture.place pose tout en une seule étape annulable', async () => {
    const { svc } = makeService();
    await svc.init();
    await svc.execute({ type: 'project.new', name: 'Équiper' });
    const { ids } = await svc.execute({ type: 'fixture.add', profileId: 'demo-spot', mode: '13ch étendu', universe: 1, address: null, count: 2, namePrefix: 'Lyre', tags: [] });
    const run = (cmd: unknown) => svc.execute(commandSchema.parse(cmd) as never);
    await run({ type: 'project.update', visualizer: { trusses: [line({ id: 't1' })] } });
    const h = svc.projectState().sceneHistory.undo;
    await run({ type: 'fixture.place', placements: (ids as string[]).map((fid, i) => ({ id: fid, position: { x: i, y: 4 }, height: 5.8, trussId: 't1', mount: 'hanging' })) });
    expect(svc.projectState().sceneHistory.undo).toBe(h + 1);
    expect(svc.projectState().project.patch.every((f) => f.trussId === 't1' && f.height === 5.8)).toBe(true);
    await expect(run({ type: 'fixture.place', placements: [{ id: ids[0], position: { x: 0, y: 0 }, height: 1, trussId: 'absente' }] })).rejects.toThrow('Structure introuvable');
    await run({ type: 'scene.undo' });
    expect(svc.projectState().project.patch.every((f) => !f.trussId)).toBe(true);
  });
});

describe('bibliothèque : pièces de truss, décor', () => {
  const piece = (o: Partial<Truss>): Truss => ({ id: 'p', name: 'P', shape: 'line', x: 0, y: 0, height: 3, length: 2, rotation: 0, support: 'none', ...o });

  it('jonctions, totem : segments, extrémités et appuis', () => {
    expect(trussSegments(piece({ shape: 'corner', length: 0.5 }))).toHaveLength(2);
    expect(trussSegments(piece({ shape: 'tee', length: 0.5 }))).toHaveLength(3);
    expect(trussSegments(piece({ shape: 'cross', length: 0.5 }))).toHaveLength(4);
    expect(trussSegments(piece({ shape: 'totem' }))).toEqual([]);
    const ends = trussEnds(piece({ shape: 'corner', length: 0.5, rotation: 90 }));
    expect(ends[0]!.x).toBeCloseTo(0); expect(ends[0]!.y).toBeCloseTo(0.5);
    expect(ends[1]!.x).toBeCloseTo(-0.5); expect(ends[1]!.y).toBeCloseTo(0);
    expect(trussEnds(piece({ shape: 'totem', x: 2, y: 3 }))).toEqual([{ x: 2, y: 3 }]);
    expect(trussSupports(piece({ support: 'none' }))).toEqual([]);
    expect(trussSupports(piece({ shape: 'corner', support: 'towers' }))).toEqual([]);
    expect(trussSupports(piece({ shape: 'totem', x: 1, y: 1, support: 'towers' }))).toEqual([{ x: 1, y: 1 }]);
  });

  it('aimantation bout à bout : une droite lâchée près d’un totem s’y pose, à sa hauteur', () => {
    const totem = piece({ id: 'tot', shape: 'totem', height: 2.5 });
    const snap = snapTrussEnds(piece({ id: 'd', x: 1.1, y: 0.2 }), [totem]);
    expect(snap).toMatchObject({ x: 1, y: 0, height: 2.5 });
    expect(snapTrussEnds(piece({ id: 'd', x: 2 }), [totem])).toBeNull();
    // Equip on totems alone: clamped on the front face, stacked every 50 cm from under the top.
    const out = equipTrusses([{ id: 'a', movable: false }, { id: 'b', movable: false }], [totem]);
    expect(out).toEqual([
      { id: 'a', position: { x: 0, y: -0.25 }, height: 2.3, trussId: 'tot' },
      { id: 'b', position: { x: 0, y: -0.25 }, height: 1.8, trussId: 'tot' },
    ]);
  });

  it('chaque élément de la bibliothèque donne un projet valide', () => {
    let n = 0;
    const id = () => `b${n++}`;
    const p = createProject('Bibliothèque');
    let v = p.visualizer;
    for (const item of LIBRARY) v = { ...v, ...withElement(v, item.kind, newElement(v, item.kind, id, { x: 1, y: 2 }, item.preset)) };
    const parsed = projectSchema.parse({ ...p, visualizer: v });
    expect(parsed.visualizer.props).toHaveLength(LIBRARY.filter((x) => x.kind === 'prop').length);
    expect(parsed.visualizer.trusses.find((t) => t.shape === 'totem')).toMatchObject({ name: expect.stringMatching(/^Totem 1 m/), x: 1, y: 2 });
    expect(() => newElement(v, 'prop', id, undefined, { width: -1 })).toThrow();
  });
});

describe('set pieces in the light', () => {
  const riser: StageProp = { id: 'r1', name: 'Praticable', kind: 'riser', x: 0, y: 3, width: 2, depth: 1, height: 0.4, elevation: 0, rotation: 0, color: '#2a2f3a' };

  it('stops a beam on the top of a riser, with an upward normal', () => {
    const hit = beamHit({ x: 0, y: 6, z: -3 }, { x: 0, y: -1, z: 0 }, { ...stage, props: [riser] })!;
    expect(hit.surface).toBe('prop');
    close(hit.point, { x: 0, y: 0.4, z: -3 });
    close(hit.normal, { x: 0, y: 1, z: 0 });
    expect(hit.distance).toBeCloseTo(5.6, 5);
    // Beside the riser the floor is hit as before.
    expect(beamHit({ x: 3, y: 6, z: -3 }, { x: 0, y: -1, z: 0 }, { ...stage, props: [riser] })!.surface).toBe('floor');
  });

  it('hits the side of a rotated piece facing the beam', () => {
    const turned = { ...riser, rotation: 90 }; // 1 m wide along x, 2 m along z once turned
    const hit = beamHit({ x: -5, y: 0.2, z: -3 }, { x: 1, y: 0, z: 0 }, { ...stage, wall: false, props: [turned] })!;
    expect(hit.surface).toBe('prop');
    expect(hit.point.x).toBeCloseTo(-0.5, 5);
    close(hit.normal, { x: -1, y: 0, z: 0 });
  });

  it('raises a performer standing on a riser', () => {
    expect(floorAt(0.5, 3.2, [riser])).toBeCloseTo(0.4);
    expect(floorAt(0, 4, [riser])).toBe(0);
    expect(floorAt(0, 3, [{ ...riser, kind: 'speaker' }])).toBe(0); // not walkable
    expect(floorAt(0, 3, [riser, { ...riser, id: 'r2', elevation: 0.4 }])).toBeCloseTo(0.8); // stacked
    const pf: Performer = { id: 'p1', name: 'Chant', kind: 'standing', x: 0, y: 3, rotation: 0 };
    // Horizontal 10° beam at 2 m towards the audience: it reaches the face only once raised (0.4 + 1.6 m).
    const spot = { x: 0, height: 2, y: 5, movable: true, mount: 'hanging', rotation: 0, panDeg: 0, tiltDeg: 90, intensity: 1, color: '#ffffff', beamAngle: 10 } as unknown as VisualFixture;
    expect(performerLight(pf, [], [spot], [riser]).level).toBeGreaterThan(DARK_LEVEL);
    expect(performerLight(pf, [], [spot]).level).toBeLessThan(DARK_LEVEL);
  });

  it('hangs a fixture on the front face of a totem', () => {
    const totem: Truss = { id: 't1', name: 'Totem', shape: 'totem', x: 2, y: 1, height: 3, length: 0.5, rotation: 0, support: 'towers' };
    const snap = snapToTrusses([totem], 2.1, 0.8)!;
    expect(snap.truss.id).toBe('t1');
    expect(snap).toMatchObject({ x: 2, y: 0.75, height: hangHeight(totem) });
    expect(snapToTrusses([totem], 4, 4)).toBeNull();
  });
});
