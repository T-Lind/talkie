/**
 * End-to-end smoke test against the built server (no Electron needed).
 * Run with: npm run smoke
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;

class Client {
  constructor() {
    this.messages = [];
    this.socket = new WebSocket(WS);
    this.socket.on('message', (raw) => {
      try {
        this.messages.push(JSON.parse(String(raw)));
      } catch {
        // ignore
      }
    });
  }

  async open() {
    if (this.socket.readyState === WebSocket.OPEN) return this;
    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    return this;
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(type, predicate = () => true, timeoutMs = 6000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = this.messages.find((m) => m.t === type && predicate(m));
      if (found) return found;
      await sleep(30);
    }
    throw new Error(
      `Timed out waiting for "${type}". Got: ${JSON.stringify(this.messages.slice(-6))}`,
    );
  }

  close() {
    this.socket.close();
  }
}

async function waitForServer(timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error('server did not start');
}

const server = spawn(process.execPath, ['apps/server/dist/server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LOG_LEVEL: 'error' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

server.stderr.on('data', (chunk) => process.stderr.write(chunk));

let a;
let b;

try {
  await waitForServer();

  a = await new Client().open();
  a.send({
    t: 'join',
    mode: 'create',
    name: 'Ada',
    roomName: 'Smoke test',
    clientId: 'smoke-ada-0001',
    protocol: 2,
  });
  const joinedA = await a.waitFor('joined');
  const code = joinedA.room.code;
  assert.equal(joinedA.members.length, 1);

  b = await new Client().open();
  b.send({
    t: 'join',
    mode: 'enter',
    code,
    name: 'Grace',
    clientId: 'smoke-grace-0001',
    protocol: 2,
  });
  const joinedB = await b.waitFor('joined');
  assert.equal(joinedB.members.length, 2);
  assert.equal(joinedB.me.host, false);

  b.send({ t: 'intent', intent: 'queued' });
  const graceQueued = await a.waitFor(
    'member_updated',
    (m) => m.member.id === joinedB.me.id && m.member.intent === 'queued',
  );
  assert.ok(graceQueued.member.queuedAt);

  a.send({ t: 'intent', intent: 'queued' });
  const roster = await b.waitFor(
    'member_updated',
    (m) => m.member.id === joinedA.me.id && m.member.intent === 'queued',
  );
  assert.equal(roster.member.name, 'Ada');

  b.close();
  await sleep(150);
  const b2 = await new Client().open();
  b2.send({
    t: 'join',
    mode: 'enter',
    code,
    name: 'Grace',
    clientId: 'smoke-grace-0001',
    protocol: 2,
  });
  const resumed = await b2.waitFor('joined');
  const self = resumed.members.find((m) => m.id === resumed.me.id);
  assert.equal(self?.intent, 'queued');
  assert.equal(resumed.members.length, 2);
  b = b2;

  a.send({ t: 'end' });
  const closed = await b.waitFor('closed');
  assert.equal(closed.reason, 'ended');

  await sleep(120);
  const health = await (await fetch(`${BASE}/healthz`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.rooms, 0);

  console.log('smoke ok — create, join, queue, reconnect, end');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  a?.close();
  b?.close();
  server.kill();
}
