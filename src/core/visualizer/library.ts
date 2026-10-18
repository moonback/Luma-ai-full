import type { Performer, StageProp, StageScreen, StageMarker, Truss } from '../model/schemas';

/**
 * Library of stage elements: standard truss pieces (straights, junctions, totems, circle, square), set pieces,
 * performers, screens and stage points. An item is a kind plus a preset merged into a new element by `newElement`;
 * `name` in a preset is the base of the generated name ("Droite 2 m 3").
 */
export type LibraryGroup = 'truss' | 'decor' | 'people' | 'video';
type Preset<T> = Partial<Omit<T, 'id' | 'x' | 'y'>>;
export type LibraryItem =
  | { id: string; group: LibraryGroup; label: string; kind: 'truss'; preset: Preset<Truss> }
  | { id: string; group: LibraryGroup; label: string; kind: 'prop'; preset: Preset<StageProp> }
  | { id: string; group: LibraryGroup; label: string; kind: 'performer'; preset: Preset<Performer> }
  | { id: string; group: LibraryGroup; label: string; kind: 'screen'; preset: Preset<StageScreen> }
  | { id: string; group: LibraryGroup; label: string; kind: 'marker'; preset: Preset<StageMarker> };

export const LIBRARY_GROUPS: { id: LibraryGroup; label: string }[] = [
  { id: 'truss', label: 'Structures' }, { id: 'decor', label: 'Décor' }, { id: 'people', label: 'Artistes' }, { id: 'video', label: 'Vidéo et repères' },
];

export const TRUSS_SHAPE_LABEL: Record<Truss['shape'], string> = {
  line: 'Droite', circle: 'Cercle', square: 'Carré', corner: 'Angle 90°', tee: 'Té', cross: 'Croix', totem: 'Totem',
};
/** Label of the `length` field for each truss shape. */
export const TRUSS_LENGTH_LABEL: Record<Truss['shape'], string> = {
  line: 'Longueur', circle: 'Diamètre', square: 'Côté', corner: 'Bras', tee: 'Bras', cross: 'Bras', totem: 'Longueur',
};
export const PROP_KIND_LABEL: Record<StageProp['kind'], string> = {
  riser: 'Praticable', stairs: 'Escalier', speaker: 'Enceinte', monitor: 'Retour', mic: 'Pied de micro', table: 'Table', drape: 'Pendrillon', box: 'Cube', column: 'Colonne',
};

/** Assembly pieces rest on totems / junctions: same height as a 3 m totem, no towers or motors of their own. */
const piece = (name: string, shape: Truss['shape'], length: number, extra: Preset<Truss> = {}): Preset<Truss> =>
  ({ name, shape, length, height: 3, support: 'none', ...extra });
const prop = (kind: StageProp['kind'], name: string, width: number, depth: number, height: number, color: string): Preset<StageProp> =>
  ({ kind, name, width, depth, height, color, elevation: 0 });

