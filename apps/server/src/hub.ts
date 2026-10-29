import { randomBytes, randomInt, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
  LIMITS,
  PROTOCOL_VERSION,
  clampText,
  isValidRoomCode,
  memberColorFor,
  type ClientMessage,
  type ErrorCode,
  type Intent,
  type JoinRequest,
  type Member,
  type RoomInfo,
  type ServerMessage,
} from '@talkie/protocol';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface Connection {
  id: string;
  socket: SocketLike;
  ip?: string;
  room?: Room;
  memberId?: string;
  clientId?: string;
  joinedAt?: number;
  alive: boolean;
  general: Bucket;
  joins: Bucket;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

interface StoredMember extends Member {
  clientId: string;
  socket?: Connection;
  disconnectTimer?: NodeJS.Timeout;
}

interface Passcode {
  salt: Buffer;
  hash: Buffer;
}

interface Room {
  code: string;
  name: string;
  createdAt: number;
  locked: boolean;
  passcode?: Passcode;
  hostId: string;
  members: Map<string, StoredMember>;
  emptyAt: number | null;
}

export interface HubOptions {
  now?: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
  reconnectGraceMs?: number;
  roomIdleMs?: number;
  roomMaxAgeMs?: number;
  maxRooms?: number;
  maxMembers?: number;
  randomCode?: () => string;
}

export interface HubStats {
  rooms: number;
  members: number;
  connections: number;
}

function newBucket(tokens: number, now: number): Bucket {
  return { tokens, updatedAt: now };
}

function consume(bucket: Bucket, ratePerSecond: number, burst: number, now: number): boolean {
  const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(burst, bucket.tokens + elapsed * ratePerSecond);
  bucket.updatedAt = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function defaultCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < LIMITS.roomCodeLength; i += 1) {
    code += alphabet[randomInt(0, alphabet.length)];
  }
  return code;
}

function memberName(input: unknown): string {
  return clampText(input, LIMITS.displayName);
}

function roomName(input: unknown): string {
  return clampText(input, LIMITS.roomName);
}

function normalizePasscode(input: unknown): string | null | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length < LIMITS.passcodeMin || trimmed.length > LIMITS.passcodeMax) return null;
  return trimmed;
}

function normalizeClientId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length < 8 || trimmed.length > 64) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

function normalizeCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.trim().toUpperCase();
  return isValidRoomCode(code) ? code : null;
}

function publicMember(member: StoredMember, hostId: string): Member {
  return {
    id: member.id,
    name: member.name,
    color: member.color,
    intent: member.intent,
    queuedAt: member.queuedAt,
    joinedAt: member.joinedAt,
    connected: member.socket !== undefined,
    host: member.id === hostId,
  };
}

function serializeRoom(room: Room): RoomInfo {
  return {
    code: room.code,
    name: room.name,
    hasPasscode: Boolean(room.passcode),
    locked: room.locked,
    createdAt: room.createdAt,
    memberCount: room.members.size,
  };
}

/**
 * All room state is in memory. There is no database and nothing survives a
 * room's expiry; the room code is the only key.
 */
