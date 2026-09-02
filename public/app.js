/* Codex Remote 前端 v2：多机器 + 模型/effort/沙箱切换 + 思考过程 + 插话 */
'use strict';

const TOKEN_KEY = 'codex-remote-token';
const MACHINE_KEY = 'codex-remote-machine';

const state = {
  ws: null,
  connected: false,
  machineId: 'local',
  machines: [],          // [{id,name,type,...}]
  machineReady: {},       // id -> bool
  threadId: null,
  running: false,
  models: [],
  model: null, effort: null, sandbox: null,
  rateLimits: null,
  approvalReq: null,
  items: new Map(),
  threads: [],
  threadQuery: '',
  attachments: [],
  queueByContext: new Map(),
  queuePanelOpen: false,
  drainingQueue: false,
  rpcSeq: 0,
  rpcPending: new Map(),
};

const $ = (id) => document.getElementById(id);
const pages = { pair: $('page-pair'), threads: $('page-threads'), machines: $('page-machines'), chat: $('page-chat') };

function showPage(name) {
  for (const k of Object.keys(pages)) pages[k].classList.toggle('hidden', k !== name);
}

// ---------- WebSocket ----------
function wsUrl(token) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`;
}

function connect(token) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(wsUrl(token)); } catch (e) { return reject(e); }
    state.ws = ws;
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('连接超时')); }, 8000);
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'bridge' && msg.event === 'hello') {
        clearTimeout(timer); state.connected = true; resolve(msg.data); return;
      }
      if (msg.type === 'bridge' && msg.event === 'auth.failed') {
        clearTimeout(timer); reject(new Error('配对码错误')); return;
      }
      handleBridgeMessage(msg);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('无法连接服务')); };
    ws.onclose = () => {
      state.connected = false;
      if (state.threadId || state.running) toast('连接断开，重连中…');
      scheduleReconnect(token);
    };
  });
}

let reconnectTimer = null;
function scheduleReconnect(token) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connect(token);
      toast('已重连');
      if (state.threadId) await rpc('thread/resume', { threadId: state.threadId });
    } catch { scheduleReconnect(token); }
  }, 3000);
}

function rpc(method, params) {
  const ref = ++state.rpcSeq;
  return new Promise((resolve, reject) => {
    state.rpcPending.set(ref, { resolve, reject });
    state.ws.send(JSON.stringify({ kind: 'rpc', ref, method, params, machineId: state.machineId }));
  });
}

function machineCmd(action, data) {
  state.ws.send(JSON.stringify({ kind: 'machine', action, ...data }));
}

// ---------- 消息分发 ----------
function handleBridgeMessage(msg) {
  if (msg.type === 'bridge') {
    const d = msg.data ?? {};
    switch (msg.event) {
      case 'rpc.result': {
        const p = state.rpcPending.get(d.ref);
        if (p) { state.rpcPending.delete(d.ref); p.resolve(d.result); }
        break;
      }
      case 'rpc.error': {
        const p = state.rpcPending.get(d.ref);
        if (p) { state.rpcPending.delete(d.ref); p.reject(new Error(d.message)); }
        break;
      }
      case 'machines':
        state.machines = d.machines ?? [];
        state.machineReady = Object.fromEntries((d.connections ?? []).map(c => [c.id, c.ready && !c.dead]));
        renderMachineBar(); renderMachineList(); renderMachineStatus();
        break;
      case 'machine.added':
        state.machines = [...state.machines.filter(m => m.id !== d.id), d];
        renderMachineBar(); renderMachineList();
        toast(`机器已添加：${d.name}`);
        break;
      case 'machine.state': {
        const { machineId, type, delay } = d;
        if (type === 'ready') state.machineReady[machineId] = true;
        if (type === 'exit' || type === 'reconnecting') state.machineReady[machineId] = false;
        renderMachineBar(); renderMachineStatus();
        if (machineId === state.machineId && type === 'reconnecting') toast(`连接断开，${delay / 1000}s 后重试`);
        break;
      }
    }
    return;
  }
  if (msg.type !== 'codex') return;
  const { method, params, id, machineId } = msg.data ?? {};
  if (machineId && machineId !== state.machineId) return; // 只显示当前机器
  if (method && /requestApproval|elicitation\/request/.test(method) && id !== undefined) {
    showApproval({ id, method, params, machineId });
    return;
  }
  handleCodexNotification(method, params ?? {});
}

function handleCodexNotification(method, params) {
  switch (method) {
    case 'thread/started':
      if (!state.threadId && params.thread?.id) {
        state.threadId = params.thread.id;
      }
      break;
    case 'turn/started':
      state.running = true; updateRunUI(); break;
    case 'turn/completed':
      state.running = false; updateRunUI(); finalizeAllItems();
      if (params.turn?.error) addSystemNote(`回合出错：${JSON.stringify(params.turn.error)}`);
      drainQueue().catch(e => addSystemNote(`队列发送失败：${e.message}`));
      break;
    case 'error':
      addSystemNote(`${params.willRetry ? '⚠️' : '❌'} ${params.error?.message ?? '出错'}`);
      break;
    case 'item/started': renderItemStart(params.item, params.turnId); break;
    case 'item/updated': renderItemUpdate(params.item); break;
    case 'item/completed': renderItemComplete(params.item); break;
    case 'item/agentMessage/delta': appendAgentDelta(params.itemId, params.delta); break;
    case 'item/commandExecution/outputDelta': appendCommandOutput(params.itemId, params.delta); break;
    case 'item/reasoning/summaryTextDelta': appendReasoningDelta(params.itemId, params.delta); break;
    case 'turn/diff/updated': renderDiff(params); break;
    case 'thread/tokenUsage/updated': updateUsage(params.tokenUsage); break;
    case 'account/rateLimits/updated': state.rateLimits = params.rateLimits ?? params; updateUsagePanel(); break;
    case 'thread/status/changed':
      if (params.status?.type === 'idle' && state.running) { state.running = false; updateRunUI(); }
      break;
  }
}

// ---------- 机器管理 ----------
function renderMachineBar() {
  const bar = $('machine-bar');
  bar.innerHTML = '';
  for (const m of state.machines) {
    const chip = document.createElement('div');
    chip.className = 'machine-chip' + (m.id === state.machineId ? ' active' : '');
    const dotClass = state.machineReady[m.id] ? 'on' : (m.id === state.machineId ? 'err' : '');
    chip.innerHTML = `<span class="dot ${dotClass}"></span><span></span>`;
    chip.querySelector('span:last-child').textContent = m.name;
    chip.onclick = () => switchMachine(m.id);
    bar.appendChild(chip);
  }
}

function renderMachineStatus() {
  const el = $('machine-status');
  const m = state.machines.find(x => x.id === state.machineId);
  if (!m) { el.textContent = ''; return; }
  const ready = state.machineReady[machineKey(m.id)];
  el.textContent = ready
    ? `● ${m.name} 已连接${m.type === 'ssh' ? ` (${m.user ? m.user + '@' : ''}${m.host})` : '（本机）'}`
    : `○ ${m.name} 连接中…`;
}
function machineKey(id) { return id; }

async function switchMachine(id) {
  if (id === state.machineId) return;
  state.machineId = id;
  localStorage.setItem(MACHINE_KEY, id);
  state.threadId = null; state.items.clear();
  renderMachineBar(); renderMachineStatus();
  machineCmd('connect', { id });
  await loadThreads();
  renderQueue();
  await loadModels();
}

function renderMachineList() {
  const list = $('machine-list');
  list.innerHTML = '';
  for (const m of state.machines) {
    const card = document.createElement('div');
    card.className = 'machine-card';
    const meta = m.type === 'local'
      ? '本机 codex'
      : `${m.user ? m.user + '@' : ''}${m.host}:${m.port ?? 22}`;
    card.innerHTML = `
      <div class="machine-card-head">
        <span class="machine-card-name"></span>
        ${state.machineReady[m.id] ? '<span class="card-badge badge-ok">已连接</span>' : '<span class="card-badge badge-run">未连接</span>'}
      </div>
      <div class="machine-card-meta"></div>
      <div class="machine-card-actions"></div>`;
    card.querySelector('.machine-card-name').textContent = m.name;
    card.querySelector('.machine-card-meta').textContent = meta;
    const actions = card.querySelector('.machine-card-actions');
    const useBtn = document.createElement('button');
    useBtn.className = 'btn-ghost'; useBtn.textContent = '使用';
    useBtn.onclick = () => { switchMachine(m.id); showPage('threads'); };
    actions.appendChild(useBtn);
    if (m.type === 'ssh') {
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-ghost'; delBtn.textContent = '删除';
      delBtn.onclick = () => { machineCmd('delete', { id: m.id }); };
      actions.appendChild(delBtn);
    }
    list.appendChild(card);
  }
}

function openMachineForm() {
  $('machine-form').classList.remove('hidden');
  $('machine-form-title').textContent = '添加服务器（SSH）';
  ['mf-name', 'mf-host', 'mf-port', 'mf-user', 'mf-key', 'mf-workspace', 'mf-codex-bin'].forEach(id => $(id).value = '');
  $('mf-port').value = '22';
}

async function saveMachineForm() {
  const host = $('mf-host').value.trim();
  if (!host) { toast('请填写主机地址'); return; }
  machineCmd('add', {
    name: $('mf-name').value.trim() || host,
    type: 'ssh',
    host, port: Number($('mf-port').value || 22),
    user: $('mf-user').value.trim(),
    sshKey: $('mf-key').value.trim(),
    workspace: $('mf-workspace').value.trim(),
    codexBin: $('mf-codex-bin').value.trim(),
  });
  $('machine-form').classList.add('hidden');
}

// ---------- 设置抽屉（模型/effort/沙箱） ----------
async function loadModels() {
  try {
    const res = await rpc('model/list', {});
    state.models = (res?.data ?? []).filter(m => !m.hidden);
    renderModelOptions();
  } catch (e) { console.warn('model/list failed', e.message); }
}

function renderModelOptions() {
  const el = $('model-options');
  el.innerHTML = '';
  for (const m of state.models) {
    const opt = document.createElement('div');
    opt.className = 'option' + (m.id === state.model ? ' active' : '');
    const short = m.displayName ?? m.id;
    const eff = m.supportedReasoningEfforts?.length;
    opt.innerHTML = `<span></span>${eff ? `<small>${m.supportedReasoningEfforts.length} 档推理</small>` : ''}`;
    opt.querySelector('span').textContent = short;
    opt.onclick = () => applySetting({ model: m.id });
    el.appendChild(opt);
  }
}

function renderEffortOptions() {
  const model = state.models.find(m => m.id === state.model);
  const efforts = model?.supportedReasoningEfforts?.map(e => e.reasoningEffort)
    ?? ['low', 'medium', 'high'];
  const el = $('effort-options');
  el.innerHTML = '';
  for (const e of efforts) {
    const opt = document.createElement('div');
    opt.className = 'option' + (e === state.effort ? ' active' : '');
    opt.textContent = { low: '低', medium: '中', high: '高', xhigh: '特高' }[e] ?? e;
    opt.onclick = () => applySetting({ effort: e });
    el.appendChild(opt);
  }
}

function renderSandboxOptions() {
  const opts = [
    ['read-only', '只读'], ['workspace-write', '工作区可写'], ['danger-full-access', '完全访问'],
  ];
  const el = $('sandbox-options');
  el.innerHTML = '';
  for (const [mode, label] of opts) {
    const opt = document.createElement('div');
    opt.className = 'option' + (mode === state.sandbox ? ' active' : '');
    opt.textContent = label;
    opt.onclick = () => applySetting({ sandboxMode: mode });
    el.appendChild(opt);
  }
}

async function applySetting(patch) {
  try {
    if (patch.model) state.model = patch.model;
    if (patch.effort) state.effort = patch.effort;
    const params = { threadId: state.threadId };
    if (patch.model) params.model = patch.model;
    if (patch.effort) params.effort = patch.effort;
    if (patch.sandboxMode) params.sandboxMode = patch.sandboxMode;
    await rpc('thread/settings/update', params);
    if (patch.sandboxMode) state.sandbox = patch.sandboxMode;
    renderModelOptions(); renderEffortOptions(); renderSandboxOptions(); renderBadges();
    toast('已应用');
  } catch (e) { toast(`设置失败: ${e.message}`); }
}

function renderBadges() {
  const el = $('chat-badges');
  el.innerHTML = '';
  const model = state.models.find(m => m.id === state.model);
  if (model) {
    const b = document.createElement('span');
    b.className = 'badge accent'; b.textContent = (model.displayName ?? model.id).replace('GPT-', '');
    el.appendChild(b);
  }
  if (state.effort) {
    const b = document.createElement('span');
    b.className = 'badge'; b.textContent = { low: '低推理', medium: '中推理', high: '高推理', xhigh: '特高推理' }[state.effort] ?? state.effort;
    el.appendChild(b);
  }
}

async function toggleDrawer() {
  const d = $('settings-drawer');
  const opening = d.classList.contains('hidden');
  d.classList.toggle('hidden');
  if (opening && !state.models.length) await loadModels();
  if (opening) renderEffortOptions(), renderSandboxOptions(), updateUsagePanel();
}

function updateUsage(usage) {
  state.lastUsage = usage;
  updateUsagePanel();
}
function updateUsagePanel() {
  const el = $('usage-panel');
  const u = state.lastUsage?.last ?? state.lastUsage;
  const rl = state.rateLimits;
  let html = '';
  if (rl?.primary) {
    const pct = rl.primary.usedPercent ?? 0;
    html += `额度：${pct}% 已用（${rl.planType ?? ''}，${formatWindow(rl.primary)})<div class="usage-bar"><div class="usage-bar-fill" style="width:${Math.min(pct, 100)}%"></div></div>`;
  }
  if (u?.totalTokens) {
    html += `本回合 token：输入 ${fmtK(u.inputTokens)} / 输出 ${fmtK(u.outputTokens)} / 缓存 ${fmtK(u.cachedInputTokens)}`;
    if (u.modelContextWindow) html += `（上下文窗口 ${(u.modelContextWindow / 1000).toFixed(0)}k）`;
  }
  el.innerHTML = html || '暂无用量数据';
}
function fmtK(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n ?? 0); }
function formatWindow(p) {
  if (!p?.resetsAt) return '';
  return `重置于 ${new Date(p.resetsAt * 1000).toLocaleDateString('zh-CN')}`;
}

// ---------- 会话列表 ----------
async function loadThreads() {
  try {
    const list = await rpc('thread/list', { cursor: null });
    state.threads = (list?.data ?? []).slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    renderThreads();
  } catch (e) { toast(`加载会话失败: ${e.message}`); }
}

function renderThreads() {
  const el = $('thread-list');
  const query = state.threadQuery.trim().toLocaleLowerCase();
  const threads = query
    ? state.threads.filter(t => [t.name, t.preview, t.cwd].filter(Boolean).join('\n').toLocaleLowerCase().includes(query))
    : state.threads;
  el.innerHTML = '';
  if (!threads.length) {
    el.innerHTML = `<div class="thread-empty">${query ? '没有匹配的会话' : '还没有会话<br>点右上角 ＋ 开始'}</div>`;
    return;
  }
  for (const t of threads) {
    const div = document.createElement('div');
    div.className = 'thread-item';
    const time = t.updatedAt ? new Date(t.updatedAt * 1000).toLocaleString('zh-CN', { hour12: false }) : '';
    div.innerHTML = `
      <div class="thread-preview"></div>
      <div class="thread-meta"><span>${time}</span><span></span></div>
      <div class="thread-actions"><button class="thread-archive">归档</button><button class="thread-delete">删除</button></div>`;
    div.querySelector('.thread-preview').textContent = t.name || t.preview || '(无预览)';
    div.querySelector('.thread-meta span:last-child').textContent = (t.cwd ?? '').split(/[\\/]/).pop() ?? '';
    div.onclick = () => openThread(t.id);
    div.querySelector('.thread-archive').onclick = (e) => { e.stopPropagation(); archiveThread(t); };
    div.querySelector('.thread-delete').onclick = (e) => { e.stopPropagation(); deleteThread(t); };
    el.appendChild(div);
  }
}

async function archiveThread(thread) {
  if (!confirm(`归档“${thread.name || thread.preview || '此会话'}”？`)) return;
  try {
    await rpc('thread/archive', { threadId: thread.id });
    state.threads = state.threads.filter(t => t.id !== thread.id);
    renderThreads(); toast('已归档会话');
  } catch (e) { toast(`归档失败: ${e.message}`); }
}

async function deleteThread(thread) {
  if (!confirm(`永久删除“${thread.name || thread.preview || '此会话'}”？此操作无法撤销。`)) return;
  try {
    await rpc('thread/delete', { threadId: thread.id });
    state.threads = state.threads.filter(t => t.id !== thread.id);
    renderThreads(); toast('已删除会话');
  } catch (e) { toast(`删除失败: ${e.message}`); }
}

async function openThread(threadId) {
  state.threadId = threadId;
  state.items.clear();
  messagesEl().innerHTML = '';
  showPage('chat');
  renderQueue();
  try {
    const info = await rpc('thread/resume', { threadId });
    const t = info?.thread ?? {};
    $('chat-title').textContent = t.name || (t.preview || '').slice(0, 20) || `会话 ${threadId.slice(0, 8)}`;
    // 回填当前设置
    if (t.model) state.model = t.model;
    if (t.effort) state.effort = t.effort;
    await loadThreadHistory(threadId);
    renderBadges();
  } catch (e) { toast(`打开会话失败: ${e.message}`); }
}

async function loadThreadHistory(threadId) {
  try {
    const res = await rpc('thread/turns/list', { threadId });
    for (const turn of res?.data ?? []) {
      for (const item of turn.items ?? []) {
        if (item.type === 'userMessage') {
          const text = (item.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
          const images = (item.content ?? []).filter(c => c.type === 'image' && c.url).map(c => ({ url: c.url, name: '图片' }));
          if (text || images.length) addUserMsg({ text, images }, { history: true });
        } else if (['agentMessage', 'commandExecution', 'fileChange'].includes(item.type)) {
          renderItemComplete(item);
        }
      }
    }
    scrollBottom();
  } catch (e) { console.warn('历史加载失败', e); }
}

function newThread() {
  state.threadId = null;
  state.items.clear();
  messagesEl().innerHTML = '';
  $('chat-title').textContent = '新会话';
  showPage('chat');
  renderQueue();
  rpc('thread/start', { options: {} })
    .then(r => { if (r?.thread?.id) state.threadId = r.thread.id; })
    .catch(e => toast(`创建会话失败: ${e.message}`));
}

// ---------- 发送 / 队列 / 插话 / 停止 ----------
function clonePayload(payload) {
  return { text: payload.text ?? '', images: (payload.images ?? []).map(image => ({ ...image })) };
}

function takeDraftPayload() {
  const text = $('msg-input').value.trim();
  const images = state.attachments.map(image => ({ ...image }));
  if (!text && !images.length) return null;
  $('msg-input').value = '';
  state.attachments = [];
  $('image-input').value = '';
  autoGrow(); renderAttachments();
  return { text, images };
}

function queueContextKey() { return `${state.machineId}:${state.threadId ?? '__new__'}`; }
function currentQueue() {
  const key = queueContextKey();
  if (!state.queueByContext.has(key)) state.queueByContext.set(key, []);
  return state.queueByContext.get(key);
}

function renderQueue() {
  const queue = currentQueue();
  const bar = $('queue-bar');
  const panel = $('queue-panel');
  $('queue-count').textContent = `队列中有 ${queue.length} 条任务`;
  bar.classList.toggle('hidden', !queue.length);
  panel.classList.toggle('hidden', !queue.length || !state.queuePanelOpen);
  panel.innerHTML = '';
  queue.forEach((payload, index) => {
    const row = document.createElement('div');
    row.className = 'queue-item';
    const text = payload.text || `图片 ${payload.images?.length ?? 0} 张`;
    row.innerHTML = '<span class="queue-item-text"></span><button title="移除">×</button>';
    row.querySelector('.queue-item-text').textContent = `${index + 1}. ${text}`;
    row.querySelector('button').onclick = () => { queue.splice(index, 1); renderQueue(); };
    panel.appendChild(row);
  });
}

function enqueuePayload(payload) {
  const queued = clonePayload(payload);
  queued.displayed = true;
  currentQueue().push(queued);
  addUserMsg(queued, { queued: true });
  renderQueue();
  toast('已加入任务队列');
}

async function startPayload(payload, { showMessage = true } = {}) {
  if (!state.connected) throw new Error('连接已断开');
  if (!state.threadId) {
    const r = await rpc('thread/start', { options: {} });
    state.threadId = r?.thread?.id;
    if (!state.threadId) throw new Error('未能创建会话');
  }
  if (showMessage) addUserMsg(payload);
  const input = [];
  if (payload.text) input.push({ type: 'text', text: payload.text });
  for (const image of payload.images ?? []) input.push({ type: 'image', url: image.url });
  await rpc('turn/start', { threadId: state.threadId, input });
  state.running = true; updateRunUI();
}

async function sendMsg() {
  const payload = takeDraftPayload();
  if (!payload) return;
  if (state.running) { enqueuePayload(payload); return; }
  try { await startPayload(payload); }
  catch (e) { addSystemNote(`❌ 发送失败: ${e.message}`); }
}

function queueMsg() {
  const payload = takeDraftPayload();
  if (!payload) return;
  enqueuePayload(payload);
}

async function drainQueue() {
  if (state.drainingQueue || state.running) return;
  const queue = currentQueue();
  if (!queue.length) { renderQueue(); return; }
  state.drainingQueue = true;
  const payload = queue.shift();
  renderQueue();
  try { await startPayload(payload, { showMessage: !payload.displayed }); }
  catch (e) { queue.unshift(payload); renderQueue(); throw e; }
  finally { state.drainingQueue = false; }
}

async function steerMsg() {
  const input = $('msg-input');
  const text = input.value.trim();
  if (!text || !state.running || !state.threadId) return;
  input.value = '';
  autoGrow();
  addSystemNote(`💬 插话：${text}`);
  try {
    await rpc('turn/steer', { threadId: state.threadId, input: [{ type: 'text', text }] });
    toast('已插入当前任务');
  } catch (e) { toast(`插话失败: ${e.message}`); }
}

async function stopRun() {
  if (!state.threadId) return;
  try { await rpc('turn/interrupt', { threadId: state.threadId }); toast('已请求中断'); }
  catch (e) { toast(`中断失败: ${e.message}`); }
}

function updateRunUI() {
  $('btn-stop').classList.toggle('hidden', !state.running);
  $('btn-send').classList.toggle('hidden', state.running);
  $('btn-queue').classList.toggle('hidden', !state.running);
  $('btn-steer').classList.toggle('hidden', !state.running);
}

// ---------- 渲染（消息流） ----------
const messagesEl = () => $('chat-messages');

function addUserMsg(payload, { history = false, queued = false } = {}) {
  const message = typeof payload === 'string' ? { text: payload, images: [] } : clonePayload(payload);
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.innerHTML = '<div class="msg-text"></div>';
  div.querySelector('.msg-text').textContent = message.text;
  for (const image of message.images ?? []) {
    const img = document.createElement('img');
    img.className = 'user-image'; img.src = image.url; img.alt = image.name || '图片';
    div.appendChild(img);
  }
  if (queued) {
    const note = document.createElement('div');
    note.className = 'queue-note'; note.textContent = '已加入队列'; div.appendChild(note);
  }
  if (!history) {
    const actions = document.createElement('div');
    actions.className = 'user-actions';
    const edit = document.createElement('button'); edit.textContent = '编辑';
    edit.onclick = () => editUserPayload(message);
    const retry = document.createElement('button'); retry.textContent = '重试';
    retry.onclick = () => retryUserPayload(message);
    actions.append(edit, retry); div.appendChild(actions);
  }
  messagesEl().appendChild(div);
  scrollBottom();
}

function editUserPayload(payload) {
  $('msg-input').value = payload.text ?? '';
  state.attachments = (payload.images ?? []).map(image => ({ ...image }));
  autoGrow(); renderAttachments();
  $('msg-input').focus();
  toast('已载入输入框；发送后会作为新一轮消息');
}

async function retryUserPayload(payload) {
  const copy = clonePayload(payload);
  if (state.running) { enqueuePayload(copy); return; }
  try { await startPayload(copy); }
  catch (e) { addSystemNote(`❌ 重试失败: ${e.message}`); }
}

function addSystemNote(text) {
  const div = document.createElement('div');
  div.className = 'retry-note';
  div.textContent = text;
  messagesEl().appendChild(div);
  scrollBottom();
}

function renderMarkdown(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const parts = text.split(/```/);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      html += esc(parts[i]).replace(/`([^`\n]+)`/g, '<code>$1</code>');
    } else {
      const nl = parts[i].indexOf('\n');
      const lang = nl > -1 ? parts[i].slice(0, nl).trim() : '';
      const code = nl > -1 ? parts[i].slice(nl + 1) : parts[i];
      html += `<pre><code data-lang="${esc(lang)}">${esc(code)}</code></pre>`;
    }
  }
  return html;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text; textarea.style.position = 'fixed'; textarea.style.opacity = '0';
    document.body.appendChild(textarea); textarea.select();
    document.execCommand('copy'); textarea.remove();
  }
  toast('已复制');
}

function selectNodeText(node) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges(); selection.addRange(range);
  toast('已全选代码');
}

function decorateCodeBlocks(container) {
  for (const pre of container.querySelectorAll('pre')) {
    if (pre.parentElement?.classList.contains('code-block')) continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';
    const actions = document.createElement('div');
    actions.className = 'code-actions';
    const copy = document.createElement('button'); copy.textContent = '复制';
    const select = document.createElement('button'); select.textContent = '全选';
    copy.onclick = () => copyText(pre.querySelector('code')?.textContent ?? '');
    select.onclick = () => selectNodeText(pre.querySelector('code') ?? pre);
    actions.append(copy, select);
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.append(actions, pre);
  }
}

function ensureAgentMsg(itemId) {
  let it = state.items.get(itemId);
  if (!it) {
    const div = document.createElement('div');
    div.className = 'msg msg-agent';
    div.innerHTML = '<div class="msg-text typing-dots"></div>';
    messagesEl().appendChild(div);
    it = { el: div, type: 'agentMessage', text: '' };
    state.items.set(itemId, it);
    scrollBottom();
  }
  return it;
}

function appendAgentDelta(itemId, delta) {
  if (!delta) return;
  const it = ensureAgentMsg(itemId);
  it.text += delta;
  const t = it.el.querySelector('.msg-text');
  t.classList.remove('typing-dots');
  t.innerHTML = renderMarkdown(it.text);
  decorateCodeBlocks(t);
  scrollBottom();
}

let reasoningTimers = new Map();
function appendReasoningDelta(itemId, delta) {
  if (!delta) return;
  let it = state.items.get(`r:${itemId}`);
  if (!it) {
    const div = document.createElement('div');
    div.className = 'reasoning';
    div.innerHTML = '<div class="reasoning-label">💭 思考中…</div><div class="reasoning-text"></div>';
    messagesEl().appendChild(div);
    it = { el: div, type: 'reasoning', text: '', collapsed: false };
    state.items.set(`r:${itemId}`, it);
  }
  it.text += delta;
  // 未折叠时实时更新
  if (!it.collapsed) it.el.querySelector('.reasoning-text').textContent = it.text;
  clearTimeout(reasoningTimers.get(itemId));
  reasoningTimers.set(itemId, setTimeout(() => {
    it.collapsed = true;
    const label = it.el.querySelector('.reasoning-label');
    label.textContent = '💭 思考过程（点按展开）';
    it.el.querySelector('.reasoning-text').style.display = 'none';
    it.el.onclick = () => {
      const t = it.el.querySelector('.reasoning-text');
      const hidden = t.style.display === 'none';
      t.style.display = hidden ? 'block' : 'none';
      if (hidden) { it.el.querySelector('.reasoning-label').textContent = '💭 思考过程（点按收起）'; }
    };
  }, 1500));
  scrollBottom();
}

function ensureCommandCard(itemId, init) {
  let it = state.items.get(itemId);
  if (!it) {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `
      <div class="card-head">
        <span class="card-icon">$</span>
        <span class="card-title"></span>
        <span class="card-badge badge-run">运行中</span>
      </div>
      <div class="card-body"><div class="card-output"></div></div>`;
    div.querySelector('.card-head').onclick = () => div.classList.toggle('open');
    messagesEl().appendChild(div);
    it = { el: div, type: 'commandExecution', output: '' };
    state.items.set(itemId, it);
    scrollBottom();
  }
  if (init?.command) it.el.querySelector('.card-title').textContent = init.command;
  return it;
}

function appendCommandOutput(itemId, delta) {
  if (!delta) return;
  const it = ensureCommandCard(itemId);
  it.output += delta;
  it.el.querySelector('.card-output').textContent = it.output;
  scrollBottom(true);
}

function ensureFileCard(itemId) {
  let it = state.items.get(itemId);
  if (!it) {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `
      <div class="card-head">
        <span class="card-icon">✏️</span>
        <span class="card-title"></span>
        <span class="card-badge badge-run">变更</span>
      </div>
      <div class="card-body"><div class="diff-actions"></div><div class="card-diff"></div></div>`;
    div.querySelector('.card-head').onclick = () => div.classList.toggle('open');
    messagesEl().appendChild(div);
    it = { el: div, type: 'fileChange' };
    state.items.set(itemId, it);
    scrollBottom();
  }
  return it;
}

function renderDiffHtml(lines) {
  return lines.map(l => {
    const cls = l.startsWith('+') && !l.startsWith('+++') ? 'diff-add'
      : l.startsWith('-') && !l.startsWith('---') ? 'diff-del'
      : l.startsWith('@@') ? 'diff-hunk' : '';
    const esc = l.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return cls ? `<span class="${cls}">${esc}</span>` : esc;
  }).join('\n');
}

function renderDiff(params) {
  const diffText = params.diff;
  if (!diffText) return;
  const chunks = diffText.split(/(?=^diff --git )/m).filter(Boolean);
  for (const chunk of chunks) {
    const m = chunk.match(/^diff --git a\/(.+) b\/(.+)$/m);
    const filePath = m ? m[2] : '变更';
    const it = ensureFileCard(`diff:${filePath}:${params.turnId ?? ''}`);
    it.el.querySelector('.card-title').textContent = filePath;
    it.el.querySelector('.card-diff').innerHTML = renderDiffHtml(chunk.split('\n'));
    setDiffActions(it, chunk);
  }
}

function renderFileChange(item) {
  const it = ensureFileCard(item.id);
  const changes = item.changes ?? [];
  it.el.querySelector('.card-title').textContent = changes.map(c => c.path ?? c).join(', ') || '文件变更';
  if (changes.length) {
    const diff = changes.map(c => String(c.diff ?? '')).filter(Boolean).join('\n');
    it.el.querySelector('.card-diff').innerHTML = changes.map(c =>
      `<div style="margin-bottom:8px"><b>${(c.path ?? '').split(/[\\/]/).pop()}</b></div>` +
      renderDiffHtml(String(c.diff ?? '').split('\n'))
    ).join('<hr style="border-color:var(--border)">');
    if (diff) setDiffActions(it, diff);
  }
}

function setDiffActions(it, diff) {
  if (!diff) return;
  it.diff = diff;
  const actions = it.el.querySelector('.diff-actions');
  if (actions.dataset.ready) return;
  actions.dataset.ready = 'true';
  const copy = document.createElement('button'); copy.textContent = '复制 Diff';
  const apply = document.createElement('button'); apply.textContent = '让 Codex 应用';
  copy.onclick = () => copyText(it.diff);
  apply.onclick = () => applyDiffWithCodex(it.diff);
  actions.append(copy, apply);
}

async function applyDiffWithCodex(diff) {
  if (!state.threadId) return;
  if (!confirm('让 Codex 将这份 Diff 应用到工作区？Codex 仍会按当前沙箱和审批策略执行。')) return;
  const payload = { text: `请将下面的 unified diff 应用到当前工作区；先检查冲突，必要时请求审批。\n\n\`\`\`diff\n${diff}\n\`\`\``, images: [] };
  if (state.running) { enqueuePayload(payload); return; }
  try { await startPayload(payload); }
  catch (e) { addSystemNote(`❌ 应用 Diff 失败: ${e.message}`); }
}

