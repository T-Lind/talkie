import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  shell,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { join, resolve } from 'node:path';
import { extractRoomCode } from '@talkie/protocol';
import {
  IPC,
  type MainAction,
  type NativeSettings,
  type NotifyPayload,
  type TrayState,
  type WindowAction,
  type WindowBounds,
  type WindowState,
} from '../shared/ipc';
import appIconPath from './assets/appIcon.png?asset';
import trayIconPath from './assets/tray.png?asset';
import trayTemplatePath from './assets/trayTemplate.png?asset';
import { SettingsStore } from './settings';

app.setName('Team Talkie');
if (process.platform === 'win32') app.setAppUserModelId('com.teamtalkie.app');

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const isWindows = process.platform === 'win32';
const isDev = !app.isPackaged;
const TOGGLE_ACCELERATOR = 'CommandOrControl+Shift+Space';

const WINDOW_DEFAULT = { width: 400, height: 420 };
const WINDOW_MIN = { width: 380, height: 110 };
const WINDOW_MAX = { width: 560, height: 640 };

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: SettingsStore | null = null;
let quitting = false;
let startHidden = process.argv.includes('--hidden');
let pendingDeepLink: string | null = null;
let rendererReady = false;
let trayState: TrayState = {
  inRoom: false,
  memberCount: 0,
  queued: false,
  connection: 'idle',
};

const liveNotifications = new Set<Notification>();

function settingsStore(): SettingsStore {
  store ??= new SettingsStore();
  return store;
}

function isTrusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return Boolean(mainWindow && event.sender === mainWindow.webContents);
}

function clampBounds(bounds: WindowBounds): WindowBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.min(WINDOW_MAX.width, Math.max(WINDOW_MIN.width, Math.round(bounds.width))),
    height: Math.min(WINDOW_MAX.height, Math.max(WINDOW_MIN.height, Math.round(bounds.height))),
  };
}

function restoreBounds(): WindowBounds | null {
  const saved = settingsStore().get().bounds;
  if (!saved) return null;
  const onScreen = screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapX = Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x);
    const overlapY = Math.min(saved.y + saved.height, area.y + area.height) - Math.max(saved.y, area.y);
    return overlapX >= 80 && overlapY >= 80;
  });
  if (!onScreen) return null;
  return clampBounds(saved);
}

function contentProtectionSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

/**
 * The two defining desktop behaviours:
 *  - pinned above everything, including full-screen meeting windows
 *  - invisible to screen shares / recordings where the OS supports it
 */
function applyWindowFlags(): void {
  if (!mainWindow) return;
  const settings = settingsStore().get();

  mainWindow.setAlwaysOnTop(settings.alwaysOnTop, settings.alwaysOnTop ? 'screen-saver' : 'normal');
  if (isMac) {
    mainWindow.setVisibleOnAllWorkspaces(settings.alwaysOnTop, { visibleOnFullScreen: true });
  }

  if (contentProtectionSupported()) {
    mainWindow.setContentProtection(settings.hideFromCapture);
  }

  broadcastWindowState();
}

function windowState(): WindowState {
  const settings = settingsStore().get();
  return {
    alwaysOnTop: settings.alwaysOnTop,
    hideFromCapture: settings.hideFromCapture,
    captureSupported: contentProtectionSupported(),
    contentProtected: mainWindow?.isContentProtected?.() ?? settings.hideFromCapture,
    visible: mainWindow?.isVisible() ?? false,
    minimized: mainWindow?.isMinimized() ?? false,
    platform: process.platform,
    isPackaged: app.isPackaged,
    version: app.getVersion(),
  };
}

function broadcastWindowState(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.windowStateChanged, windowState());
  }
}

function showWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  // Some window managers and DWM reset topmost/protection on re-show.
  applyWindowFlags();
}

function hideWindow(): void {
  mainWindow?.hide();
}

function quitApp(): void {
  quitting = true;
  settingsStore().flush();
  app.quit();
}

function sendAction(action: MainAction): void {
  showWindow();
  mainWindow?.webContents.send(IPC.action, action);
}

function buildTrayMenu(): void {
  if (!tray) return;
  const state = trayState;
  const inRoom = state.inRoom;
  const handLabel = state.queued ? 'Lower hand' : 'Raise hand';

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: inRoom ? 'Show Talkie' : 'Open Talkie',
      click: () => showWindow(),
    },
  ];

  if (inRoom) {
    template.push(
      { type: 'separator' },
      {
        label: `${state.roomName ?? 'Room'}${state.roomCode ? ` · ${state.roomCode}` : ''}`,
        enabled: false,
      },
      {
        label: handLabel,
        enabled: state.connection === 'online',
        click: () => sendAction('toggle-hand'),
      },
      {
        label: 'Copy invite code',
        enabled: Boolean(state.roomCode),
        click: () => sendAction('copy-code'),
      },
    );
  }

  template.push(
    { type: 'separator' },
    {
      label: 'Settings…',
      click: () => sendAction('open-settings'),
    },
    {
      label: 'Hide widget',
      visible: mainWindow?.isVisible() ?? false,
      click: () => hideWindow(),
    },
    {
      label: 'Quit Talkie',
      click: () => quitApp(),
    },
  );

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(
    inRoom
      ? `Talkie - ${state.roomName ?? 'Room'}${state.memberCount ? ` (${state.memberCount})` : ''}`
      : 'Talkie',
  );
}

