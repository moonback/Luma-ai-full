/** Attribute classes drive merge rules, blackout policy and UI control generation. */
export type AttributeClass = 'intensity' | 'color' | 'position' | 'beam' | 'special';

const CLASS: Record<string, AttributeClass> = {
  dimmer: 'intensity',
  red: 'color', green: 'color', blue: 'color', white: 'color', amber: 'color', uv: 'color',
  cyan: 'color', magenta: 'color', yellow: 'color', cto: 'color', colorWheel: 'color',
  warmWhite: 'color', coldWhite: 'color', lime: 'color', indigo: 'color',
  colorTemperature: 'color', colorMacro: 'color', colorMacroFade: 'color',
  pan: 'position', tilt: 'position', panTiltSpeed: 'position', panTiltMode: 'position',
  shutter: 'beam', strobe: 'beam', gobo: 'beam', goboRotation: 'beam', prism: 'beam',
  focus: 'beam', zoom: 'beam', iris: 'beam', frost: 'beam', effectWheel: 'beam', zoomMode: 'beam',
  gobo2: 'beam', gobo2Rotation: 'beam', prismIndex: 'beam', prismRotation: 'beam',
  speed: 'special', macro: 'special', control: 'special', macroSpeed: 'special', fog: 'special', fan: 'special', dimmerCurve: 'special',
};

/**
 * Multi-cell fixtures (LED bars, pixel battens) expose the same attribute once per cell.
 * Their value key is "<attribute>#<cell>" (e.g. "red#3"); single-cell attributes keep the bare name.
 */
export const cellKey = (attr: string, cell?: number): string => (cell ? `${attr}#${cell}` : attr);
export const baseAttribute = (key: string): string => {
  const i = key.indexOf('#');
  return i < 0 ? key : key.slice(0, i);
};
export const cellOf = (key: string): number | undefined => {
  const i = key.indexOf('#');
  return i < 0 ? undefined : Number(key.slice(i + 1));
};

export function attributeClass(attr: string): AttributeClass {
  return CLASS[baseAttribute(attr)] ?? 'special';
}

/** Additive emitters that the virtual dimmer scales when a fixture has no dimmer channel. */
export const EMITTER_ATTRIBUTES = ['red', 'green', 'blue', 'white', 'amber', 'uv', 'warmWhite', 'coldWhite', 'lime', 'indigo'] as const;

export const ATTRIBUTE_LABELS: Record<string, string> = {
  dimmer: 'Intensité', red: 'Rouge', green: 'Vert', blue: 'Bleu', white: 'Blanc', amber: 'Ambre', uv: 'UV',
  cyan: 'Cyan', magenta: 'Magenta', yellow: 'Jaune', cto: 'CTO', colorWheel: 'Roue couleurs',
  warmWhite: 'Blanc chaud', coldWhite: 'Blanc froid', lime: 'Lime', indigo: 'Indigo',
  colorTemperature: 'Température de couleur', colorMacro: 'Macro couleur', colorMacroFade: 'Fondu macro couleur',
  pan: 'Pan', tilt: 'Tilt', panTiltSpeed: 'Vitesse P/T', panTiltMode: 'Mode P/T',
  shutter: 'Shutter', strobe: 'Strobe', gobo: 'Gobo', goboRotation: 'Rotation gobo', prism: 'Prisme',
  focus: 'Focus', zoom: 'Zoom', iris: 'Iris', frost: 'Frost', effectWheel: 'Roue d’effets', zoomMode: 'Mode zoom',
  gobo2: 'Gobo 2', gobo2Rotation: 'Rotation gobo 2', prismIndex: 'Indexation prisme', prismRotation: 'Rotation prisme',
  speed: 'Vitesse', macro: 'Macro', control: 'Contrôle', macroSpeed: 'Vitesse macro', fog: 'Fumée', fan: 'Ventilateur', dimmerCurve: 'Courbe dimmer',
};

export function attributeLabel(attr: string): string {
  const base = baseAttribute(attr);
  const cell = cellOf(attr);
  const label = ATTRIBUTE_LABELS[base] ?? base.replace(/^custom:/, '');
  return cell ? `${label} ${cell}` : label;
}