function renderItemStart(item, turnId) {
  if (!item) return;
  switch (item.type) {
    case 'agentMessage': ensureAgentMsg(item.id); break;
    case 'commandExecution': ensureCommandCard(item.id, item); break;
    case 'fileChange': case 'patch':
      ensureFileCard(item.id);
      if (item.changes) renderFileChange(item);
      break;
  }
}

function renderItemUpdate(item) { renderItemStart(item); if (item.type === 'commandExecution') updateCommandState(item); }

function updateCommandState(item) {
  const it = state.items.get(item.id);
  if (!it) return;
  if (item.command) it.el.querySelector('.card-title').textContent = item.command;
  const badge = it.el.querySelector('.card-badge');
  if (item.exitCode === 0) { badge.textContent = '成功'; badge.className = 'card-badge badge-ok'; }
  else if (item.exitCode > 0 || item.status === 'failed') { badge.textContent = `失败(${item.exitCode ?? '?'})`; badge.className = 'card-badge badge-fail'; }
  if (item.output) { it.output = item.output; it.el.querySelector('.card-output').textContent = item.output; }
}

function renderItemComplete(item) {
  if (!item) return;
  switch (item.type) {
    case 'agentMessage': {
      const it = ensureAgentMsg(item.id);
      if (item.text) {
        it.text = item.text;
        const target = it.el.querySelector('.msg-text');
        target.innerHTML = renderMarkdown(item.text);
        decorateCodeBlocks(target);
      }
      else it.el.querySelector('.msg-text').classList.remove('typing-dots');
      break;
    }
    case 'commandExecution': updateCommandState(item); break;
    case 'fileChange': case 'patch': renderFileChange(item); break;
  }
}

