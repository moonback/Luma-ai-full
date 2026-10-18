import type { EffectParams, EffectType } from '../model/schemas';

/**
 * Ten fictional demonstration projects, described as plain data (importable by the renderer for the gallery) and
 * turned into real, validated projects by `buildDemo` (main process). Venues, artists and events are invented; every
 * fixture uses the built-in "Luma Demo" profiles, which describe no commercial model.
 */
export interface DemoRig {
  prefix: string;
  label: string;
  profile: 'demo-par-rgb' | 'demo-par-rgbw' | 'demo-spot' | 'demo-wash' | 'demo-led-bar-4' | 'demo-strobe';
  mode: string;
  count: number;
  universe?: number;
  /** Distance from the stage front (m) and mounting height (m). */
  y: number;
  height: number;
  /** Share of the stage width used (across) or the x offset as a share of the width (alongDepth). */
  span?: number;
  /** Fixtures laid out along the depth (runway) instead of across. */
  alongDepth?: boolean;
  color: string;
}
export interface DemoLookPart { rigs: string[]; colors: string[]; level: number; pan?: number; tilt?: number }
export interface DemoLook { name: string; parts: DemoLookPart[] }
export interface DemoEffect { name: string; type: EffectType; rigs: string[]; params: Partial<EffectParams>; blend?: 'override' | 'scale' }
export interface DemoCue { name: string; look: string | null; fade: number; follow?: number; effects?: string[]; description?: string }
export interface DemoSpec {
  id: string;
  name: string;
  venue: string;
  show: string;
  category: string;
  description: string;
  highlights: string[];
  bpm: number;
  stage: [number, number];
  rigs: DemoRig[];
  looks: DemoLook[];
  effects: DemoEffect[];
  cueLists: { name: string; loop?: boolean; cues: DemoCue[] }[];
  timeline?: { name: string; duration: number; events: { at: number; dur: number; look?: string; effect?: string; fade?: number }[] };
  notes: string;
}

const C = {
  white: '#FFFFFF', warm: '#FFD7A0', amber: '#FFB000', orange: '#FF7000', red: '#FF0000', pink: '#FF4FA0', magenta: '#FF00C8',
  violet: '#8B00FF', blue: '#0040FF', navy: '#1A237E', cyan: '#00E5FF', teal: '#00BFA5', green: '#00FF60', gold: '#FFC23D',
};

const club: DemoSpec = {
  id: 'club-electro', name: 'Le Hangar — nuit électro', venue: 'Le Hangar (club, 600 places)', show: 'Résidence DJ « Pulse »', category: 'Club',
  description: 'Club techno/house : lyres, PAR, barres LED et strobes, un set DJ en cues et une timeline de drop.',
  highlights: ['Liste « Set DJ » de 6 cues avec effets', 'Timeline « Drop » de 64 s', 'Chase, arc-en-ciel, mouvements et strobe'],
  bpm: 126, stage: [10, 6],
  rigs: [
    { prefix: 'SPOT', label: 'Lyres spot', profile: 'demo-spot', mode: '13ch étendu', count: 6, y: 4.5, height: 5, color: '#8B5CF6' },
    { prefix: 'PAR', label: 'PAR contre', profile: 'demo-par-rgbw', mode: '6ch DRGBW+Strobe', count: 8, y: 5.5, height: 4.5, color: '#22D3EE' },
    { prefix: 'BAR', label: 'Barres LED sol', profile: 'demo-led-bar-4', mode: '14ch pixels', count: 4, y: 1, height: 0.2, color: '#F472B6' },
    { prefix: 'STR', label: 'Strobes', profile: 'demo-strobe', mode: '2ch', count: 2, y: 3, height: 5, span: 0.6, color: '#FACC15' },
  ],
  looks: [
    { name: 'Warm-up', parts: [{ rigs: ['PAR'], colors: [C.violet, C.blue], level: 0.45 }, { rigs: ['BAR'], colors: [C.violet], level: 0.3 }] },
    { name: 'Groove', parts: [{ rigs: ['PAR'], colors: [C.magenta, C.cyan], level: 0.7 }, { rigs: ['SPOT'], colors: [C.cyan], level: 0.6, tilt: 0.65 }, { rigs: ['BAR'], colors: [C.magenta, C.cyan], level: 0.6 }] },
    { name: 'Montée', parts: [{ rigs: ['PAR'], colors: [C.violet], level: 0.5 }, { rigs: ['SPOT'], colors: [C.white], level: 0.8, tilt: 0.3 }, { rigs: ['BAR'], colors: [C.white], level: 0.4 }] },
    { name: 'Drop', parts: [{ rigs: ['PAR', 'BAR'], colors: [C.white, C.cyan], level: 1 }, { rigs: ['SPOT'], colors: [C.white], level: 1, tilt: 0.7 }] },
    { name: 'Afterhours', parts: [{ rigs: ['PAR'], colors: [C.red, C.orange], level: 0.35 }, { rigs: ['BAR'], colors: [C.red], level: 0.25 }] },
  ],
  effects: [
    { name: 'Chase PAR', type: 'chase', rigs: ['PAR'], params: { bpmSync: true, beatsPerCycle: 2, phaseSpread: 1, barSync: true }, blend: 'scale' },
    { name: 'Arc-en-ciel barres', type: 'rainbow', rigs: ['BAR'], params: { bpmSync: true, beatsPerCycle: 8, phaseSpread: 1 } },
    { name: 'Balayage lyres', type: 'panTilt', rigs: ['SPOT'], params: { bpmSync: true, beatsPerCycle: 8, amplitude: 0.5, phaseSpread: 0.5, shape: 'figure8', barSync: true } },
    { name: 'Strobe drop', type: 'strobe', rigs: ['STR'], params: { speed: 6 } },
  ],
  cueLists: [{ name: 'Set DJ', cues: [
    { name: 'Ouverture des portes', look: 'Warm-up', fade: 5 },
    { name: 'Groove', look: 'Groove', fade: 3, effects: ['Arc-en-ciel barres'] },
    { name: 'Peak time', look: 'Groove', fade: 1, effects: ['Chase PAR', 'Balayage lyres'] },
    { name: 'Montée', look: 'Montée', fade: 8 },
    { name: 'Drop', look: 'Drop', fade: 0, effects: ['Chase PAR', 'Balayage lyres', 'Strobe drop'] },
    { name: 'Afterhours', look: 'Afterhours', fade: 10 },
  ] }],
  timeline: { name: 'Drop', duration: 64, events: [
    { at: 0, dur: 30, look: 'Groove', fade: 2 }, { at: 0, dur: 30, effect: 'Arc-en-ciel barres' },
    { at: 30, dur: 15, look: 'Montée', fade: 6 },
    { at: 45, dur: 19, look: 'Drop' }, { at: 45, dur: 19, effect: 'Chase PAR' }, { at: 45, dur: 19, effect: 'Balayage lyres' },
  ] },
  notes: 'Démo : régler la plage de tempo audio sur 120–135 (house) pour un suivi fiable. Strobe plafonné par les paramètres de sécurité.',
};

