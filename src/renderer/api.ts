import type { CommandInput, CommandResults, CommandType } from '../shared/commands';
import { useStore } from './store';

/** Typed command call. Errors are shown as a toast and re-thrown. */
export async function call<T extends CommandType>(cmd: Extract<CommandInput, { type: T }>): Promise<CommandResults[T]> {
  const r = await window.luma.invoke<T>(cmd);
  if (!r.ok) {
    useStore.getState().toast({ kind: 'error', title: 'Action impossible', detail: r.error });
    throw new Error(r.error);
  }
  return r.data;
}

/** Same as `call` but swallows the (already displayed) error. For fire-and-forget UI actions. */
export async function act<T extends CommandType>(cmd: Extract<CommandInput, { type: T }>): Promise<CommandResults[T] | undefined> {
  try {
    return await call(cmd);
  } catch {
    return undefined;
  }
}

export const newId = (): string => crypto.randomUUID();
