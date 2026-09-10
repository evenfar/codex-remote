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
  const proxy = machine.proxy
    ? `export HTTP_PROXY=${posixQuote(machine.proxy)} HTTPS_PROXY=${posixQuote(machine.proxy)} ALL_PROXY=${posixQuote(machine.proxy)} http_proxy=${posixQuote(machine.proxy)} https_proxy=${posixQuote(machine.proxy)} all_proxy=${posixQuote(machine.proxy)}; `
    : '';
  const script = `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.npm/bin:$HOME/.local/share/npm/bin:$HOME/bin:$PATH"; ${proxy}${workspace}${launch}`;
  return `bash -lc ${posixQuote(script)}`;
}

export function upsertMachine({ id, name, type, host, port, user, sshKey, proxy, workspace, codexBin }) {
  const list = loadMachines();
  const cleanId = id === undefined || id === '' ? crypto.randomUUID() : cleanIdentifier(id);
  if (cleanId === 'local') throw new Error('不能修改本机配置');
  const existing = list.find(m => m.id === cleanId);
  const cleanType = type ?? existing?.type ?? 'ssh';
  if (cleanType !== 'ssh') throw new Error('仅支持添加 SSH 服务器');
  const cleanHost = cleanText(host ?? existing?.host, '服务器地址', 253, true);
  if (/\s|[/?#@]/.test(cleanHost)) throw new Error('服务器地址格式无效');
  const cleanUser = cleanText(user ?? existing?.user, '登录用户', 128, true);
  const cleanName = cleanText(name ?? existing?.name ?? cleanHost, '名称', 100, true);
  const cleanPort = Number(port ?? existing?.port ?? 22);
  if (!Number.isInteger(cleanPort) || cleanPort < 1 || cleanPort > 65535) throw new Error('端口必须是 1 到 65535 的整数');
  const rec = { id: cleanId, name: cleanName, type: cleanType, host: cleanHost, user: cleanUser, port: cleanPort };
  if (rec.type === 'ssh') {
    if (sshKey) rec.sshKey = validateSshKey(sshKey);
  }
  if (proxy !== undefined) rec.proxy = validateProxy(proxy);
  if (workspace !== undefined) rec.workspace = validateRemotePath(workspace, '工作目录');
  if (codexBin !== undefined) rec.codexBin = validateRemotePath(codexBin, 'Codex 路径');
  const i = list.findIndex(m => m.id === rec.id);
  const saved = i >= 0 ? { ...list[i], ...rec } : rec;
  if (i >= 0) list[i] = saved;
  else list.push(saved);
  saveMachines(list);
  return saved;
}

function cleanText(value, label, maxLength, required = false) {
  if (typeof value !== 'string') throw new Error(`${label}格式无效`);
  const text = value.trim();
  if (required && !text) throw new Error(`请输入${label}`);
  if (text.length > maxLength || /[\0\r\n]/.test(text)) throw new Error(`${label}格式无效`);
  return text;
}

function cleanIdentifier(value) {
  const id = cleanText(value, '机器 ID', 128, true);
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error('机器 ID 格式无效');
  return id;
}

function validateRemotePath(value, label) {
  const text = cleanText(value, label, 4096);
  if (text && !text.startsWith('/')) throw new Error(`${label}必须是绝对路径`);
  return text;
}

function validateProxy(value) {
  const text = cleanText(value, '代理地址', 2048);
  if (!text) return '';
  let parsed;
  try { parsed = new URL(text); } catch { throw new Error('代理地址格式无效'); }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) throw new Error('代理协议不受支持');
  return text;
}

function validateSshKey(value) {
  const resolved = path.resolve(String(value));
  const sshRoot = path.resolve(os.homedir(), '.ssh');
  if (resolved !== sshRoot && !resolved.startsWith(sshRoot + path.sep)) {
    throw new Error('SSH 私钥必须位于当前用户的 .ssh 目录中');
  }
  return resolved;
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

  // A dead connection may still own a delayed restart callback. Stop it before
  // replacing the entry so an old process cannot revive after reconfiguration.
  if (conn) conn.stop();
  conn = new CodexConnection(machine);
  connections.set(machineId, conn);
  await conn.start();
  return conn;
}

export async function closeConnection(machineId) {
  const conn = connections.get(machineId);
  if (conn) { conn.stop(); connections.delete(machineId); }
}

export async function shutdownAllConnections() {
  const closing = [...connections.values()];
  connections.clear();
  for (const conn of closing) conn.stop();
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
    this.restartTimer = null;
    this.generation = 0;
    this.invalidJsonCount = 0;
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
    this.invalidJsonCount = 0;
    const generation = ++this.generation;

    let cmd, args, env = { ...process.env };
    let exitSource, exitEvent = 'exit';
    if (this.machine.type === 'ssh') {
      // 表单未指定密钥时也显式传入当前 Windows 用户的默认私钥，避免后台进程
      // 因缺少 HOME/USERPROFILE 而找不到 ~/.ssh/id_rsa。
      const keyDir = path.join(os.homedir(), '.ssh');
      const defaultKey = ['id_ed25519', 'id_rsa'].map(name => path.join(keyDir, name)).find(_exists);
      const sshKey = this.machine.sshKey || defaultKey || '';
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

    const activeProc = this.proc;
    this.proc.stdout.setEncoding('utf8');
    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this.#onLine(line));
    this.proc.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) {
        this.stderr = `${this.stderr}\n${s}`.slice(-2000);
        this.#emit('notification', { method: '__stderr', machineId: this.machine.id, params: { text: s } });
      }
    });
    let exited = false;
    const onExit = (code, sig) => {
      if (exited) return;
      exited = true;
      // A stale child/channel must not tear down a newer successful start.
      if (this.proc !== activeProc || generation !== this.generation) return;
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
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.stopping && generation === this.generation) {
            this.dead = false;
            this.start().catch(() => {});
          }
        }, delay);
        this.restartTimer.unref?.();
      }
    };
    // spawn/SSH channel 错误都收敛到同一个退出路径，避免重复重连。
    exitSource.on('error', (error) => {
      this.stderr = `${this.stderr}\n${error.code ?? error.message}`.slice(-2000);
      onExit(null, null);
    });
    exitSource.on(exitEvent, onExit);

    try {
      await this.request('initialize', {
        clientInfo: { name: 'codex-remote-bridge', title: 'Codex Remote', version: '0.2.0' },
        capabilities: { experimentalApi: true }, // 解锁 thread/settings/update 等
      });
    } catch (error) {
      // initialize timeout/failure otherwise leaves a live child behind and
      // makes all later retries talk to a broken JSON-RPC stream.
      if (this.proc === activeProc) {
        ++this.generation;
        this.ready = false;
        this.dead = true;
        this.#rejectAll(error instanceof Error ? error : new Error(String(error)));
        try { activeProc.kill(); } catch {}
        try { this.sshClient?.end(); } catch {}
        this.proc = null;
        this.sshClient = null;
        this.#emit('state', { type: 'initializeFailed' });
      }
      throw error;
    }
    this.notify('initialized');
    this.ready = true;
    this.restartDelay = 1000;
    this.#emit('state', { type: 'ready' });
  }

  stop() {
    this.stopping = true;
    ++this.generation;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.ready = false;
    this.#rejectAll(new Error('codex app-server 已停止'));
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
    try { msg = JSON.parse(s); } catch {
      this.invalidJsonCount += 1;
      this.#emit('state', { type: 'malformedMessage', count: this.invalidJsonCount });
      return;
    }

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
      try {
        const input = this.proc?.stdin;
        if (!input || input.destroyed || input.writable === false) throw new Error('codex app-server 输入流不可写');
        input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            clearTimeout(pending.timer);
            pending.reject(error);
          }
        });
      } catch (error) {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          clearTimeout(pending.timer);
        }
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#writeNotification({ jsonrpc: '2.0', method, params });
  }

  replyToServer(id, result) {
    return new Promise((resolve, reject) => {
      const input = this.proc?.stdin;
      if (!input || input.destroyed || input.writable === false) return reject(new Error('审批通道已断开'));
      try { input.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n', error => error ? reject(error) : resolve()); }
      catch (error) { reject(error); }
    });
  }

  #writeNotification(message) {
    try {
      const input = this.proc?.stdin;
      if (!input || input.destroyed || input.writable === false) throw new Error('输入流不可写');
      input.write(JSON.stringify(message) + '\n', (error) => {
        if (error) this.#emit('state', { type: 'writeError' });
      });
    } catch {
      this.#emit('state', { type: 'writeError' });
    }
  }

  #rejectAll(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }
}
