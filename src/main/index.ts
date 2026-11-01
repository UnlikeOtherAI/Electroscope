import { hostname } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, nativeTheme, screen, session, shell } from 'electron';
import { IPC } from '../shared/ipc.js';
import type { ActivityEvent, ClientInfo, ServerInfo, Settings, WindowBounds } from '../shared/types.js';
import { RendererBridge, type CommandResult } from './bridge.js';
import { CaptureStore } from './captures.js';
import { AppHub } from './hub.js';
import { buildMenu } from './menu.js';
import { startMcpHttp, type McpHttp } from './mcp/http.js';
import { createMcpServer } from './mcp/tools.js';
import { lanAddresses } from './net.js';
import { SettingsStore } from './store.js';

const isMac = process.platform === 'darwin';
const useFakeCamera = process.env['ELECTROSCOPE_FAKE_CAMERA'] === '1';

/** Matches the CSS title bar height; the Windows caption buttons are drawn to it. */
const TITLEBAR_HEIGHT = 52;

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
let clients: ClientInfo[] = [];

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

function publishClients(list: ClientInfo[]): void {
  clients = list;
  toRenderer(IPC.clientsChanged, clients);
}

function publishActivity(event: ActivityEvent): void {
  toRenderer(IPC.activity, event);
}

async function startServer(preferredPort: number, network: boolean): Promise<void> {
  if (http) {
    await http.close();
    http = null;
  }
  publishClients([]);
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
        createServer: (client) => createMcpServer(bridge, hub, version, client),
        onClientsChanged: publishClients,
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

/** A saved position is only used when it still lands on a display that exists now. */
function placeWindow(saved: WindowBounds | null): Electron.BrowserWindowConstructorOptions {
  const size = { width: saved?.width ?? 1440, height: saved?.height ?? 900 };
  if (saved?.x === undefined || saved.y === undefined) return size;
  const area = screen.getDisplayMatching({ ...size, x: saved.x, y: saved.y }).workArea;
  const onScreen =
    saved.x + size.width > area.x + 80 &&
    saved.x < area.x + area.width - 80 &&
    saved.y >= area.y - 1 &&
    saved.y < area.y + area.height - 60;
  return onScreen ? { ...size, x: saved.x, y: saved.y } : size;
}

function createWindow(saved: WindowBounds | null): void {
  win = new BrowserWindow({
    ...placeWindow(saved),
    minWidth: 1040,
    minHeight: 640,
    show: false,
    title: 'Electroscope',
    icon: join(__dirname, '../icon.png'),
    backgroundColor: '#00000000',
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          vibrancy: 'under-window' as const,
          trafficLightPosition: { x: 18, y: 18 },
        }
      : {
          backgroundMaterial: 'mica' as const,
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: TITLEBAR_HEIGHT },
        }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  if (saved?.maximized) win.maximize();

  const updateOverlay = () => {
    if (isMac || !win || win.isDestroyed()) return;
    win.setTitleBarOverlay({
      color: '#00000000',
      symbolColor: nativeTheme.shouldUseDarkColors ? '#f2f4f8' : '#1c2128',
      height: TITLEBAR_HEIGHT,
    });
  };
  nativeTheme.on('updated', updateOverlay);

  // The window remembers where it was, but only once the user stops moving it.
  let saveTimer: NodeJS.Timeout | undefined;
  const rememberBounds = () => {
    if (!win || win.isDestroyed()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const maximized = win.isMaximized();
      const b = maximized ? win.getNormalBounds() : win.getBounds();
      void store.patch({ window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized } }).catch(() => undefined);
    }, 400);
  };
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);
  win.on('maximize', rememberBounds);
  win.on('unmaximize', rememberBounds);

  const sendWindowState = () => toRenderer(IPC.menu, { action: win?.isMaximized() ? 'window-maximized' : 'window-restored' });
  win.on('maximize', sendWindowState);
  win.on('unmaximize', sendWindowState);
  win.on('enter-full-screen', () => toRenderer(IPC.menu, { action: 'window-fullscreen' }));
  win.on('leave-full-screen', () => toRenderer(IPC.menu, { action: 'window-restored' }));

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
    clearTimeout(saveTimer);
    nativeTheme.off('updated', updateOverlay);
    win = null;
  });
  void win.loadFile(join(__dirname, '../renderer/index.html'));
}

function registerIpc(): void {
  ipcMain.handle(IPC.getSettings, () => store.get());
  ipcMain.handle(IPC.patchSettings, (_e, patch: Partial<Settings>) => patchSettings(patch));
  ipcMain.handle(IPC.getServerInfo, () => serverInfo);
  ipcMain.handle(IPC.getClients, () => clients);
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
    hub = new AppHub(new CaptureStore(join(app.getPath('userData'), 'captures'), 200), photos, publishActivity);

    // Only our own bundled page may use the camera.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      callback(permission === 'media' && wc === win?.webContents);
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => {
      return permission === 'media' && (!wc || wc === win?.webContents);
    });

    registerIpc();
    buildMenu({
      send: (action) => toRenderer(IPC.menu, { action }),
      openPhotos: () => void shell.openPath(photos.dir),
      openDocs: () => void shell.openExternal('https://github.com/UnlikeOtherAI/Electroscope/blob/main/docs/mcp.md'),
    });
    await startServer(
      process.env['ELECTROSCOPE_PORT'] ? Number(process.env['ELECTROSCOPE_PORT']) : settings.port,
      settings.network,
    );
    createWindow(settings.window);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    void http?.close();
  });
}