const pop: DemoSpec = {
  id: 'concert-pop', name: 'Tournée « Aurore » — concert pop', venue: 'Le Dôme (salle de concert, 2 500 places)', show: 'Aurore — tournée 2026', category: 'Concert',
  description: 'Concert pop : face en wash, contre en lyres spot, PAR et barres ; une liste de cues d’un morceau type.',
  highlights: ['8 cues Intro → Salut, avec un enchaînement automatique', 'Couplets chauds, refrains froids', 'Mouvements synchronisés au BPM'],
  bpm: 118, stage: [12, 8],
  rigs: [
    { prefix: 'WASH', label: 'Wash face', profile: 'demo-wash', mode: '13ch', count: 6, y: 1.5, height: 6, color: '#F59E0B' },
    { prefix: 'SPOT', label: 'Spots contre', profile: 'demo-spot', mode: '13ch étendu', count: 6, y: 7, height: 7, color: '#8B5CF6' },
    { prefix: 'PAR', label: 'PAR latéraux', profile: 'demo-par-rgbw', mode: '6ch DRGBW+Strobe', count: 12, y: 4, height: 5, color: '#22D3EE' },
    { prefix: 'BAR', label: 'Barres décor', profile: 'demo-led-bar-4', mode: '14ch pixels', count: 4, y: 7.8, height: 0.3, color: '#F472B6' },
  ],
  looks: [
    { name: 'Intro', parts: [{ rigs: ['SPOT'], colors: [C.blue], level: 0.5, tilt: 0.6 }, { rigs: ['BAR'], colors: [C.navy], level: 0.4 }] },
    { name: 'Couplet', parts: [{ rigs: ['WASH'], colors: [C.warm], level: 0.6 }, { rigs: ['PAR'], colors: [C.amber, C.orange], level: 0.5 }, { rigs: ['BAR'], colors: [C.amber], level: 0.3 }] },
    { name: 'Refrain', parts: [{ rigs: ['WASH'], colors: [C.white], level: 0.85 }, { rigs: ['PAR'], colors: [C.cyan, C.magenta], level: 0.9 }, { rigs: ['SPOT'], colors: [C.white], level: 0.9, tilt: 0.7 }, { rigs: ['BAR'], colors: [C.cyan, C.magenta], level: 0.8 }] },
    { name: 'Pont', parts: [{ rigs: ['WASH'], colors: [C.violet], level: 0.4 }, { rigs: ['SPOT'], colors: [C.violet], level: 0.6, tilt: 0.5 }] },
    { name: 'Final', parts: [{ rigs: ['WASH', 'SPOT', 'PAR', 'BAR'], colors: [C.gold, C.white], level: 1 }] },
    { name: 'Salut', parts: [{ rigs: ['WASH'], colors: [C.warm], level: 1 }] },
  ],
  effects: [
    { name: 'Pulse refrain', type: 'pulse', rigs: ['PAR'], params: { bpmSync: true, beatsPerCycle: 1, offset: 0.7, amplitude: 0.6 }, blend: 'scale' },
    { name: 'Cercles spots', type: 'panTilt', rigs: ['SPOT'], params: { bpmSync: true, beatsPerCycle: 16, amplitude: 0.35, phaseSpread: 0.5, barSync: true } },
    { name: 'Vague barres', type: 'dimmerWave', rigs: ['BAR'], params: { bpmSync: true, beatsPerCycle: 8, phaseSpread: 1, offset: 0.6, amplitude: 0.8 }, blend: 'scale' },
  ],
  cueLists: [{ name: 'Morceau type', cues: [
    { name: 'Noir salle → intro', look: 'Intro', fade: 4 },
    { name: 'Couplet 1', look: 'Couplet', fade: 2, effects: ['Vague barres'] },
    { name: 'Refrain 1', look: 'Refrain', fade: 0.5, effects: ['Pulse refrain', 'Cercles spots'] },
    { name: 'Couplet 2', look: 'Couplet', fade: 2 },
    { name: 'Pont', look: 'Pont', fade: 4, effects: ['Cercles spots'] },
    { name: 'Refrain final', look: 'Refrain', fade: 0.5, effects: ['Pulse refrain', 'Cercles spots', 'Vague barres'] },
    { name: 'Final', look: 'Final', fade: 1, follow: 8, description: 'Enchaîne automatiquement sur le salut après 8 s' },
    { name: 'Salut', look: 'Salut', fade: 2 },
  ] }],
  notes: 'Démo : importez un morceau dans Musique pour générer automatiquement un show Song-to-Show sur ce kit.',
};

