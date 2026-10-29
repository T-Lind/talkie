/** Types and channel names shared by the Electron main process and renderer. */

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeSettings {
  alwaysOnTop: boolean;
  hideFromCapture: boolean;
  closeToTray: boolean;
  launchAtLogin: boolean;
  bounds: WindowBounds | null;
}

export interface WindowState {
  alwaysOnTop: boolean;
  hideFromCapture: boolean;
  captureSupported: boolean;
  contentProtected: boolean;
  visible: boolean;
  minimized: boolean;
  platform: string;
  isPackaged: boolean;
  version: string;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface TrayState {
  inRoom: boolean;
  roomName?: string;
  roomCode?: string;
  memberCount: number;
  queued: boolean;
  connection: ConnectionStatus;
}

export type MainAction = 'toggle-hand' | 'open-settings' | 'copy-code';
export type WindowAction = 'minimize' | 'close' | 'hide' | 'quit';

export interface NotifyPayload {
  title: string;
  body: string;
  silent?: boolean;
}

export interface AppInfo {
  version: string;
  platform: string;
  isPackaged: boolean;
}

export interface TalkieBridge {
  isDesktop: true;
  platform: string;
  window: {
    minimize(): void;
    close(): void;
    setHeight(height: number): void;
    getState(): Promise<WindowState>;
    onStateChanged(callback: (state: WindowState) => void): () => void;
  };
  settings: {
    get(): Promise<NativeSettings>;
    set(patch: Partial<NativeSettings>): Promise<NativeSettings>;
  };
  onAction(callback: (action: MainAction) => void): () => void;
  onDeepLink(callback: (code: string) => void): () => void;
  takePendingDeepLink(): Promise<string | null>;
  copyText(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  notify(payload: NotifyPayload): void;
  syncTray(state: TrayState): void;
  quit(): void;
}

export const IPC = {
  windowAction: 'talkie:window-action',
  windowState: 'talkie:window-state',
  windowStateChanged: 'talkie:window-state-changed',
  windowHeight: 'talkie:window-height',
  settingsGet: 'talkie:settings-get',
  settingsSet: 'talkie:settings-set',
  action: 'talkie:action',
  deepLink: 'talkie:deep-link',
  deepLinkTake: 'talkie:deep-link-take',
  clipboardWrite: 'talkie:clipboard-write',
  openExternal: 'talkie:open-external',
  notify: 'talkie:notify',
  traySync: 'talkie:tray-sync',
  quit: 'talkie:quit',
} as const;
