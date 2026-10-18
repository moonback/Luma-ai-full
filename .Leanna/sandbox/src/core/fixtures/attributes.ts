/** Attribute classes drive merge rules, blackout policy and UI control generation. */
export type AttributeClass = 'intensity' | 'color' | 'position' | 'beam' | 'special';

const CLASS: Record<string, AttributeClass> = {
  dimmer: 'intensity',
  red: 'color', green: 'color', blue: 'color', white: 'color', amber: 'color', uv: 'color',
  cyan: 'color', magenta: 'color', yellow: 'color', cto: 'color', colorWheel: 'color',
  pan: 'position', tilt: 'position', panTiltSpeed: 'position',
  shutter: 'beam', strobe: 'beam', gobo: 'beam', goboRotation: 'beam', prism: 'beam',
  focus: 'beam', zoom: 'beam', iris: 'beam', frost: 'beam',
  speed: 'special', macro: 'special', control: 'special',
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
export const EMITTER_ATTRIBUTES = ['red', 'green', 'blue', 'white', 'amber', 'uv'] as const;

export const ATTRIBUTE_LABELS: Record<string, string> = {
  dimmer: 'Intensité', red: 'Rouge', green: 'Vert', blue: 'Bleu', white: 'Blanc', amber: 'Ambre', uv: 'UV',
  cyan: 'Cyan', magenta: 'Magenta', yellow: 'Jaune', cto: 'CTO', colorWheel: 'Roue couleurs',
  pan: 'Pan', tilt: 'Tilt', panTiltSpeed: 'Vitesse P/T',
  shutter: 'Shutter', strobe: 'Strobe', gobo: 'Gobo', goboRotation: 'Rotation gobo', prism: 'Prisme',
  focus: 'Focus', zoom: 'Zoom', iris: 'Iris', frost: 'Frost', speed: 'Vitesse', macro: 'Macro', control: 'Contrôle',
};

export function attributeLabel(attr: string): string {
  const base = baseAttribute(attr);
  const cell = cellOf(attr);
  const label = ATTRIBUTE_LABELS[base] ?? base.replace(/^custom:/, '');
  return cell ? `${label} ${cell}` : label;
}