const theatre: DemoSpec = {
  id: 'theatre', name: 'Théâtre des Lilas — « Le Misanthrope »', venue: 'Théâtre des Lilas (salle à l’italienne, 400 places)', show: 'Le Misanthrope — mise en scène fictive', category: 'Théâtre',
  description: 'Conduite théâtrale : face chaude, contres, ambiances de jour et de nuit, longs fondus.',
  highlights: ['Conduite de 10 cues numérotés', 'Fondus longs (jusqu’à 12 s) et noirs', 'Aucun effet dynamique : lumière dramaturgique'],
  bpm: 90, stage: [10, 9],
  rigs: [
    { prefix: 'FACE', label: 'Face', profile: 'demo-par-rgbw', mode: '6ch DRGBW+Strobe', count: 8, y: -2, height: 7, color: '#F59E0B' },
    { prefix: 'CONTRE', label: 'Contres', profile: 'demo-par-rgbw', mode: '6ch DRGBW+Strobe', count: 6, y: 7, height: 7, color: '#60A5FA' },
    { prefix: 'DECOUPE', label: 'Découpes (lyres)', profile: 'demo-spot', mode: '13ch étendu', count: 4, y: 3, height: 7.5, color: '#A78BFA' },
    { prefix: 'CYCLO', label: 'Cyclorama', profile: 'demo-led-bar-4', mode: '4ch DRGB global', count: 6, y: 8.8, height: 0.2, color: '#34D399' },
  ],
  looks: [
    { name: 'Entrée public', parts: [{ rigs: ['CYCLO'], colors: [C.navy], level: 0.3 }] },
    { name: 'Salon — jour', parts: [{ rigs: ['FACE'], colors: [C.warm], level: 0.75 }, { rigs: ['CONTRE'], colors: [C.warm], level: 0.5 }, { rigs: ['CYCLO'], colors: ['#87CEEB'], level: 0.6 }] },
    { name: 'Aparté Alceste', parts: [{ rigs: ['FACE'], colors: [C.warm], level: 0.2 }, { rigs: ['DECOUPE'], colors: [C.white], level: 0.8, pan: 0.45, tilt: 0.7 }] },
    { name: 'Crépuscule', parts: [{ rigs: ['FACE'], colors: [C.orange], level: 0.5 }, { rigs: ['CONTRE'], colors: [C.violet], level: 0.5 }, { rigs: ['CYCLO'], colors: [C.orange, C.pink], level: 0.7 }] },
    { name: 'Nuit', parts: [{ rigs: ['CONTRE'], colors: [C.blue], level: 0.4 }, { rigs: ['CYCLO'], colors: [C.navy], level: 0.5 }, { rigs: ['DECOUPE'], colors: ['#B0C4FF'], level: 0.3, tilt: 0.6 }] },
    { name: 'Salut', parts: [{ rigs: ['FACE', 'CONTRE'], colors: [C.warm], level: 0.9 }, { rigs: ['CYCLO'], colors: [C.warm], level: 0.6 }] },
  ],
  effects: [],
  cueLists: [{ name: 'Conduite', cues: [
    { name: '1 — Entrée public', look: 'Entrée public', fade: 3 },
    { name: '2 — Noir salle', look: null, fade: 6 },
    { name: '3 — Acte I, salon', look: 'Salon — jour', fade: 5 },
    { name: '4 — Aparté', look: 'Aparté Alceste', fade: 3 },
    { name: '5 — Retour salon', look: 'Salon — jour', fade: 4 },
    { name: '6 — Acte IV, crépuscule', look: 'Crépuscule', fade: 12 },
    { name: '7 — Nuit', look: 'Nuit', fade: 10 },
    { name: '8 — Noir final', look: null, fade: 4 },
    { name: '9 — Salut', look: 'Salut', fade: 2 },
    { name: '10 — Sortie public', look: 'Entrée public', fade: 5 },
  ] }],
  notes: 'Démo : les cues sans scène (2, 8) font des noirs. Les découpes sont simulées par des lyres spot.',
};

