/**
 * 多后端管理器：每台"机器"对应一个 codex app-server 连接
 * - local:  直接 spawn 本机 codex
 * - ssh:    通过 Node SSH 通道启动登录用户自己的 codex app-server
 * 各后端独立生命周期、独立 JSON-RPC 通道，手机端按 machineId 切换。
 */
import { config, DATA_DIR, readJson, writeJsonSafe } from './config.mjs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Client as SshClient } from 'ssh2';

const MACHINES_FILE = path.join(DATA_DIR, 'machines.json');

export function loadMachines() {
  const defaults = [{ id: 'local', name: '本机', type: 'local' }];
  if (!existsSync(MACHINES_FILE)) return defaults;
  const list = readJson(MACHINES_FILE);
  if (!Array.isArray(list) || !list.length) return defaults;
  // 确保 local 永远存在
  return list.some(m => m.type === 'local') ? list : [...defaults, ...list];
}

export function saveMachines(list) { writeJsonSafe(MACHINES_FILE, list); }

/**
 * 解析本机 codex 可执行文件绝对路径：
 * 1. 显式配置 codexBin 时直接用
 * 2. Windows npm 全局安装时取 %APPDATA%\npm\codex.cmd（spawn shell 用）
 */
import { existsSync as _exists } from 'node:fs';
import os from 'node:os';
function resolveCodexBin() {
  if (config.codexBin && config.codexBin !== 'codex') return config.codexBin;
  if (process.platform === 'win32') {
    const cmd = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd');
    if (_exists(cmd)) return cmd;
    return 'codex';
  }
  return 'codex';
}

function posixQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * 远端 SSH 已以 machine.user 登录。显式优先该用户目录里的可执行文件，
 * 只有这些路径都不存在时才回退到 shell PATH，避免误用 root 的全局 Codex。
 */
export function buildRemoteCommand(machine) {
  const userBins = [
    '$HOME/.local/bin/codex',
    '$HOME/.npm-global/bin/codex',
    '$HOME/.npm/bin/codex',
    '$HOME/.local/share/npm/bin/codex',
    '$HOME/bin/codex',
  ];
  const workspace = machine.workspace ? `cd -- ${posixQuote(machine.workspace)} && ` : '';
  const launch = machine.codexBin
    ? `exec ${posixQuote(machine.codexBin)} app-server`
    : `for codex_path in ${userBins.join(' ')}; do if [ -x "$codex_path" ]; then exec "$codex_path" app-server; fi; done; codex_path="$(command -v codex)" || { echo "codex not found for $(id -un)" >&2; exit 127; }; exec "$codex_path" app-server`;
  const script = `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.npm/bin:$HOME/.local/share/npm/bin:$HOME/bin:$PATH"; ${workspace}${launch}`;
  return `bash -lc ${posixQuote(script)}`;
}

export function upsertMachine({ id, name, type, host, port, user, sshKey, proxy, workspace, codexBin }) {
  const list = loadMachines();
  const rec = { id: id || crypto.randomUUID(), name: name || host || '新机器', type: type || 'ssh' };
  if (type === 'ssh') {
    Object.assign(rec, { host, port: port || 22, user });
    if (sshKey) rec.sshKey = sshKey;
  }
  if (proxy) rec.proxy = proxy;
  if (workspace) rec.workspace = workspace;
  if (codexBin) rec.codexBin = codexBin;
  const i = list.findIndex(m => m.id === rec.id);
  if (i >= 0) list[i] = { ...list[i], ...rec };
  else list.push(rec);
  saveMachines(list);
  return rec;
}

export function deleteMachine(id) {
  if (id === 'local') throw new Error('不能删除本机');
  const list = loadMachines().filter(m => m.id !== id);
  saveMachines(list);
}

// ---- 连接管理 ----
const connections = new Map(); // machineId -> CodexConnection

export function getConnection(machineId) {
  return connections.get(machineId);
}

