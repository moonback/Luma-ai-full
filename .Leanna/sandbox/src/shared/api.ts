import type { AppEvents, CommandInput, CommandResponse, CommandType } from './commands';

export interface LumaApi {
  invoke<T extends CommandType>(cmd: Extract<CommandInput, { type: T }>): Promise<CommandResponse<T>>;
  on(listener: <K extends keyof AppEvents>(name: K, payload: AppEvents[K]) => void): () => void;
}

declare global {
  interface Window {
    luma: LumaApi;
  }
}
