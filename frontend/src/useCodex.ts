import { computed, reactive } from 'vue'
import type {
  ActivityItem,
  ApprovalRequest,
  ChatMessage,
  DraftPayload,
  ImageAttachment,
  Machine,
  ThreadSummary,
} from './types'

type RpcPending = { resolve: (value: any) => void; reject: (reason: Error) => void }
type ViewCache = { threads: ThreadSummary[]; threadId: string; threadTitle: string; messages: ChatMessage[]; activities: ActivityItem[]; cursor?: string | null }
type RunState = { running: boolean; sending: boolean; turnId?: string; revision: number }
const OUTPUT_LIMIT = 200_000

const TOKEN_KEY = 'codex-remote-token'
const MACHINE_KEY = 'codex-remote-machine'
const QUEUE_KEY = 'codex-remote-queue'
const LEGACY_TOKEN_KEY = 'codex-mobile-token'
const LEGACY_MACHINE_KEY = 'codex-mobile-machine'
const LEGACY_QUEUE_KEY = 'codex-mobile-vue-queue'

const state = reactive({
  paired: false,
  connected: false,
  connecting: false,
  token: storageGet(TOKEN_KEY, storageGet(LEGACY_TOKEN_KEY)),
  machines: [] as Machine[],
  machineReady: {} as Record<string, boolean>,
  machineErrors: {} as Record<string, string>,
  machineId: storageGet(MACHINE_KEY, storageGet(LEGACY_MACHINE_KEY, 'local')),
  threads: [] as ThreadSummary[],
  threadId: '' as string,
  threadTitle: '新会话',
  messages: [] as ChatMessage[],
  activities: [] as ActivityItem[],
  runs: {} as Record<string, RunState>,
  get running(): boolean { return !!state.runs[queueKey()]?.running },
  get sending(): boolean { return !!state.runs[queueKey()]?.sending },
  readOnly: false,
  archived: false,
  projectCwd: '',
  defaultCwd: '',
  loadingThreads: false,
  loadingChat: false,
  screen: 'threads' as 'threads' | 'chat',
  drawer: null as null | 'machines' | 'activity' | 'settings' | 'new',
  approval: null as ApprovalRequest | null,
  queue: [] as DraftPayload[],
  approvals: [] as ApprovalRequest[],
  settings: { model: '', effort: '', sandboxMode: '' },
  models: [] as any[],
  usage: null as any,
  rateLimits: null as any,
  threadsCursor: null as string | null,
  threadsLoadingMore: false,
  historyCursor: null as string | null,
  historyLoadingMore: false,
  userAtBottom: true,
  toast: '',
  pairError: '',
})

let socket: WebSocket | null = null
let socketGeneration = 0
let rpcSeq = 0
let reconnectTimer: number | undefined
let reconnectAttempts = 0
let toastTimer: number | undefined
let lifecycleBound = false
let viewGeneration = 0
let listGeneration = 0
let modelGeneration = 0
let usageGeneration = 0
const rpcPending = new Map<number, RpcPending & { timer: number }>()
const machineViews = new Map<string, ViewCache>()
const deltaBuffers = new Map<string, { assistant?: string; reasoning?: string; terminal?: string; timer?: number }>()
const context = () => ({ machineId: state.machineId, threadId: state.threadId, generation: viewGeneration })
const isCurrent = (ctx: ReturnType<typeof context>) => ctx.machineId === state.machineId && ctx.threadId === state.threadId && ctx.generation === viewGeneration
function runState(machineId = state.machineId, threadId = state.threadId) {
  const key = `${machineId}:${threadId || 'new'}`
  state.runs[key] ??= { running: false, sending: false, revision: 0 }
  return state.runs[key]
}
function beginView() {
  flushAll(); viewGeneration++
  state.readOnly = false; state.historyCursor = null; state.historyLoadingMore = false
  state.settings = { model: '', effort: '', sandboxMode: '' }; state.usage = null
}

function storageGet(key: string, fallback = '') {
  try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
}
function storageSet(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* private mode/quota */ }
}
function cacheCurrentView() {
  if (state.archived) return
  machineViews.set(state.machineId, {
    threads: state.threads.slice(), threadId: state.threadId, threadTitle: state.threadTitle,
    messages: state.messages.map((item) => ({ ...item, images: item.images?.slice() })),
    activities: state.activities.map((item) => ({ ...item })), cursor: state.threadsCursor,
  })
}
function restoreView(machineId: string) {
  const view = machineViews.get(machineId)
  if (!view) return false
  state.threads = view.threads.slice(); state.threadId = view.threadId; state.threadTitle = view.threadTitle
  state.messages = view.messages.map((item) => ({ ...item, images: item.images?.slice() }))
  state.activities = view.activities.map((item) => ({ ...item })); state.threadsCursor = view.cursor ?? null
  return true
}

