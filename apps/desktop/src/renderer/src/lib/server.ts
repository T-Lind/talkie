import { extractRoomCode, type RoomLookup } from '@talkie/protocol';

export function normalizeServerUrl(input: string): string | null {
  let raw = input.trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `ws://${raw}`;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;

  if (!url.pathname || url.pathname === '/') url.pathname = '/ws';
  if (url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function httpBaseOf(serverUrl: string): string | null {
  try {
    const url = new URL(serverUrl);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    else if (url.protocol === 'wss:') url.protocol = 'https:';
    else return null;
    if (url.pathname.endsWith('/ws')) url.pathname = url.pathname.slice(0, -3) || '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function serverHost(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    return url.host;
  } catch {
    return serverUrl;
  }
}

export function isSecureServer(serverUrl: string): boolean {
  try {
    return new URL(serverUrl).protocol === 'wss:';
  } catch {
    return false;
  }
}

export interface ProbeResult {
  ok: boolean;
  latencyMs: number | null;
  version?: string;
}

/**
 * Cloud Run is configured to scale to zero. This request wakes the instance
 * while the user is still typing their name, and the explicit join paths call
 * it again before opening the WebSocket.
 */
export async function warmServer(serverUrl: string, timeoutMs = 12_000): Promise<boolean> {
  const base = httpBaseOf(serverUrl);
  if (!base) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/healthz`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeServer(serverUrl: string, timeoutMs = 2600): Promise<ProbeResult> {
  const base = httpBaseOf(serverUrl);
  if (!base) return { ok: false, latencyMs: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(`${base}/healthz`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) return { ok: false, latencyMs };
    const body = (await response.json()) as { ok?: boolean; version?: string };
    return { ok: body.ok === true, latencyMs, ...(body.version ? { version: body.version } : {}) };
  } catch {
    return { ok: false, latencyMs: null };
  } finally {
    clearTimeout(timer);
  }
}

export type RoomLookupResult =
  | { status: 'found'; room: NonNullable<RoomLookup['room']> }
  | { status: 'missing' }
  | { status: 'error' };

export async function lookupRoom(serverUrl: string, codeInput: string): Promise<RoomLookupResult> {
  const base = httpBaseOf(serverUrl);
  const code = extractRoomCode(codeInput);
  if (!base || !code) return { status: 'error' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2600);
  try {
    const response = await fetch(`${base}/api/rooms/${encodeURIComponent(code)}`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (response.status === 404) return { status: 'missing' };
    if (!response.ok) return { status: 'error' };
    const body = (await response.json()) as RoomLookup;
    if (!body.room) return { status: 'missing' };
    return { status: 'found', room: body.room };
  } catch {
    return { status: 'error' };
  } finally {
    clearTimeout(timer);
  }
}