function createTray(): void {
  if (tray) return;
  const path = isMac ? trayTemplatePath : trayIconPath;
  const source = nativeImage.createFromPath(path);
  const image = isMac ? source.resize({ width: 16, height: 16 }) : source;
  if (isMac) image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip('Talkie');
  tray.on('click', () => {
    if (mainWindow?.isVisible() && !mainWindow.isMinimized()) hideWindow();
    else showWindow();
  });
  tray.on('double-click', () => showWindow());
  buildTrayMenu();
}

function createWindow(): void {
  const bounds = restoreBounds();
  const settings = settingsStore().get();

  mainWindow = new BrowserWindow({
    width: bounds?.width ?? WINDOW_DEFAULT.width,
    height: bounds?.height ?? WINDOW_DEFAULT.height,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    maxWidth: WINDOW_MAX.width,
    maxHeight: WINDOW_MAX.height,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    transparent: !isWindows,
    backgroundColor: '#00000000',
    ...(isMac
      ? { vibrancy: 'under-window' as const, visualEffectState: 'active' as const }
      : {}),
    ...(isWindows ? { backgroundMaterial: 'acrylic' as const } : {}),
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    roundedCorners: true,
    hasShadow: true,
    alwaysOnTop: settings.alwaysOnTop,
    icon: nativeImage.createFromPath(appIconPath),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      spellcheck: false,
      devTools: isDev,
      backgroundThrottling: false,
    },
  });

  if (!isMac) mainWindow.setMenuBarVisibility(false);

  mainWindow.on('ready-to-show', () => {
    if (!startHidden) mainWindow?.show();
    applyWindowFlags();
  });

  let boundsTimer: NodeJS.Timeout | null = null;
  const saveBounds = (): void => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      boundsTimer = null;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      settingsStore().setBounds(mainWindow.getBounds());
    }, 400);
  };
  mainWindow.on('move', saveBounds);
  mainWindow.on('resize', saveBounds);

  mainWindow.on('show', () => {
    broadcastWindowState();
    setTimeout(() => applyWindowFlags(), 120);
    buildTrayMenu();
  });
  mainWindow.on('hide', () => {
    broadcastWindowState();
    buildTrayMenu();
  });
  mainWindow.on('minimize', () => broadcastWindowState());
  mainWindow.on('restore', () => {
    broadcastWindowState();
    applyWindowFlags();
  });

  mainWindow.on('close', (event) => {
    if (!quitting && settingsStore().get().closeToTray) {
      event.preventDefault();
      hideWindow();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    rendererReady = false;
  });

  mainWindow.webContents.on('did-finish-load', () => {
    rendererReady = true;
    try {
      mainWindow?.webContents.setVisualZoomLevelLimits(1, 1);
    } catch {
      // The frame can be unavailable during a reload.
    }
    applyWindowFlags();
    if (pendingDeepLink) {
      // Do not consume it here: the renderer pulls (and clears) it on mount,
      // which covers the gap between did-finish-load and React mounting.
      mainWindow?.webContents.send(IPC.deepLink, pendingDeepLink);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? '';
    if (url !== current) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });

  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && rendererUrl) {
    void mainWindow.loadURL(rendererUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  createTray();
}

function routeDeepLink(url: string): void {
  const code = extractRoomCode(url);
  if (!code) return;
  showWindow();
  if (mainWindow && rendererReady) {
    mainWindow.webContents.send(IPC.deepLink, code);
  } else {
    pendingDeepLink = code;
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.windowState, () => windowState());

  ipcMain.on(IPC.windowHeight, (event, height: number) => {
    if (!isTrusted(event) || typeof height !== 'number' || !Number.isFinite(height)) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const [width = WINDOW_DEFAULT.width, currentHeight = WINDOW_MIN.height] =
      mainWindow.getContentSize();
    const display = screen.getDisplayMatching(mainWindow.getBounds());
    const maxHeight = Math.min(
      WINDOW_MAX.height,
      Math.max(WINDOW_MIN.height, display.workArea.height - 24),
    );
    const target = Math.round(Math.min(maxHeight, Math.max(WINDOW_MIN.height, height)));
    if (Math.abs(currentHeight - target) < 2) return;
    mainWindow.setContentSize(width, target);
  });

  ipcMain.on(IPC.windowAction, (event, action: WindowAction) => {
    if (!isTrusted(event)) return;
    switch (action) {
      case 'minimize':
        mainWindow?.minimize();
        break;
      case 'close':
        if (settingsStore().get().closeToTray) hideWindow();
        else quitApp();
        break;
      case 'hide':
        hideWindow();
        break;
      case 'quit':
        quitApp();
        break;
    }
  });

  ipcMain.handle(IPC.settingsGet, (event) => {
    if (!isTrusted(event)) return settingsStore().get();
    return settingsStore().get();
  });

  ipcMain.handle(IPC.settingsSet, (event, patch: Partial<NativeSettings>) => {
    if (!isTrusted(event) || !patch || typeof patch !== 'object') return settingsStore().get();
    const next = settingsStore().patch(patch);
    if (typeof patch.alwaysOnTop === 'boolean' || typeof patch.hideFromCapture === 'boolean') {
      applyWindowFlags();
    }
    if (typeof patch.launchAtLogin === 'boolean' && app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: patch.launchAtLogin,
        ...(process.platform === 'win32' ? { args: ['--hidden'] } : {}),
      });
    }
    buildTrayMenu();
    return next;
  });

  ipcMain.handle(IPC.clipboardWrite, (event, text: string) => {
    if (!isTrusted(event) || typeof text !== 'string') return;
    clipboard.writeText(text.slice(0, 4_000));
  });

  ipcMain.handle(IPC.openExternal, async (event, url: string) => {
    if (!isTrusted(event) || typeof url !== 'string') return;
    if (!/^https?:\/\//i.test(url)) return;
    await shell.openExternal(url);
  });

  ipcMain.handle(IPC.deepLinkTake, (event) => {
    if (!isTrusted(event)) return null;
    const code = pendingDeepLink;
    pendingDeepLink = null;
    return code;
  });

  ipcMain.on(IPC.notify, (event, payload: NotifyPayload) => {
    if (!isTrusted(event) || !payload || typeof payload !== 'object') return;
    if (!Notification.isSupported()) return;
    const title = String(payload.title ?? 'Talkie').slice(0, 80);
    const body = String(payload.body ?? '').slice(0, 200);
    if (!body) return;
    const notification = new Notification({
      title,
      body,
      silent: Boolean(payload.silent),
      icon: nativeImage.createFromPath(appIconPath),
    });
    liveNotifications.add(notification);
    notification.on('click', () => showWindow());
    notification.on('close', () => liveNotifications.delete(notification));
    notification.show();
    setTimeout(() => liveNotifications.delete(notification), 15_000);
  });

  ipcMain.on(IPC.traySync, (event, next: TrayState) => {
    if (!isTrusted(event) || !next || typeof next !== 'object') return;
    trayState = {
      inRoom: Boolean(next.inRoom),
      roomName: typeof next.roomName === 'string' ? next.roomName.slice(0, 60) : undefined,
      roomCode: typeof next.roomCode === 'string' ? next.roomCode.slice(0, 16) : undefined,
      memberCount: Number(next.memberCount) || 0,
      queued: Boolean(next.queued),
      connection: next.connection,
    };
    buildTrayMenu();
  });

  ipcMain.on(IPC.quit, (event) => {
    if (!isTrusted(event)) return;
    quitApp();
  });
}

function registerGlobalShortcuts(): void {
  const registered = globalShortcut.register(TOGGLE_ACCELERATOR, () => {
    if (!mainWindow) return;
    showWindow();
    mainWindow.webContents.send(IPC.action, 'toggle-hand');
  });
  if (!registered) {
    // The shortcut may be claimed by another app; everything still works via UI.
    console.warn(`Could not register ${TOGGLE_ACCELERATOR}`);
  }

  // A second, less crowded shortcut for quickly hiding the widget.
  const hideRegistered = globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (mainWindow?.isVisible()) hideWindow();
  });
  if (!hideRegistered) {
    console.warn('Could not register hide shortcut');
  }
}

function installMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'editMenu' as const },
    { role: 'windowMenu' as const },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const link = argv.find((arg) => arg.startsWith('talkie://'));
    if (link) routeDeepLink(link);
    else showWindow();
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    routeDeepLink(url);
  });

  const initialLink = process.argv.find((arg) => arg.startsWith('talkie://'));
  if (initialLink) {
    const code = extractRoomCode(initialLink);
    if (code) pendingDeepLink = code;
  }

  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      const entry = process.argv[1];
      if (entry) app.setAsDefaultProtocolClient('talkie', process.execPath, [resolve(entry)]);
    }
  } else {
    app.setAsDefaultProtocolClient('talkie');
  }

  app.whenReady().then(() => {
    nativeTheme.themeSource = 'light';
    settingsStore();
    installMenu();
    registerIpc();
    createWindow();
    registerGlobalShortcuts();

    if (app.isPackaged && settingsStore().get().launchAtLogin) {
      app.setLoginItemSettings({
        openAtLogin: true,
        ...(process.platform === 'win32' ? { args: ['--hidden'] } : {}),
      });
    }

    app.on('activate', () => {
      if (!mainWindow) createWindow();
      else showWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    settingsStore().flush();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });
}

// Keep the tray icon alive in dev when the renderer window is reloaded.
if (isDev && isLinux) {
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception in main process:', error);
});
