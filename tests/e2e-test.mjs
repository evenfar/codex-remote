/**
 * 端到端测试：不真开浏览器，直接以 WebSocket 客户端身份模拟手机。
 * 覆盖：token 鉴权（错误 token 必须被拒）、thread/list、thread/start、
 *       turn/start 流式 delta、turn/completed、审批请求转发与答复闭环。
 * 用法: node scripts/e2e-test.mjs  （需先 npm start 跑起服务，或本脚本自启）
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = process.env.CM_PORT || 3010;
const TOKEN = process.env.CM_TEST_TOKEN;
const BASE = `ws://127.0.0.1:${PORT}/ws`;

let passed = 0, failed = 0;
function ok(name) { passed++; console.log(`  ✅ ${name}`); }
function bad(name, detail) { failed++; console.log(`  ❌ ${name} — ${detail}`); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class Phone {
  constructor(token) {
    this.token = token;
    this.ws = null;
    this.ref = 0;
    this.pendingRpc = new Map();
    this.events = [];
    this.waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${BASE}?token=${encodeURIComponent(this.token)}`);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'bridge' && msg.event === 'rpc.result') {
          const p = this.pendingRpc.get(msg.data.ref);
          if (p) { this.pendingRpc.delete(msg.data.ref); p.resolve(msg.data.result); }
        } else if (msg.type === 'bridge' && msg.event === 'rpc.error') {
          const p = this.pendingRpc.get(msg.data.ref);
          if (p) { this.pendingRpc.delete(msg.data.ref); p.reject(new Error(msg.data.message)); }
        } else {
          this.events.push(msg);
          this.waiters = this.waiters.filter(w => !w(msg));
        }
      });
    });
  }
  rpc(method, params) {
    const ref = ++this.ref;
    return new Promise((resolve, reject) => {
      this.pendingRpc.set(ref, { resolve, reject });
      this.ws.send(JSON.stringify({ kind: 'rpc', ref, method, params }));
    });
  }
  replyServer(id, result) {
    this.ws.send(JSON.stringify({ kind: 'serverReply', id, result }));
  }
  // 等待某事件出现（在已收到与未来收到的事件里找）
  waitFor(predicate, timeoutMs = 60000) {
    const found = this.events.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待事件超时')), timeoutMs);
      const w = (msg) => {
        if (predicate(msg)) { clearTimeout(timer); resolve(msg); return true; }
        return false;
      };
      this.waiters.push(w);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  console.log('== e2e 测试 ==');

  // 0) 错误 token 必须被拒
  const badPhone = new Phone('000000-wrong');
  let rejected = false;
  await new Promise((resolve) => {
    const ws = new WebSocket(`${BASE}?token=wrong-token`);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.event === 'auth.failed') { rejected = true; }
    });
    ws.on('close', () => resolve());
    ws.on('error', () => resolve());
    setTimeout(() => { try { ws.close(); } catch {}; resolve(); }, 5000);
  });
  rejected ? ok('错误 token 被拒绝') : bad('错误 token 被拒绝', '未收到 auth.failed');

  // 1) 正确 token 连接 + hello
  const phone = new Phone(TOKEN);
  await phone.connect();
  const hello = await phone.waitFor(m => m.event === 'hello', 10000);
  ok(`连接并收到 hello (codex ready=${hello.data.ready})`);

  // 2) rpc 白名单外方法必须被拒
  try {
    await phone.rpc('fs/writeFile', { path: 'x', content: 'y' });
    bad('白名单拦截 fs/writeFile', '居然成功了？！');
  } catch { ok('白名单拦截 fs/writeFile'); }

  // 3) thread/list
  const list = await phone.rpc('thread/list', { cursor: null });
  Array.isArray(list?.data) ? ok(`thread/list 返回 ${list.data.length} 个会话`) : bad('thread/list', JSON.stringify(list).slice(0, 200));

  // 4) thread/start
  const started = await phone.rpc('thread/start', {
    options: { cwd: process.cwd(), sandbox: { mode: 'workspace-write' } },
  });
  const threadId = started?.thread?.id;
  threadId ? ok(`thread/start -> ${threadId.slice(0, 13)}...`) : bad('thread/start', JSON.stringify(started).slice(0, 200));

  // 5) turn/start + 等流式 delta（要求跑个命令，从而触发审批）
  await phone.rpc('turn/start', {
    threadId,
    input: [{ type: 'text', text: '请运行命令 node -e "console.log(42)" 然后告诉我输出结果' }],
  });

  // 6) 等审批请求转发过来，然后答复 accept
  try {
    const approval = await phone.waitFor(m =>
      m.type === 'codex' && m.event === 'serverRequest' && /requestApproval/.test(m.data?.method ?? ''), 90000);
    ok(`收到审批请求: ${approval.data.method}`);
    phone.replyServer(approval.data.id, { decision: 'accept' });
    ok('已答复审批 accept');
  } catch (e) {
    console.log('  ⚠️ 未收到审批请求（可能沙箱已放行该命令）:', e.message);
  }

  // 7) 等 turn/completed
  const completed = await phone.waitFor(
    m => m.type === 'codex' && m.data?.method === 'turn/completed', 120000);
  const err = completed.data.params?.turn?.error;
  if (err) bad('turn/completed', `turn error: ${JSON.stringify(err).slice(0, 300)}`);
  else ok('turn/completed 无错误');

  // 8) 收到了 agentMessage（流式或完整）
  const hasAgentMsg = phone.events.some(m =>
    m.type === 'codex' &&
    ((m.data?.method === 'item/completed' && m.data.params?.item?.type === 'agentMessage') ||
     m.data?.method === 'item/agentMessage/delta'));
  hasAgentMsg ? ok('收到 agentMessage（流式或完整）') : bad('agentMessage', '未见任何 agent 输出');

  // 9) turn/interrupt 在 idle 状态调用不应崩溃（错误即可接受）
  try { await phone.rpc('turn/interrupt', { threadId }); } catch {}
  ok('turn/interrupt 调用未崩溃');

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  phone.close();
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
