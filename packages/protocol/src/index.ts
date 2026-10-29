/**
 * Shared wire protocol for Team Talkie.
 *
 * One job: keep a private, ordered list of who wants to speak.
 * Dependency-free so it can be shared by the renderer, preload and server.
 */

export const PROTOCOL_VERSION = 2;

export const LIMITS = {
  displayName: 28,
  roomName: 34,
  passcodeMin: 4,
  passcodeMax: 32,
  roomCodeLength: 6,
  membersPerRoom: 8,
  roomsPerServer: 2_000,
  payloadBytes: 16 * 1024,
  roomIdleMs: 30 * 60 * 1_000,
  roomMaxAgeMs: 24 * 60 * 60 * 1_000,
  reconnectGraceMs: 8_000,
} as const;

/** Palette indexes become the small identity dots in the list. */
export const PALETTE_SIZE = 8;

/**
 * `listening` means no hand raised. `queued` means the hand is up and the
 * person is in the speaking order.
 */
export type Intent = 'listening' | 'queued';

export interface Member {
  id: string;
  name: string;
  color: number;
  intent: Intent;
  /** Server timestamp when the hand went up, or null. */
  queuedAt: number | null;
  /** Server timestamp when the member joined the room. */
  joinedAt: number;
  /** False during the short reconnect grace window. */
  connected: boolean;
  host: boolean;
}

export interface RoomInfo {
  code: string;
  name: string;
  hasPasscode: boolean;
  locked: boolean;
  createdAt: number;
  memberCount: number;
}

export type ErrorCode =
  | 'bad_request'
  | 'room_not_found'
  | 'bad_passcode'
  | 'room_full'
  | 'room_locked'
  | 'server_full'
  | 'rate_limited'
  | 'not_in_room'
  | 'not_host'
  | 'unsupported';

/** Sent immediately after the socket opens. */
export type JoinRequest =
  | {
      t: 'join';
      mode: 'create';
      name: string;
      roomName: string;
      passcode?: string;
      clientId: string;
      protocol?: number;
    }
  | {
      t: 'join';
      mode: 'enter';
      name: string;
      code: string;
      passcode?: string;
      clientId: string;
      protocol?: number;
    };

export type ClientMessage =
  | JoinRequest
  | { t: 'intent'; intent: Intent }
  | { t: 'profile'; name: string }
  | { t: 'lock'; locked: boolean }
  | { t: 'end' }
  | { t: 'leave' }
  | { t: 'ping'; at: number };

export interface JoinedMessage {
  t: 'joined';
  room: RoomInfo;
  me: { id: string; clientId: string; host: boolean };
  members: Member[];
  protocol: number;
  serverTime: number;
}

export type ServerMessage =
  | JoinedMessage
  | { t: 'member_joined'; member: Member }
  | { t: 'member_left'; id: string }
  | { t: 'member_updated'; member: Member }
  | { t: 'room_updated'; room: RoomInfo }
  | { t: 'pong'; at: number; serverTime: number }
  | { t: 'closed'; reason: 'ended' | 'expired' | 'deleted'; by?: string }
  | { t: 'error'; code: ErrorCode; message: string };

export interface RoomLookup {
  exists: boolean;
  room?: {
    code: string;
    name: string;
    hasPasscode: boolean;
    locked: boolean;
    memberCount: number;
  };
}

export const ERROR_TEXT: Record<ErrorCode, string> = {
  bad_request: 'That request was not valid.',
  room_not_found: 'That room does not exist or has expired.',
  bad_passcode: 'That passcode is not correct.',
  room_full: 'That room is full.',
  room_locked: 'That room is locked.',
  server_full: 'The server is at capacity. Try again shortly.',
  rate_limited: 'Slow down a little.',
  not_in_room: 'You are not in a room yet.',
  not_host: 'Only the host can do that.',
  unsupported: 'This version is not supported by the server.',
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(length = LIMITS.roomCodeLength, random = Math.random): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)] ?? 'A';
  }
  return out;
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== LIMITS.roomCodeLength) return false;
  for (const char of code) {
    if (!CODE_ALPHABET.includes(char)) return false;
  }
  return true;
}

/**
 * Accepts `K7F2QX`, `K7F-2QX`, `talkie://join/CODE`, or a URL with `?code=`.
 */
export function extractRoomCode(input: string): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match =
    /talkie:\/\/join\/([a-zA-Z0-9-]{4,16})/i.exec(trimmed) ??
    /[?&]code=([a-zA-Z0-9-]{4,16})/i.exec(trimmed);
  const raw = match?.[1] ?? trimmed;
  const cleaned = raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (cleaned.length < 4 || cleaned.length > 16) return null;
  return cleaned;
}

/** Display form, e.g. `K7F 2QX`. Copy uses the raw code. */
export function formatRoomCode(code: string): string {
  const mid = Math.ceil(code.length / 2);
  return `${code.slice(0, mid)} ${code.slice(mid)}`;
}

export function deepLinkForCode(code: string): string {
  return `talkie://join/${code}`;
}

export interface InviteTextOptions {
  code: string;
  roomName?: string;
  passcode?: string;
  includePasscode?: boolean;
}

export function inviteText({ code, roomName, passcode, includePasscode }: InviteTextOptions): string {
  const lines = [`Join my Team Talkie room${roomName ? ` "${roomName}"` : ''}.`, `Code: ${code}`];
  if (includePasscode && passcode) lines.push(`Passcode: ${passcode}`);
  lines.push('Open Team Talkie and enter the code.');
  return lines.join('\n');
}

export function memberColorFor(seed: string, used: Set<number> = new Set()): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const start = Math.abs(hash) % PALETTE_SIZE;
  for (let i = 0; i < PALETTE_SIZE; i += 1) {
    const candidate = (start + i) % PALETTE_SIZE;
    if (!used.has(candidate)) return candidate;
  }
  return start;
}

/** Listening first? No: raised hands, in signal order, then everyone else. */
export function queueOf(members: Member[]): Member[] {
  return members
    .filter((m) => m.intent === 'queued')
    .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0) || a.joinedAt - b.joinedAt);
}

export function clampText(input: unknown, max: number): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
