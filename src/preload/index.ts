import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipc.js';
import type { ActivityEvent, CameraAccess, ClientInfo, ServerInfo, Settings } from '../shared/types.js';

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
  getClients: (): Promise<ClientInfo[]> => ipcRenderer.invoke(IPC.getClients),
  getCameraAccess: (): Promise<CameraAccess> => ipcRenderer.invoke(IPC.getCameraAccess),
  openCameraSettings: (): Promise<void> => ipcRenderer.invoke(IPC.openCameraSettings),
  savePhoto: (data: Uint8Array, mimeType: string): Promise<string> => ipcRenderer.invoke(IPC.savePhoto, data, mimeType),
  openPhotos: (): Promise<void> => ipcRenderer.invoke(IPC.openPhotos),
  ready: (): void => ipcRenderer.send(IPC.rendererReady),
  sendCommandResult: (msg: unknown): void => ipcRenderer.send(IPC.commandResult, msg),
  onCommand: (cb: (envelope: { id: string; name: string; args: unknown }) => void) => on(IPC.command, cb),
  onServerInfo: (cb: (info: ServerInfo) => void) => on<ServerInfo>(IPC.serverInfo, cb),
  onSettings: (cb: (s: Settings) => void) => on<Settings>(IPC.settingsChanged, cb),
  onClients: (cb: (clients: ClientInfo[]) => void) => on<ClientInfo[]>(IPC.clientsChanged, cb),
  onActivity: (cb: (event: ActivityEvent) => void) => on<ActivityEvent>(IPC.activity, cb),
  onCameraAccess: (cb: (access: CameraAccess) => void) => on<CameraAccess>(IPC.cameraAccess, cb),
  onMenu: (cb: (msg: { action: string }) => void) => on<{ action: string }>(IPC.menu, cb),
};

export type ElectroscopeApi = typeof api;

contextBridge.exposeInMainWorld('electroscope', api);