export async function ensureConnection(machineId) {
  let conn = connections.get(machineId);
  if (conn && !conn.dead) {
    await conn.start();
    return conn;
  }

  const machine = loadMachines().find(m => m.id === machineId);
  if (!machine) throw new Error(`机器不存在: ${machineId}`);

  conn = new CodexConnection(machine);
  connections.set(machineId, conn);
  await conn.start();
  return conn;
}

export async function closeConnection(machineId) {
  const conn = connections.get(machineId);
  if (conn) { conn.stop(); connections.delete(machineId); }
}

export function listConnections() {
  return [...connections.values()].map(c => ({
    id: c.machine.id, name: c.machine.name, ready: c.ready, dead: c.dead,
  }));
}

async function openSshSession(machine, sshKey) {
  const client = new SshClient();
  const connectOptions = {
    host: machine.host,
    port: machine.port || 22,
    username: machine.user,
    readyTimeout: 15000,
    keepaliveInterval: 30000,
    keepaliveCountMax: 3,
  };
  if (sshKey) connectOptions.privateKey = readFileSync(sshKey);
  else if (process.env.SSH_AUTH_SOCK) connectOptions.agent = process.env.SSH_AUTH_SOCK;
  else throw new Error(`未找到 SSH 私钥，请为 ${machine.name} 配置 sshKey`);

  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(new Error(`SSH 连接失败: ${error.message}`));
      client.once('error', onError);
      client.once('ready', () => {
        client.removeListener('error', onError);
        resolve();
      });
      client.connect(connectOptions);
    });
  } catch (error) {
    client.end();
    throw error;
  }

  try {
    const stream = await new Promise((resolve, reject) => {
      client.exec(buildRemoteCommand(machine), { pty: false }, (error, channel) => {
        if (error) reject(new Error(`启动远程 Codex 失败: ${error.message}`));
        else resolve(channel);
      });
    });
    return { client, stream };
  } catch (error) {
    client.end();
    throw error;
  }
}

/**
 * 单个 codex app-server 连接（本机或 SSH 远程）。
 * 与 v1 的 CodexAppServer 等价，但 spawn 命令按机器类型构造，
 * 且 initialize 带 experimentalApi capability（模型/effort/沙箱切换需要）。
 */
export class CodexConnection {
  constructor(machine) {
    this.machine = machine;
    this.proc = null;
    this.sshClient = null;
    this.startPromise = null;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = false;
    this.dead = false;
    this.stopping = false;
    this.stderr = '';
    this.restartDelay = 1000;
    this.listeners = { notification: new Set(), serverRequest: new Set(), state: new Set() };
  }

  on(event, fn) { this.listeners[event]?.add(fn); return () => this.listeners[event]?.delete(fn); }
  #emit(event, arg) { for (const fn of this.listeners[event] ?? []) { try { fn(arg); } catch {} } }

  start() {
    if (this.startPromise) return this.startPromise;
    const pending = this.#startInternal();
    this.startPromise = pending;
    pending.then(
      () => { if (this.startPromise === pending) this.startPromise = null; },
      () => { if (this.startPromise === pending) this.startPromise = null; },
    );
    return pending;
  }

  async #startInternal() {
    if (this.proc && !this.dead) return;
    this.stopping = false;
    this.stderr = '';