function finalizeAllItems() {
  for (const it of state.items.values()) {
    if (it.type === 'agentMessage') it.el.querySelector('.msg-text')?.classList.remove('typing-dots');
  }
}

function scrollBottom(gentle) {
  const el = messagesEl();
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
  if (near || !gentle) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

// ---------- 审批 ----------
function showApproval(req) {
  state.approvalReq = req;
  const p = req.params ?? {};
  let text = 'Codex 请求执行敏感操作';
  if (p.item?.command) text = `执行命令：\n${p.item.command}`;
  else if (p.item?.changes?.length) text = `修改文件：\n${p.item.changes.map(c => c.path ?? c).join('\n')}`;
  else if (p.text) text = p.text;
  $('approval-text').textContent = text;
  $('approval-bar').classList.remove('hidden');
  scrollBottom();
}

async function answerApproval(decision) {
  const req = state.approvalReq;
  if (!req) return;
  state.approvalReq = null;
  $('approval-bar').classList.add('hidden');
  state.ws.send(JSON.stringify({
    kind: 'serverReply', id: req.id, machineId: req.machineId, result: { decision },
  }));
}

// ---------- 工具 ----------
let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function autoGrow() {
  const t = $('msg-input');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 120) + 'px';
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法解析图片')); };
    image.src = url;
  });
}

