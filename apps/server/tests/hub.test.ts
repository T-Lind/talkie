import { describe, expect, it } from 'vitest';
import { queueOf, type JoinedMessage, type Member, type ServerMessage } from '@talkie/protocol';
import { Hub, type Connection, type SocketLike } from '../src/hub';

class FakeSocket implements SocketLike {
  messages: ServerMessage[] = [];
  closed = false;
  closeCode: number | undefined;

  send(data: string): void {
    this.messages.push(JSON.parse(data) as ServerMessage);
  }

  close(code?: number): void {
    this.closed = true;
    this.closeCode = code;
  }

  ofType<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }>[] {
    return this.messages.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === type);
  }

  last<T extends ServerMessage['t']>(type: T): Extract<ServerMessage, { t: T }> | undefined {
    const all = this.ofType(type);
    return all[all.length - 1];
  }
}

interface Harness {
  hub: Hub;
  now: () => number;
  advance: (ms: number) => void;
  connect: () => { socket: FakeSocket; conn: Connection };
  send: (conn: Connection, msg: unknown) => Promise<void>;
}

function harness(options: { maxMembers?: number; reconnectGraceMs?: number } = {}): Harness {
  let clock = 1_700_000_000_000;
  const hub = new Hub({
    now: () => clock,
    reconnectGraceMs: options.reconnectGraceMs ?? 60_000,
    maxMembers: options.maxMembers,
    maxRooms: 100,
    randomCode: () => 'ABC234',
  });
  return {
    hub,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    connect: () => {
      const socket = new FakeSocket();
      const conn = hub.register(socket);
      return { socket, conn };
    },
    send: async (conn, msg) => {
      await hub.handle(conn, JSON.stringify(msg));
    },
  };
}

const me = (clientId: string, name = 'Ada') => ({ name, clientId, protocol: 2 });

async function createRoom(h: Harness, name = 'Ada', roomName = 'Design sync', passcode?: string) {
  const { socket, conn } = h.connect();
  await h.send(conn, { t: 'join', mode: 'create', ...me(conn.id, name), roomName, ...(passcode ? { passcode } : {}) });
  const joined = socket.last('joined');
  if (!joined) throw new Error(`expected joined message: ${JSON.stringify(socket.messages)}`);
  return { socket, conn, joined };
}

async function joinRoom(h: Harness, code: string, name: string, clientId: string, passcode?: string) {
  const { socket, conn } = h.connect();
  await h.send(conn, { t: 'join', mode: 'enter', ...me(clientId, name), code, ...(passcode ? { passcode } : {}) });
  return { socket, conn };
}

async function enterRoom(h: Harness, code: string, name: string, clientId: string, passcode?: string) {
  const result = await joinRoom(h, code, name, clientId, passcode);
  const joined = result.socket.last('joined');
  if (!joined) throw new Error(`expected joined message: ${JSON.stringify(result.socket.messages)}`);
  return { ...result, joined };
}

async function attemptEnterRoom(h: Harness, code: string, name: string, clientId: string, passcode?: string) {
  return joinRoom(h, code, name, clientId, passcode);
}

/** Replay presence messages from one socket into a current roster. */
function roster(socket: FakeSocket, joined: JoinedMessage): Member[] {
  const members = new Map(joined.members.map((member) => [member.id, member]));
  for (const message of socket.messages) {
    if (message.t === 'member_joined' || message.t === 'member_updated') {
      members.set(message.member.id, message.member);
    } else if (message.t === 'member_left') {
      members.delete(message.id);
    }
  }
  return [...members.values()];
}

