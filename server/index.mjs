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
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { config, PUBLIC_DIR, loadOrCreateToken } from './config.mjs';
import {
  loadMachines, upsertMachine, deleteMachine, ensureConnection,
  closeConnection, listConnections,
} from './machines.mjs';

const tokenRec = loadOrCreateToken();
const VUE_PUBLIC_DIR = path.join(path.dirname(PUBLIC_DIR), 'public-vue');

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

const httpServer = new http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // v4 迁移：旧版 PWA 曾在根作用域注册 Service Worker，会继续缓存旧首页。
  // 根路径返回一个退役 worker，接管后清除旧缓存并注销；legacy 版改在 /legacy/ 独立作用域运行。
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
  if (pathname === '/legacy') {
    res.writeHead(302, { location: '/legacy/' });
    res.end();
    return;
  }
  if (pathname === '/app') {
    res.writeHead(302, { location: '/app/' });
    res.end();
    return;
  }
  const isLegacy = pathname.startsWith('/legacy/');
  const isVueAlias = pathname.startsWith('/app/');
  const staticRoot = isLegacy || !existsSync(path.join(VUE_PUBLIC_DIR, 'index.html'))
    ? PUBLIC_DIR
    : VUE_PUBLIC_DIR;
  const requestPath = isLegacy
    ? pathname.slice('/legacy'.length)
    : isVueAlias
      ? pathname.slice('/app'.length)
      : pathname;
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
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
const clients = new Set();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  if (token !== tokenRec.token) {
    ws.send(JSON.stringify({ type: 'bridge', event: 'auth.failed' }));
    setTimeout(() => ws.close(), 100);
    log('WS 拒绝：token 错误', req.socket.remoteAddress);
    return;
  }

  clients.add(ws);
  log('手机已连接', req.socket.remoteAddress);
  ws.send(JSON.stringify({
    type: 'bridge', event: 'hello',
    data: {
      machines: loadMachines(),
      connections: listConnections(),
      config: { workspace: config.workspace, proxy: !!config.proxy },
    },
  }));

  // 连接所有已登记机器（local 必连；ssh 惰性连接由手机触发）
  ensureConnection('local').catch(e => log('local 连接失败:', e.message));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleClientMessage(ws, msg).catch(e => {
      safeSend(ws, { type: 'bridge', event: 'error', data: { message: String(e?.message || e) } });
    });
  });
  ws.on('close', () => { clients.delete(ws); log('手机已断开'); });
  ws.on('error', () => { clients.delete(ws); try { ws.close(); } catch {} });
});

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) try { ws.send(JSON.stringify(obj)); } catch {}
}

async function handleClientMessage(ws, msg) {
  // 机器管理（桥接层自己的命令，不透传给 codex）
  if (msg.kind === 'machine') {
    const payload = msg.data ?? msg;
    if (msg.action === 'list') {
      safeSend(ws, { type: 'bridge', event: 'machines', data: { machines: loadMachines(), connections: listConnections() } });
    } else if (msg.action === 'add') {
      const rec = upsertMachine(payload);
      safeSend(ws, { type: 'bridge', event: 'machine.added', data: rec });
      await attachConnection(rec.id);
    } else if (msg.action === 'delete') {
      await closeConnection(payload.id);
      deleteMachine(payload.id);
      safeSend(ws, { type: 'bridge', event: 'machines', data: { machines: loadMachines(), connections: listConnections() } });
    } else if (msg.action === 'connect') {
      await attachConnection(payload.id, ws);
    }
    return;
  }

  // RPC：透传给指定机器的 codex
  if (msg.kind === 'rpc') {
    if (!ALLOWED_CLIENT_METHODS.has(msg.method)) {
      safeSend(ws, { type: 'bridge', event: 'rpc.error', data: { ref: msg.ref, message: `方法不在白名单: ${msg.method}` } });
      return;
    }
    const machineId = msg.machineId || 'local';
    try {
      const conn = await ensureConnection(machineId);
      const result = await conn.request(msg.method, msg.params ?? {});
      safeSend(ws, { type: 'bridge', event: 'rpc.result', data: { ref: msg.ref, result } });
    } catch (e) {
      safeSend(ws, { type: 'bridge', event: 'rpc.error', data: { ref: msg.ref, message: String(e?.message || e) } });
    }
    return;
  }

  // 审批答复
  if (msg.kind === 'serverReply') {
    const conn = _getConnection(msg.machineId || 'local');
    if (conn) conn.replyToServer(msg.id, msg.result ?? { decision: 'decline' });
    return;
  }
}

// 通知/审批转发：给每台机器的连接挂监听（连接建立后事件带 machineId 广播给手机）
const attached = new Set();
async function attachConnection(machineId, ws) {
  if (attached.has(machineId)) return;
  const conn = await ensureConnection(machineId);
  attached.add(machineId);

  conn.on('notification', (m) => broadcast({ type: 'codex', event: 'notification', data: m }));
  conn.on('serverRequest', (m) => broadcast({ type: 'codex', event: 'serverRequest', data: m }));
  conn.on('state', (s) => broadcast({
    type: 'bridge', event: 'machine.state',
    data: { machineId, ...s },
  }));
  if (ws) safeSend(ws, { type: 'bridge', event: 'machine.state', data: { machineId, type: conn.ready ? 'ready' : 'starting' } });
}

// 保证 local 的监听也挂上（启动即连）
attachConnection('local').catch(() => {});

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) { try { ws.send(s); } catch {} }
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
  log(`  配对码/Token: ${tokenRec.token}`);
  log(`  已登记机器: ${loadMachines().map(m => m.name).join(', ')}`);
});

function localIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// 兼容引用：machines.mjs 内部维护连接表
import { getConnection as _getConnection } from './machines.mjs';