export const LIBRARY: LibraryItem[] = [
  { id: 'truss-0.5', group: 'truss', label: 'Droite 0,5 m', kind: 'truss', preset: piece('Droite 0,5 m', 'line', 0.5) },
  { id: 'truss-1', group: 'truss', label: 'Droite 1 m', kind: 'truss', preset: piece('Droite 1 m', 'line', 1) },
  { id: 'truss-2', group: 'truss', label: 'Droite 2 m', kind: 'truss', preset: piece('Droite 2 m', 'line', 2) },
  { id: 'truss-3', group: 'truss', label: 'Droite 3 m', kind: 'truss', preset: piece('Droite 3 m', 'line', 3) },
  { id: 'truss-4', group: 'truss', label: 'Droite 4 m', kind: 'truss', preset: piece('Droite 4 m', 'line', 4) },
  { id: 'truss-corner', group: 'truss', label: 'Angle 90°', kind: 'truss', preset: piece('Angle', 'corner', 0.5) },
  { id: 'truss-tee', group: 'truss', label: 'Té 3 départs', kind: 'truss', preset: piece('Té', 'tee', 0.5) },
  { id: 'truss-cross', group: 'truss', label: 'Croix 4 départs', kind: 'truss', preset: piece('Croix', 'cross', 0.5) },
  { id: 'totem-1', group: 'truss', label: 'Totem 1 m', kind: 'truss', preset: piece('Totem 1 m', 'totem', 0.5, { height: 1 }) },
  { id: 'totem-2', group: 'truss', label: 'Totem 2 m', kind: 'truss', preset: piece('Totem 2 m', 'totem', 0.5, { height: 2 }) },
  { id: 'totem-3', group: 'truss', label: 'Totem 3 m', kind: 'truss', preset: piece('Totem 3 m', 'totem', 0.5, { height: 3 }) },
  { id: 'truss-circle', group: 'truss', label: 'Cercle Ø 4 m', kind: 'truss', preset: { name: 'Cercle', shape: 'circle', length: 4, height: 5, support: 'hung' } },
  { id: 'truss-square', group: 'truss', label: 'Carré 3 m', kind: 'truss', preset: { name: 'Carré', shape: 'square', length: 3, height: 5, support: 'hung' } },
  { id: 'truss-bridge', group: 'truss', label: 'Pont sur pieds 8 m', kind: 'truss', preset: { name: 'Pont', shape: 'line', length: 8, height: 5, support: 'towers' } },

  { id: 'riser-2x1', group: 'decor', label: 'Praticable 2 × 1 m', kind: 'prop', preset: prop('riser', 'Praticable', 2, 1, 0.4, '#2a2f3a') },
  { id: 'riser-2x2', group: 'decor', label: 'Praticable 2 × 2 m', kind: 'prop', preset: prop('riser', 'Praticable', 2, 2, 0.6, '#2a2f3a') },
  { id: 'stairs', group: 'decor', label: 'Escalier', kind: 'prop', preset: prop('stairs', 'Escalier', 1, 1, 0.6, '#2a2f3a') },
  { id: 'speaker', group: 'decor', label: 'Enceinte', kind: 'prop', preset: prop('speaker', 'Enceinte', 0.6, 0.6, 1.2, '#15171c') },
  { id: 'monitor', group: 'decor', label: 'Retour de scène', kind: 'prop', preset: prop('monitor', 'Retour', 0.6, 0.45, 0.35, '#15171c') },
  { id: 'mic', group: 'decor', label: 'Pied de micro', kind: 'prop', preset: prop('mic', 'Micro', 0.3, 0.3, 1.6, '#3a3f4a') },
  { id: 'table', group: 'decor', label: 'Table / régie DJ', kind: 'prop', preset: prop('table', 'Table', 1.6, 0.7, 0.9, '#1d2129') },
  { id: 'drape', group: 'decor', label: 'Pendrillon', kind: 'prop', preset: prop('drape', 'Pendrillon', 2, 0.1, 5, '#0b0c10') },
  { id: 'box', group: 'decor', label: 'Cube', kind: 'prop', preset: prop('box', 'Cube', 1, 1, 1, '#475569') },
  { id: 'column', group: 'decor', label: 'Colonne', kind: 'prop', preset: prop('column', 'Colonne', 0.5, 0.5, 3, '#cbd5e1') },

  { id: 'performer-standing', group: 'people', label: 'Artiste debout', kind: 'performer', preset: { name: 'Artiste', kind: 'standing' } },
  { id: 'performer-seated', group: 'people', label: 'Artiste assis', kind: 'performer', preset: { name: 'Artiste', kind: 'seated' } },
  { id: 'performer-drums', group: 'people', label: 'Batterie', kind: 'performer', preset: { name: 'Batterie', kind: 'drums' } },
  { id: 'performer-keys', group: 'people', label: 'Clavier', kind: 'performer', preset: { name: 'Clavier', kind: 'keys' } },
  { id: 'performer-lectern', group: 'people', label: 'Pupitre', kind: 'performer', preset: { name: 'Pupitre', kind: 'lectern' } },

  { id: 'screen-16-9', group: 'video', label: 'Écran 16:9 3 m', kind: 'screen', preset: { name: 'Écran', width: 3, height: 1.7, elevation: 1.2 } },
  { id: 'screen-wall', group: 'video', label: 'Mur LED 6 × 3 m', kind: 'screen', preset: { name: 'Mur LED', width: 6, height: 3, elevation: 0.5, color: '#7c3aed' } },
  { id: 'marker', group: 'video', label: 'Point de scène', kind: 'marker', preset: { name: 'Point' } },
];

export const libraryItem = (id: string) => LIBRARY.find((x) => x.id === id);
