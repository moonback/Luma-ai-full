import { resolveShortcuts, type ShortcutAction } from '../core/settings/settings';

const KEY_NAMES: Record<string, string> = { ' ': 'Space', Esc: 'Escape', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/** Normalized combo for a keyboard event ("Ctrl+Shift+S"), or null for a lone modifier key. */
export function comboFromEvent(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string | null {
  if (MODIFIERS.has(e.key)) return null;
  let key = KEY_NAMES[e.key] ?? e.key;
  if (key.length === 1) key = key.toUpperCase();
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && key.length > 1) parts.push('Shift'); // Shift is part of the character for printable keys…
  else if (e.shiftKey && /^[A-Z0-9]$/.test(key)) parts.push('Shift'); // …except letters/digits
  parts.push(key);
  return parts.join('+');
}

export function bindingsFrom(overrides: Record<string, string> | undefined): Map<string, ShortcutAction> {
  const map = new Map<string, ShortcutAction>();
  for (const [id, combo] of Object.entries(resolveShortcuts(overrides ?? {}))) if (combo && !map.has(combo)) map.set(combo, id as ShortcutAction);
  return map;
}

/** Bare keys (no Ctrl/Alt) must not fire while the user types in a field; Shift+Escape (STOP) always works. */
export function allowedWhileTyping(combo: string): boolean {
  return combo.startsWith('Ctrl+') || combo.startsWith('Alt+') || combo === 'Shift+Escape';
}
