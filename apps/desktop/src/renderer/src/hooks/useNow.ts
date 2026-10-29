import { useEffect, useState } from 'react';

let listeners = new Set<() => void>();
let interval: number | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (interval === null) {
    interval = window.setInterval(() => {
      for (const entry of listeners) entry();
    }, 1_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && interval !== null) {
      window.clearInterval(interval);
      interval = null;
    }
  };
}

/** One shared 1s clock for every timer in the widget. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribe(() => setNow(Date.now())), []);
  return now;
}

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
