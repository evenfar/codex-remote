/**
 * codex app-server 子进程封装（核心模块）
 * - spawn codex app-server，NDJSON 帧解析
 * - JSON-RPC：请求/响应配对、通知分发、服务端主动请求（审批）
 * - 崩溃自动重启 + 事件Emitter 供上层订阅
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { config } from './config.mjs';

export class CodexAppServer extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();      // 请求 id -> {resolve, reject, method, timer}
    this.serverRequests = new Map(); // 服务端请求 id -> method（审批等）
    this.ready = false;
    this.stopping = false;
    this.restartDelay = 1000;
  }

  async start() {
    if (this.proc) return;
    this.stopping = false;

    const env = { ...process.env };
    // 服务器借道 Windows 梯子的场景：注入代理环境变量
    if (config.proxy) {
      env.HTTPS_PROXY = config.proxy;
      env.HTTP_PROXY = config.proxy;
      env.ALL_PROXY = config.proxy;
      // OpenAI 域名直连不走代理的场景一般不存在，故不设 NO_PROXY
    }

    // Windows 上 npm 全局安装的 .cmd shim 必须 shell 才能启动
    this.proc = spawn(config.codexBin, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env,
      cwd: config.workspace,
    });

    this.proc.stdout.setEncoding('utf8');
    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this.#onLine(line));

    this.proc.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) this.emit('stderr', s);
    });
    this.proc.on('exit', (code, sig) => {
      this.ready = false;
      this.#rejectAllPending(new Error(`codex app-server 退出 (code=${code} signal=${sig})`));
      this.proc = null;
      this.emit('exited', { code, sig });
      if (!this.stopping) {
        // 崩溃自动重启（指数退避，上限 15s）
        const delay = this.restartDelay;
        this.restartDelay = Math.min(this.restartDelay * 2, 15000);
        this.emit('restarting', { delay });
        setTimeout(() => this.start().catch(() => {}), delay);
      }
    });

    // 1) 握手 initialize -> initialized
    await this.request('initialize', {
      clientInfo: { name: 'codex-remote-bridge', title: 'Codex Remote', version: '0.1.0' },
    });
    this.notify('initialized');
    this.ready = true;
    this.restartDelay = 1000;
    this.emit('ready');
  }

  stop() {
    this.stopping = true;
    if (this.proc) { try { this.proc.kill(); } catch {} }
    this.proc = null;
  }

  #onLine(line) {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch { this.emit('stderr', `non-json: ${s.slice(0, 120)}`); return; }

    // 1. 响应（我发的请求的应答）
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new RpcError(msg.error, p.method));
        else p.resolve(msg.result);
      }
      return;
    }

    // 2. 服务端主动请求（审批 / elicitation）——带 id 且有 method
    if (msg.id !== undefined && msg.method) {
      this.serverRequests.set(msg.id, msg.method);
      this.emit('serverRequest', msg); // 上层（桥接）负责答复
      return;
    }

    // 3. 通知
    if (msg.method) {
      this.emit('notification', msg);
      return;
    }
  }

  request(method, params = {}, timeoutMs = 120000) {
    if (!this.proc && !['initialize'].includes(method)) {
      return Promise.reject(new Error('app-server 未运行'));
    }
    const id = this.nextId++;
    const frame = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时(${timeoutMs}ms): ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.proc.stdin.write(JSON.stringify(frame) + '\n');
      } catch (e) { reject(e); }
    });
  }

  notify(method, params = {}) {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  // 答复服务端主动请求（审批）
  replyToServer(id, result) {
    this.serverRequests.delete(id);
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }
  rejectServer(id, error) {
    this.serverRequests.delete(id);
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error }) + '\n');
  }

  #rejectAllPending(err) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.serverRequests.clear();
  }
}

export class RpcError extends Error {
  constructor(rpcError, method) {
    super(`[${method}] ${rpcError?.message ?? JSON.stringify(rpcError)}`);
    this.rpcError = rpcError;
  }
}
