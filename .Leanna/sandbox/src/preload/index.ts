import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { LumaApi } from '../shared/api';

// Minimal, typed surface: one command channel and one event channel. No Node API reaches the renderer.
const api: LumaApi = {
  invoke: (cmd) => ipcRenderer.invoke('luma:cmd', cmd),
  on: (listener) => {
    const handler = (_e: IpcRendererEvent, name: string, payload: unknown) => listener(name as never, payload as never);
    ipcRenderer.on('luma:event', handler);
    return () => ipcRenderer.removeListener('luma:event', handler);
  },
};

contextBridge.exposeInMainWorld('luma', api);
