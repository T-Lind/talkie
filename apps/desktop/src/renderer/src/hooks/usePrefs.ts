import { useCallback, useEffect, useState } from 'react';
import { loadPrefs, savePrefs, type Prefs } from '../lib/prefs';

export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs());

  const update = useCallback((patch: Partial<Prefs> | ((current: Prefs) => Partial<Prefs>)) => {
    setPrefs((current) => {
      const delta = typeof patch === 'function' ? patch(current) : patch;
      const next = { ...current, ...delta };
      savePrefs(next);
      return next;
    });
  }, []);

  // Keep multiple windows / reloads consistent.
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== 'talkie.prefs.v1') return;
      setPrefs(loadPrefs());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return { prefs, update };
}
