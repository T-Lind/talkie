export interface LastRoom {
  code: string;
  name: string;
  passcode?: string;
}

export interface Prefs {
  name: string;
  sounds: boolean;
  serverUrl: string;
  clientId: string;
  lastRoom: LastRoom | null;
  seenIntro: boolean;
}

const KEY = 'talkie.prefs.v1';

export const DEFAULT_SERVER =
  (import.meta.env.VITE_TALKIE_SERVER as string | undefined)?.trim() || 'ws://localhost:8787';

function newClientId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    // Fall through.
  }
  return `c_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function defaultPrefs(): Prefs {
  return {
    name: '',
    sounds: true,
    serverUrl: DEFAULT_SERVER,
    clientId: newClientId(),
    lastRoom: null,
    seenIntro: false,
  };
}

function sanitizeLastRoom(value: unknown): LastRoom | null {
  if (!value || typeof value !== 'object') return null;
  const room = value as Record<string, unknown>;
  if (typeof room.code !== 'string' || typeof room.name !== 'string') return null;
  if (!room.code.trim()) return null;
  return {
    code: room.code.slice(0, 16),
    name: room.name.slice(0, 60),
    ...(typeof room.passcode === 'string' && room.passcode ? { passcode: room.passcode.slice(0, 64) } : {}),
  };
}

export function loadPrefs(): Prefs {
  const base = defaultPrefs();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const storedServer = typeof parsed.serverUrl === 'string' ? parsed.serverUrl : '';
    const wasLocalDefault =
      storedServer === 'ws://localhost:8787' ||
      storedServer === 'ws://127.0.0.1:8787' ||
      storedServer === 'http://localhost:8787' ||
      storedServer === 'http://127.0.0.1:8787';
    const shouldMigrate = wasLocalDefault && !DEFAULT_SERVER.includes('localhost');
    return {
      name: typeof parsed.name === 'string' ? parsed.name.slice(0, 28) : base.name,
      sounds: typeof parsed.sounds === 'boolean' ? parsed.sounds : base.sounds,
      serverUrl: storedServer && !shouldMigrate ? storedServer : base.serverUrl,
      clientId:
        typeof parsed.clientId === 'string' && parsed.clientId.length >= 8
          ? parsed.clientId
          : base.clientId,
      lastRoom: sanitizeLastRoom(parsed.lastRoom),
      seenIntro: Boolean(parsed.seenIntro),
    };
  } catch {
    return base;
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be unavailable; the app still works for this session.
  }
}
