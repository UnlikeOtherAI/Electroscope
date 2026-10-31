/** IPC channel names. */
export const IPC = {
  // renderer -> main (invoke)
  getSettings: 'settings:get',
  patchSettings: 'settings:patch',
  getServerInfo: 'server:info',
  getActivity: 'activity:list',
  getShared: 'shared:list',
  saveCapture: 'capture:save',
  shareFrame: 'shared:add',
  openCaptures: 'captures:open',
  revealFile: 'captures:reveal',
  clearActivity: 'activity:clear',
  rendererReady: 'renderer:ready',
  commandResult: 'command:result',
  // main -> renderer (send)
  command: 'command:run',
  serverInfo: 'server:info:update',
  activityAdded: 'activity:added',
  settingsChanged: 'settings:changed',
  claudeCapturing: 'claude:capturing',
} as const;