export class Hub {
  private readonly rooms = new Map<string, Room>();
  private readonly connections = new Set<Connection>();
  private readonly creationBuckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly log: (event: string, data?: Record<string, unknown>) => void;
  private readonly reconnectGraceMs: number;
  private readonly roomIdleMs: number;
  private readonly roomMaxAgeMs: number;
  private readonly maxRooms: number;
  private readonly maxMembers: number;
  private readonly randomCode: () => string;
  private sweepTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(options: HubOptions = {}) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.reconnectGraceMs = options.reconnectGraceMs ?? LIMITS.reconnectGraceMs;
    this.roomIdleMs = options.roomIdleMs ?? LIMITS.roomIdleMs;
    this.roomMaxAgeMs = options.roomMaxAgeMs ?? LIMITS.roomMaxAgeMs;
    this.maxRooms = options.maxRooms ?? LIMITS.roomsPerServer;
    this.maxMembers = options.maxMembers ?? LIMITS.membersPerRoom;
    this.randomCode = options.randomCode ?? defaultCode;
  }

  register(socket: SocketLike, ip?: string): Connection {
    const now = this.now();
    const conn: Connection = {
      id: randomUUID(),
      socket,
      ip,
      alive: true,
      general: newBucket(40, now),
      joins: newBucket(5, now),
    };
    this.connections.add(conn);
    return conn;
  }

  unregister(conn: Connection): void {
    this.connections.delete(conn);
    this.detach(conn, false);
  }

  /** Deliberate leave: remove presence instantly. */
  leave(conn: Connection): void {
    this.connections.delete(conn);
    this.detach(conn, true);
  }

  async handle(conn: Connection, raw: string | Buffer): Promise<void> {
    const now = this.now();
    let msg: ClientMessage;
    try {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      if (text.length > LIMITS.payloadBytes) {
        this.error(conn, 'bad_request');
        return;
      }
      msg = JSON.parse(text) as ClientMessage;
    } catch {
      this.error(conn, 'bad_request');
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') {
      this.error(conn, 'bad_request');
      return;
    }

    if (msg.t === 'ping') {
      this.send(conn, { t: 'pong', at: typeof msg.at === 'number' ? msg.at : 0, serverTime: now });
      return;
    }

    if (msg.t === 'join') {
      if (conn.room) {
        this.error(conn, 'bad_request', 'Already in a room.');
        return;
      }
      if (!consume(conn.joins, 0.12, 5, now)) {
        this.error(conn, 'rate_limited');
        return;
      }
      await this.join(conn, msg);
      return;
    }

    if (!conn.room || !conn.memberId) {
      this.error(conn, 'not_in_room');
      return;
    }

    if (!consume(conn.general, 8, 40, now)) {
      this.error(conn, 'rate_limited');
      return;
    }

    const room = conn.room;
    const member = room.members.get(conn.memberId);
    if (!member || member.socket !== conn) {
      this.error(conn, 'not_in_room');
      return;
    }

    switch (msg.t) {
      case 'intent':
        this.setIntent(conn, room, member, msg.intent);
        break;
      case 'profile':
        this.profile(room, member, msg.name);
        break;
      case 'lock':
        this.lock(conn, room, member, msg.locked);
        break;
      case 'end':
        this.end(conn, room, member);
        break;
      case 'leave':
        this.connections.delete(conn);
        this.detach(conn, true);
        break;
      default:
        this.error(conn, 'bad_request');
    }
  }

  lookup(codeInput: string): RoomInfo | null {
    const code = normalizeCode(codeInput);
    if (!code) return null;
    const room = this.rooms.get(code);
    if (!room) return null;
    return serializeRoom(room);
  }

  stats(): HubStats {
    let members = 0;
    for (const room of this.rooms.values()) members += room.members.size;
    return { rooms: this.rooms.size, members, connections: this.connections.size };
  }

  startSweeper(intervalMs = 60_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref?.();
  }

  sweep(): void {
    if (this.closed) return;
    const now = this.now();
    for (const [ip, bucket] of this.creationBuckets) {
      if (now - bucket.updatedAt > 10 * 60 * 1_000) this.creationBuckets.delete(ip);
    }
    for (const room of [...this.rooms.values()]) {
      if (now - room.createdAt > this.roomMaxAgeMs) {
        this.log('room.expired', { code: room.code, ageMs: now - room.createdAt });
        this.closeRoom(room, 'expired');
        continue;
      }
      if (room.members.size === 0) {
        if (room.emptyAt === null) room.emptyAt = now;
        if (now - room.emptyAt > this.roomIdleMs) {
          this.log('room.idle_deleted', { code: room.code });
          this.deleteRoom(room);
        }
      } else {
        room.emptyAt = null;
      }
    }
  }

  destroy(): void {
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const room of this.rooms.values()) {
      for (const member of room.members.values()) {
        if (member.disconnectTimer) clearTimeout(member.disconnectTimer);
      }
    }
    this.rooms.clear();
    this.connections.clear();
  }

  private async join(conn: Connection, msg: JoinRequest): Promise<void> {    const name = memberName(msg.name);
    if (!name) {
      this.error(conn, 'bad_request', 'Please choose a name.');
      return;
    }
    const clientId = normalizeClientId(msg.clientId);
    if (!clientId) {
      this.error(conn, 'bad_request');
      return;
    }
    if (msg.protocol !== undefined && msg.protocol !== PROTOCOL_VERSION) {
      this.error(conn, 'unsupported');
      return;
    }

    if (msg.mode === 'create') {
      await this.createRoom(conn, name, clientId, roomName(msg.roomName), msg.passcode);
      return;
    }

    const code = normalizeCode(msg.code);
    if (!code) {
      this.error(conn, 'room_not_found');
      return;
    }
    const room = this.rooms.get(code);
    if (!room) {
      this.error(conn, 'room_not_found');
      return;
    }

    const now = this.now();

    // A dropped connection reclaims its seat and queue position for a short
    // grace window without re-entering the passcode.
    const resumable = [...room.members.values()].find(
      (m) => m.clientId === clientId && m.socket === undefined,
    );
    if (resumable) {
      if (resumable.disconnectTimer) clearTimeout(resumable.disconnectTimer);
      resumable.disconnectTimer = undefined;
      resumable.socket = conn;
      resumable.name = name;
      conn.room = room;
      conn.memberId = resumable.id;
      conn.clientId = clientId;
      conn.joinedAt = now;
      room.emptyAt = null;
      this.log('member.resumed', { code, id: resumable.id, name });
      this.sendJoined(conn, room, resumable);
      this.broadcast(room, { t: 'member_updated', member: publicMember(resumable, room.hostId) }, resumable.id);
      return;
    }

    if (room.locked) {
      this.error(conn, 'room_locked');
      return;
    }
    if (room.members.size >= this.maxMembers) {
      this.error(conn, 'room_full');
      return;
    }

    if (room.passcode) {
      const passcode = normalizePasscode(msg.passcode);
      if (!passcode) {
        this.error(conn, 'bad_passcode');
        return;
      }
      const candidate = await scrypt(passcode, room.passcode.salt, 32);
      if (
        candidate.length !== room.passcode.hash.length ||
        !timingSafeEqual(candidate, room.passcode.hash)
      ) {
        this.error(conn, 'bad_passcode');
        return;
      }
    }

    const used = new Set([...room.members.values()].map((m) => m.color));
    const member: StoredMember = {
      id: conn.id,
      clientId,
      name,
      color: memberColorFor(clientId, used),
      intent: 'listening',
      queuedAt: null,
      joinedAt: now,
      connected: true,
      host: false,
      socket: conn,
    };
    if (!room.members.has(room.hostId)) room.hostId = member.id;
    room.members.set(member.id, member);
    room.emptyAt = null;
    conn.room = room;
    conn.memberId = member.id;
    conn.clientId = clientId;
    conn.joinedAt = now;

    this.log('member.joined', { code, id: member.id, name, members: room.members.size });
    this.sendJoined(conn, room, member);
    this.broadcast(room, { t: 'member_joined', member: publicMember(member, room.hostId) }, member.id);
  }

  private async createRoom(
    conn: Connection,
    name: string,
    clientId: string,
    nameOfRoom: string,
    passcodeInput: unknown,
  ): Promise<void> {
    if (!nameOfRoom) {
      this.error(conn, 'bad_request', 'Give your room a name.');
      return;
    }
    const passcode = normalizePasscode(passcodeInput);
    if (passcode === null) {
      this.error(conn, 'bad_request', `Passcodes must be ${LIMITS.passcodeMin}–${LIMITS.passcodeMax} characters.`);
      return;
    }

    const now = this.now();
    if (!this.allowRoomCreation(conn.ip ?? 'unknown', now)) {
      this.error(conn, 'rate_limited', 'Too many new rooms. Try again in a moment.');
      return;
    }

    this.sweep();
    if (this.rooms.size >= this.maxRooms) {
      this.error(conn, 'server_full');
      return;
    }

    let code = this.randomCode();
    for (let i = 0; i < 20 && this.rooms.has(code); i += 1) code = this.randomCode();
    if (this.rooms.has(code)) {
      this.error(conn, 'server_full');
      return;
    }

    let pass: Passcode | undefined;
    if (passcode) {
      const salt = randomBytes(16);
      pass = { salt, hash: await scrypt(passcode, salt, 32) };
    }

    const room: Room = {
      code,
      name: nameOfRoom,
      createdAt: now,
      locked: false,
      passcode: pass,
      hostId: conn.id,
      members: new Map(),
      emptyAt: null,
    };

    const member: StoredMember = {
      id: conn.id,
      clientId,
      name,
      color: memberColorFor(clientId),
      intent: 'listening',
      queuedAt: null,
      joinedAt: now,
      connected: true,
      host: true,
      socket: conn,
    };
    room.members.set(member.id, member);
    this.rooms.set(code, room);
    conn.room = room;
    conn.memberId = member.id;
    conn.clientId = clientId;
    conn.joinedAt = now;

    this.log('room.created', { code, name: nameOfRoom, host: name, hasPasscode: Boolean(pass) });
    this.sendJoined(conn, room, member);
  }

  private allowRoomCreation(ip: string, now: number): boolean {
    let bucket = this.creationBuckets.get(ip);
    if (!bucket) {
      bucket = newBucket(4, now);
      this.creationBuckets.set(ip, bucket);
    }
    return consume(bucket, 0.02, 4, now);
  }

  private setIntent(conn: Connection, room: Room, member: StoredMember, intent: Intent): void {
    if (intent !== 'listening' && intent !== 'queued') {
      this.error(conn, 'bad_request');
      return;
    }
    if (member.intent === intent) return;

    const now = this.now();
    member.intent = intent;
    member.queuedAt = intent === 'queued' ? now : null;

    this.broadcast(room, { t: 'member_updated', member: publicMember(member, room.hostId) });
    this.log('member.intent', { code: room.code, id: member.id, intent });
  }

  private profile(room: Room, member: StoredMember, nameInput: unknown): void {
    const name = memberName(nameInput);
    if (!name) return;
    if (name === member.name) return;
    member.name = name;
    this.broadcast(room, { t: 'member_updated', member: publicMember(member, room.hostId) });
    this.log('member.renamed', { code: room.code, id: member.id, name });
  }

  private lock(conn: Connection, room: Room, member: StoredMember, locked: unknown): void {
    if (member.id !== room.hostId) {
      this.error(conn, 'not_host');
      return;
    }
    room.locked = Boolean(locked);
    this.broadcast(room, { t: 'room_updated', room: serializeRoom(room) });
    this.log('room.locked', { code: room.code, locked: room.locked });
  }

  private end(conn: Connection, room: Room, member: StoredMember): void {
    if (member.id !== room.hostId) {
      this.error(conn, 'not_host');
      return;
    }
    this.log('room.ended', { code: room.code, by: member.name });
    this.closeRoom(room, 'ended', member.name);
  }

  private detach(conn: Connection, immediate: boolean): void {
    const room = conn.room;
    const memberId = conn.memberId;
    conn.room = undefined;
    conn.memberId = undefined;
    if (!room || !memberId) return;
    const member = room.members.get(memberId);
    if (!member || (member.socket && member.socket !== conn)) return;
    member.socket = undefined;
    if (immediate) {
      this.removeMember(room, member);
      return;
    }
    member.connected = false;
    this.broadcast(room, { t: 'member_updated', member: publicMember(member, room.hostId) });
    member.disconnectTimer = setTimeout(() => {
      const current = room.members.get(memberId);
      if (current && current.socket === undefined) this.removeMember(room, current);
    }, this.reconnectGraceMs);
    member.disconnectTimer.unref?.();
  }

  private removeMember(room: Room, member: StoredMember): void {
    if (member.disconnectTimer) clearTimeout(member.disconnectTimer);
    room.members.delete(member.id);
    this.log('member.left', { code: room.code, id: member.id, name: member.name });
    if (room.hostId === member.id && room.members.size > 0) {
      const next = [...room.members.values()]
        .filter((m) => m.socket !== undefined)
        .sort((a, b) => a.joinedAt - b.joinedAt)[0] ??
        [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (next) {
        room.hostId = next.id;
        this.broadcast(room, { t: 'member_updated', member: publicMember(next, room.hostId) });
        this.log('host.transferred', { code: room.code, id: next.id, name: next.name });
      }
    }
    this.broadcast(room, { t: 'member_left', id: member.id });
    if (room.members.size === 0) room.emptyAt = this.now();
  }

  private closeRoom(room: Room, reason: 'ended' | 'expired' | 'deleted', by?: string): void {
    const payload: ServerMessage = { t: 'closed', reason, ...(by ? { by } : {}) };
    for (const member of room.members.values()) {
      if (member.disconnectTimer) clearTimeout(member.disconnectTimer);
      member.disconnectTimer = undefined;
      const conn = member.socket;
      if (conn) {
        this.send(conn, payload);
        conn.room = undefined;
        conn.memberId = undefined;
        try {
          conn.socket.close(4001, reason);
        } catch {
          // Already closing.
        }
      }
    }
    this.deleteRoom(room);
  }

  private deleteRoom(room: Room): void {
    for (const member of room.members.values()) {
      if (member.disconnectTimer) clearTimeout(member.disconnectTimer);
    }
    this.rooms.delete(room.code);
  }

  private sendJoined(conn: Connection, room: Room, member: StoredMember): void {
    const members = [...room.members.values()]
      .map((m) => publicMember(m, room.hostId))
      .sort((a, b) => a.joinedAt - b.joinedAt);
    this.send(conn, {
      t: 'joined',
      room: serializeRoom(room),
      me: { id: member.id, clientId: member.clientId, host: member.id === room.hostId },
      members,
      protocol: PROTOCOL_VERSION,
      serverTime: this.now(),
    });
  }

  private broadcast(room: Room, msg: ServerMessage, exceptMemberId?: string): void {
    let payload: string | undefined;
    for (const member of room.members.values()) {
      if (member.id === exceptMemberId) continue;
      const conn = member.socket;
      if (!conn) continue;
      payload ??= JSON.stringify(msg);
      this.sendRaw(conn, payload);
    }
  }

  private send(conn: Connection, msg: ServerMessage): void {
    this.sendRaw(conn, JSON.stringify(msg));
  }

  private sendRaw(conn: Connection, payload: string): void {
    try {
      conn.socket.send(payload);
    } catch {
      // Socket closed between the check and the write.
    }
  }

  private error(conn: Connection, code: ErrorCode, message?: string): void {
    this.send(conn, { t: 'error', code, message: message ?? '' });
  }
}
