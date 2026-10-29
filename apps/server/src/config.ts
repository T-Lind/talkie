import { LIMITS } from '@talkie/protocol';

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export const config = {
  port: intEnv('PORT', 8787, 1, 65_535),
  host: process.env.HOST ?? '0.0.0.0',
  reconnectGraceMs: intEnv('RECONNECT_GRACE_MS', LIMITS.reconnectGraceMs, 0, 60_000),
  roomIdleMs: intEnv('ROOM_IDLE_MS', LIMITS.roomIdleMs, 60_000, 24 * 60 * 60 * 1_000),
  roomMaxAgeMs: intEnv('ROOM_MAX_AGE_MS', LIMITS.roomMaxAgeMs, 5 * 60 * 1_000, 7 * 24 * 60 * 60 * 1_000),
  maxRooms: intEnv('MAX_ROOMS', 2_000, 10, 100_000),
  maxConnections: intEnv('MAX_CONNECTIONS', 180, 10, 5_000),
  maxConnectionsPerIp: intEnv('MAX_CONNECTIONS_PER_IP', 16, 2, 100),
  origins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  trustProxy: process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true',
  version: process.env.RELEASE_VERSION ?? '0.1.0',
};