describe('room lifecycle', () => {
  it('creates a room and lets a second person join', async () => {
    const h = harness();
    const a = await createRoom(h, 'Ada');
    expect(a.joined.room.code).toBe('ABC234');
    expect(a.joined.room.name).toBe('Design sync');
    expect(a.joined.me.host).toBe(true);
    expect(a.joined.members).toHaveLength(1);
    expect(a.joined.room.hasPasscode).toBe(false);

    const b = await enterRoom(h, 'ABC234', 'Grace', 'client-grace-0001');
    expect(b.joined.me.host).toBe(false);
    expect(b.joined.members).toHaveLength(2);
    expect(b.joined.members.find((m) => m.name === 'Ada')?.host).toBe(true);
    expect(a.socket.last('member_joined')?.member.name).toBe('Grace');
  });

  it('rejects a missing room and missing names', async () => {
    const h = harness();
    const { socket, conn } = h.connect();
    await h.send(conn, { t: 'join', mode: 'enter', ...me('client-missing-1', 'Ada'), code: 'ZZZZZZ' });
    expect(socket.last('error')?.code).toBe('room_not_found');

    const second = h.connect();
    await h.send(second.conn, { t: 'join', mode: 'create', ...me('client-badname-1', '   '), roomName: 'x' });
    expect(second.socket.last('error')?.code).toBe('bad_request');
  });

  it('requires the passcode and keeps it out of room metadata', async () => {
    const h = harness();
    const a = await createRoom(h, 'Ada', 'Secret', '1234');
    expect(a.joined.room.hasPasscode).toBe(true);
    expect(JSON.stringify(a.joined)).not.toContain('1234');

    const wrong = await attemptEnterRoom(h, 'ABC234', 'Mallory', 'client-mallory-1', '9999');
    expect(wrong.socket.last('error')?.code).toBe('bad_passcode');

    const right = await enterRoom(h, 'ABC234', 'Grace', 'client-grace-0001', '1234');
    expect(right.joined.me.id).toBeTruthy();
    expect(right.joined.members).toHaveLength(2);
  });

  it('locks the room for new people but lets a dropped member resume', async () => {
    const h = harness();
    const a = await createRoom(h, 'Ada');
    const b = await enterRoom(h, 'ABC234', 'Grace', 'client-grace-0001');

    await h.send(a.conn, { t: 'lock', locked: true });
    expect(a.socket.last('room_updated')?.room.locked).toBe(true);

    const blocked = await attemptEnterRoom(h, 'ABC234', 'Mallory', 'client-mallory-1');
    expect(blocked.socket.last('error')?.code).toBe('room_locked');

    h.hub.unregister(b.conn);
    const resumed = await enterRoom(h, 'ABC234', 'Grace', 'client-grace-0001');
    expect(resumed.joined.me.id).toBe(b.joined.me.id);
  });

  it('only the host can lock or end', async () => {
    const h = harness();
    await createRoom(h, 'Ada');
    const b = await enterRoom(h, 'ABC234', 'Grace', 'client-grace-0001');

    await h.send(b.conn, { t: 'lock', locked: true });
    expect(b.socket.last('error')?.code).toBe('not_host');
    await h.send(b.conn, { t: 'end' });
    expect(b.socket.last('error')?.code).toBe('not_host');
  });

  it('ends a room for everyone and closes the sockets', async () => {
    const h = harness();
    const a = await createRoom(h, 'Ada');
    const b = await enterRoom(h, 'ABC234', 'Grace', 'client-grace-0001');

    await h.send(a.conn, { t: 'end' });
    expect(b.socket.last('closed')).toMatchObject({ reason: 'ended', by: 'Ada' });
    expect(b.socket.closed).toBe(true);
    expect(a.socket.closed).toBe(true);
    expect(h.hub.lookup('ABC234')).toBeNull();
  });

  it('transfers host when the host leaves', async () => {
    const h = harness();
    const a = await createRoom(h, 'Ada');
    const b = await enterRoom(h, 'ABC234', 'Grace', 'client-grace-0001');

    await h.send(a.conn, { t: 'leave' });
    expect(b.socket.last('member_left')?.id).toBe(a.joined.me.id);
    const updated = b.socket.last('member_updated');
    expect(updated?.member.name).toBe('Grace');
    expect(updated?.member.host).toBe(true);
  });

  it('expires idle rooms only after the TTL', async () => {
    const h = harness();
    const a = await createRoom(h, 'Ada');
    h.hub.leave(a.conn);
    h.hub.sweep();
    expect(h.hub.lookup('ABC234')).not.toBeNull();
    h.advance(31 * 60 * 1_000);
    h.hub.sweep();
    expect(h.hub.lookup('ABC234')).toBeNull();
  });

  it('removes disconnected members after the grace window', async () => {
    const h = harness({ reconnectGraceMs: 5 });
    const a = await createRoom(h, 'Ada');
    const b = await enterRoom(h, 'ABC234', 'Grace', 'client-grace-0001');
    h.hub.unregister(b.conn);
    expect(a.socket.last('member_updated')?.member.connected).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.hub.lookup('ABC234')?.memberCount).toBe(1);
  });
});

