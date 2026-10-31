import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipc.js';
import type { ActivityEntry, CaptureResult, ServerInfo, Settings } from '../shared/types.js';

type Unsubscribe = () => void;

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  platform: process.platform,
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.getSettings),
  patchSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(IPC.patchSettings, patch),
  getServerInfo: (): Promise<ServerInfo> => ipcRenderer.invoke(IPC.getServerInfo),
  getActivity: (): Promise<ActivityEntry[]> => ipcRenderer.invoke(IPC.getActivity),
  clearActivity: (): Promise<void> => ipcRenderer.invoke(IPC.clearActivity),
  shareFrame: (result: CaptureResult, note: string): Promise<{ path: string; count: number }> =>
    ipcRenderer.invoke(IPC.shareFrame, result, note),
  saveCapture: (data: Uint8Array, mimeType: string): Promise<string> =>
    ipcRenderer.invoke(IPC.saveCapture, data, mimeType),
  openCaptures: (): Promise<void> => ipcRenderer.invoke(IPC.openCaptures),
  revealFile: (path: string): Promise<void> => ipcRenderer.invoke(IPC.revealFile, path),
  ready: (): void => ipcRenderer.send(IPC.rendererReady),
  sendCommandResult: (msg: unknown): void => ipcRenderer.send(IPC.commandResult, msg),
  onCommand: (cb: (envelope: { id: string; name: string; args: unknown }) => void) => on(IPC.command, cb),
  onServerInfo: (cb: (info: ServerInfo) => void) => on<ServerInfo>(IPC.serverInfo, cb),
  onActivity: (cb: (entry: ActivityEntry) => void) => on<ActivityEntry>(IPC.activityAdded, cb),
  onSettings: (cb: (s: Settings) => void) => on<Settings>(IPC.settingsChanged, cb),
  onClaudeCapturing: (cb: (tool: string) => void) => on<string>(IPC.claudeCapturing, cb),
};

export type ElectroscopeApi = typeof api;

contextBridge.exposeInMainWorld('electroscope', api);
