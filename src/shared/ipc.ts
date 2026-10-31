/** IPC channel names. */
export const IPC = {
  // renderer -> main (invoke / send)
  getSettings: 'settings:get',
  patchSettings: 'settings:patch',
  getServerInfo: 'server:info',
  savePhoto: 'photo:save',
  openPhotos: 'photo:open-folder',
  rendererReady: 'renderer:ready',
  commandResult: 'command:result',
  // main -> renderer (send)
  command: 'command:run',
  serverInfo: 'server:info:update',
  settingsChanged: 'settings:changed',
} as const;
