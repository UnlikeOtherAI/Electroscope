import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, nativeTheme, session, shell } from 'electron';
import { IPC } from '../shared/ipc.js';
import type { CaptureResult, ServerInfo, Settings } from '../shared/types.js';
import { RendererBridge, type CommandResult } from './bridge.js';
import { CaptureStore } from './captures.js';
import { AppHub } from './hub.js';
import { startMcpHttp, type McpHttp } from './mcp/http.js';
import { createMcpServer } from './mcp/tools.js';
import { SettingsStore } from './store.js';

const isMac = process.platform === 'darwin';
const useFakeCamera = process.env['ELECTROSCOPE_FAKE_CAMERA'] === '1';

// Frames must keep flowing while the human works in another window (a terminal, a schematic).
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
if (useFakeCamera) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}
if (process.env['ELECTROSCOPE_USER_DATA']) {
  app.setPath('userData', process.env['ELECTROSCOPE_USER_DATA']);
}

let win: BrowserWindow | null = null;
let store: SettingsStore;
let hub: AppHub;
let http: McpHttp | null = null;
let serverInfo: ServerInfo = { running: false, port: 0, url: '', clients: [] };

const bridge = new RendererBridge((envelope) => {
  if (!win || win.isDestroyed()) return false;
  win.webContents.send(IPC.command, envelope);
  return true;
});

function toRenderer(channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function publishServerInfo(patch: Partial<ServerInfo> = {}): void {
  serverInfo = { ...serverInfo, ...patch };
  toRenderer(IPC.serverInfo, serverInfo);
}

async function startServer(preferredPort: number): Promise<void> {
  if (http) {
    await http.close();
    http = null;
  }
  const version = app.getVersion();
  let lastError = '';
  // The preferred port and the next nine, then any free port: some machines keep large port blocks
  // unavailable, and a working server on an unusual port beats none (the app shows the live URL).
  const candidates = preferredPort === 0 ? [0] : [...Array.from({ length: 10 }, (_, i) => preferredPort + i), 0];
  for (const port of candidates) {
    try {
      http = await startMcpHttp({
        port,
        version,
        createServer: () => createMcpServer(bridge, hub, version),
        onClientsChanged: (clients) => publishServerInfo({ clients }),
      });
      publishServerInfo({ running: true, port: http.port, url: http.url, clients: [], error: '' });
      return;
    } catch (e) {
      lastError = (e as Error).message;
    }
  }
  publishServerInfo({ running: false, port: preferredPort, url: '', error: lastError });
}

async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const before = store.get();
  const next = await store.patch(patch);
  if (patch.theme) nativeTheme.themeSource = next.theme;
  if (patch.port !== undefined && patch.port !== before.port) await startServer(next.port);
  toRenderer(IPC.settingsChanged, next);
  return next;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: 'Electroscope',
    icon: join(__dirname, '../icon.png'),
    backgroundColor: '#00000000',
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, vibrancy: 'under-window' as const, trafficLightPosition: { x: 16, y: 14 } }
      : {
          backgroundMaterial: 'mica' as const,
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: 44 },
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  const updateOverlay = () => {
    if (isMac || !win || win.isDestroyed()) return;
    win.setTitleBarOverlay({
      color: '#00000000',
      symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#1b1b1b',
      height: 44,
    });
  };
  nativeTheme.on('updated', updateOverlay);

  win.once('ready-to-show', () => {
    updateOverlay();
    win?.show();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => {
    win = null;
  });
  void win.loadFile(join(__dirname, '../renderer/index.html'));
}

function registerIpc(): void {
  ipcMain.handle(IPC.getSettings, () => store.get());
  ipcMain.handle(IPC.patchSettings, (_e, patch: Partial<Settings>) => patchSettings(patch));
  ipcMain.handle(IPC.getServerInfo, () => serverInfo);
  ipcMain.handle(IPC.getActivity, () => hub.listActivity());
  ipcMain.handle(IPC.clearActivity, () => hub.clearActivity());
  ipcMain.handle(IPC.getShared, () => hub.sharedCount());
  ipcMain.handle(IPC.shareFrame, async (_e, result: CaptureResult, note: string) => {
    const entry = await hub.addShared(result, note);
    return { path: entry.path, count: hub.sharedCount() };
  });
  ipcMain.handle(IPC.saveCapture, async (_e, data: Uint8Array, mimeType: string) => {
    const store = new CaptureStore(join(app.getPath('pictures'), 'Electroscope'), 100_000);
    return store.save(data, mimeType, 'capture');
  });
  ipcMain.handle(IPC.openCaptures, async () => {
    await shell.openPath(join(app.getPath('pictures'), 'Electroscope'));
  });
  ipcMain.handle(IPC.revealFile, (_e, path: string) => {
    shell.showItemInFolder(path);
  });
  ipcMain.on(IPC.rendererReady, () => bridge.rendererReady());
  ipcMain.on(IPC.commandResult, (_e, msg: CommandResult) => bridge.handleResult(msg));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    app.setAppUserModelId('ai.unlikeother.electroscope');
    store = SettingsStore.at(app.getPath('userData'));
    const settings = await store.load();
    nativeTheme.themeSource = settings.theme;

    hub = new AppHub(
      () => store.get().claudeAccess,
      new CaptureStore(join(app.getPath('userData'), 'captures'), 200),
      new CaptureStore(join(app.getPath('userData'), 'shared'), 200),
      {
        activityAdded: (entry) => toRenderer(IPC.activityAdded, entry),
        claudeCapturing: (tool) => toRenderer(IPC.claudeCapturing, tool),
      },
    );

    // Only our own bundled page may use the camera.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      callback(permission === 'media' && wc === win?.webContents);
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => {
      return permission === 'media' && (!wc || wc === win?.webContents);
    });

    registerIpc();
    await startServer(process.env['ELECTROSCOPE_PORT'] ? Number(process.env['ELECTROSCOPE_PORT']) : settings.port);
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    void http?.close();
  });
}
