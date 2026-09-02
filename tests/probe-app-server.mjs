#!/usr/bin/env node
/**
 * 协议探针：对 `codex app-server` 做真实握手，
 * 拿到第一手的 initialize / thread/start / turn/start / 审批消息格式。
 * 用法: node scripts/probe-app-server.mjs
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const log = (...a) => console.log('[probe]', ...a);

const child = spawn(CODEX_BIN, ['app-server'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});

let nextId = 1;
const pending = new Map(); // id -> {resolve, method}

const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch { log('STDOUT(non-json):', line.slice(0, 200)); return; }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      log(`<< result for ${p.method}:`, JSON.stringify(msg).slice(0, 600));
      p.resolve(msg);
    } else {
      log('<< orphan result:', JSON.stringify(msg).slice(0, 300));
    }
  } else if (msg.method) {
    // 服务端主动请求（审批等）或通知
    log(`<< ${msg.method}${msg.id !== undefined ? ' (req id=' + msg.id + ')' : ' (notification)'}:`,
        JSON.stringify(msg.params ?? {}).slice(0, 900));
    // 对审批类请求先自动拒绝，避免探针卡住
    if (msg.id !== undefined && /requestApproval|elicitation/.test(msg.method)) {
      send({ jsonrpc: '2.0', id: msg.id, result: { decision: 'decline' } });
    }
  } else {
    log('<< unknown:', JSON.stringify(msg).slice(0, 300));
  }
});

child.stderr.on('data', (d) => {
  const s = d.toString().trim();
  if (s) log('STDERR:', s.slice(0, 300));
});
child.on('exit', (code, sig) => { log('app-server exited', { code, sig }); process.exit(0); });

function send(obj) {
  const s = JSON.stringify(obj);
  log('>>', s.slice(0, 400));
  child.stdin.write(s + '\n');
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, { resolve, method });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  await wait(500);
  // 1. 握手
  const init = await request('initialize', {
    clientInfo: { name: 'codex-remote-bridge-probe', title: 'probe', version: '0.1.0' },
  });
  const caps = init?.result?.capabilities ?? {};
  log('capabilities keys:', Object.keys(caps));
  send({ jsonrpc: '2.0', method: 'initialized' });

  await wait(300);

  // 2. 模型列表（顺便验证 auth）
  const models = await request('model/list', {});
  const modelIds = (models?.result?.data ?? []).map(m => m.id || m.slug).slice(0, 8);
  log('models:', JSON.stringify(modelIds));

  // 3. 会话列表
  const threads = await request('thread/list', { cursor: null });
  const t = threads?.result?.data ?? [];
  log(`thread/list: ${t.length} threads; first:`, JSON.stringify(t[0] ?? null).slice(0, 500));

  // 4. 开新会话（读沙箱，避免触发审批）
  const started = await request('thread/start', {
    options: {
      cwd: process.cwd(),
      sandbox: { mode: 'read-only' },
      model: modelIds[0],
    },
  });
  const threadId = started?.result?.thread?.id ?? null;
  log('threadId:', threadId);

  if (threadId) {
    // 5. 跑一个 turn
    const turn = await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: '请只回复两个字：好的' }],
    });
    log('turn/start result:', JSON.stringify(turn).slice(0, 400));

    // 6. 等通知流入（流式 delta / turn/completed）
    log('--- collecting notifications for 60s ---');
    await wait(60000);
    await request('thread/interrupt', { threadId });
  }

  log('=== probe done ===');
  child.kill();
  setTimeout(() => process.exit(0), 1000);
}

main().catch(e => { log('FATAL', e); child.kill(); process.exit(1); });
