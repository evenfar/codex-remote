/**
 * 不连接 Codex 的静态回归测试。检查新版 Vue 与桥接层的公共接线，
 * 不依赖构建产物或真实回合，因此可在离线环境运行。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { buildRemoteCommand, CodexConnection } from '../server/machines.mjs';

const root = new URL('..', import.meta.url);
const read = (file) => readFileSync(new URL(file, root), 'utf8');
const source = {
  app: read('frontend/src/App.vue'),
  styles: read('frontend/src/styles.css'),
  composable: read('frontend/src/useCodex.ts'),
  types: read('frontend/src/types.ts'),
  server: read('server/index.mjs'),
  machines: read('server/machines.mjs'),
};
const has = (file, pattern, message = pattern) => {
  if (pattern instanceof RegExp) assert.match(source[file], pattern, `缺少 ${message}`);
  else assert.ok(source[file].includes(pattern), `缺少 ${message}`);
};

for (const marker of ['useCodex', 'newThread', 'switchMachine', 'sendMessage', 'answerApproval', 'type="file"', 'queue', 'steer', 'compact', 'rename', 'settings']) has('app', marker);
for (const marker of ['codex-remote-theme', 'toggleTheme', '切换到白天模式', '切换到夜间模式']) has('app', marker);
for (const marker of ["html[data-theme='light']", '--sidebar-bg', '--code-bg', '--user-bg']) has('styles', marker);
for (const marker of ['state', 'connect', 'loadThreads', 'switchMachine', 'send', 'answerApproval', 'localStorage', 'machineId']) has('composable', marker);
for (const marker of ['machineViews', 'threadsCursor', 'socketGeneration', 'rpcPending', 'deltaBuffers', 'flushOne', 'approvals', 'steer', 'settings/update', 'compact/start', 'renameThread']) has('composable', marker);
for (const marker of ['thread/list', 'thread/start', 'thread/resume', 'thread/turns/list', 'turn/start', 'turn/interrupt']) has('server', marker);
for (const marker of ['ALLOWED_CLIENT_METHODS', 'machineId', 'serverReply', 'maxPayload', 'heartbeat', 'bufferedAmount', 'flushClient', 'shutdownAllConnections']) has('server', marker);
for (const marker of ['content-security-policy', 'timingSafeEqual', 'AUTH_MAX_FAILURES', 'originAllowed', "message?.kind !== 'auth'", 'sshKeyConfigured']) has('server', marker);
assert.ok(!source.composable.includes('?token='), 'WebSocket token 不应出现在 URL 中');
assert.ok(!source.composable.includes('codex-remote.${token}'), 'WebSocket token 不应出现在握手头中');
for (const marker of ['pending', 'request(method', 'initialize', 'experimentalApi', 'closeConnection', 'buildRemoteCommand', 'id_ed25519', 'proxy']) has('machines', marker);
for (const marker of ['Machine', 'ApprovalRequest', 'DraftPayload', 'ThreadSummary']) has('types', marker);

const command = buildRemoteCommand({ user: 'devuser', workspace: '/home/devuser/project' });
assert.match(command, /\.local\/bin\/codex/, '未优先查找当前用户的 ~/.local/bin/codex');
assert.ok(command.includes('cd --') && command.includes('/home/devuser/project'), '未安全进入远端工作目录');
assert.match(command, /exec "\$codex_path" app-server/, '未通过当前用户的 codex 路径启动 app-server');
const explicit = buildRemoteCommand({ codexBin: '/home/devuser/.local/bin/codex' });
assert.match(explicit, /exec '.*codex.*' app-server/, '未尊重显式 codexBin 配置');

const quoted = buildRemoteCommand({
  workspace: "/tmp/a'b",
  proxy: "http://user:p'a@proxy.example:8080",
});
assert.match(quoted, /a'.*b/, 'workspace 单引号未保留');
assert.match(quoted, /proxy\.example/, 'proxy 未接入远程命令');
assert.match(quoted, /'\\''/, 'shell 单引号未正确转义');

const connection = new CodexConnection({ id: 'test', name: 'test', type: 'local' });
connection.proc = { stdin: { writable: false, destroyed: false } };
await assert.rejects(connection.request('test/request', {}, 1000), /不可写/);
assert.equal(connection.pending.size, 0, '不可写 stdin 后 pending 未清理');

// Execute the actual composable with Vue reactivity and an in-memory transport.
// No browser, network, real Codex turns or additional generated test files.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const transpile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const frontendCode = transpile(source.composable + '\nexport const audit = { handleNotification, handleMessage, renderItem, flushAll, resyncCurrentThread, runState, setSocket(value: any) { socket = value } };');
function frontend(handler) {
  const requests = [], storage = new Map(), timers = new Map();
  let sequence = 0;
  const sandbox = {
    exports: {}, require,
    window: { setTimeout: fn => { timers.set(++sequence, fn); return sequence; }, clearTimeout: id => timers.delete(id), addEventListener() {} },
    document: { hidden: false, addEventListener() {} }, location: { protocol: 'http:', host: 'test.invalid' }, WebSocket: { OPEN: 1 },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    crypto: { randomUUID: () => `message-${++sequence}` },
  };
  vm.runInNewContext(frontendCode, sandbox);
  const api = sandbox.exports.useCodex(), audit = sandbox.exports.audit;
  function reply(request, result = {}, error) {
    audit.handleMessage({ type: 'bridge', event: error ? 'rpc.error' : 'rpc.result', data: { ref: request.ref, result, message: error } });
  }
  function standard(request) {
    const result = request.method === 'thread/start' ? { thread: { id: `thread-${++sequence}` } }
      : request.method === 'thread/resume' ? { thread: { id: request.params.threadId, status: { type: 'idle' } }, model: 'test-model', reasoningEffort: 'high', cwd: '/project', sandbox: { type: 'readOnly' } }
      : request.method === 'turn/start' ? { turn: { id: 'active-turn' } } : { data: [] };
    reply(request, result);
  }
  audit.setSocket({ readyState: 1, send(raw) { const request = JSON.parse(raw); requests.push(request); if (request.kind === 'rpc' && handler?.(request, reply) !== false) standard(request); }, close() {} });
  api.state.connected = true;
  return { api, audit, requests, reply, timers };
}

let checks = 0;
async function check(name, run) { await run(); checks++; console.log(`  PASS ${name}`); }
await check('运行状态隔离、发送锁与队列顺序', async () => {
  const held = [];
  const h = frontend(request => { if (request.method === 'turn/start') { held.push(request); return false; } });
  h.api.state.threadId = 'A'; h.audit.runState().running = true;
  await h.api.newThread('/project');
  assert.equal(h.api.state.running, false);
  const sending = h.api.send({ text: 'first', images: [] });
  await h.api.send({ text: 'second', images: [] });
  assert.equal(held.length, 1); assert.equal(h.api.state.queue.length, 1);
  h.audit.handleNotification('turn/completed', { threadId: 'A', turn: { id: 'A-turn' } });
  assert.equal(h.api.state.running, true);
  h.reply(held[0], { turn: { id: 'active-turn' } }); await sending;
  h.audit.handleNotification('turn/completed', { threadId: h.api.state.threadId, turn: { id: 'active-turn' } });
  assert.equal(held.length, 2); assert.equal(h.api.state.queue.length, 0);
  h.reply(held[1], { turn: { id: 'next-turn' } });
});
await check('迟到的新建及打开响应不跨机器写入', async () => {
  let held;
  const h = frontend(request => { if (request.method === 'thread/start' || request.method === 'thread/resume') { held = request; return false; } });
  const creating = h.api.newThread('/local');
  await h.api.switchMachine('remote'); h.reply(held, { thread: { id: 'local-thread' } }); await creating;
  assert.equal(h.api.state.threadId, ''); assert.equal(h.api.state.machineId, 'remote');
  const opening = h.api.openThread({ id: 'remote-thread' });
  await h.api.switchMachine('local'); h.reply(held, { thread: { id: 'remote-thread', name: 'stale' }, model: 'stale-model' }); await opening;
  assert.notEqual(h.api.state.threadTitle, 'stale');
  assert.equal(h.requests.filter(request => request.method === 'thread/turns/list').length, 0);
  const models = [];
  const modelClient = frontend(request => { if (request.method === 'model/list') { models.push(request); return false; } });
  const localModels = modelClient.api.loadModels(); modelClient.api.state.machineId = 'remote';
  const remoteModels = modelClient.api.loadModels();
  modelClient.reply(models[1], { data: [{ id: 'remote-model' }] }); await remoteModels;
  modelClient.reply(models[0], { data: [{ id: 'local-model' }] }); await localModels;
  assert.equal(modelClient.api.state.models[0].id, 'remote-model');
});
await check('目录与模型设置进入请求、设置失败不改变 UI', async () => {
  const h = frontend((request, reply) => { if (request.method === 'thread/settings/update') { reply(request, {}, 'invalid setting'); return false; } });
  Object.assign(h.api.state.settings, { model: 'chosen', effort: 'high', sandboxMode: 'read-only' });
  await h.api.newThread('/chosen/project');
  const start = h.requests.find(request => request.method === 'thread/start').params;
  assert.equal(start.cwd, '/chosen/project'); assert.equal(start.model, 'chosen'); assert.equal(start.config.model_reasoning_effort, 'high'); assert.equal(start.sandbox, 'read-only');
  await assert.rejects(h.api.updateSettings({ model: 'invalid' }), /invalid/); assert.equal(h.api.state.settings.model, 'chosen');
  await h.api.send({ text: 'task', images: [] });
  const turn = h.requests.find(request => request.method === 'turn/start').params;
  assert.equal(turn.effort, 'high'); assert.equal(turn.sandboxPolicy.type, 'readOnly');
  await h.api.interrupt(); await h.api.steer('continue');
  assert.equal(h.requests.find(request => request.method === 'turn/interrupt').params.turnId, 'active-turn');
  assert.equal(h.requests.find(request => request.method === 'turn/steer').params.expectedTurnId, 'active-turn');
});
await check('失败消息原位重试、恢复历史解锁运行状态', async () => {
  let failed = false;
  const h = frontend((request, reply) => { if (request.method === 'turn/start' && !failed) { failed = true; reply(request, {}, 'rejected'); return false; } });
  await h.api.newThread();
  assert.equal(await h.api.send({ text: 'retry me', images: [] }), false);
  assert.equal(h.api.state.messages[0].delivery, 'failed');
  await h.api.retryMessage(h.api.state.messages[0]);
  assert.equal(h.api.state.messages.length, 1); assert.equal(h.api.state.messages[0].delivery, 'sent');
  await h.audit.resyncCurrentThread(); assert.equal(h.api.state.running, false);
  assert.equal(h.api.state.settings.model, 'test-model');
});
await check('历史时间顺序、全量内容、日志限长及跨机器日志隔离', async () => {
  const h = frontend((request, reply) => {
    if (request.method === 'thread/turns/list') { reply(request, { data: [2, 1].map(n => ({ id: `turn-${n}`, status: 'completed', items: [{ id: `answer-${n}`, type: 'agentMessage', text: String(n) }] })) }); return false; }
  });
  await h.api.openThread({ id: 'history' });
  assert.equal(h.api.state.messages.map(message => message.text).join(','), '1,2');
  assert.equal(h.requests.find(request => request.method === 'thread/turns/list').params.itemsView, 'full');
  h.audit.renderItem({ id: 'log', type: 'commandExecution', aggregatedOutput: 'x'.repeat(300000) }, true);
  assert.equal(h.api.state.activities[0].content.length, 200000);
  assert.equal(h.api.state.activities[0].truncated, true);
  h.audit.handleMessage({ type: 'codex', event: 'notification', data: { method: '__stderr', machineId: 'remote', params: { text: 'wrong-machine' } } });
  h.audit.flushAll(); assert.equal(h.api.state.activities.length, 1);
});
await check('归档恢复、机器编辑字段和重连请求', async () => {
  const h = frontend();
  await h.api.showArchived(true); assert.equal(h.requests.at(-1).params.archived, true);
  await h.api.restoreThread('archived'); assert.equal(h.api.state.archived, false);
  h.api.addMachine({ id: 'remote', name: 'Edited', type: 'ssh', host: 'example.invalid', workspace: '/project', proxy: '', codexBin: '/home/user/codex' });
  assert.equal(h.requests.at(-1).data.id, 'remote'); assert.equal(h.requests.at(-1).data.proxy, '');
  h.api.reconnectMachine('remote'); assert.equal(h.requests.at(-1).action, 'reconnect');
});

await check('桥接审批重放、多设备去重、失败重试及已解决同步', async () => {
  class FakeServer extends EventEmitter { constructor(handler) { super(); this.handler = handler; } listen() {} close(callback) { callback?.(); } }
  const emitter = new EventEmitter(); let replies = 0, failReply = false;
  const conn = { ready: true, dead: false, on(event, fn) { emitter.on(event, fn); return () => emitter.off(event, fn); }, async replyToServer() { replies++; if (failReply) throw new Error('write failed'); } };
  const machines = [{ id: 'local', name: 'Test', type: 'local', sshKey: '/private/key' }];
  const mocks = {
    'node:http': { createServer: FakeServer }, ws: { WebSocketServer: FakeServer },
    './config.mjs': { config: {}, ROOT: '/project', loadOrCreateToken: () => ({ token: 'test-token' }) },
    './machines.mjs': { loadMachines: () => machines, listConnections: () => [], ensureConnection: async () => conn, closeConnection: async () => {}, shutdownAllConnections: async () => {} },
  };
  const sandbox = { exports: {}, require: name => mocks[name] ?? require(name), console: { log() {} }, Buffer, URL,
    process: { once() {} }, setInterval: () => ({ unref() {} }), clearInterval() {}, setTimeout, clearTimeout };
  vm.runInNewContext(transpile(source.server) + '\nexports.audit = { httpServer, wss, attachConnection, handleClientMessage, originAllowed, tokensEqual, authAllowed, recordAuthFailure };', sandbox);
  const bridge = sandbox.exports.audit;
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, writeHead(_status, headers) { Object.assign(this.headers, headers); }, end(body) { this.body = body; } };
  bridge.httpServer.handler({ url: '/healthz' }, response);
  assert.match(response.headers['content-security-policy'], /default-src 'self'/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.ok(!response.body.includes('private/key'));
  assert.equal(bridge.tokensEqual('test-token', 'test-token'), true);
  assert.equal(bridge.tokensEqual('wrong-token', 'test-token'), false);
  assert.equal(bridge.originAllowed({ headers: { host: 'test.invalid', origin: 'http://test.invalid' } }), true);
  assert.equal(bridge.originAllowed({ headers: { host: 'test.invalid', origin: 'https://evil.invalid' } }), false);
  for (let attempt = 0; attempt < 5; attempt++) bridge.recordAuthFailure('brute-force-client');
  assert.equal(bridge.authAllowed('brute-force-client'), false);
  await bridge.attachConnection('local');
  function phone() {
    const ws = new EventEmitter(); Object.assign(ws, { OPEN: 1, readyState: 1, bufferedAmount: 0, frames: [], send(raw) { this.frames.push(JSON.parse(raw)); }, close() {} });
    bridge.wss.emit('connection', ws, { url: '/ws', headers: { host: 'test.invalid' }, socket: { remoteAddress: 'test' } });
    ws.emit('message', Buffer.from(JSON.stringify({ kind: 'auth', token: 'test-token' })));
    return ws;
  }
  const request = { machineId: 'local', id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', command: 'test' } };
  emitter.emit('serverRequest', request);
  const first = phone(), second = phone();
  assert.equal(first.frames[0].data.machines[0].sshKey, undefined);
  assert.equal(first.frames[0].data.machines[0].sshKeyConfigured, true);
  assert.equal(first.frames[0].data.approvals.length, 1);
  const h = frontend();
  h.audit.handleMessage({ type: 'bridge', event: 'approvals', data: { requests: [request] } });
  assert.equal(h.api.state.approval.detail, 'test');
  h.api.answerApproval('accept'); assert.equal(h.api.state.approvals.length, 1);
  h.audit.handleMessage({ type: 'bridge', event: 'approvals', data: { requests: [] } });
  assert.equal(h.api.state.approval, null);
  await Promise.all([bridge.handleClientMessage(first, { kind: 'serverReply', machineId: 'local', id: 1, result: { decision: 'accept' } }), bridge.handleClientMessage(second, { kind: 'serverReply', machineId: 'local', id: 1, result: { decision: 'accept' } })]);
  assert.equal(replies, 1); assert.equal(second.frames.at(-1).data.requests.length, 0);
  emitter.emit('serverRequest', { ...request, id: 2 }); failReply = true;
  await assert.rejects(bridge.handleClientMessage(first, { kind: 'serverReply', machineId: 'local', id: 2 }), /write failed/);
  assert.equal(first.frames.at(-1).data.requests.length, 1);
  emitter.emit('notification', { machineId: 'local', method: 'serverRequest/resolved', params: { requestId: 2 } });
  assert.equal(first.frames.filter(frame => frame.event === 'approvals').at(-1).data.requests.length, 0);
  const count = first.frames.length;
  emitter.emit('notification', { machineId: 'remote', method: '__stderr', params: { text: 'remote log' } });
  assert.equal(first.frames.length, count, '非当前机器的输出不应占用客户端带宽');
});
await check('机器配置校验并保留未重新填写的私钥', async () => {
  let saved = [{ id: 'local', type: 'local' }, { id: 'remote', name: 'Remote', type: 'ssh', host: 'example.invalid', user: 'devuser', port: 22, proxy: 'http://proxy.example', codexBin: '/old/codex', sshKey: '/old/key' }];
  const sandbox = { exports: {}, URL, require: name => name === './config.mjs' ? { config: {}, DATA_DIR: '/test', readJson: () => saved, writeJsonSafe: (_path, value) => { saved = value; } } : name === 'node:fs' ? { ...require(name), existsSync: () => true } : require(name) };
  vm.runInNewContext(transpile(source.machines), sandbox);
  sandbox.exports.upsertMachine({ id: 'remote', name: 'Edited', proxy: '', codexBin: '', sshKey: '' });
  assert.equal(saved[1].host, 'example.invalid'); assert.equal(saved[1].name, 'Edited');
  assert.equal(saved[1].proxy, ''); assert.equal(saved[1].codexBin, ''); assert.equal(saved[1].sshKey, '/old/key');
  assert.throws(() => sandbox.exports.upsertMachine({ id: 'local', name: 'x' }), /不能修改本机/);
  assert.throws(() => sandbox.exports.upsertMachine({ id: 'remote', port: 70000 }), /端口/);
  assert.throws(() => sandbox.exports.upsertMachine({ id: 'remote', workspace: 'relative/path' }), /绝对路径/);
  assert.throws(() => sandbox.exports.upsertMachine({ id: 'remote', proxy: 'file:///secret' }), /代理协议/);
});
await check('实际 Vue 组件渲染：项目、归档、重试、队列、机器编辑入口', async () => {
  const { parse, compileScript } = require('@vue/compiler-sfc');
  const { createSSRApp } = require('vue');
  const { renderToString } = require('@vue/server-renderer');
  const h = frontend(); h.api.state.paired = true;
  h.api.state.machines = [{ id: 'local', name: 'Test', type: 'local' }, { id: 'remote', name: 'Remote', type: 'ssh', host: 'example.invalid' }];
  h.api.state.threadId = 'thread'; h.api.state.screen = 'chat';
  h.api.state.messages = [{ id: 'failed', role: 'user', text: '<script>unsafe</script>', delivery: 'failed', error: 'rejected' }];
  h.audit.runState().running = true;
  const { descriptor } = parse(source.app);
  const componentCode = transpile(compileScript(descriptor, { id: 'test-ui', inlineTemplate: true }).content);
  const sandbox = { exports: {}, require: name => name === './useCodex' ? { useCodex: () => h.api } : require(name) };
  vm.runInNewContext(componentCode, sandbox);
  const render = () => renderToString(createSSRApp(sandbox.exports.default));
  h.api.state.drawer = 'new'; let html = await render();
  assert.match(html, /项目工作目录/); assert.match(html, /加入队列/); assert.match(html, /重试/); assert.ok(!html.includes('<script>unsafe</script>'));
  assert.match(html, /切换到白天模式/);
  h.api.state.drawer = 'machines'; html = await render();
  assert.match(html, /aria-label="编辑机器"/); assert.match(html, /aria-label="重新连接"/);
  h.api.state.archived = true; html = await render(); assert.match(html, /归档会话/);
});
console.log(`P0 回归通过：静态接线及 ${checks} 组行为测试，无真实 Codex 回合。`);
