import { hostname } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, nativeTheme, session, shell } from 'electron';
import { IPC } from '../shared/ipc.js';
import type { ServerInfo, Settings } from '../shared/types.js';
import { RendererBridge, type CommandResult } from './bridge.js';
import { CaptureStore } from './captures.js';
import { AppHub } from './hub.js';
import { startMcpHttp, type McpHttp } from './mcp/http.js';
import { createMcpServer } from './mcp/tools.js';
import { lanAddresses } from './net.js';
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
let photos: CaptureStore;
let http: McpHttp | null = null;
let serverInfo: ServerInfo = { running: false, port: 0, url: '', addresses: [], hostname: '', network: true };

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

async function startServer(preferredPort: number, network: boolean): Promise<void> {
  if (http) {
    await http.close();
    http = null;
  }
  const version = app.getVersion();
  const host = process.env['ELECTROSCOPE_HOST'] ?? (network ? '0.0.0.0' : '127.0.0.1');
  const addresses = lanAddresses();
  let lastError = '';
  // The preferred port and the next nine, then any free port: some machines keep large port blocks
  // unavailable, and a working server on an unusual port beats none (the app shows the live URL).
  const candidates = preferredPort === 0 ? [0] : [...Array.from({ length: 10 }, (_, i) => preferredPort + i), 0];
  for (const port of candidates) {
    try {
      http = await startMcpHttp({
        port,
        host,
        version,
        createServer: () => createMcpServer(bridge, hub, version),
      });
      const open = host !== '127.0.0.1';
      publishServerInfo({
        running: true,
        port: http.port,
        url: `http://${open ? (addresses[0] ?? '127.0.0.1') : '127.0.0.1'}:${http.port}/mcp`,
        addresses,
        hostname: hostname(),
        network: open,
        error: '',
      });
      return;
    } catch (e) {
      lastError = (e as Error).message;
    }
  }
  publishServerInfo({ running: false, port: preferredPort, url: '', addresses, hostname: hostname(), network, error: lastError });
}

async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const before = store.get();
  const next = await store.patch(patch);
  if (patch.theme) nativeTheme.themeSource = next.theme;
  if (next.port !== before.port || next.network !== before.network) await startServer(next.port, next.network);
  toRenderer(IPC.settingsChanged, next);
  return next;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 580,
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
  ipcMain.handle(IPC.savePhoto, (_e, data: Uint8Array, mimeType: string) => photos.save(data, mimeType, 'photo'));
  ipcMain.handle(IPC.openPhotos, async () => {
    await shell.openPath(photos.dir);
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

    photos = new CaptureStore(join(app.getPath('pictures'), 'Electroscope'), 100_000);
    hub = new AppHub(new CaptureStore(join(app.getPath('userData'), 'captures'), 200), photos);

    // Only our own bundled page may use the camera.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      callback(permission === 'media' && wc === win?.webContents);
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => {
      return permission === 'media' && (!wc || wc === win?.webContents);
    });

    registerIpc();
    await startServer(
      process.env['ELECTROSCOPE_PORT'] ? Number(process.env['ELECTROSCOPE_PORT']) : settings.port,
      settings.network,
    );
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    void http?.close();
  });
}
