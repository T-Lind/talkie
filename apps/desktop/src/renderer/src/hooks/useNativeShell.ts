import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { NativeSettings, WindowState } from '@shared/ipc';
export interface NativeShell {
  supported: boolean;
  window: WindowState | null;
  settings: NativeSettings | null;
  update: (patch: Partial<NativeSettings>) => Promise<void>;
  minimize: () => void;
  close: () => void;
  quit: () => void;
}

export function useNativeShell(): NativeShell {
  const [windowState, setWindowState] = useState<WindowState | null>(null);
  const [settings, setSettings] = useState<NativeSettings | null>(null);
  const supported = Boolean(window.talkie);

  useEffect(() => {
    const bridge = window.talkie;
    if (!bridge) return;
    let alive = true;
    void Promise.all([bridge.window.getState(), bridge.settings.get()]).then(([state, prefs]) => {
      if (!alive) return;
      setWindowState(state);
      setSettings(prefs);
    });
    const unsubscribe = bridge.window.onStateChanged((state) => setWindowState(state));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const update = useCallback(async (patch: Partial<NativeSettings>) => {
    const bridge = window.talkie;
    if (!bridge) return;
    const next = await bridge.settings.set(patch);
    setSettings(next);
    setWindowState(await bridge.window.getState());
  }, []);

  const minimize = useCallback(() => window.talkie?.window.minimize(), []);
  const close = useCallback(() => window.talkie?.window.close(), []);
  const quit = useCallback(() => window.talkie?.quit(), []);

  return { supported, window: windowState, settings, update, minimize, close, quit };
}

export function useClickOutside<T extends HTMLElement>(
  onOutside: () => void,
  enabled: boolean,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const callback = useRef(onOutside);
  callback.current = onOutside;

  useEffect(() => {
    if (!enabled) return;
    const handler = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) callback.current();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [enabled]);

  return ref;
}
