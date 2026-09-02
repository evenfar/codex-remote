import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const dataDir = DATA_DIR;

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

/**
 * 配置来源优先级：环境变量 > data/config.json > 默认值
 * 想自定义就改 data/config.json（已加入 .gitignore，不会被开源上传）
 */
export const config = loadConfig();

function loadConfig() {
  const fileConfig = readJson(path.join(DATA_DIR, 'config.json'));
  const env = process.env;

  const cfg = {
    // 监听地址：PC 本机用默认 127.0.0.1，服务器公网部署改 0.0.0.0
    host: env.CM_HOST || fileConfig.host || '127.0.0.1',
    port: Number(env.CM_PORT || fileConfig.port || 3010),

    // codex 二进制
    codexBin: env.CM_CODEX_BIN || fileConfig.codexBin || 'codex',

    // 会话默认工作目录（Codex 在哪个目录下干活）
    workspace: env.CM_WORKSPACE || fileConfig.workspace || process.cwd(),

    // token 强度：6 位配对码（局域网）或 43 位强 token（公网）
    tokenMode: env.CM_TOKEN_MODE || fileConfig.tokenMode || 'pair', // 'pair' | 'strong'

    // 公网/服务器场景：给 codex 子进程注入代理（梯子在 Windows 上时走 SSH 反向隧道）
    // 例： "http://127.0.0.1:7890"
    proxy: env.CM_PROXY || fileConfig.proxy || '',

    // 服务器场景：是否允许手机经 HTTPS 反代访问（Caddy/nginx 负责 TLS）
    trustProxy: env.CM_TRUST_PROXY || fileConfig.trustProxy || false,
  };
  return cfg;
}

export function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; };
}

// ---- token 管理 ----
const TOKEN_FILE = path.join(DATA_DIR, 'token.json');

export function loadOrCreateToken() {
  const existing = readJson(TOKEN_FILE);
  if (existing.token) return existing;

  const rec = {
    createdAt: new Date().toISOString(),
    token: config.tokenMode === 'strong'
      ? crypto.randomBytes(32).toString('base64url')
      : String(crypto.randomInt(100000, 1000000)), // 6 位配对码
  };
  writeJson(TOKEN_FILE, rec);
  return rec;
}

export function regenerateToken() {
  try { unlinkSync(TOKEN_FILE); } catch {}
  return loadOrCreateToken();
}

import { writeFileSync, unlinkSync } from 'node:fs';
function writeJson(p, obj) {
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}
export { writeJson as writeJsonSafe };
