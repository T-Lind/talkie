import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { LIMITS, PROTOCOL_VERSION, type RoomLookup } from '@talkie/protocol';
import { config } from './config';
import { Hub, type Connection } from './hub';
import { logger } from './logger';

const STARTED_AT = Date.now();

const hub = new Hub({
  log: (event, data) => logger.debug(event, data),
  reconnectGraceMs: config.reconnectGraceMs,
  roomIdleMs: config.roomIdleMs,
  roomMaxAgeMs: config.roomMaxAgeMs,
  maxRooms: config.maxRooms,
});

function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = value?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function commonHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const lookupBuckets = new Map<string, { tokens: number; updatedAt: number }>();

function allowLookup(ip: string): boolean {
  const now = Date.now();
  let bucket = lookupBuckets.get(ip);
  if (!bucket) {
    bucket = { tokens: 30, updatedAt: now };
    lookupBuckets.set(ip, bucket);
  }
  const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(30, bucket.tokens + elapsed * 0.5);
  bucket.updatedAt = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

const lookupSweep = setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1_000;
  for (const [ip, bucket] of lookupBuckets) {
    if (bucket.updatedAt < cutoff) lookupBuckets.delete(ip);
  }
}, 5 * 60 * 1_000);
lookupSweep.unref();

const upgradeBuckets = new Map<string, { tokens: number; updatedAt: number }>();
const ipConnections = new Map<string, number>();

function allowUpgrade(ip: string): boolean {
  const now = Date.now();
  let bucket = upgradeBuckets.get(ip);
  if (!bucket) {
    bucket = { tokens: 20, updatedAt: now };
    upgradeBuckets.set(ip, bucket);
  }
  const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
  bucket.tokens = Math.min(20, bucket.tokens + elapsed * 0.5);
  bucket.updatedAt = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function originAllowed(origin: string | undefined): boolean {
  if (config.origins.length === 0) return true;
  // Electron's file:// renderer and other native clients may omit an origin.
  if (!origin || origin === 'null' || origin.startsWith('file://')) return true;
  return config.origins.includes(origin);
}

const server = createServer((req, res) => {
  commonHeaders(res);
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method_not_allowed' });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/api') {
    json(res, 200, {
      service: 'team-talkie',
      status: 'ok',
      version: config.version,
      protocol: PROTOCOL_VERSION,
      websocket: '/ws',
      health: '/healthz',
      endpoints: {
        health: 'GET /healthz',
        room: 'GET /api/rooms/:code',
        realtime: 'WS /ws',
      },
    });
    return;
  }

  if (url.pathname === '/healthz') {
    const stats = hub.stats();
    json(res, 200, {
      ok: true,
      service: 'team-talkie',
      version: config.version,
      protocol: PROTOCOL_VERSION,
      uptimeMs: Date.now() - STARTED_AT,
      rooms: stats.rooms,
      members: stats.members,
      connections: stats.connections,
    });
    return;
  }

  const roomMatch = /^\/api\/rooms\/([a-zA-Z0-9]{4,16})$/.exec(url.pathname);
  if (roomMatch) {
    const ip = clientIp(req);
    if (!allowLookup(ip)) {
      json(res, 429, { error: 'rate_limited' });
      return;
    }
    const code = roomMatch[1]?.toUpperCase() ?? '';
    const room = hub.lookup(code);
    if (!room) {
      json(res, 404, { error: 'room_not_found' });
      return;
    }
    const body: RoomLookup = {
      exists: true,
      room: {
        code: room.code,
        name: room.name,
        hasPasscode: room.hasPasscode,
        locked: room.locked,
        memberCount: room.memberCount,
      },
    };
    json(res, 200, body);
    return;
  }

  json(res, 404, { error: 'not_found' });
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: LIMITS.payloadBytes,
  perMessageDeflate: false,
  clientTracking: true,
});

interface TrackedSocket extends WebSocket {
  isAlive?: boolean;
}

server.on('upgrade', (req: IncomingMessage, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!originAllowed(req.headers.origin)) {
    logger.warn('ws.origin_rejected', { origin: req.headers.origin ?? '' });
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const ip = clientIp(req);
  if (!allowUpgrade(ip)) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    (req as IncomingMessage & { talkieIp?: string }).talkieIp = ip;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws: TrackedSocket, req: IncomingMessage) => {
  const ip = (req as IncomingMessage & { talkieIp?: string }).talkieIp ?? 'unknown';

  if (wss.clients.size > config.maxConnections) {
    ws.close(1013, 'Server busy');
    return;
  }
  const activeFromIp = ipConnections.get(ip) ?? 0;
  if (activeFromIp >= config.maxConnectionsPerIp) {
    ws.close(1013, 'Too many connections');
    return;
  }
  ipConnections.set(ip, activeFromIp + 1);

  const conn: Connection = hub.register(ws, ip);
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Serialize messages per connection: scrypt verification in the join path is
  // async, and we must not process a follow-up "intent" before the join lands.
  let chain = Promise.resolve();
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      ws.close(1003, 'Text messages only');
      return;
    }
    chain = chain
      .then(() => hub.handle(conn, data as Buffer))
      .catch((error: unknown) => {
        logger.error('ws.message_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });

  ws.on('close', () => {
    hub.unregister(conn);
    const remaining = (ipConnections.get(ip) ?? 1) - 1;
    if (remaining <= 0) ipConnections.delete(ip);
    else ipConnections.set(ip, remaining);
  });
  ws.on('error', (error) => {
    logger.warn('ws.error', { message: error.message });
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const tracked = ws as TrackedSocket;
    if (tracked.isAlive === false) {
      tracked.terminate();
      continue;
    }
    tracked.isAlive = false;
    try {
      tracked.ping();
    } catch {
      // Ignore closed sockets.
    }
  }
}, 30_000);
heartbeat.unref();

hub.startSweeper();

server.listen(config.port, config.host, () => {
  logger.info('server.listening', {
    host: config.host,
    port: config.port,
    version: config.version,
    protocol: PROTOCOL_VERSION,
    origins: config.origins.length ? config.origins : 'any',
  });
});

server.on('error', (error) => {
  logger.error('server.error', { message: error.message });
  process.exitCode = 1;
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('server.shutdown', { signal });
  clearInterval(heartbeat);
  for (const ws of wss.clients) {
    try {
      ws.close(1001, 'Server restarting');
    } catch {
      // Ignore.
    }
  }
  wss.close();
  hub.destroy();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  logger.error('process.unhandled_rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});
