/**
 * codex-remote 桥接服务 v2
 * 手机(WebSocket) <-> 本服务 <-> 多个 codex app-server（本机 + SSH 远程机器）
 *
 * v2 变化：
 * - 多后端：机器 = local | ssh，每台独立 JSON-RPC 通道，手机按 machineId 切换
 * - 白名单扩充：模型/effort/沙箱/压缩/重命名/MCP 状态等
 * - initialize 带 experimentalApi capability
 * - 通知与审批请求全量透传（带 machineId 标记来源）
 */
import http from 'node:http';
import * as os from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { config, ROOT, loadOrCreateToken } from './config.mjs';
import {
  loadMachines, upsertMachine, deleteMachine, ensureConnection,
  closeConnection, listConnections, shutdownAllConnections,
} from './machines.mjs';

const tokenRec = loadOrCreateToken();
const pendingApprovals = new Map();
const approvalKey = (machineId, id) => JSON.stringify([machineId, id]);
function publishApprovals() {
  broadcast({ type: 'bridge', event: 'approvals', data: { requests: [...pendingApprovals.values()].map(entry => entry.request) } }, true);
}
function clearApprovals(machineId, predicate = () => true) {
  let changed = false;
  for (const [key, entry] of pendingApprovals) {
    if (entry.request.machineId === machineId && predicate(entry.request)) { pendingApprovals.delete(key); changed = true; }
  }
  if (changed) publishApprovals();
}
const VUE_PUBLIC_DIR = path.join(ROOT, 'public-vue');
const BRIDGE_VERSION = '0.2.0';
const startedAt = Date.now();

// ---- 允许手机直连调用的 app-server 方法（可按需增删）----
const ALLOWED_CLIENT_METHODS = new Set([
  'thread/start', 'thread/list', 'thread/read', 'thread/resume', 'thread/fork',
  'thread/delete', 'thread/archive', 'thread/unarchive', 'thread/name/set',
  'thread/turns/list', 'thread/items/list', 'thread/search', 'thread/loaded/list',
  'turn/start', 'turn/steer', 'turn/interrupt',
  'thread/settings/update', 'thread/compact/start',
  'thread/queue/add', 'thread/queue/list', 'thread/queue/update',
  'thread/queue/delete', 'thread/queue/reorder', 'thread/queue/start',
  'thread/rollback', 'thread/revert',
  'model/list', 'account/rateLimits/read',
  'permissionProfile/list', 'mcpServerStatus/list', 'skills/list',
  'server/diagnostics',
]);

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

const httpServer = new http.createServer((req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    // Deliberately omit machine names, hosts, workspaces and token: health
    // endpoints are frequently polled by infrastructure outside the LAN.
    res.end(JSON.stringify({
      ok: true,
      version: BRIDGE_VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      clients: clients.size,
      machines: listConnections().map(({ ready, dead }) => ({ ready, dead })),
    }));
    return;
  }
  // 旧版本曾在根作用域注册 Service Worker；保留退役端点以清缓存并注销。
  if (url.pathname === '/sw.js') {
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      'service-worker-allowed': '/',
    });
    res.end(`
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const key of await caches.keys()) await caches.delete(key);
  await self.registration.unregister();
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) client.navigate(client.url);
})()));`);
    return;
  }
  serveStatic(url.pathname, res);
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic(pathname, res) {
  if (!existsSync(path.join(VUE_PUBLIC_DIR, 'index.html'))) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('web app is not built; run npm run build:web');
    return;
  }
  const staticRoot = VUE_PUBLIC_DIR;
  const requestPath = pathname;
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^[/\\]+/, '');
  const p = path.resolve(staticRoot, relativePath);
  if (p !== staticRoot && !p.startsWith(staticRoot + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    const data = readFileSync(p);
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

// ---- WebSocket ----
// Four 1600px data-URL images can exceed 1 MiB, but keep a finite ceiling so
// malformed clients cannot allocate unbounded memory.
const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 16 * 1024 * 1024 });
const clients = new Set();
const CLIENT_HIGH_WATER_MARK = 1024 * 1024;
const CLIENT_QUEUE_LIMIT = 2 * 1024 * 1024;
const CLIENT_QUEUE_MESSAGES = 500;
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_FAILURES = 5;
const authFailures = new Map();

wss.on('connection', (ws, req) => {
  const remoteId = req.socket?.remoteAddress || 'unknown';
  if (!originAllowed(req) || !authAllowed(remoteId)) { rejectAuthentication(ws, remoteId); return; }
  const authTimer = setTimeout(() => rejectAuthentication(ws, remoteId), 5000);
  authTimer.unref?.();
  ws.once('close', () => clearTimeout(authTimer));
  ws.once('error', () => clearTimeout(authTimer));
  ws.once('message', (raw) => {
    clearTimeout(authTimer);
    let message;
    try { message = raw.length <= 1024 ? JSON.parse(raw.toString()) : null; } catch { message = null; }
    if (message?.kind !== 'auth' || !tokensEqual(message.token, tokenRec.token)) {
      rejectAuthentication(ws, remoteId);
      return;
    }
    authFailures.delete(remoteId);
    acceptClient(ws);
  });
});

