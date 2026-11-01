import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron';

/** Menu items that act on the live view; the renderer owns the camera, so it does the work. */
export type MenuAction =
  | 'settings'
  | 'copy-prompt'
  | 'save-photo'
  | 'undo'
  | 'clear-marks'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'toggle-grid'
  | 'toggle-crosshair'
  | 'toggle-freeze'
  | 'rotate-cw'
  | 'rotate-ccw'
  | 'mirror'
  | 'rescan-cameras';

export interface MenuHooks {
  send(action: MenuAction): void;
  openPhotos(): void;
  openDocs(): void;
}

const isMac = process.platform === 'darwin';

/**
 * A real menu rather than Electron's default. Everything in the window has a keyboard shortcut
 * here, which is also how the shortcuts become discoverable.
 */
export function buildMenu(hooks: MenuHooks): void {
  /**
   * The window itself handles these keys, so the menu only advertises them. Letting the menu
   * register the accelerator too would fire the action twice, and would take keys like Space
   * away from the page.
   */
  const item = (label: string, accelerator: string | undefined, action: MenuAction): MenuItemConstructorOptions => ({
    label,
    ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
    click: () => hooks.send(action),
  });

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              item('Settings…', 'CmdOrCtrl+,', 'settings'),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: '&File',
      submenu: [
        item('Save Photo', 'CmdOrCtrl+S', 'save-photo'),
        { label: 'Open Photos Folder', accelerator: 'CmdOrCtrl+Shift+O', click: () => hooks.openPhotos() },
        { type: 'separator' },
        item('Copy Prompt for Agent', 'CmdOrCtrl+Shift+C', 'copy-prompt'),
        ...(isMac
          ? ([{ type: 'separator' }, { role: 'close' }] satisfies MenuItemConstructorOptions[])
          : ([
              { type: 'separator' },
              item('Settings…', 'CmdOrCtrl+,', 'settings'),
              { type: 'separator' },
              { role: 'quit' },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      label: '&Edit',
      submenu: [
        item('Undo Last Mark', 'CmdOrCtrl+Z', 'undo'),
        item('Clear All Marks', 'CmdOrCtrl+Shift+Backspace', 'clear-marks'),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '&View',
      submenu: [
        item('Zoom In', 'CmdOrCtrl+Plus', 'zoom-in'),
        item('Zoom Out', 'CmdOrCtrl+-', 'zoom-out'),
        item('Actual Size', 'CmdOrCtrl+0', 'zoom-reset'),
        { type: 'separator' },
        item('Grid', 'CmdOrCtrl+G', 'toggle-grid'),
        item('Crosshair', 'CmdOrCtrl+K', 'toggle-crosshair'),
        item('Freeze View', 'Space', 'toggle-freeze'),
        { type: 'separator' },
        item('Rotate Clockwise', 'CmdOrCtrl+R', 'rotate-cw'),
        item('Rotate Counter-clockwise', 'CmdOrCtrl+Shift+R', 'rotate-ccw'),
        item('Mirror', 'CmdOrCtrl+M', 'mirror'),
        { type: 'separator' },
        item('Rescan Cameras', 'CmdOrCtrl+Shift+N', 'rescan-cameras'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : ([{ role: 'toggleDevTools' }] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      label: '&Window',
      submenu: [
        { role: 'minimize' },
        ...(isMac
          ? ([{ role: 'zoom' }, { type: 'separator' }, { role: 'front' }] satisfies MenuItemConstructorOptions[])
          : ([{ role: 'close' }] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      role: 'help',
      submenu: [
        { label: 'MCP Reference', click: () => hooks.openDocs() },
        { label: 'Electroscope on GitHub', click: () => void shell.openExternal('https://github.com/UnlikeOtherAI/Electroscope') },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
