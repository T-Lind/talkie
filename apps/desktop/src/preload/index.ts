import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type MainAction,
  type NativeSettings,
  type NotifyPayload,
  type TalkieBridge,
  type TrayState,
  type WindowState,
} from '../shared/ipc';

const bridge: TalkieBridge = {
  isDesktop: true,
  platform: process.platform,
  window: {
    minimize: () => ipcRenderer.send(IPC.windowAction, 'minimize'),
    close: () => ipcRenderer.send(IPC.windowAction, 'close'),
    setHeight: (height: number) => ipcRenderer.send(IPC.windowHeight, height),
    getState: () => ipcRenderer.invoke(IPC.windowState) as Promise<WindowState>,
    onStateChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: WindowState): void => callback(state);
      ipcRenderer.on(IPC.windowStateChanged, listener);
      return () => ipcRenderer.removeListener(IPC.windowStateChanged, listener);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<NativeSettings>,
    set: (patch) => ipcRenderer.invoke(IPC.settingsSet, patch) as Promise<NativeSettings>,
  },
  onAction: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, action: MainAction): void => callback(action);
    ipcRenderer.on(IPC.action, listener);
    return () => ipcRenderer.removeListener(IPC.action, listener);
  },
  onDeepLink: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, code: string): void => callback(code);
    ipcRenderer.on(IPC.deepLink, listener);
    return () => ipcRenderer.removeListener(IPC.deepLink, listener);
  },
  takePendingDeepLink: () => ipcRenderer.invoke(IPC.deepLinkTake) as Promise<string | null>,
  copyText: async (text) => {
    await ipcRenderer.invoke(IPC.clipboardWrite, text);
  },
  openExternal: async (url) => {
    await ipcRenderer.invoke(IPC.openExternal, url);
  },
  notify: (payload: NotifyPayload) => ipcRenderer.send(IPC.notify, payload),
  syncTray: (state: TrayState) => ipcRenderer.send(IPC.traySync, state),
  quit: () => ipcRenderer.send(IPC.quit),
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('talkie', bridge);
} else {
  // Should never happen (contextIsolation is always on), but keeps preload
  // useful when loaded by older Electron builds.
  (globalThis as unknown as { talkie: TalkieBridge }).talkie = bridge;
}