async function compressImage(file) {
  const image = await loadImage(file);
  const maxEdge = 1600;
  const ratio = Math.min(1, maxEdge / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
  const width = Math.max(1, Math.round((image.naturalWidth || image.width) * ratio));
  const height = Math.max(1, Math.round((image.naturalHeight || image.height) * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').drawImage(image, 0, 0, width, height);
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise(resolve => canvas.toBlob(resolve, type, 0.82));
  if (!blob) throw new Error('图片压缩失败');
  return readAsDataUrl(blob);
}

async function addImages(files) {
  const accepted = [...files].filter(file => file.type.startsWith('image/'));
  if (!accepted.length) { toast('请选择图片文件'); return; }
  const remaining = Math.max(0, 4 - state.attachments.length);
  if (!remaining) { toast('一次最多发送 4 张图片'); return; }
  for (const file of accepted.slice(0, remaining)) {
    try {
      const url = await compressImage(file);
      state.attachments.push({ id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, name: file.name, url });
    } catch (e) { toast(`${file.name}: ${e.message}`); }
  }
  if (accepted.length > remaining) toast('一次最多发送 4 张图片');
  renderAttachments();
}

function renderAttachments() {
  const tray = $('image-tray');
  tray.innerHTML = '';
  tray.classList.toggle('hidden', !state.attachments.length);
  for (const image of state.attachments) {
    const chip = document.createElement('div');
    chip.className = 'image-chip';
    chip.innerHTML = '<img><button title="移除">×</button>';
    chip.querySelector('img').src = image.url;
    chip.querySelector('img').alt = image.name;
    chip.querySelector('button').onclick = () => {
      state.attachments = state.attachments.filter(item => item.id !== image.id);
      renderAttachments();
    };
    tray.appendChild(chip);
  }
}

// ---------- 事件绑定 ----------
$('pair-btn').onclick = doPair;
$('pair-input').onkeydown = (e) => { if (e.key === 'Enter') doPair(); };
$('btn-new-thread').onclick = newThread;
$('btn-back').onclick = () => { loadThreads(); showPage('threads'); };
$('btn-send').onclick = sendMsg;
$('btn-attach').onclick = () => $('image-input').click();
$('image-input').onchange = (e) => { addImages(e.target.files); };
$('btn-queue').onclick = queueMsg;
$('btn-steer').onclick = steerMsg;
$('btn-stop').onclick = stopRun;
$('queue-toggle').onclick = () => { state.queuePanelOpen = !state.queuePanelOpen; renderQueue(); };
$('search-input').oninput = (e) => { state.threadQuery = e.target.value; renderThreads(); };
$('btn-approve').onclick = () => answerApproval('accept');
$('btn-decline').onclick = () => answerApproval('decline');
$('btn-chat-settings').onclick = toggleDrawer;
$('btn-machines').onclick = () => { renderMachineList(); showPage('machines'); };
$('btn-machines-back').onclick = () => showPage('threads');
$('btn-add-machine').onclick = openMachineForm;
$('mf-save').onclick = saveMachineForm;
$('mf-cancel').onclick = () => $('machine-form').classList.add('hidden');
$('btn-compact').onclick = async () => {
  if (!state.threadId) return;
  try { await rpc('thread/compact/start', { threadId: state.threadId }); toast('已请求压缩上下文'); }
  catch (e) { toast(`压缩失败: ${e.message}`); }
};
$('btn-rename').onclick = async () => {
  if (!state.threadId) return;
  const name = prompt('新会话名称：', $('chat-title').textContent);
  if (!name) return;
  try {
    await rpc('thread/name/set', { threadId: state.threadId, name });
    $('chat-title').textContent = name;
    toast('已重命名');
  } catch (e) { toast(`重命名失败: ${e.message}`); }
};
$('msg-input').oninput = autoGrow;
$('msg-input').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMsg(); }
};

async function doPair() {
  const token = $('pair-input').value.trim();
  if (!token) return;
  $('pair-error').textContent = '';
  try {
    localStorage.setItem(TOKEN_KEY, token);
    const hello = await connect(token);
    await enterApp(hello);
  } catch (e) {
    localStorage.removeItem(TOKEN_KEY);
    $('pair-error').textContent = e.message;
  }
}

async function enterApp(hello) {
  if (hello?.machines) {
    state.machines = hello.machines;
    state.machineReady = Object.fromEntries((hello.connections ?? []).map(c => [c.id, c.ready && !c.dead]));
  }
  const saved = localStorage.getItem(MACHINE_KEY);
  if (saved && state.machines.some(m => m.id === saved)) state.machineId = saved;
  renderMachineBar(); renderMachineStatus();
  await loadThreads();
  showPage('threads');
  loadModels().catch(() => {});
  rpc('account/rateLimits/read', {}).then(r => { state.rateLimits = r?.rateLimits ?? r; updateUsagePanel(); }).catch(() => {});
}

(async function init() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    try {
      const hello = await connect(token);
      await enterApp(hello);
      return;
    } catch { localStorage.removeItem(TOKEN_KEY); }
  }
  showPage('pair');
})();