const wedding: DemoSpec = {
  id: 'mariage', name: 'Domaine des Tilleuls — mariage', venue: 'Domaine des Tilleuls (salle de réception)', show: 'Mariage de Camille & Sacha (fictif)', category: 'Événementiel',
  description: 'Réception : uplights au sol autour de la salle, barres LED derrière la table d’honneur, ambiances de soirée.',
  highlights: ['16 uplights au sol', 'Cocktail, dîner, ouverture de bal, soirée dansante', 'Cycle de couleurs lent pendant le dîner'],
  bpm: 110, stage: [16, 12],
  rigs: [
    { prefix: 'UP', label: 'Uplights', profile: 'demo-par-rgbw', mode: '6ch DRGBW+Strobe', count: 16, y: 11, height: 0.3, color: '#F472B6' },
    { prefix: 'BAR', label: 'Table d’honneur', profile: 'demo-led-bar-4', mode: '14ch pixels', count: 2, y: 2, height: 0.5, span: 0.3, color: '#FBBF24' },
    { prefix: 'WASH', label: 'Piste de danse', profile: 'demo-wash', mode: '13ch', count: 4, y: 6, height: 4, span: 0.5, color: '#8B5CF6' },
  ],
  looks: [
    { name: 'Cocktail', parts: [{ rigs: ['UP'], colors: [C.amber], level: 0.6 }, { rigs: ['BAR'], colors: [C.warm], level: 0.5 }] },
    { name: 'Dîner', parts: [{ rigs: ['UP'], colors: [C.amber, C.pink], level: 0.4 }, { rigs: ['BAR'], colors: [C.warm], level: 0.7 }] },
    { name: 'Ouverture de bal', parts: [{ rigs: ['UP'], colors: [C.pink], level: 0.3 }, { rigs: ['WASH'], colors: [C.white], level: 0.9, tilt: 0.75 }] },
    { name: 'Soirée dansante', parts: [{ rigs: ['UP'], colors: [C.magenta, C.cyan, C.violet], level: 0.8 }, { rigs: ['WASH'], colors: [C.magenta, C.cyan], level: 0.9, tilt: 0.6 }, { rigs: ['BAR'], colors: [C.violet], level: 0.6 }] },
  ],
  effects: [
    { name: 'Cycle dîner', type: 'colorCycle', rigs: ['UP'], params: { speed: 0.02, colors: [C.amber, C.pink, C.warm], phaseSpread: 0.5 } },
    { name: 'Danse wash', type: 'randomMove', rigs: ['WASH'], params: { bpmSync: true, beatsPerCycle: 4, amplitude: 0.5 } },
    { name: 'Chase uplights', type: 'chase', rigs: ['UP'], params: { bpmSync: true, beatsPerCycle: 2, phaseSpread: 1 }, blend: 'scale' },
  ],
  cueLists: [{ name: 'Soirée', cues: [
    { name: 'Accueil cocktail', look: 'Cocktail', fade: 5 },
    { name: 'Dîner', look: 'Dîner', fade: 10, effects: ['Cycle dîner'] },
    { name: 'Discours', look: 'Cocktail', fade: 3 },
    { name: 'Ouverture de bal', look: 'Ouverture de bal', fade: 2 },
    { name: 'Soirée dansante', look: 'Soirée dansante', fade: 1, effects: ['Danse wash', 'Chase uplights'] },
  ] }],
  notes: 'Démo : uplights répartis le long du fond de salle (voir la vue 3D).',
};