const currentMachine = computed(() => state.machines.find((m) => m.id === state.machineId))
const filteredThreads = (query: string) => {
  const q = query.trim().toLowerCase()
  if (!q) return state.threads
  return state.threads.filter((thread) =>
    [thread.name, thread.preview, thread.cwd, thread.id].some((value) => value?.toLowerCase().includes(q)),
  )
}

function notify(message: string) {
  state.toast = message
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (state.toast = ''), 2600)
}

function wsUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}/ws`
}

function connect(token = state.token) {
  if (!token || state.connecting) return Promise.reject(new Error('请输入配对码'))
  window.clearTimeout(reconnectTimer); reconnectTimer = undefined
  const generation = ++socketGeneration
  state.connecting = true
  state.pairError = ''
  if (!lifecycleBound) {
    lifecycleBound = true
    window.addEventListener('online', () => { if (state.paired && !state.connected) connect(state.token).catch(() => undefined) })
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.paired && !state.connected) connect(state.token).catch(() => undefined) })
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      state.connecting = false
      reject(error)
    }

    let ws: WebSocket
    try {
      socket?.close()
      ws = new WebSocket(wsUrl())
      socket = ws
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
      return
    }

    const timeout = window.setTimeout(() => { fail(new Error('连接超时')); try { ws.close() } catch {} }, 8000)
    ws.onopen = () => ws.send(JSON.stringify({ kind: 'auth', token }))
    ws.onmessage = (event) => {
      if (generation !== socketGeneration || socket !== ws) return
      let message: any
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }

      if (message.type === 'bridge' && message.event === 'hello') {
        window.clearTimeout(timeout)
        settled = true
        state.token = token
        state.paired = true
        state.connected = true
        state.connecting = false
        storageSet(TOKEN_KEY, token)
        reconnectAttempts = 0
        applyHello(message.data ?? {})
        resolve()
        return
      }
      if (message.type === 'bridge' && message.event === 'auth.failed') {
        window.clearTimeout(timeout)
        state.paired = false; state.connected = false; state.token = ''
        try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ }
        state.pairError = '配对码错误'
        fail(new Error('配对码错误'))
        return
      }
      handleMessage(message)
    }
    ws.onerror = () => { if (generation === socketGeneration) fail(new Error('无法连接服务')) }
    ws.onclose = (event) => {
      window.clearTimeout(timeout)
      if (generation !== socketGeneration) return
      fail(new Error('连接已断开'))
      state.connected = false
      state.connecting = false
      for (const pending of rpcPending.values()) { window.clearTimeout(pending.timer); pending.reject(new Error('连接已断开')) }
      rpcPending.clear()
      if (event.code === 1013) notify('连接缓冲已满，重连后正在同步当前会话')
      if (state.paired && !reconnectTimer) {
        const delay = Math.min(30000, 800 * (2 ** reconnectAttempts++)) + Math.floor(Math.random() * 500)
        reconnectTimer = window.setTimeout(() => { reconnectTimer = undefined; connect(state.token).catch(() => undefined) }, delay)
      }
    }
  })
}

function applyHello(data: any) {
  state.machines = data.machines ?? []
  state.machineReady = Object.fromEntries(
    (data.connections ?? []).map((connection: any) => [connection.id, connection.ready && !connection.dead]),
  )
  state.defaultCwd = data.config?.workspace ?? ''
  replaceApprovals(data.approvals ?? [])
  if (!state.machines.some((machine) => machine.id === state.machineId)) { beginView(); state.machineId = 'local'; state.threadId = ''; state.messages = []; state.activities = [] }
  machineCommand('connect', { id: state.machineId })
  loadThreads().catch((error) => notify(error.message))
  restoreQueue()
  loadModels().catch(() => undefined)
  loadUsage().catch(() => undefined)
  if (state.threadId) resyncCurrentThread()
}

async function resyncCurrentThread() {
  if (!state.threadId) return
  const screen = state.screen
  const loading = openThread({ id: state.threadId, name: state.threadTitle })
  state.screen = screen
  await loading
}

function rpc(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000, machineId = state.machineId) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('服务未连接'))
  const ref = ++rpcSeq
  return new Promise<any>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      const pending = rpcPending.get(ref)
      if (!pending) return
      rpcPending.delete(ref)
      pending.reject(new Error(`请求超时：${method}`))
    }, timeoutMs)
    rpcPending.set(ref, { resolve, reject, timer })
    try {
      socket?.send(JSON.stringify({ kind: 'rpc', ref, method, params, machineId }))
    } catch (error) {
      window.clearTimeout(timer); rpcPending.delete(ref)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function machineCommand(action: string, data: Record<string, unknown> = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ kind: 'machine', action, data }))
}

function handleMessage(message: any) {
  if (message.type === 'bridge') {
    const data = message.data ?? {}
    if (message.event === 'rpc.result' || message.event === 'rpc.error') {
      const pending = rpcPending.get(data.ref)
      if (!pending) return
      rpcPending.delete(data.ref)
      window.clearTimeout(pending.timer)
      if (message.event === 'rpc.result') pending.resolve(data.result)
      else pending.reject(new Error(data.message ?? '请求失败'))
      return
    }
    if (message.event === 'machines') {
      state.machines = data.machines ?? []
      state.machineReady = Object.fromEntries(
        (data.connections ?? []).map((connection: any) => [connection.id, connection.ready && !connection.dead]),
      )
      if (!state.machines.some(machine => machine.id === state.machineId)) switchMachine('local')
    } else if (message.event === 'approvals') {
      replaceApprovals(data.requests ?? [])
    } else if (message.event === 'machine.added') {
      state.machines = [...state.machines.filter((machine) => machine.id !== data.id), data]
      notify(`已添加 ${data.name}`)
    } else if (message.event === 'machine.state') {
      state.machineReady[data.machineId] = data.type === 'ready'
      if (data.type === 'ready') state.machineErrors[data.machineId] = ''
      if (data.type === 'ready' && data.machineId === state.machineId) {
        loadThreads().catch(() => undefined); loadModels().catch(() => undefined); loadUsage().catch(() => undefined)
        if (state.threadId && !state.loadingChat) resyncCurrentThread()
      }
      if (data.type === 'reconnecting' && data.machineId === state.machineId) notify('服务器连接中断，正在重连')
    } else if (message.event === 'error') {
      if (data.machineId) state.machineErrors[data.machineId] = data.message
      notify(data.message ?? '服务错误')
    }
    return
  }

  if (message.type !== 'codex') return
  const data = message.data ?? {}
  if (message.event === 'serverRequest' || (data.id !== undefined && /requestApproval|elicitation\/request/.test(data.method ?? ''))) {
    showApproval(data)
    return
  }
  handleNotification(data.method, data.params ?? {}, data.machineId ?? data.params?.machineId ?? state.machineId)
}

function handleNotification(method: string, params: any, machineId = state.machineId) {
  const notificationThreadId = params?.threadId ?? params?.thread?.id ?? params?.turn?.threadId ?? params?.item?.threadId
  if (notificationThreadId) {
    const run = runState(machineId, notificationThreadId)
    if (method === 'turn/started') { run.running = true; run.turnId = params.turn?.id; run.revision++ }
    if (method === 'turn/completed') { run.running = false; run.turnId = undefined; run.revision++ }
    if (method === 'thread/status/changed') { run.running = params.status?.type === 'active'; run.revision++ }
  }
  if (machineId !== state.machineId) return
  if (notificationThreadId && notificationThreadId !== state.threadId) {
    if (method === 'turn/completed') loadThreads().catch(() => undefined)
    return
  }
  switch (method) {
    case 'thread/started':
      break
    case 'turn/started':
      break
    case 'turn/completed':
      finishActivities(params.turn?.error ? 'failed' : 'done')
      if (params.turn?.error) addSystemMessage(`回合出错：${params.turn.error.message ?? JSON.stringify(params.turn.error)}`)
      drainQueue()
      break
    case 'item/started':
      renderItem(params.item, false)
      break
    case 'item/updated':
    case 'item/completed':
      renderItem(params.item, method === 'item/completed')
      break
    case 'item/agentMessage/delta':
      appendAssistant(params.itemId, params.delta ?? '')
      break
    case 'item/reasoning/summaryTextDelta':
      appendReasoning(params.itemId, params.delta ?? '')
      break
    case 'item/commandExecution/outputDelta':
      appendTerminal(params.itemId, params.delta ?? '')
      break
    case 'turn/diff/updated':
      addDiff(`turn-diff-${params.turnId ?? Date.now()}`, '本回合文件变更', params.diff ?? '')
      break
    case 'thread/tokenUsage/updated':
      state.usage = params.tokenUsage ?? params
      break
    case 'account/rateLimits/updated':
      state.rateLimits = params.rateLimits ?? params
      break
    case 'error':
      addSystemMessage(`${params.willRetry ? '正在重试：' : '错误：'}${params.error?.message ?? '未知错误'}`)
      break
    case '__stderr':
      appendTerminal(`stderr-${state.machineId}`, 'Codex 日志', `${params.text ?? ''}\n`)
      break
    case 'thread/status/changed':
      break
  }
}

async function loadThreads() {
  const requestedMachineId = state.machineId
  const generation = ++listGeneration
  state.loadingThreads = true
  state.threadsLoadingMore = false
  state.machineErrors[requestedMachineId] = ''
  try {
    const result = await rpc('thread/list', { cursor: null, archived: state.archived, sortKey: 'updated_at', limit: 40 })
    if (state.machineId === requestedMachineId && generation === listGeneration) {
      state.threads = (result?.data ?? []).slice().sort((a: ThreadSummary, b: ThreadSummary) =>
        (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
      )
      state.threadsCursor = result?.nextCursor ?? null
      cacheCurrentView()
    }
  } catch (error) {
    if (state.machineId === requestedMachineId && generation === listGeneration) {
      state.machineErrors[requestedMachineId] = error instanceof Error ? error.message : String(error)
    }
    throw error
  } finally {
    if (state.machineId === requestedMachineId && generation === listGeneration) state.loadingThreads = false
  }
}

async function loadMoreThreads() {
  const requestedMachineId = state.machineId
  const generation = listGeneration
  if (!state.threadsCursor || state.threadsLoadingMore) return
  state.threadsLoadingMore = true
  try {
    const result = await rpc('thread/list', { cursor: state.threadsCursor, archived: state.archived, sortKey: 'updated_at', limit: 40 })
    if (state.machineId !== requestedMachineId || generation !== listGeneration) return
    const merged = [...state.threads, ...(result?.data ?? [])]
    state.threads = merged.filter((thread, index, all) => all.findIndex((candidate) => candidate.id === thread.id) === index)
      .sort((a: ThreadSummary, b: ThreadSummary) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    state.threadsCursor = result?.nextCursor ?? null
    cacheCurrentView()
  } finally { if (generation === listGeneration && requestedMachineId === state.machineId) state.threadsLoadingMore = false }
}

async function switchMachine(id: string) {
  if (id === state.machineId) {
    state.drawer = null
    return
  }
  flushAll(); cacheCurrentView(); beginView()
  state.machineId = id
  state.archived = false; state.loadingChat = false; state.threadsCursor = null; state.threadsLoadingMore = false
  state.models = []; state.rateLimits = null; state.projectCwd = ''
  state.threadId = ''
  state.threadTitle = '新会话'
  state.messages = []
  state.activities = []
  state.threads = []
  restoreView(id)
  state.machineErrors[id] = ''
  state.screen = 'threads'
  state.drawer = null
  storageSet(MACHINE_KEY, id)
  machineCommand('connect', { id })
  restoreQueue()
  try {
    await Promise.all([loadThreads(), loadModels(), loadUsage()])
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error))
  }
}

function addMachine(machine: Omit<Machine, 'id'> & { id?: string }) {
  machineCommand('add', machine)
}

function reconnectMachine(id: string) { machineCommand('reconnect', { id }) }

async function showArchived(archived: boolean) {
  state.archived = archived; state.threads = []; state.threadsCursor = null
  try { await loadThreads() } catch (error) { notify(String(error)) }
}

async function restoreThread(threadId: string) {
  const ctx = context()
  await rpc('thread/unarchive', { threadId })
  if (isCurrent(ctx)) {
    await showArchived(false)
    if (isCurrent(ctx) && state.threadId === threadId) await openThread({ id: threadId, name: state.threadTitle })
  }
}

function deleteMachine(id: string) {
  machineCommand('delete', { id })
  if (state.machineId === id) switchMachine('local')
}

async function openThread(thread: ThreadSummary) {
  const unsent = state.threadId === thread.id ? state.messages.filter(message => message.delivery === 'failed' || message.delivery === 'sending') : []
  beginView()
  state.screen = 'chat'
  state.loadingChat = true
  state.threadId = thread.id
  state.threadTitle = thread.name || thread.preview?.slice(0, 36) || '会话'
  state.messages = unsent
  state.activities = []
  state.historyCursor = null
  state.projectCwd = thread.cwd ?? currentMachine.value?.workspace ?? (state.machineId === 'local' ? state.defaultCwd : '')
  state.readOnly = state.archived
  restoreQueue()
  const ctx = context()
  const run = runState()
  const revision = run.revision
  try {
    let resumeError = ''
    try {
      const result = await rpc(state.archived ? 'thread/read' : 'thread/resume', { threadId: thread.id }, 30000, ctx.machineId)
      if (!isCurrent(ctx)) return
      const resumed = result?.thread ?? {}
      state.threadTitle = resumed.name || resumed.preview?.slice(0, 36) || state.threadTitle
      state.settings = { model: result.model ?? resumed.model ?? '', effort: result.reasoningEffort ?? resumed.reasoningEffort ?? '', sandboxMode: ({ readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access' } as Record<string, string>)[result.sandbox?.type] ?? '' }
      state.projectCwd = result.cwd ?? resumed.cwd ?? state.projectCwd
      if (run.revision === revision && !run.sending) run.running = resumed.status?.type === 'active'
    } catch (error) {
      // 远端会话可能正被桌面 Codex 占用。此时 resume 会拒绝，但历史仍可只读加载。
      resumeError = error instanceof Error ? error.message : String(error)
      if (!isCurrent(ctx)) return
      state.readOnly = true
    }
    if (!isCurrent(ctx)) return
    await loadHistory(thread.id, ctx)
    if (!isCurrent(ctx)) return
    if (resumeError) notify(/active writer/i.test(resumeError) ? '会话正在其他 Codex 中运行，已只读打开' : resumeError)
    if (!state.readOnly && !state.running) drainQueue()
  } catch (error) {
    if (isCurrent(ctx)) notify(error instanceof Error ? error.message : String(error))
  } finally {
    if (isCurrent(ctx)) state.loadingChat = false
  }
}

async function loadHistory(threadId: string, ctx = context()) {
  const run = runState(ctx.machineId, threadId)
  const revision = run.revision
  const result = await rpc('thread/turns/list', { threadId, cursor: null, sortDirection: 'desc', itemsView: 'full', limit: 20 }, 30000, ctx.machineId)
  if (!isCurrent(ctx)) return
  state.historyCursor = result?.nextCursor ?? null
  const turns = (result?.data ?? []).slice().reverse()
  if (run.revision === revision && !run.sending) {
    const active = turns.find((turn: any) => turn.status === 'inProgress')
    run.running = !!active; run.turnId = active?.id
  }
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      renderItem(item, turn.status !== 'inProgress')
    }
  }
  cacheCurrentView()
}

async function loadMoreHistory() {
  const threadId = state.threadId
  const requestedMachineId = state.machineId
  const ctx = context()
  if (!threadId || !state.historyCursor || state.historyLoadingMore) return
  state.historyLoadingMore = true
  try {
    const result = await rpc('thread/turns/list', { threadId, cursor: state.historyCursor, sortDirection: 'desc', itemsView: 'full', limit: 20 }, 30000, requestedMachineId)
    if (!isCurrent(ctx)) return
    state.historyCursor = result?.nextCursor ?? null
    const existingMessages = state.messages
    const existingActivities = state.activities
    state.messages = []; state.activities = []
    for (const turn of (result?.data ?? []).slice().reverse()) for (const item of turn.items ?? []) {
      renderItem(item, turn.status !== 'inProgress')
    }
    const pageMessages = state.messages; const pageActivities = state.activities
    state.messages = [...pageMessages.filter(message => !existingMessages.some(item => item.id === message.id)), ...existingMessages]
    state.activities = [...pageActivities.filter(activity => !existingActivities.some(item => item.id === activity.id)), ...existingActivities]
    cacheCurrentView()
  } finally { if (isCurrent(ctx)) state.historyLoadingMore = false }
}

async function newThread(cwd?: string) {
  if (state.loadingChat) return
  const settings = { ...state.settings }
  beginView()
  state.settings = settings
  state.archived = false
  state.projectCwd = typeof cwd === 'string' ? cwd.trim() : currentMachine.value?.workspace ?? (state.machineId === 'local' ? state.defaultCwd : '')
  state.screen = 'chat'
  state.threadId = ''
  state.threadTitle = '新会话'
  state.messages = []
  state.activities = []
  state.historyCursor = null
  restoreQueue()
  const pendingQueueKey = queueKey()
  const ctx = context()
  state.loadingChat = true
  try {
    const result = await rpc('thread/start', creationOptions(), 30000, ctx.machineId)
    if (!isCurrent(ctx)) return
    state.threadId = result?.thread?.id ?? ''
    ctx.threadId = state.threadId
    if (state.threadId) migrateQueueKey(pendingQueueKey, queueKey())
    cacheCurrentView()
    loadThreads().catch(() => undefined)
  } catch (error) {
    if (isCurrent(ctx)) notify(error instanceof Error ? error.message : String(error))
  } finally {
    if (isCurrent(ctx)) state.loadingChat = false
  }
}

async function archiveThread(threadId: string) {
  const ctx = context()
  await rpc('thread/archive', { threadId })
  if (isCurrent(ctx)) { state.threads = state.threads.filter((thread) => thread.id !== threadId); if (state.threadId === threadId) state.readOnly = true }
}

async function removeThread(threadId: string) {
  const ctx = context()
  await rpc('thread/delete', { threadId })
  if (isCurrent(ctx)) { state.threads = state.threads.filter((thread) => thread.id !== threadId); if (state.threadId === threadId) state.readOnly = true }
}

function queueKey() {
  return `${state.machineId}:${state.threadId || 'new'}`
}

function persistQueue() {
  try {
    const raw = storageGet(QUEUE_KEY, storageGet(LEGACY_QUEUE_KEY, '{}'))
    const all = JSON.parse(raw || '{}')
    const serializable = state.queue.map((item) => ({ ...item, images: item.images.slice(0, 4) }))
    let json = JSON.stringify({ ...all, [queueKey()]: serializable })
    // Images are useful in-memory but can exhaust localStorage. Keep text queue and notify once.
    if (json.length > 2_000_000) {
      const withoutImages = state.queue.map((item) => ({ ...item, images: [] }))
      json = JSON.stringify({ ...all, [queueKey()]: withoutImages })
      notify('队列图片较大，仅保留文字消息')
    }
    storageSet(QUEUE_KEY, json)
  } catch { notify('队列暂时无法持久化') }
}

function restoreQueue() {
  try {
    const all = JSON.parse(storageGet(QUEUE_KEY, storageGet(LEGACY_QUEUE_KEY, '{}')) || '{}')
    state.queue = all[queueKey()] ?? []
  } catch {
    state.queue = []
  }
}

function migrateQueueKey(from: string, to: string) {
  if (!from || from === to) { persistQueue(); return }
  try {
    const all = JSON.parse(storageGet(QUEUE_KEY, '{}') || '{}')
    const source = all[from] ?? state.queue
    if (source?.length && !all[to]) all[to] = source
    delete all[from]
    state.queue = all[to] ?? state.queue
    storageSet(QUEUE_KEY, JSON.stringify(all))
  } catch { persistQueue() }
}

function sandboxPolicy(mode: string) {
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false }
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' }
  if (mode === 'workspace-write') return { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  return undefined
}
function creationOptions() {
  const { model, effort, sandboxMode } = state.settings
  return { cwd: state.projectCwd || undefined, model: model || undefined, sandbox: sandboxMode || undefined, config: effort ? { model_reasoning_effort: effort } : undefined }
}

async function startPayload(payload: DraftPayload, existing?: ChatMessage) {
  if (!state.threadId || state.readOnly) throw new Error('请先打开可写会话')
  const ctx = context()
  const run = runState()
  if (run.running || run.sending) throw new Error('会话正在运行')
  run.sending = true; run.running = true
  let message: ChatMessage = existing ?? { id: crypto.randomUUID(), role: 'user' as const, text: payload.text, images: payload.images }
  message.delivery = 'sending'; message.error = ''
  if (!existing) { state.messages.push(message); message = state.messages[state.messages.length - 1]! }
  const input: any[] = []
  if (payload.text) input.push({ type: 'text', text: payload.text })
  for (const image of payload.images) input.push({ type: 'image', url: image.url })
  try {
    const result = await rpc('turn/start', { threadId: ctx.threadId, clientUserMessageId: message.id, input, model: state.settings.model || undefined, effort: state.settings.effort || undefined, sandboxPolicy: sandboxPolicy(state.settings.sandboxMode) }, 30000, ctx.machineId)
    if (run.running) run.turnId = result?.turn?.id ?? run.turnId
    message.delivery = 'sent'
    return true
  } catch (error) {
    message.delivery = 'failed'; message.error = error instanceof Error ? error.message : String(error)
    run.running = /请求超时|连接已断开/.test(message.error)
    if (run.running) message.error += '；结果待同步，重新连接后确认是否已发送'
    throw error
  } finally {
    run.sending = false
    if (isCurrent(ctx) && message.delivery === 'sent' && !run.running) drainQueue()
  }
}

async function send(payload: DraftPayload) {
  if (!payload.text.trim() && !payload.images.length) return false
  if (state.loadingChat || state.readOnly || !state.threadId || !state.connected) { notify('请先连接并打开可写会话'); return false }
  if (state.running || state.sending) {
    state.queue.push(payload)
    persistQueue()
    notify('已加入队列')
    return true
  }
  try {
    return await startPayload(payload)
  } catch (error) {
    notify(`发送失败：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