    let cmd, args, env = { ...process.env };
    let exitSource, exitEvent = 'exit';
    if (this.machine.type === 'ssh') {
      // 表单未指定密钥时也显式传入当前 Windows 用户的默认私钥，避免后台进程
      // 因缺少 HOME/USERPROFILE 而找不到 ~/.ssh/id_rsa。
      const defaultKey = path.join(os.homedir(), '.ssh', 'id_rsa');
      const sshKey = this.machine.sshKey || (_exists(defaultKey) ? defaultKey : '');
      try {
        const { client, stream } = await openSshSession(this.machine, sshKey);
        this.sshClient = client;
        this.proc = {
          stdin: stream,
          stdout: stream,
          stderr: stream.stderr,
          kill: () => { try { stream.close(); } catch {} try { client.end(); } catch {} },
        };
        exitSource = stream;
        exitEvent = 'close';
        client.on('error', (error) => {
          const text = `SSH 通道错误: ${error.message}`;
          this.stderr = `${this.stderr}\n${text}`.slice(-2000);
        });
      } catch (error) {
        this.dead = true;
        this.stderr = String(error?.message || error);
        throw error;
      }
    } else {
      cmd = resolveCodexBin();
      args = ['app-server'];
      if (config.proxy) {
        env.HTTPS_PROXY = config.proxy; env.HTTP_PROXY = config.proxy; env.ALL_PROXY = config.proxy;
      }
      this.proc = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        // Windows 上本地 codex 是 npm 的 .cmd shim，必须经 shell
        shell: process.platform === 'win32',
        env,
        cwd: this.machine.workspace || config.workspace,
      });
      exitSource = this.proc;
    }

    this.proc.stdout.setEncoding('utf8');
    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this.#onLine(line));
    this.proc.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) {
        this.stderr = `${this.stderr}\n${s}`.slice(-2000);
        this.#emit('notification', { method: '__stderr', params: { text: s, machineId: this.machine.id } });
      }
    });
    let exited = false;
    const onExit = (code, sig) => {
      if (exited) return;
      exited = true;
      this.ready = false;
      const detail = this.stderr ? `: ${this.stderr.trim()}` : '';
      this.#rejectAll(new Error(`codex app-server 退出 (code=${code} signal=${sig})${detail}`));
      if (this.sshClient) { try { this.sshClient.end(); } catch {} }
      this.proc = null;
      this.sshClient = null;
      this.dead = true;
      this.#emit('state', { type: 'exit' });
      if (!this.stopping) {
        const delay = this.restartDelay;
        this.restartDelay = Math.min(this.restartDelay * 2, 15000);
        this.#emit('state', { type: 'reconnecting', delay });
        setTimeout(() => { this.dead = false; this.start().catch(() => {}); }, delay);
      }
    };
    // spawn/SSH channel 错误都收敛到同一个退出路径，避免重复重连。
    exitSource.on('error', (error) => {
      this.stderr = `${this.stderr}\n${error.code ?? error.message}`.slice(-2000);
      onExit(null, null);
    });
    exitSource.on(exitEvent, onExit);

    await this.request('initialize', {
      clientInfo: { name: 'codex-remote-bridge', title: 'Codex Remote', version: '0.2.0' },
      capabilities: { experimentalApi: true }, // 解锁 thread/settings/update 等
    });
    this.notify('initialized');
    this.ready = true;
    this.restartDelay = 1000;
    this.#emit('state', { type: 'ready' });
  }

  stop() {
    this.stopping = true;
    if (this.proc) { try { this.proc.kill(); } catch {} }
    if (this.sshClient) { try { this.sshClient.end(); } catch {} }
    this.proc = null;
    this.sshClient = null;
    this.dead = true;
  }

  #onLine(line) {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch { return; }

    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.error ? p.reject(new Error(`[${p.method}] ${msg.error?.message ?? ''}`)) : p.resolve(msg.result);
      }
      return;
    }
    if (msg.id !== undefined && msg.method) { // 服务端主动请求（审批）
      this.#emit('serverRequest', { ...msg, machineId: this.machine.id });
      return;
    }
    if (msg.method) this.#emit('notification', { ...msg, machineId: this.machine.id });
  }

  request(method, params = {}, timeoutMs = 120000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`请求超时(${timeoutMs}ms): ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      try { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
      catch (e) { reject(e); }
    });
  }

  notify(method, params = {}) {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  replyToServer(id, result) {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  #rejectAll(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }
}