const conference: DemoSpec = {
  id: 'conference', name: 'Forum Numérique — conférence', venue: 'Centre des congrès (auditorium, 800 places)', show: 'Forum Numérique 2026 (fictif)', category: 'Corporate',
  description: 'Conférence : face blanche neutre pour la captation vidéo, contre aux couleurs de la marque, barres sur le pupitre.',
  highlights: ['Face blanche homogène (vidéo)', 'Couleurs de marque bleu / teal', 'Keynote, table ronde, pause, remise de prix'],
  bpm: 100, stage: [12, 6],
  rigs: [
    { prefix: 'FACE', label: 'Face', profile: 'demo-par-rgbw', mode: '6ch DRGBW+Strobe', count: 8, y: -3, height: 6, color: '#F8FAFC' },
    { prefix: 'CONTRE', label: 'Contre marque', profile: 'demo-wash', mode: '13ch', count: 4, y: 5, height: 5, color: '#14B8A6' },
    { prefix: 'BAR', label: 'Pupitre et logo', profile: 'demo-led-bar-4', mode: '14ch pixels', count: 4, y: 2, height: 1, span: 0.5, color: '#3B82F6' },
  ],
  looks: [
    { name: 'Accueil', parts: [{ rigs: ['CONTRE'], colors: [C.teal], level: 0.6, tilt: 0.55 }, { rigs: ['BAR'], colors: [C.blue], level: 0.6 }] },
    { name: 'Keynote', parts: [{ rigs: ['FACE'], colors: [C.white], level: 0.85 }, { rigs: ['CONTRE'], colors: [C.blue], level: 0.5, tilt: 0.6 }, { rigs: ['BAR'], colors: [C.blue], level: 0.5 }] },
    { name: 'Table ronde', parts: [{ rigs: ['FACE'], colors: [C.white], level: 0.9 }, { rigs: ['CONTRE'], colors: [C.teal], level: 0.4, tilt: 0.6 }] },
    { name: 'Pause', parts: [{ rigs: ['CONTRE'], colors: [C.teal, C.blue], level: 0.4 }, { rigs: ['BAR'], colors: [C.teal], level: 0.4 }] },
    { name: 'Remise des prix', parts: [{ rigs: ['FACE'], colors: [C.white], level: 1 }, { rigs: ['CONTRE'], colors: [C.gold], level: 0.8, tilt: 0.5 }, { rigs: ['BAR'], colors: [C.gold], level: 0.8 }] },
  ],
  effects: [{ name: 'Respiration logo', type: 'pulse', rigs: ['BAR'], params: { speed: 0.15, offset: 0.7, amplitude: 0.4 }, blend: 'scale' }],
  cueLists: [{ name: 'Programme', cues: [
    { name: 'Accueil', look: 'Accueil', fade: 3, effects: ['Respiration logo'] },
    { name: 'Ouverture — keynote', look: 'Keynote', fade: 2 },
    { name: 'Table ronde', look: 'Table ronde', fade: 2 },
    { name: 'Pause café', look: 'Pause', fade: 4, effects: ['Respiration logo'] },
    { name: 'Remise des prix', look: 'Remise des prix', fade: 1 },
    { name: 'Clôture', look: 'Accueil', fade: 5 },
  ] }],
  notes: 'Démo : éviter tout effet rapide pendant la captation (scintillement à l’image).',
};

const jazz: DemoSpec = {
  id: 'jazz-club', name: 'Blue Note Café — soirée jazz', venue: 'Blue Note Café (club, 120 places)', show: 'Quartet « Nocturne » (fictif)', category: 'Club',
  description: 'Petit club de jazz : PAR RGB simples et deux lyres pour les solos, ambiances ambre et bleu nuit.',
  highlights: ['Kit minimal (6 PAR 3 canaux + 2 lyres)', 'Douches de solo sur les lyres', 'Liste en boucle'],
  bpm: 96, stage: [6, 4],
  rigs: [
    { prefix: 'PAR', label: 'PAR', profile: 'demo-par-rgb', mode: '3ch RGB', count: 6, y: 2, height: 3.5, color: '#F59E0B' },
    { prefix: 'SOLO', label: 'Lyres solo', profile: 'demo-spot', mode: '13ch étendu', count: 2, y: 1, height: 3.8, span: 0.5, color: '#60A5FA' },
  ],
  looks: [
    { name: 'Ambre', parts: [{ rigs: ['PAR'], colors: [C.amber, C.orange], level: 0.6 }] },
    { name: 'Bleu nuit', parts: [{ rigs: ['PAR'], colors: [C.navy, C.violet], level: 0.5 }] },
    { name: 'Solo saxophone', parts: [{ rigs: ['PAR'], colors: [C.navy], level: 0.25 }, { rigs: ['SOLO'], colors: [C.warm], level: 0.9, pan: 0.4, tilt: 0.75 }] },
    { name: 'Solo piano', parts: [{ rigs: ['PAR'], colors: [C.navy], level: 0.25 }, { rigs: ['SOLO'], colors: [C.warm], level: 0.9, pan: 0.6, tilt: 0.75 }] },
  ],
  effects: [{ name: 'Fondu lent', type: 'colorCycle', rigs: ['PAR'], params: { speed: 0.01, colors: [C.amber, C.navy, C.violet], phaseSpread: 0.3 } }],
  cueLists: [{ name: 'Set', loop: true, cues: [
    { name: 'Ambre', look: 'Ambre', fade: 4 },
    { name: 'Solo sax', look: 'Solo saxophone', fade: 2 },
    { name: 'Bleu nuit', look: 'Bleu nuit', fade: 6, effects: ['Fondu lent'] },
    { name: 'Solo piano', look: 'Solo piano', fade: 2 },
  ] }],
  notes: 'Démo : liste en boucle — GO repasse au premier cue après le dernier.',
};

