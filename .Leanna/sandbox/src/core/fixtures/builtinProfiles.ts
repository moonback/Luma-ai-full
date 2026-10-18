import { profileSchema, type FixtureProfile } from '../model/schemas';

/**
 * FICTIONAL demo profiles for development, tests and demos.
 * They do NOT describe any commercial fixture and are flagged `fictional: true` everywhere in the UI.
 */
const raw = [
  {
    id: 'demo-par-rgb',
    name: 'Demo PAR RGB',
    manufacturer: 'Luma Demo (fictif)',
    type: 'par',
    fictional: true,
    physical: { panRange: 0, tiltRange: 0, beamAngle: 25 },
    modes: [
      {
        name: '3ch RGB',
        channels: [
          { name: 'Rouge', attribute: 'red' },
          { name: 'Vert', attribute: 'green' },
          { name: 'Bleu', attribute: 'blue' },
        ],
      },
      {
        name: '5ch DRGB+Strobe',
        channels: [
          { name: 'Dimmer', attribute: 'dimmer' },
          { name: 'Rouge', attribute: 'red' },
          { name: 'Vert', attribute: 'green' },
          { name: 'Bleu', attribute: 'blue' },
          {
            name: 'Strobe', attribute: 'strobe',
            ranges: [
              { from: 0, to: 9, label: 'Pas de strobe', kind: 'open' },
              { from: 10, to: 255, label: 'Strobe lent → rapide', kind: 'strobe' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'demo-par-rgbw',
    name: 'Demo PAR RGBW',
    manufacturer: 'Luma Demo (fictif)',
    type: 'par',
    fictional: true,
    physical: { panRange: 0, tiltRange: 0, beamAngle: 30 },
    modes: [
      {
        name: '6ch DRGBW+Strobe',
        channels: [
          { name: 'Dimmer', attribute: 'dimmer' },
          { name: 'Rouge', attribute: 'red' },
          { name: 'Vert', attribute: 'green' },
          { name: 'Bleu', attribute: 'blue' },
          { name: 'Blanc', attribute: 'white' },
          {
            name: 'Strobe', attribute: 'strobe',
            ranges: [
              { from: 0, to: 9, label: 'Pas de strobe', kind: 'open' },
              { from: 10, to: 255, label: 'Strobe lent → rapide', kind: 'strobe' },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'demo-spot',
    name: 'Demo Lyre Spot',
    manufacturer: 'Luma Demo (fictif)',
    type: 'moving-head-spot',
    fictional: true,
    physical: { panRange: 540, tiltRange: 270, beamAngle: 15 },
    modes: [
      {
        name: '13ch étendu',
        channels: [
          { name: 'Pan', attribute: 'pan', default: 128 },
          { name: 'Pan fin', attribute: 'pan', fine: true },
          { name: 'Tilt', attribute: 'tilt', default: 128 },
          { name: 'Tilt fin', attribute: 'tilt', fine: true },
          { name: 'Vitesse P/T', attribute: 'panTiltSpeed' },
          { name: 'Dimmer', attribute: 'dimmer' },
          {
            name: 'Shutter', attribute: 'shutter', default: 8,
            ranges: [
              { from: 0, to: 3, label: 'Fermé', kind: 'closed' },
              { from: 4, to: 7, label: 'Fermé', kind: 'closed' },
              { from: 8, to: 15, label: 'Ouvert', kind: 'open' },
              { from: 16, to: 131, label: 'Strobe lent → rapide', kind: 'strobe' },
              { from: 132, to: 139, label: 'Ouvert', kind: 'open' },
              { from: 140, to: 255, label: 'Strobe aléatoire', kind: 'random' },
            ],
          },
          {
            name: 'Roue couleurs', attribute: 'colorWheel',
            ranges: [
              { from: 0, to: 9, label: 'Blanc', kind: 'color', color: '#FFFFFF' },
              { from: 10, to: 19, label: 'Rouge', kind: 'color', color: '#FF2020' },
              { from: 20, to: 29, label: 'Orange', kind: 'color', color: '#FF8A00' },
              { from: 30, to: 39, label: 'Jaune', kind: 'color', color: '#FFE600' },
              { from: 40, to: 49, label: 'Vert', kind: 'color', color: '#20E040' },
              { from: 50, to: 59, label: 'Cyan', kind: 'color', color: '#00E5FF' },
              { from: 60, to: 69, label: 'Bleu', kind: 'color', color: '#2040FF' },
              { from: 70, to: 79, label: 'Magenta', kind: 'color', color: '#FF20D0' },
              { from: 80, to: 89, label: 'Violet', kind: 'color', color: '#8A2BE2' },
              { from: 90, to: 127, label: 'Rotation', kind: 'rotation' },
              { from: 128, to: 255, label: 'Rotation continue', kind: 'rotation' },
            ],
          },
          {
            name: 'Gobo', attribute: 'gobo',
            ranges: [
              { from: 0, to: 9, label: 'Ouvert', kind: 'open' },
              { from: 10, to: 19, label: 'Gobo 1', kind: 'gobo' },
              { from: 20, to: 29, label: 'Gobo 2', kind: 'gobo' },
              { from: 30, to: 39, label: 'Gobo 3', kind: 'gobo' },
              { from: 40, to: 49, label: 'Gobo 4', kind: 'gobo' },
              { from: 50, to: 127, label: 'Shake', kind: 'shake' },
              { from: 128, to: 255, label: 'Rotation roue', kind: 'rotation' },
            ],
          },
          { name: 'Rotation gobo', attribute: 'goboRotation' },
          { name: 'Prisme', attribute: 'prism', ranges: [{ from: 0, to: 127, label: 'Sans prisme', kind: 'open' }, { from: 128, to: 255, label: 'Prisme 3 facettes', kind: 'other' }] },
          { name: 'Focus', attribute: 'focus', default: 128 },
          {
            name: 'Contrôle', attribute: 'control',
            ranges: [
              { from: 0, to: 99, label: 'Aucune fonction', kind: 'other' },
              { from: 100, to: 149, label: 'Reset (maintenir 3 s)', kind: 'reset', dangerous: true },
              { from: 150, to: 199, label: 'Lampe ON', kind: 'lamp-on' },
              { from: 200, to: 255, label: 'Lampe OFF', kind: 'lamp-off', dangerous: true },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'demo-wash',
    name: 'Demo Lyre Wash',
    manufacturer: 'Luma Demo (fictif)',
    type: 'moving-head-wash',
    fictional: true,
    physical: { panRange: 540, tiltRange: 200, beamAngle: 30 },
    modes: [
      {
        name: '13ch',
        channels: [
          { name: 'Pan', attribute: 'pan', default: 128 },
          { name: 'Pan fin', attribute: 'pan', fine: true },
          { name: 'Tilt', attribute: 'tilt', default: 128 },
          { name: 'Tilt fin', attribute: 'tilt', fine: true },
          { name: 'Vitesse P/T', attribute: 'panTiltSpeed' },
          { name: 'Dimmer', attribute: 'dimmer' },
          {
            name: 'Shutter', attribute: 'shutter', default: 255,
            ranges: [
              { from: 0, to: 9, label: 'Fermé', kind: 'closed' },
              { from: 10, to: 249, label: 'Strobe lent → rapide', kind: 'strobe' },
              { from: 250, to: 255, label: 'Ouvert', kind: 'open' },
            ],
          },
          { name: 'Rouge', attribute: 'red' },
          { name: 'Vert', attribute: 'green' },
          { name: 'Bleu', attribute: 'blue' },
          { name: 'Blanc', attribute: 'white' },
          { name: 'Zoom', attribute: 'zoom', default: 128 },
          {
            name: 'Contrôle', attribute: 'control',
            ranges: [
              { from: 0, to: 199, label: 'Aucune fonction', kind: 'other' },
              { from: 200, to: 255, label: 'Reset (maintenir 3 s)', kind: 'reset', dangerous: true },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'demo-led-bar-4',
    name: 'Demo Barre LED 4 cellules',
    manufacturer: 'Luma Demo (fictif)',
    type: 'led-bar',
    fictional: true,
    physical: { panRange: 0, tiltRange: 0, beamAngle: 25 },
    modes: [
      {
        name: '14ch pixels',
        channels: [
          { name: 'Dimmer', attribute: 'dimmer' },
          {
            name: 'Strobe', attribute: 'strobe',
            ranges: [
              { from: 0, to: 9, label: 'Pas de strobe', kind: 'open' },
              { from: 10, to: 255, label: 'Strobe lent → rapide', kind: 'strobe' },
            ],
          },
          ...[1, 2, 3, 4].flatMap((cell) => [
            { name: `Rouge ${cell}`, attribute: 'red', cell },
            { name: `Vert ${cell}`, attribute: 'green', cell },
            { name: `Bleu ${cell}`, attribute: 'blue', cell },
          ]),
        ],
      },
      {
        name: '4ch DRGB global',
        channels: [
          { name: 'Dimmer', attribute: 'dimmer' },
          { name: 'Rouge', attribute: 'red' },
          { name: 'Vert', attribute: 'green' },
          { name: 'Bleu', attribute: 'blue' },
        ],
      },
    ],
  },
  {
    id: 'demo-strobe',
    name: 'Demo Stroboscope',
    manufacturer: 'Luma Demo (fictif)',
    type: 'strobe',
    fictional: true,
    physical: { panRange: 0, tiltRange: 0, beamAngle: 90 },
    modes: [
      {
        name: '2ch',
        channels: [
          { name: 'Intensité', attribute: 'dimmer' },
          {
            name: 'Fréquence', attribute: 'strobe',
            ranges: [
              { from: 0, to: 9, label: 'Éclair fixe', kind: 'open' },
              { from: 10, to: 255, label: 'Strobe 1 → 20 Hz', kind: 'strobe' },
            ],
          },
        ],
      },
    ],
  },
];

export const BUILTIN_PROFILES: readonly FixtureProfile[] = raw.map((p) => profileSchema.parse(p));