async function drainQueue() {
  if (state.running || state.sending || state.readOnly || !state.connected || !state.queue.length || state.messages.some(message => message.delivery === 'failed')) return
  const next = state.queue.shift()
  persistQueue()
  if (!next) return
  try {
    await startPayload(next)
  } catch (error) {
    notify(`队列发送失败，可在消息旁重试：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function retryMessage(message: ChatMessage) {
  if (message.delivery !== 'failed' || state.running || state.sending || state.loadingChat || state.readOnly || !state.connected) return
  try { await startPayload({ text: message.text, images: message.images ?? [] }, message) }
  catch (error) { notify(String(error)) }
}

function removeQueued(index: number) {
  state.queue.splice(index, 1)
  persistQueue()
}

async function interrupt() {
  if (!state.threadId) return
  try {
    const turnId = runState().turnId
    if (!turnId) { notify('正在同步回合，请稍后重试'); return }
    await rpc('turn/interrupt', { threadId: state.threadId, turnId })
    notify('已请求停止')
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error))
  }
}

function addSystemMessage(text: string) {
  state.messages.push({ id: crypto.randomUUID(), role: 'system', text })
}

function assistantMessage(id: string) {
  let message = state.messages.find((item) => item.id === id)
  if (!message) {
    message = { id, role: 'assistant', text: '' }
    state.messages.push(message)
  }
  return message
}

function appendAssistant(id: string, delta: string) {
  bufferDelta(id, 'assistant', delta)
}

function appendReasoning(id: string, delta: string) {
  bufferDelta(id, 'reasoning', delta)
}

function bufferDelta(id: string, kind: 'assistant' | 'reasoning' | 'terminal', delta: string) {
  if (!delta) return
  const buffer = deltaBuffers.get(id) ?? {}
  buffer[kind] = (buffer[kind] ?? '') + delta
  if (buffer.timer) return
  buffer.timer = window.setTimeout(() => flushOne(id), 32)
  deltaBuffers.set(id, buffer)
}

function flushOne(id: string) {
  const buffer = deltaBuffers.get(id)
  if (!buffer) return
  if (buffer.timer) window.clearTimeout(buffer.timer)
  deltaBuffers.delete(id)
  if (buffer.assistant) assistantMessage(id).text += buffer.assistant
  if (buffer.reasoning) { const message = assistantMessage(id); message.reasoning = (message.reasoning ?? '') + buffer.reasoning }
  if (buffer.terminal) appendTerminalNow(id, '命令执行', buffer.terminal)
}

function flushAll() {
  for (const id of [...deltaBuffers.keys()]) flushOne(id)
}

function upsertActivity(item: ActivityItem) {
  const existing = state.activities.find((activity) => activity.id === item.id)
  if (existing) Object.assign(existing, item)
  else state.activities.push(item)
}

function appendTerminal(id: string, titleOrDelta: string, maybeDelta?: string) {
  const title = maybeDelta === undefined ? '命令执行' : titleOrDelta
  const delta = maybeDelta === undefined ? titleOrDelta : maybeDelta
  let activity = state.activities.find((item) => item.id === id)
  if (!activity) {
    activity = { id, type: 'terminal', title, content: '', status: 'running' }
    state.activities.push(activity)
  }
  bufferDelta(id, 'terminal', delta)
}

function appendTerminalNow(id: string, title: string, delta: string) {
  let activity = state.activities.find((item) => item.id === id)
  if (!activity) {
    activity = { id, type: 'terminal', title, content: '', status: 'running' }
    state.activities.push(activity)
  }
  const content = `${activity.content}${delta}`
  activity.truncated ||= content.length > OUTPUT_LIMIT
  activity.content = content.slice(-OUTPUT_LIMIT)
}

function addDiff(id: string, title: string, diff: string) {
  if (!diff) return
  upsertActivity({ id, type: 'diff', title, content: diff.slice(-OUTPUT_LIMIT), status: 'done', truncated: diff.length > OUTPUT_LIMIT })
}

function renderItem(item: any, completed: boolean) {
  if (!item) return
  flushOne(item.id)
  if (item.type === 'userMessage') {
    const existing = state.messages.find(message => message.id === item.id)
    if (existing) { existing.delivery = 'sent'; return }
    state.messages.push({ id: item.id, role: 'user', text: (item.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n'), images: (item.content ?? []).filter((part: any) => part.type === 'image' && part.url).map((part: any) => ({ url: part.url, name: '图片' })), delivery: 'sent' })
  } else if (item.type === 'agentMessage') {
    const message = assistantMessage(item.id)
    if (item.text) message.text = item.text
  } else if (item.type === 'commandExecution') {
    const existing = state.activities.find((activity) => activity.id === item.id)
    upsertActivity({
      id: item.id,
      type: 'terminal',
      title: item.command ?? existing?.title ?? '命令执行',
      content: String(item.aggregatedOutput ?? item.output ?? existing?.content ?? '').slice(-OUTPUT_LIMIT),
      truncated: String(item.aggregatedOutput ?? item.output ?? '').length > OUTPUT_LIMIT || !!existing?.truncated,
      status: item.status === 'failed' || item.exitCode > 0 ? 'failed' : completed ? 'done' : 'running',
      expanded: existing?.expanded,
    })
  } else if (item.type === 'fileChange' || item.type === 'patch') {
    const changes = item.changes ?? []
    const title = changes.map((change: any) => change.path ?? change).join(', ') || '文件变更'
    const diff = changes.map((change: any) => change.diff ?? '').filter(Boolean).join('\n')
    addDiff(item.id, title, diff)
  }
}

function finishActivities(status: 'done' | 'failed') {
  flushAll()
  for (const item of state.activities) if (item.status === 'running') item.status = status
}

function showApproval(request: any) {
  const requestMachineId = request.machineId ?? state.machineId
  const params = request.params ?? {}
  const command = params.command ?? params.item?.command
  const files = params.item?.changes?.map((change: any) => change.path ?? change).join('\n')
  const approval: ApprovalRequest = {
    id: request.id,
    method: request.method,
    machineId: requestMachineId,
    title: command ? '允许执行命令？' : files ? '允许修改文件？' : 'Codex 请求确认',
    detail: [command ?? files ?? params.text ?? request.method, params.cwd, params.reason].filter(Boolean).join('\n'),
    receivedAt: Date.now(),
  }
  if (!state.approvals.some((item) => item.id === approval.id && item.machineId === approval.machineId)) state.approvals.push(approval)
  state.approval = state.approvals[0] ?? null
}

function replaceApprovals(requests: any[]) {
  state.approvals = []
  for (const request of requests) showApproval(request)
  state.approval = state.approvals[0] ?? null
}

function answerApproval(decision: 'accept' | 'decline') {
  if (!state.approval || !socket || socket.readyState !== WebSocket.OPEN) return
  const approval = state.approval
  socket.send(JSON.stringify({
    kind: 'serverReply',
    id: approval.id,
    machineId: approval.machineId,
    result: { decision },
  }))
  // Keep the prompt until the bridge confirms the write and synchronizes every device.
}

async function loadModels() {
  const machineId = state.machineId, generation = ++modelGeneration
  try { const result = await rpc('model/list', {}, 30000, machineId); if (machineId === state.machineId && generation === modelGeneration) state.models = result.data ?? []; return result.data ?? [] }
  catch { return [] }
}
async function loadUsage() {
  const machineId = state.machineId, generation = ++usageGeneration
  try { const result = await rpc('account/rateLimits/read', {}, 30000, machineId); if (machineId === state.machineId && generation === usageGeneration) state.rateLimits = result.rateLimits ?? null } catch { /* optional */ }
  return state.rateLimits
}
async function updateSettings(patch: Partial<typeof state.settings>) {
  if (state.readOnly) throw new Error('此会话只读')
  const ctx = context()
  const params: Record<string, unknown> = { threadId: ctx.threadId }
  if ('model' in patch) params.model = patch.model || null
  if ('effort' in patch) params.effort = patch.effort || null
  if ('sandboxMode' in patch) params.sandboxPolicy = sandboxPolicy(patch.sandboxMode ?? '') ?? null
  if (ctx.threadId) await rpc('thread/settings/update', params, 30000, ctx.machineId)
  if (isCurrent(ctx)) { Object.assign(state.settings, patch); notify('设置已应用') }
}
async function steer(text: string) {
  if (!state.threadId || !text.trim()) return
  const expectedTurnId = runState().turnId
  if (!expectedTurnId) throw new Error('正在同步回合，请稍后重试')
  await rpc('turn/steer', { threadId: state.threadId, expectedTurnId, input: [{ type: 'text', text: text.trim() }] })
  notify('已插话')
}
async function compact() {
  if (!state.threadId) return
  await rpc('thread/compact/start', { threadId: state.threadId }); notify('已请求压缩上下文')
}
async function renameThread(name: string) {
  if (!state.threadId || !name.trim()) return
  const ctx = context()
  await rpc('thread/name/set', { threadId: ctx.threadId, name: name.trim() }, 30000, ctx.machineId)
  if (!isCurrent(ctx)) return
  state.threadTitle = name.trim(); state.threads = state.threads.map((thread) => thread.id === state.threadId ? { ...thread, name: name.trim() } : thread); cacheCurrentView(); notify('会话已重命名')
}

function logout() {
  state.paired = false
  state.connected = false
  state.token = ''
  try { localStorage.removeItem(TOKEN_KEY) } catch { /* ignore */ }
  socketGeneration++
  viewGeneration++
  window.clearTimeout(reconnectTimer); reconnectTimer = undefined
  for (const pending of rpcPending.values()) { window.clearTimeout(pending.timer); pending.reject(new Error('已退出')) }
  rpcPending.clear()
  socket?.close()
}

export function useCodex() {
  return {
    state,
    currentMachine,
    filteredThreads,
    connect,
    loadThreads,
    loadMoreThreads,
    switchMachine,
    addMachine,
    reconnectMachine,
    showArchived,
    restoreThread,
    deleteMachine,
    openThread,
    loadMoreHistory,
    newThread,
    archiveThread,
    removeThread,
    send,
    retryMessage,
    removeQueued,
    interrupt,
    steer,
    compact,
    renameThread,
    loadModels,
    loadUsage,
    updateSettings,
    answerApproval,
    notify,
    logout,
  }
}