const festival: DemoSpec = {
  id: 'festival', name: 'Festival des Dunes — grande scène', venue: 'Festival des Dunes (plein air, 15 000 personnes)', show: 'Grande scène — soirée de clôture (fictif)', category: 'Festival',
  description: 'Grande scène sur 2 univers : lyres, wash, PAR, barres et strobes, timeline d’ouverture.',
  highlights: ['2 univers, 50 projecteurs', 'Timeline d’ouverture de 90 s', 'Mouvements aléatoires, arc-en-ciel, chase, strobe'],
  bpm: 128, stage: [18, 12],
  rigs: [
    { prefix: 'SPOT', label: 'Spots', profile: 'demo-spot', mode: '13ch étendu', count: 12, y: 10, height: 10, color: '#8B5CF6' },
    { prefix: 'WASH', label: 'Wash', profile: 'demo-wash', mode: '13ch', count: 12, y: 4, height: 9, color: '#F59E0B' },
    { prefix: 'PAR', label: 'PAR sol', profile: 'demo-par-rgbw', mode: '6ch DRGBW+Strobe', count: 14, y: 11.5, height: 0.4, color: '#22D3EE' },
    { prefix: 'BAR', label: 'Barres', profile: 'demo-led-bar-4', mode: '14ch pixels', count: 8, universe: 2, y: 11.8, height: 2, color: '#F472B6' },
    { prefix: 'STR', label: 'Strobes', profile: 'demo-strobe', mode: '2ch', count: 4, universe: 2, y: 7, height: 10, span: 0.7, color: '#FACC15' },
  ],
  looks: [
    { name: 'Attente', parts: [{ rigs: ['PAR'], colors: [C.blue], level: 0.4 }, { rigs: ['BAR'], colors: [C.navy], level: 0.4 }] },
    { name: 'Intro', parts: [{ rigs: ['SPOT'], colors: [C.white], level: 0.7, tilt: 0.25 }, { rigs: ['PAR'], colors: [C.violet], level: 0.5 }] },
    { name: 'Pleine scène', parts: [{ rigs: ['WASH'], colors: [C.magenta, C.cyan], level: 0.9 }, { rigs: ['SPOT'], colors: [C.cyan], level: 0.9, tilt: 0.65 }, { rigs: ['PAR', 'BAR'], colors: [C.magenta, C.cyan], level: 0.9 }] },
    { name: 'Feu', parts: [{ rigs: ['WASH', 'PAR', 'BAR'], colors: [C.red, C.orange, C.amber], level: 1 }, { rigs: ['SPOT'], colors: [C.orange], level: 1, tilt: 0.6 }] },
    { name: 'Calme', parts: [{ rigs: ['WASH'], colors: [C.teal], level: 0.5 }, { rigs: ['BAR'], colors: [C.teal], level: 0.4 }] },
  ],
  effects: [
    { name: 'Spots aléatoires', type: 'randomMove', rigs: ['SPOT'], params: { bpmSync: true, beatsPerCycle: 4, amplitude: 0.6 } },
    { name: 'Arc-en-ciel barres', type: 'rainbow', rigs: ['BAR'], params: { bpmSync: true, beatsPerCycle: 16, phaseSpread: 1 } },
    { name: 'Chase sol', type: 'chase', rigs: ['PAR'], params: { bpmSync: true, beatsPerCycle: 1, phaseSpread: 1, barSync: true }, blend: 'scale' },
    { name: 'Vague wash', type: 'dimmerWave', rigs: ['WASH'], params: { bpmSync: true, beatsPerCycle: 8, phaseSpread: 1, offset: 0.6, amplitude: 0.8 }, blend: 'scale' },
    { name: 'Strobe final', type: 'strobe', rigs: ['STR'], params: { speed: 8 } },
  ],
  cueLists: [{ name: 'Headliner', cues: [
    { name: 'Attente public', look: 'Attente', fade: 4 },
    { name: 'Intro', look: 'Intro', fade: 6, effects: ['Spots aléatoires'] },
    { name: 'Premier titre', look: 'Pleine scène', fade: 0, effects: ['Spots aléatoires', 'Chase sol', 'Arc-en-ciel barres'] },
    { name: 'Ballade', look: 'Calme', fade: 5, effects: ['Vague wash'] },
    { name: 'Final', look: 'Feu', fade: 0, effects: ['Spots aléatoires', 'Chase sol', 'Strobe final'] },
  ] }],
  timeline: { name: 'Ouverture', duration: 90, events: [
    { at: 0, dur: 20, look: 'Attente', fade: 3 },
    { at: 20, dur: 25, look: 'Intro', fade: 8 }, { at: 20, dur: 25, effect: 'Spots aléatoires' },
    { at: 45, dur: 45, look: 'Pleine scène' }, { at: 45, dur: 45, effect: 'Chase sol' }, { at: 45, dur: 45, effect: 'Arc-en-ciel barres' }, { at: 45, dur: 45, effect: 'Vague wash' },
  ] },
  notes: 'Démo : univers 2 pour les barres et strobes (sortie Art-Net ou sACN à configurer).',
};

