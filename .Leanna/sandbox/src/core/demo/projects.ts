import { createProject } from '../project/format';
import { projectSchema, effectParamsSchema, type Project, type FixtureValues } from '../model/schemas';
import { ProjectIndex } from '../engine/resolve';
import { channelCount } from '../fixtures/profiles';
import { colorCapability, colorCells, colorToAttributes } from '../fixtures/color';
import { hexToRgb } from '../util/math';
import { DEMOS, type DemoSpec } from './catalog';

/** Builds a complete, schema-validated project from a demo spec (deterministic ids: reproducible and testable). */
export function buildDemo(id: string): Project {
  const spec = DEMOS.find((d) => d.id === id);
  if (!spec) throw new Error(`Projet de démonstration inconnu : ${id}`);
  return build(spec);
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function build(spec: DemoSpec): Project {
  const p = createProject(spec.name);
  const [W, D] = spec.stage;
  p.meta.show = spec.show.slice(0, 80);
  p.meta.notes = `${spec.description}\n\nLieu : ${spec.venue} (fictif).\n${spec.notes}`;
  p.show.bpm = spec.bpm;
  p.visualizer = { ...p.visualizer, stageWidth: W, stageDepth: D };
  p.cueLists = [];
  const pid = (s: string) => `${spec.id}-${slug(s)}`.slice(0, 64);

  // Patch: consecutive addresses per universe, positions spread across (or along) the stage.
  const next = new Map<number, number>();
  const rigIds = new Map<string, string[]>();
  for (const rig of spec.rigs) {
    const u = rig.universe ?? 1;
    const ch = channelCount(new ProjectIndex(p).lib.get(rig.profile)!, rig.mode);
    const ids: string[] = [];
    for (let i = 0; i < rig.count; i++) {
      const address = next.get(u) ?? 1;
      if (address + ch - 1 > 512) throw new Error(`${spec.id} : univers ${u} plein`);
      next.set(u, address + ch);
      const t = rig.count === 1 ? 0.5 : i / (rig.count - 1);
      const position = rig.alongDepth
        ? { x: (rig.span ?? 0) * W, y: 0.5 + t * (D - 1) }
        : { x: (t - 0.5) * W * (rig.span ?? 0.9), y: rig.y };
      const id = pid(`${rig.prefix}-${i + 1}`);
      ids.push(id);
      p.patch.push({ id, name: `${rig.label} ${i + 1}`, profileId: rig.profile, mode: rig.mode, universe: u, address, tags: [rig.prefix.toLowerCase()], position: { x: Math.round(position.x * 10) / 10, y: Math.round(position.y * 10) / 10 }, rotation: 0, height: rig.height, notes: '' });
    }
    rigIds.set(rig.prefix, ids);
    p.groups.push({ id: pid(`g-${rig.prefix}`), name: rig.label, color: rig.color, fixtureIds: ids });
  }
  p.show.universes = Math.max(1, ...next.keys());

  // Scenes: per-fixture colours from the real colour capabilities of each profile.
  const index = new ProjectIndex(p);
  const sceneId = new Map<string, string>();
  for (const look of spec.looks) {
    const values: FixtureValues = {};
    for (const part of look.parts) {
      const ids = part.rigs.flatMap((r) => rigIds.get(r) ?? []);
      ids.forEach((fid, i) => {
        const rf = index.fixtures.get(fid)!;
        const v: Record<string, number> = { dimmer: part.level };
        if (colorCapability(rf) !== 'none') {
          const cells = colorCells(rf);
          if (cells.length > 1) cells.forEach((c, k) => Object.assign(v, colorToAttributes(rf, hexToRgb(part.colors[(i + k) % part.colors.length]!), c)));
          else Object.assign(v, colorToAttributes(rf, hexToRgb(part.colors[i % part.colors.length]!)));
        }
        if (part.pan !== undefined && rf.attributes.includes('pan')) v.pan = part.pan;
        if (part.tilt !== undefined && rf.attributes.includes('tilt')) v.tilt = part.tilt;
        values[fid] = v;
      });
    }
    const id = pid(`s-${look.name}`);
    sceneId.set(look.name, id);
    p.scenes.push({ id, name: look.name, notes: '', values, origin: 'user' });
  }

  const effectId = new Map<string, string>();
  for (const fx of spec.effects) {
    const id = pid(`fx-${fx.name}`);
    effectId.set(fx.name, id);
    p.effects.push({
      id, name: fx.name, type: fx.type, targets: { fixtureIds: [], groupIds: fx.rigs.map((r) => pid(`g-${r}`)) },
      params: effectParamsSchema.parse(fx.params), priority: 50, blend: fx.blend ?? 'override', duration: null, trigger: 'cue', origin: 'user',
    });
  }

  for (const list of spec.cueLists) {
    p.cueLists.push({
      id: pid(`l-${list.name}`), name: list.name, priority: 50, loop: list.loop ?? false,
      cues: list.cues.map((c, i) => ({
        id: pid(`c-${list.name}-${i + 1}`), number: i + 1, name: c.name, description: c.description ?? '',
        sceneId: c.look ? sceneId.get(c.look)! : null, fade: c.fade, delay: 0, curve: c.fade >= 5 ? 'easeInOut' : 'linear',
        trigger: c.follow !== undefined ? { type: 'follow', wait: c.follow } : { type: 'manual' },
        effectIds: (c.effects ?? []).map((e) => effectId.get(e)!),
      })),
    });
  }

  if (spec.timeline) {
    p.timelines.push({
      id: pid(`t-${spec.timeline.name}`), name: spec.timeline.name, duration: spec.timeline.duration, loop: false,
      events: spec.timeline.events.map((e, i) => ({
        id: pid(`te-${i + 1}`), kind: e.look ? 'scene' : 'effect', start: e.at, duration: e.dur,
        refId: e.look ? sceneId.get(e.look)! : effectId.get(e.effect!)!, cueIndex: 0, fade: e.fade ?? 0, label: e.look ?? e.effect ?? '', lane: e.look ? 0 : 1,
      })),
    });
  }
  return projectSchema.parse(p);
}
