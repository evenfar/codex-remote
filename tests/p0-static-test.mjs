/**
 * 不连接 Codex 的静态回归测试。
 * 覆盖 P0 UI 接线和 SSH 远端 Codex 选择策略，适合在没有网络时运行。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRemoteCommand } from '../server/machines.mjs';

const root = new URL('..', import.meta.url);
const read = (file) => readFileSync(new URL(file, root), 'utf8');
const html = read('public/index.html');
const app = read('public/app.js');
const css = read('public/style.css');

for (const id of ['image-input', 'btn-attach', 'btn-queue', 'search-input', 'queue-bar', 'queue-panel']) {
  assert.match(html, new RegExp(`id="${id}"`), `缺少 ${id}`);
}
for (const marker of ['compressImage', "type: 'image'", 'enqueuePayload', 'drainQueue', 'archiveThread', 'deleteThread', 'decorateCodeBlocks', 'applyDiffWithCodex']) {
  assert.ok(app.includes(marker), `缺少 ${marker}`);
}
for (const marker of ['.image-tray', '.queue-bar', '.code-actions', '.thread-actions']) {
  assert.ok(css.includes(marker), `缺少样式 ${marker}`);
}

const command = buildRemoteCommand({
  user: 'devuser', workspace: '/home/devuser/project',
});
assert.match(command, /\.local\/bin\/codex/, '未优先查找当前用户的 ~/.local/bin/codex');
assert.ok(command.includes('cd --') && command.includes('/home/devuser/project'), '未安全进入远端工作目录');
assert.match(command, /exec "\$codex_path" app-server/, '未通过当前用户的 codex 路径启动 app-server');

const explicit = buildRemoteCommand({ codexBin: '/home/devuser/.local/bin/codex' });
assert.ok(explicit.includes('exec') && explicit.includes('/home/devuser/.local/bin/codex'), '未尊重显式 codexBin 配置');

console.log('P0 静态测试通过');