const runway: DemoSpec = {
  id: 'defile', name: 'Atelier Nova — défilé de mode', venue: 'Halle Nova (podium de 20 m)', show: 'Collection automne (fictive)', category: 'Mode',
  description: 'Défilé : deux lignes de PAR le long du podium, lyres en bout de podium pour les poses, chase de passage.',
  highlights: ['Projecteurs disposés le long du podium', 'Chase qui accompagne le passage', 'Blanc neutre pour la photo'],
  bpm: 120, stage: [6, 20],
  rigs: [
    { prefix: 'PODG', label: 'Podium jardin', profile: 'demo-par-rgbw', mode: '6ch DRGBW+Strobe', count: 10, y: 0, height: 5, alongDepth: true, span: -0.35, color: '#F8FAFC' },
    { prefix: 'PODC', label: 'Podium cour', profile: 'demo-par-rgbw', mode: '6ch DRGBW+Strobe', count: 10, y: 0, height: 5, alongDepth: true, span: 0.35, color: '#E2E8F0' },
    { prefix: 'POSE', label: 'Lyres de pose', profile: 'demo-spot', mode: '13ch étendu', count: 4, y: 1, height: 6, span: 0.8, color: '#A78BFA' },
    { prefix: 'FOND', label: 'Fond de scène', profile: 'demo-led-bar-4', mode: '14ch pixels', count: 4, y: 19.5, height: 0.5, span: 0.9, color: '#F472B6' },
  ],
  looks: [
    { name: 'Entrée public', parts: [{ rigs: ['FOND'], colors: [C.violet], level: 0.4 }] },
    { name: 'Ouverture', parts: [{ rigs: ['FOND'], colors: [C.white], level: 1 }, { rigs: ['POSE'], colors: [C.white], level: 0.8, tilt: 0.7 }] },
    { name: 'Passage blanc', parts: [{ rigs: ['PODG', 'PODC'], colors: [C.white], level: 0.9 }, { rigs: ['POSE'], colors: [C.white], level: 0.9, tilt: 0.75 }] },
    { name: 'Collection couleur', parts: [{ rigs: ['PODG', 'PODC'], colors: [C.warm], level: 0.8 }, { rigs: ['FOND'], colors: [C.orange, C.magenta], level: 0.7 }] },
    { name: 'Final', parts: [{ rigs: ['PODG', 'PODC', 'FOND'], colors: [C.white, C.gold], level: 1 }, { rigs: ['POSE'], colors: [C.gold], level: 1, tilt: 0.6 }] },
  ],
  effects: [{ name: 'Chase podium', type: 'chase', rigs: ['PODG', 'PODC'], params: { bpmSync: true, beatsPerCycle: 8, phaseSpread: 1, width: 3 }, blend: 'scale' }],
  cueLists: [{ name: 'Défilé', cues: [
    { name: 'Entrée public', look: 'Entrée public', fade: 3 },
    { name: 'Ouverture', look: 'Ouverture', fade: 0 },
    { name: 'Premier passage', look: 'Passage blanc', fade: 1, effects: ['Chase podium'] },
    { name: 'Collection', look: 'Collection couleur', fade: 3 },
    { name: 'Final — salut créatrice', look: 'Final', fade: 1 },
  ] }],
  notes: 'Démo : plateau de 6 × 20 m pour représenter le podium (positions le long de la profondeur).',
};

const gospel: DemoSpec = {
  id: 'gospel', name: 'Chœur Lumière — concert en église', venue: 'Église Saint-Martin (nef, 500 places)', show: 'Concert de Noël du chœur « Lumière » (fictif)', category: 'Concert',
  description: 'Concert en église : lumière douce et chaude, mise en valeur de l’architecture, crescendo final.',
  highlights: ['Piliers éclairés en uplight', 'Transitions lentes', 'Crescendo final enchaîné automatiquement'],
  bpm: 80, stage: [10, 14],
  rigs: [
    { prefix: 'CHOEUR', label: 'Face chœur', profile: 'demo-par-rgbw', mode: '6ch DRGBW+Strobe', count: 6, y: -2, height: 5, color: '#FBBF24' },
    { prefix: 'PILIER', label: 'Piliers', profile: 'demo-par-rgb', mode: '5ch DRGB+Strobe', count: 8, y: 7, height: 0.3, color: '#A78BFA' },
    { prefix: 'VOUTE', label: 'Voûte', profile: 'demo-wash', mode: '13ch', count: 2, y: 12, height: 1, span: 0.4, color: '#60A5FA' },
  ],
  looks: [
    { name: 'Recueillement', parts: [{ rigs: ['PILIER'], colors: [C.navy, C.violet], level: 0.4 }, { rigs: ['VOUTE'], colors: [C.blue], level: 0.4, tilt: 0.2 }] },
    { name: 'Chœur', parts: [{ rigs: ['CHOEUR'], colors: [C.warm], level: 0.7 }, { rigs: ['PILIER'], colors: [C.amber], level: 0.5 }] },
    { name: 'Soliste', parts: [{ rigs: ['CHOEUR'], colors: [C.warm], level: 0.3 }, { rigs: ['PILIER'], colors: [C.violet], level: 0.3 }] },
    { name: 'Crescendo', parts: [{ rigs: ['CHOEUR'], colors: [C.warm], level: 1 }, { rigs: ['PILIER'], colors: [C.gold], level: 0.9 }, { rigs: ['VOUTE'], colors: [C.gold], level: 0.9, tilt: 0.2 }] },
  ],
  effects: [{ name: 'Respiration piliers', type: 'pulse', rigs: ['PILIER'], params: { speed: 0.1, offset: 0.7, amplitude: 0.3, phaseSpread: 0.5 }, blend: 'scale' }],
  cueLists: [{ name: 'Concert', cues: [
    { name: 'Entrée', look: 'Recueillement', fade: 6, effects: ['Respiration piliers'] },
    { name: 'Premier chant', look: 'Chœur', fade: 8 },
    { name: 'Soliste', look: 'Soliste', fade: 5 },
    { name: 'Montée finale', look: 'Chœur', fade: 4, follow: 20, description: 'Enchaîne seul sur le crescendo après 20 s' },
    { name: 'Crescendo', look: 'Crescendo', fade: 15 },
  ] }],
  notes: 'Démo : le cue « Montée finale » enchaîne seul sur le crescendo après 20 s.',
};

