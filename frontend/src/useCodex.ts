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
  token: localStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(LEGACY_TOKEN_KEY) ?? '',
  machines: [] as Machine[],
  machineReady: {} as Record<string, boolean>,
  machineErrors: {} as Record<string, string>,
  machineId: localStorage.getItem(MACHINE_KEY) ?? localStorage.getItem(LEGACY_MACHINE_KEY) ?? 'local',
  threads: [] as ThreadSummary[],
  threadId: '' as string,
  threadTitle: '新会话',
  messages: [] as ChatMessage[],
  activities: [] as ActivityItem[],
  running: false,
  loadingThreads: false,
  loadingChat: false,
  screen: 'threads' as 'threads' | 'chat',
  drawer: null as null | 'machines' | 'activity',
  approval: null as ApprovalRequest | null,
  queue: [] as DraftPayload[],
  toast: '',
  pairError: '',
})

let socket: WebSocket | null = null
let rpcSeq = 0
let reconnectTimer: number | undefined
let toastTimer: number | undefined
const rpcPending = new Map<number, RpcPending>()

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

function wsUrl(token: string) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`
}

function connect(token = state.token) {
  if (!token || state.connecting) return Promise.reject(new Error('请输入配对码'))
  window.clearTimeout(reconnectTimer)
  state.connecting = true
  state.pairError = ''

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      state.connecting = false
      reject(error)
    }

    try {
      socket?.close()
      socket = new WebSocket(wsUrl(token))
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
      return
    }

    const timeout = window.setTimeout(() => fail(new Error('连接超时')), 8000)
    socket.onmessage = (event) => {
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
        localStorage.setItem(TOKEN_KEY, token)
        applyHello(message.data ?? {})
        resolve()
        return
      }
      if (message.type === 'bridge' && message.event === 'auth.failed') {
        window.clearTimeout(timeout)
        state.pairError = '配对码错误'
        fail(new Error('配对码错误'))
        return
      }
      handleMessage(message)
    }
    socket.onerror = () => fail(new Error('无法连接服务'))
    socket.onclose = () => {
      window.clearTimeout(timeout)
      state.connected = false
      state.connecting = false
      for (const pending of rpcPending.values()) pending.reject(new Error('连接已断开'))
      rpcPending.clear()
      if (state.paired) reconnectTimer = window.setTimeout(() => connect(state.token).catch(() => undefined), 1800)
    }
  })
}

function applyHello(data: any) {
  state.machines = data.machines ?? []
  state.machineReady = Object.fromEntries(
    (data.connections ?? []).map((connection: any) => [connection.id, connection.ready && !connection.dead]),
  )
  if (!state.machines.some((machine) => machine.id === state.machineId)) state.machineId = 'local'
  machineCommand('connect', { id: state.machineId })
  loadThreads().catch((error) => notify(error.message))
  restoreQueue()
}

function rpc(method: string, params: Record<string, unknown> = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('服务未连接'))
  const ref = ++rpcSeq
  return new Promise<any>((resolve, reject) => {
    rpcPending.set(ref, { resolve, reject })
    socket?.send(JSON.stringify({ kind: 'rpc', ref, method, params, machineId: state.machineId }))
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
      if (message.event === 'rpc.result') pending.resolve(data.result)
      else pending.reject(new Error(data.message ?? '请求失败'))
      return
    }
    if (message.event === 'machines') {
      state.machines = data.machines ?? []
      state.machineReady = Object.fromEntries(
        (data.connections ?? []).map((connection: any) => [connection.id, connection.ready && !connection.dead]),
      )
    } else if (message.event === 'machine.added') {
      state.machines = [...state.machines.filter((machine) => machine.id !== data.id), data]
      notify(`已添加 ${data.name}`)
    } else if (message.event === 'machine.state') {
      state.machineReady[data.machineId] = data.type === 'ready'
      if (data.type === 'ready') state.machineErrors[data.machineId] = ''
      if (data.type === 'reconnecting' && data.machineId === state.machineId) notify('服务器连接中断，正在重连')
    } else if (message.event === 'error') {
      notify(data.message ?? '服务错误')
    }
    return
  }

  if (message.type !== 'codex') return
  const data = message.data ?? {}
  if (data.machineId && data.machineId !== state.machineId) return
  if (message.event === 'serverRequest' || (data.id !== undefined && /requestApproval|elicitation\/request/.test(data.method ?? ''))) {
    showApproval(data)
    return
  }
  handleNotification(data.method, data.params ?? {})
}

function handleNotification(method: string, params: any) {
  switch (method) {
    case 'thread/started':
      if (!state.threadId && params.thread?.id) state.threadId = params.thread.id
      break
    case 'turn/started':
      state.running = true
      break
    case 'turn/completed':
      state.running = false
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
    case 'error':
      addSystemMessage(`${params.willRetry ? '正在重试：' : '错误：'}${params.error?.message ?? '未知错误'}`)
      break
    case '__stderr':
      appendTerminal(`stderr-${state.machineId}`, 'Codex 日志', `${params.text ?? ''}\n`)
      break
    case 'thread/status/changed':
      if (params.status?.type === 'idle') state.running = false
      break
  }
}

async function loadThreads() {
  const requestedMachineId = state.machineId
  state.loadingThreads = true
  state.machineErrors[requestedMachineId] = ''
  state.threads = []
  try {
    const result = await rpc('thread/list', { cursor: null })
    if (state.machineId === requestedMachineId) {
      state.threads = (result?.data ?? []).slice().sort((a: ThreadSummary, b: ThreadSummary) =>
        (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
      )
    }
  } catch (error) {
    if (state.machineId === requestedMachineId) {
      state.machineErrors[requestedMachineId] = error instanceof Error ? error.message : String(error)
    }
    throw error
  } finally {
    if (state.machineId === requestedMachineId) state.loadingThreads = false
  }
}

async function switchMachine(id: string) {
  if (id === state.machineId) {
    state.drawer = null
    return
  }
  state.machineId = id
  state.threadId = ''
  state.threadTitle = '新会话'
  state.messages = []
  state.activities = []
  state.threads = []
  state.machineErrors[id] = ''
  state.screen = 'threads'
  state.drawer = null
  localStorage.setItem(MACHINE_KEY, id)
  machineCommand('connect', { id })
  restoreQueue()
  try {
    await loadThreads()
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error))
  }
}

function addMachine(machine: Omit<Machine, 'id'>) {
  machineCommand('add', machine)
}

function deleteMachine(id: string) {
  machineCommand('delete', { id })
  if (state.machineId === id) switchMachine('local')
}

async function openThread(thread: ThreadSummary) {
  state.screen = 'chat'
  state.loadingChat = true
  state.threadId = thread.id
  state.threadTitle = thread.name || thread.preview?.slice(0, 36) || '会话'
  state.messages = []
  state.activities = []
  try {
    let resumeError = ''
    try {
      const result = await rpc('thread/resume', { threadId: thread.id })
      const resumed = result?.thread ?? {}
      state.threadTitle = resumed.name || resumed.preview?.slice(0, 36) || state.threadTitle
    } catch (error) {
      // 远端会话可能正被桌面 Codex 占用。此时 resume 会拒绝，但历史仍可只读加载。
      resumeError = error instanceof Error ? error.message : String(error)
    }
    await loadHistory(thread.id)
    if (resumeError) notify(/active writer/i.test(resumeError) ? '会话正在其他 Codex 中运行，已只读打开' : resumeError)
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error))
  } finally {
    state.loadingChat = false
  }
}

async function loadHistory(threadId: string) {
  const result = await rpc('thread/turns/list', { threadId })
  for (const turn of result?.data ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type === 'userMessage') {
        const text = (item.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n')
        const images = (item.content ?? [])
          .filter((part: any) => part.type === 'image' && part.url)
          .map((part: any) => ({ url: part.url, name: '图片' }))
        state.messages.push({ id: item.id ?? crypto.randomUUID(), role: 'user', text, images })
      } else {
        renderItem(item, true)
      }
    }
  }
}

async function newThread() {
  state.screen = 'chat'
  state.threadId = ''
  state.threadTitle = '新会话'
  state.messages = []
  state.activities = []
  state.loadingChat = true
  try {
    const result = await rpc('thread/start', { options: {} })
    state.threadId = result?.thread?.id ?? ''
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error))
  } finally {
    state.loadingChat = false
  }
}

async function archiveThread(threadId: string) {
  await rpc('thread/archive', { threadId })
  state.threads = state.threads.filter((thread) => thread.id !== threadId)
}

async function removeThread(threadId: string) {
  await rpc('thread/delete', { threadId })
  state.threads = state.threads.filter((thread) => thread.id !== threadId)
}

function queueKey() {
  return `${state.machineId}:${state.threadId || 'new'}`
}

function persistQueue() {
  const all = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? localStorage.getItem(LEGACY_QUEUE_KEY) ?? '{}')
  all[queueKey()] = state.queue
  localStorage.setItem(QUEUE_KEY, JSON.stringify(all))
}

function restoreQueue() {
  try {
    const all = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? localStorage.getItem(LEGACY_QUEUE_KEY) ?? '{}')
    state.queue = all[queueKey()] ?? []
  } catch {
    state.queue = []
  }
}

async function startPayload(payload: DraftPayload, showMessage = true) {
  if (!state.threadId) {
    const result = await rpc('thread/start', { options: {} })
    state.threadId = result?.thread?.id ?? ''
  }
  if (!state.threadId) throw new Error('无法创建会话')
  if (showMessage) {
    state.messages.push({ id: crypto.randomUUID(), role: 'user', text: payload.text, images: payload.images })
  }
  const input: any[] = []
  if (payload.text) input.push({ type: 'text', text: payload.text })
  for (const image of payload.images) input.push({ type: 'image', url: image.url })
  await rpc('turn/start', { threadId: state.threadId, input })
  state.running = true
}

async function send(payload: DraftPayload) {
  if (!payload.text.trim() && !payload.images.length) return
  if (state.running) {
    state.queue.push(payload)
    persistQueue()
    notify('已加入队列')
    return
  }
  try {
    await startPayload(payload)
  } catch (error) {
    addSystemMessage(`发送失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function drainQueue() {
  if (state.running || !state.queue.length) return
  const next = state.queue.shift()
  persistQueue()
  if (!next) return
  try {
    await startPayload(next)
  } catch (error) {
    state.queue.unshift(next)
    persistQueue()
    addSystemMessage(`队列发送失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function removeQueued(index: number) {
  state.queue.splice(index, 1)
  persistQueue()
}

async function interrupt() {
  if (!state.threadId) return
  try {
    await rpc('turn/interrupt', { threadId: state.threadId })
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
  assistantMessage(id).text += delta
}

function appendReasoning(id: string, delta: string) {
  assistantMessage(id).reasoning = (assistantMessage(id).reasoning ?? '') + delta
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
  activity.content += delta
}

function addDiff(id: string, title: string, diff: string) {
  if (!diff) return
  upsertActivity({ id, type: 'diff', title, content: diff, status: 'done' })
}

function renderItem(item: any, completed: boolean) {
  if (!item) return
  if (item.type === 'agentMessage') {
    const message = assistantMessage(item.id)
    if (item.text) message.text = item.text
  } else if (item.type === 'commandExecution') {
    const existing = state.activities.find((activity) => activity.id === item.id)
    upsertActivity({
      id: item.id,
      type: 'terminal',
      title: item.command ?? existing?.title ?? '命令执行',
      content: item.aggregatedOutput ?? item.output ?? existing?.content ?? '',
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
  for (const item of state.activities) if (item.status === 'running') item.status = status
}

function showApproval(request: any) {
  const params = request.params ?? {}
  const command = params.item?.command
  const files = params.item?.changes?.map((change: any) => change.path ?? change).join('\n')
  state.approval = {
    id: request.id,
    method: request.method,
    machineId: request.machineId ?? state.machineId,
    title: command ? '允许执行命令？' : files ? '允许修改文件？' : 'Codex 请求确认',
    detail: command ?? files ?? params.text ?? request.method,
  }
}

function answerApproval(decision: 'accept' | 'decline') {
  if (!state.approval || !socket || socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({
    kind: 'serverReply',
    id: state.approval.id,
    machineId: state.approval.machineId,
    result: { decision },
  }))
  state.approval = null
}

function logout() {
  state.paired = false
  state.connected = false
  state.token = ''
  localStorage.removeItem(TOKEN_KEY)
  socket?.close()
}

export function useCodex() {
  return {
    state,
    currentMachine,
    filteredThreads,
    connect,
    loadThreads,
    switchMachine,
    addMachine,
    deleteMachine,
    openThread,
    newThread,
    archiveThread,
    removeThread,
    send,
    removeQueued,
    interrupt,
    answerApproval,
    notify,
    logout,
  }
}