describe('speaking queue', () => {
  it('orders raised hands by signal time', async () => {
    const h = harness();
    const a = await createRoom(h, 'Ada');
    const b = await enterRoom(h, 'ABC234', 'Grace', 'client-grace-0001');

    h.advance(1_000);
    await h.send(b.conn, { t: 'intent', intent: 'queued' });
    h.advance(1_000);
    await h.send(a.conn, { t: 'intent', intent: 'queued' });

    const order = queueOf(roster(b.socket, b.joined)).map((member) => member.name);
    expect(order).toEqual(['Grace', 'Ada']);

    const grace = roster(b.socket, b.joined).find((member) => member.name === 'Grace');
    expect(grace?.queuedAt).toBe(h.now() - 1_000);
  });

  it('re-queues at the back when a hand is lowered and raised again', async () => {
    const h = harness();
    const a = await createRoom(h, 'Ada');
    const b = await enterRoom(h, 'ABC234', 'Grace', 'client-grace-0001');

    await h.send(b.conn, { t: 'intent', intent: 'queued' });
    h.advance(1_000);
    await h.send(a.conn, { t: 'intent', intent: 'queued' });

    await h.send(b.conn, { t: 'intent', intent: 'listening' });
    expect(queueOf(roster(a.socket, a.joined)).map((m) => m.name)).toEqual(['Ada']);

    h.advance(1_000);
    await h.send(b.conn, { t: 'intent', intent: 'queued' });
    expect(queueOf(roster(a.socket, a.joined)).map((m) => m.name)).toEqual(['Ada', 'Grace']);
  });

  it('preserves queue position while reconnecting', async () => {
    const h = harness();
    await createRoom(h, 'Ada');
    const b = await enterRoom(h, 'ABC234', 'Grace', 'client-grace-0001');
    await h.send(b.conn, { t: 'intent', intent: 'queued' });
    const queuedAt = h.now();
    h.hub.unregister(b.conn);

    const resumed = await enterRoom(h, 'ABC234', 'Grace', 'client-grace-0001');
    const self = resumed.joined.members.find((m) => m.id === resumed.joined.me.id);
    expect(self).toMatchObject({ intent: 'queued', queuedAt, connected: true });
  });

  it('lets a person lower their hand', async () => {
    const h = harness();
    const a = await createRoom(h, 'Ada');
    await h.send(a.conn, { t: 'intent', intent: 'queued' });
    await h.send(a.conn, { t: 'intent', intent: 'listening' });
    expect(a.socket.last('member_updated')?.member).toMatchObject({
      intent: 'listening',
      queuedAt: null,
    });
  });
});

describe('capacity and identity', () => {
  it('enforces a configurable member limit', async () => {
    const h = harness({ maxMembers: 2 });
    await createRoom(h, 'Ada');
    await enterRoom(h, 'ABC234', 'Grace', 'client-grace-0001');
    const third = await attemptEnterRoom(h, 'ABC234', 'Mallory', 'client-mallory-1');
    expect(third.socket.last('error')?.code).toBe('room_full');
  });

  it('caps rooms at eight people by default', async () => {
    const h = harness();
    await createRoom(h, 'Ada');
    for (let i = 0; i < 7; i += 1) {
      await enterRoom(h, 'ABC234', `Member ${i + 1}`, `client-member-${i + 1}`);
    }
    const ninth = await attemptEnterRoom(h, 'ABC234', 'Ninth', 'client-ninth-0001');
    expect(ninth.socket.last('error')?.code).toBe('room_full');
  });

  it('assigns distinct colours to members', async () => {
    const h = harness();
    const a = await createRoom(h, 'Ada');
    const b = await enterRoom(h, 'ABC234', 'Grace', 'client-grace-0001');
    const colors = new Set(b.joined.members.map((m) => m.color));
    expect(colors.size).toBe(2);
    expect(a.joined.members[0]?.color).not.toBeUndefined();
  });
});