function acceptClient(ws) {
  clients.add(ws);
  ws._machineId = 'local';
  ws._bridgeQueue = [];
  ws._bridgeQueueBytes = 0;
  ws._bridgeFlushTimer = null;
  ws.isAlive = true;
  log('手机已连接');
  safeSend(ws, {
    type: 'bridge', event: 'hello',
    data: {
      machines: clientMachines(),
      connections: listConnections(),
      approvals: [...pendingApprovals.values()].map(entry => entry.request),
      config: { workspace: config.workspace, proxy: !!config.proxy },
    },
  }, true);

  // 连接所有已登记机器（local 必连；ssh 惰性连接由手机触发）
  ensureConnection('local').catch(e => log('local 连接失败:', e.message));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch {
      log('WS 消息 JSON 无法解析');
      safeSend(ws, { type: 'bridge', event: 'error', data: { message: '消息格式无效' } }, true);
      return;
    }
    handleClientMessage(ws, msg).catch(e => {
      safeSend(ws, { type: 'bridge', event: 'error', data: { machineId: msg.data?.id ?? msg.machineId, message: String(e?.message || e) } }, true);
    });
  });
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => { cleanupClient(ws); log('手机已断开'); });
  ws.on('error', () => { cleanupClient(ws); try { ws.close(); } catch {} });
}

function rejectAuthentication(ws, remoteId) {
  if (ws._authRejected) return;
  ws._authRejected = true;
  recordAuthFailure(remoteId);
  try { ws.send(JSON.stringify({ type: 'bridge', event: 'auth.failed' })); } catch {}
  setTimeout(() => { try { ws.close(1008, 'authentication failed'); } catch {} }, 100).unref?.();
  log('WS 拒绝：鉴权失败');
}

function tokensEqual(actual, expected) {
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

function originAllowed(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  const forwardedHost = config.trustProxy ? String(req.headers?.['x-forwarded-host'] || '').split(',')[0].trim() : '';
  const expectedHost = forwardedHost || req.headers?.host;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.host === expectedHost;
  } catch { return false; }
}

function authAllowed(remoteId) {
  const record = authFailures.get(remoteId);
  if (!record || Date.now() - record.startedAt >= AUTH_WINDOW_MS) return true;
  return record.count < AUTH_MAX_FAILURES;
}

function recordAuthFailure(remoteId) {
  const now = Date.now();
  const record = authFailures.get(remoteId);
  authFailures.set(remoteId, !record || now - record.startedAt >= AUTH_WINDOW_MS
    ? { count: 1, startedAt: now }
    : { count: record.count + 1, startedAt: record.startedAt });
  if (authFailures.size > 1000) {
    for (const [key, value] of authFailures) if (now - value.startedAt >= AUTH_WINDOW_MS) authFailures.delete(key);
  }
}

function publicMachine(machine) {
  const { sshKey, ...safe } = machine;
  return { ...safe, sshKeyConfigured: !!sshKey };
}

function clientMachines() { return loadMachines().map(publicMachine); }

function safeSend(ws, obj, critical = false) {
  if (ws.readyState !== ws.OPEN) return false;
  const payload = JSON.stringify(obj);
  const queued = ws._bridgeQueue ?? (ws._bridgeQueue = []);
  const blocked = ws.bufferedAmount > CLIENT_HIGH_WATER_MARK || queued.length > 0;
  if (blocked) {
    const wouldExceed = (ws._bridgeQueueBytes ?? 0) + Buffer.byteLength(payload) > CLIENT_QUEUE_LIMIT
      || queued.length >= CLIENT_QUEUE_MESSAGES;
    if (wouldExceed) {
      // Do not silently lose streamed answers, terminal output, RPC results, or
      // permission prompts. Reconnecting gives the client one coherent resync.
      log('WS 客户端过慢，关闭以重新同步');
      try { ws.close(1013, 'client too slow; reconnect to resync'); } catch {}
      return false;
    }
    queued.push(payload);
    ws._bridgeQueueBytes = (ws._bridgeQueueBytes ?? 0) + Buffer.byteLength(payload);
    scheduleFlush(ws);
    return true;
  }
  try { ws.send(payload); return true; } catch { return false; }
}

function scheduleFlush(ws) {
  if (ws._bridgeFlushTimer || ws.readyState !== ws.OPEN) return;
  ws._bridgeFlushTimer = setTimeout(() => {
    ws._bridgeFlushTimer = null;
    flushClient(ws);
  }, 35);
  ws._bridgeFlushTimer.unref?.();
}