const gala: DemoSpec = {
  id: 'gala-danse', name: 'Gala de l’école de danse Arabesque', venue: 'Salle des fêtes municipale (450 places)', show: 'Gala de fin d’année (fictif)', category: 'Spectacle',
  description: 'Gala amateur : un look par tableau, poursuite simulée par une lyre, conduite simple pour un bénévole.',
  highlights: ['12 cues, un par tableau', 'Lyre « poursuite » centrée', 'Kit modeste, idéal pour débuter'],
  bpm: 112, stage: [10, 7],
  rigs: [
    { prefix: 'FACE', label: 'Face', profile: 'demo-par-rgbw', mode: '6ch DRGBW+Strobe', count: 6, y: -2, height: 5, color: '#FBBF24' },
    { prefix: 'CONTRE', label: 'Contre', profile: 'demo-par-rgb', mode: '5ch DRGB+Strobe', count: 6, y: 6, height: 5, color: '#60A5FA' },
    { prefix: 'POURSUITE', label: 'Poursuite', profile: 'demo-spot', mode: '13ch étendu', count: 1, y: -4, height: 6, span: 0, color: '#F8FAFC' },
  ],
  looks: [
    { name: 'Classique', parts: [{ rigs: ['FACE'], colors: ['#E0E8FF'], level: 0.7 }, { rigs: ['CONTRE'], colors: [C.blue], level: 0.6 }] },
    { name: 'Jazz', parts: [{ rigs: ['FACE'], colors: [C.warm], level: 0.7 }, { rigs: ['CONTRE'], colors: [C.red, C.amber], level: 0.8 }] },
    { name: 'Hip-hop', parts: [{ rigs: ['FACE'], colors: [C.white], level: 0.6 }, { rigs: ['CONTRE'], colors: [C.green, C.magenta], level: 1 }] },
    { name: 'Contemporain', parts: [{ rigs: ['CONTRE'], colors: [C.teal], level: 0.7 }, { rigs: ['POURSUITE'], colors: [C.white], level: 0.8, tilt: 0.7 }] },
    { name: 'Solo poursuite', parts: [{ rigs: ['FACE'], colors: [C.warm], level: 0.15 }, { rigs: ['POURSUITE'], colors: [C.white], level: 1, tilt: 0.72 }] },
    { name: 'Salut général', parts: [{ rigs: ['FACE', 'CONTRE'], colors: [C.warm], level: 1 }] },
  ],
  effects: [{ name: 'Chase hip-hop', type: 'chase', rigs: ['CONTRE'], params: { bpmSync: true, beatsPerCycle: 1, phaseSpread: 1 }, blend: 'scale' }],
  cueLists: [{ name: 'Gala', cues: [
    { name: 'Ouverture rideau', look: 'Classique', fade: 4 },
    { name: 'Tableau 1 — classique petits', look: 'Classique', fade: 2 },
    { name: 'Tableau 2 — jazz', look: 'Jazz', fade: 2 },
    { name: 'Tableau 3 — solo', look: 'Solo poursuite', fade: 3 },
    { name: 'Tableau 4 — hip-hop', look: 'Hip-hop', fade: 0.5, effects: ['Chase hip-hop'] },
    { name: 'Entracte', look: null, fade: 5 },
    { name: 'Tableau 5 — contemporain', look: 'Contemporain', fade: 6 },
    { name: 'Tableau 6 — classique grands', look: 'Classique', fade: 3 },
    { name: 'Tableau 7 — jazz final', look: 'Jazz', fade: 2 },
    { name: 'Tableau 8 — solo professeur', look: 'Solo poursuite', fade: 3 },
    { name: 'Salut général', look: 'Salut général', fade: 1 },
    { name: 'Noir final', look: null, fade: 4 },
  ] }],
  notes: 'Démo : conduite simple, idéale pour une prise en main.',
};

export const DEMOS: DemoSpec[] = [club, pop, theatre, wedding, conference, jazz, festival, runway, gospel, gala];