function cleanupClient(ws) {
  clients.delete(ws);
  if (ws._bridgeFlushTimer) clearTimeout(ws._bridgeFlushTimer);
  ws._bridgeFlushTimer = null;
  ws._bridgeQueue = [];
  ws._bridgeQueueBytes = 0;
}

function flushClient(ws) {
  if (ws.readyState !== ws.OPEN) return;
  if (ws.bufferedAmount > CLIENT_HIGH_WATER_MARK) {
    if (ws._bridgeQueue?.length) scheduleFlush(ws);
    return;
  }
  while (ws._bridgeQueue?.length && ws.bufferedAmount <= CLIENT_HIGH_WATER_MARK) {
    const payload = ws._bridgeQueue.shift();
    ws._bridgeQueueBytes = Math.max(0, (ws._bridgeQueueBytes ?? 0) - Buffer.byteLength(payload));
    try { ws.send(payload); } catch { break; }
  }
  if (ws._bridgeQueue?.length) scheduleFlush(ws);
}

const heartbeat = setInterval(() => {
  for (const ws of clients) {
    if (ws.isAlive === false) {
      log('WS 心跳超时，终止半开连接');
      cleanupClient(ws);
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.isAlive = false;
    flushClient(ws);
    try { ws.ping(); } catch {}
  }
}, 30000);
heartbeat.unref?.();

async function handleClientMessage(ws, msg) {
  // 机器管理（桥接层自己的命令，不透传给 codex）
  if (msg.kind === 'machine') {
    const payload = msg.data ?? msg;
    if (msg.action === 'list') {
      safeSend(ws, { type: 'bridge', event: 'machines', data: { machines: clientMachines(), connections: listConnections() } }, true);
    } else if (msg.action === 'add') {
      const rec = upsertMachine(payload);
      // Replacing a machine's settings needs a fresh app-server process.
      detachConnection(rec.id);
      await closeConnection(rec.id);
      broadcast({ type: 'bridge', event: 'machine.added', data: publicMachine(rec) }, true);
      broadcastMachines();
      await attachConnection(rec.id);
    } else if (msg.action === 'delete') {
      detachConnection(payload.id);
      await closeConnection(payload.id);
      deleteMachine(payload.id);
      broadcast({ type: 'bridge', event: 'machine.deleted', data: { id: payload.id } }, true);
      broadcastMachines();
    } else if (msg.action === 'connect') {
      ws._machineId = payload.id;
      await attachConnection(payload.id, ws);
    } else if (msg.action === 'reconnect') {
      await attachConnection(payload.id, ws);
    }
    return;
  }

  // RPC：透传给指定机器的 codex
  if (msg.kind === 'rpc') {
    if (!ALLOWED_CLIENT_METHODS.has(msg.method)) {
      safeSend(ws, { type: 'bridge', event: 'rpc.error', data: { ref: msg.ref, message: `方法不在白名单: ${msg.method}` } }, true);
      return;
    }
    const machineId = msg.machineId || 'local';
    try {
      const conn = await attachConnection(machineId);
      const result = await conn.request(msg.method, msg.params ?? {});
      safeSend(ws, { type: 'bridge', event: 'rpc.result', data: { ref: msg.ref, result } }, true);
    } catch (e) {
      safeSend(ws, { type: 'bridge', event: 'rpc.error', data: { ref: msg.ref, message: String(e?.message || e) } }, true);
    }
    return;
  }

  // 审批答复
  if (msg.kind === 'serverReply') {
    const key = approvalKey(msg.machineId || 'local', msg.id);
    const entry = pendingApprovals.get(key);
    if (!entry || entry.replying) { publishApprovals(); return; }
    entry.replying = true;
    try {
      await entry.conn.replyToServer(msg.id, msg.result ?? { decision: 'decline' });
      if (pendingApprovals.get(key) === entry) pendingApprovals.delete(key);
      publishApprovals();
    } catch (error) { entry.replying = false; publishApprovals(); throw error; }
    return;
  }
}

// 通知/审批转发：给每台机器的连接挂监听（连接建立后事件带 machineId 广播给手机）
const attached = new Map(); // machineId -> { conn, detach }
const attaching = new Map();
const attachmentEpoch = new Map();
const CONNECTION_SUMMARY_EVENTS = new Set(['ready', 'exit', 'reconnecting', 'initializeFailed']);
async function attachConnection(machineId, ws) {
  const current = attached.get(machineId);
  if (current && !current.conn.dead) {
    if (ws) safeSend(ws, { type: 'bridge', event: 'machine.state', data: { machineId, type: current.conn.ready ? 'ready' : 'starting' } }, true);
    return current.conn;
  }
  if (current) detachConnection(machineId);
  if (attaching.has(machineId)) {
    const conn = await attaching.get(machineId);
    if (ws) safeSend(ws, { type: 'bridge', event: 'machine.state', data: { machineId, type: conn.ready ? 'ready' : 'starting' } }, true);
    return conn;
  }
  const epoch = attachmentEpoch.get(machineId) ?? 0;
  const pending = (async () => {
    const conn = await ensureConnection(machineId);
    // A concurrent delete/update may have completed while the connection was starting.
    if (epoch !== (attachmentEpoch.get(machineId) ?? 0) || !loadMachines().some(m => m.id === machineId)) throw new Error('机器配置已变更');
    const detach = [
      conn.on('notification', (m) => {
        if (m.method === 'serverRequest/resolved') clearApprovals(machineId, request => request.id === m.params?.requestId);
        if (m.method === 'turn/completed') clearApprovals(machineId, request => request.params?.threadId === m.params?.threadId && request.params?.turnId === m.params?.turn?.id);
        broadcast({ type: 'codex', event: 'notification', data: m });
      }),
      conn.on('serverRequest', (m) => {
        pendingApprovals.set(approvalKey(machineId, m.id), { conn, request: m, replying: false });
        publishApprovals();
        broadcast({ type: 'codex', event: 'serverRequest', data: m }, true);
      }),
      conn.on('state', (s) => {
        if (CONNECTION_SUMMARY_EVENTS.has(s.type)) {
          if (s.type === 'exit' || s.type === 'initializeFailed') clearApprovals(machineId);
          broadcast({ type: 'bridge', event: 'machine.state', data: { machineId, ...s } }, true);
          broadcastMachines();
        } else {
          // Parse/write diagnostics help troubleshooting but must not cause a
          // full machine-list broadcast for every malformed protocol line.
          broadcast({ type: 'bridge', event: 'machine.diagnostic', data: { machineId, ...s } });
        }
      }),
    ];
    attached.set(machineId, { conn, detach: () => detach.forEach(fn => fn()) });
    return conn;
  })();
  attaching.set(machineId, pending);
  try {
    const conn = await pending;
    if (ws) safeSend(ws, { type: 'bridge', event: 'machine.state', data: { machineId, type: conn.ready ? 'ready' : 'starting' } }, true);
    return conn;
  } finally {
    if (attaching.get(machineId) === pending) attaching.delete(machineId);
  }
}

function detachConnection(machineId) {
  clearApprovals(machineId);
  attachmentEpoch.set(machineId, (attachmentEpoch.get(machineId) ?? 0) + 1);
  attaching.delete(machineId);
  const record = attached.get(machineId);
  if (record) {
    record.detach();
    attached.delete(machineId);
  }
}

function broadcastMachines() {
  broadcast({ type: 'bridge', event: 'machines', data: { machines: clientMachines(), connections: listConnections() } }, true);
}

// 保证 local 的监听也挂上（启动即连）
attachConnection('local').catch(() => {});

function broadcast(obj, critical = false) {
  const scoped = obj.type === 'codex' && obj.event === 'notification'
    && !['turn/started', 'turn/completed', 'thread/status/changed'].includes(obj.data?.method);
  for (const ws of clients) {
    if (scoped && obj.data?.machineId && ws._machineId !== obj.data.machineId) continue;
    safeSend(ws, obj, critical);
  }
}

function log(...a) {
  console.log(`[${new Date().toLocaleTimeString()}]`, ...a);
}

// ---- 启动 ----
httpServer.listen(config.port, config.host, () => {
  log('codex-remote 桥接服务 v2 已启动');
  log(`  本机访问   http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`);
  for (const ip of localIps()) log(`  局域网访问 http://${ip}:${config.port}`);
  if (config.tokenMode === 'strong') log('  强 Token 已保存到 data/token.json（不会写入日志）');
  else log(`  配对码: ${tokenRec.token}`);
  log(`  已登记机器: ${loadMachines().length} 台`);
});

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收到 ${signal}，正在关闭服务…`);
  clearInterval(heartbeat);
  const closingClients = [...clients];
  for (const ws of closingClients) {
    try { ws.close(1001, 'server shutting down'); } catch {}
  }
  // A browser suspended by a phone OS may never complete the close handshake.
  // Bound shutdown time and release those sockets before closing the server.
  await new Promise(resolve => setTimeout(resolve, 250));
  for (const ws of closingClients) {
    if (ws.readyState !== ws.CLOSED) { try { ws.terminate(); } catch {} }
    cleanupClient(ws);
  }
  await shutdownAllConnections();
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => httpServer.close(resolve));
}

process.once('SIGINT', () => { gracefulShutdown('SIGINT').catch(error => log('关闭失败', error?.message)); });
process.once('SIGTERM', () => { gracefulShutdown('SIGTERM').catch(error => log('关闭失败', error?.message)); });

function localIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}
