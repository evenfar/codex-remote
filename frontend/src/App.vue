<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import {
  Archive,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Clipboard,
  Code2,
  Cpu,
  FileDiff,
  ImagePlus,
  LoaderCircle,
  Menu,
  MessageSquarePlus,
  Monitor,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings2,
  Moon,
  Sun,
  TerminalSquare,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from '@lucide/vue'
import { useCodex } from './useCodex'
import type { ActivityItem, ImageAttachment, Machine, ThreadSummary } from './types'

const codex = useCodex()
const { state, currentMachine } = codex
const theme = ref<'light' | 'dark'>('dark')
const pairToken = ref(state.token)
const search = ref('')
const projectFilter = ref('')
const messageText = ref('')
const images = ref<ImageAttachment[]>([])
const messagesEl = ref<HTMLElement>()
const fileInput = ref<HTMLInputElement>()
const activityTab = ref<'all' | 'terminal' | 'diff'>('all')
const steerText = ref('')
const renameText = ref('')
const showJumpBottom = ref(false)
const showMachineForm = ref(false)
const projectInput = ref('')
const messageWindow = ref(100)
const visibleMessages = computed(() => state.messages.slice(-messageWindow.value))
const hasEarlier = computed(() => state.messages.length > messageWindow.value || !!state.historyCursor)
const draftViews = new Map<string, { text: string; images: ImageAttachment[] }>()
const openThreadMenu = ref<string | null>(null)
const machineForm = reactive({
  id: '',
  name: '远程服务器',
  type: 'ssh' as const,
  host: '',
  port: 22,
  user: '',
  workspace: '',
  sshKey: '',
  codexBin: '',
  proxy: '',
})

const projects = computed(() => [...new Set(state.threads.map((thread) => thread.cwd).filter(Boolean) as string[])])
const visibleThreads = computed(() => codex.filteredThreads(search.value).filter((thread) =>
  !projectFilter.value || thread.cwd === projectFilter.value,
))
const visibleActivities = computed(() => state.activities.filter((item) =>
  activityTab.value === 'all' || item.type === activityTab.value,
))
const supportedEfforts = computed(() => {
  const selected = state.models.find((model) => model.id === state.settings.model)
  const values = selected?.supportedReasoningEfforts?.map((item: any) => typeof item === 'string' ? item : item?.reasoningEffort).filter(Boolean)
  return [...new Set((values?.length ? values : ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) as string[])]
})
const effortLabel = (effort: string) => ({ minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '特高', max: '极高', ultra: '极致' }[effort] ?? effort)
const currentMachineError = computed(() => state.machineErrors[state.machineId])
const terminalCount = computed(() => state.activities.filter((item) => item.type === 'terminal').length)
const diffCount = computed(() => state.activities.filter((item) => item.type === 'diff').length)

function applyTheme(value: 'light' | 'dark') {
  theme.value = value
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = value
  try { if (typeof localStorage !== 'undefined') localStorage.setItem('codex-remote-theme', value) } catch { /* ignore */ }
}
function initialTheme(): 'light' | 'dark' {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('codex-remote-theme') : null
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* ignore */ }
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}
function toggleTheme() { applyTheme(theme.value === 'dark' ? 'light' : 'dark') }
applyTheme(initialTheme())

onMounted(async () => {
  if (!state.token) return
  try {
    await codex.connect(state.token)
  } catch (error) {
    state.pairError = error instanceof Error ? error.message : String(error)
  }
})

watch(
  () => [state.messages.length, state.messages.at(-1)?.text, state.activities.length],
  () => nextTick(() => {
    if (!state.userAtBottom) { showJumpBottom.value = true; return }
    messagesEl.value?.scrollTo({ top: messagesEl.value.scrollHeight })
  }),
)
watch(() => state.machineId, () => { projectFilter.value = ''; search.value = '' })
watch(() => `${state.machineId}:${state.threadId}`, (key, previous) => {
  draftViews.set(previous, { text: messageText.value, images: [...images.value] })
  if (draftViews.size > 20) draftViews.delete(draftViews.keys().next().value!)
  const draft = draftViews.get(key)
  messageText.value = draft?.text ?? ''; images.value = draft?.images ?? []
  messageWindow.value = 100; state.userAtBottom = true; showJumpBottom.value = false
})

function prepareThread() {
  projectInput.value = projectFilter.value || state.projectCwd || currentMachine.value?.workspace || (state.machineId === 'local' ? state.defaultCwd : '')
  state.drawer = 'new'
}
async function createThread() {
  const cwd = projectInput.value.trim()
  if (cwd && !/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(cwd)) { codex.notify('请填写绝对路径'); return }
  state.drawer = null
  await codex.newThread(cwd)
}
async function loadEarlier() {
  const el = messagesEl.value
  const before = el ? el.scrollHeight - el.scrollTop : 0
  state.userAtBottom = false
  try {
    if (state.messages.length <= messageWindow.value) await codex.loadMoreHistory()
    messageWindow.value += 100
    await nextTick()
    if (el) el.scrollTop = el.scrollHeight - before
  } catch (error) { codex.notify(String(error)) }
}

async function pair() {
  state.pairError = ''
  try {
    await codex.connect(pairToken.value.trim())
  } catch (error) {
    state.pairError = error instanceof Error ? error.message : String(error)
  }
}

async function openThread(thread: ThreadSummary) {
  openThreadMenu.value = null
  await codex.openThread(thread)
  await nextTick()
  state.userAtBottom = true
  showJumpBottom.value = false
  messagesEl.value?.scrollTo({ top: messagesEl.value.scrollHeight })
}

async function sendMessage() {
  const payload = { text: messageText.value.trim(), images: [...images.value] }
  if (!payload.text && !payload.images.length) return
  messageText.value = ''
  images.value = []
  const key = `${state.machineId}:${state.threadId}`
  const accepted = await codex.send(payload)
  if (!accepted && key === `${state.machineId}:${state.threadId}` && !messageText.value && !images.value.length) {
    messageText.value = payload.text; images.value = payload.images
  }
}

function onComposerKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    sendMessage()
  }
}

function onMessageScroll() {
  const el = messagesEl.value
  if (!el) return
  state.userAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140
  showJumpBottom.value = !state.userAtBottom
}
function jumpToBottom() {
  state.userAtBottom = true; showJumpBottom.value = false
  messagesEl.value?.scrollTo({ top: messagesEl.value.scrollHeight, behavior: 'smooth' })
}
function markdown(text: string) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return escaped
    .replace(/```([^\n]*)\n?([\s\S]*?)```/g, '<pre class="markdown-code"><code>$2</code></pre>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>')
}
async function steer() {
  if (!steerText.value.trim()) return
  try { await codex.steer(steerText.value); steerText.value = '' } catch (error) { codex.notify(error instanceof Error ? error.message : String(error)) }
}
async function rename() {
  const name = renameText.value.trim() || prompt('新会话名称：', state.threadTitle)?.trim() || ''
  if (!name) return
  try { await codex.renameThread(name); renameText.value = '' } catch (error) { codex.notify(error instanceof Error ? error.message : String(error)) }
}
async function compact() {
  try { await codex.compact() } catch (error) { codex.notify(error instanceof Error ? error.message : String(error)) }
}
async function changeSetting(key: 'model' | 'effort' | 'sandboxMode', event: Event) {
  const select = event.target as HTMLSelectElement
  select.disabled = true
  try { await codex.updateSettings({ [key]: select.value }) }
  catch (error) { select.value = state.settings[key]; codex.notify(error instanceof Error ? error.message : String(error)) }
  finally { select.disabled = false }
}

async function onFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? []).slice(0, Math.max(0, 4 - images.value.length))
  for (const file of files) {
    try {
      images.value.push({ url: await resizeImage(file), name: file.name })
    } catch {
      codex.notify(`无法读取 ${file.name}`)
    }
  }
  input.value = ''
}

function resizeImage(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = reject
    reader.onload = () => {
      const source = new Image()
      source.onerror = reject
      source.onload = () => {
        const ratio = Math.min(1, 1600 / Math.max(source.width, source.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(source.width * ratio)
        canvas.height = Math.round(source.height * ratio)
        canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.86))
      }
      source.src = String(reader.result)
    }
    reader.readAsDataURL(file)
  })
}

function submitMachine() {
  if (!machineForm.host.trim()) {
    codex.notify('请填写服务器地址')
    return
  }
  if (machineForm.id && Object.entries(state.runs).some(([key, run]) => key.startsWith(`${machineForm.id}:`) && run.running) && !confirm('保存会重新连接机器，并中断正在运行的任务。继续保存？')) return
  codex.addMachine({ ...machineForm, id: machineForm.id || undefined, name: machineForm.name.trim() || machineForm.host.trim() })
  showMachineForm.value = false
}

async function archive(thread: ThreadSummary) {
  openThreadMenu.value = null
  if (!confirm(`归档“${thread.name || thread.preview || '这个会话'}”？`)) return
  try {
    await codex.archiveThread(thread.id)
  } catch (error) {
    codex.notify(error instanceof Error ? error.message : String(error))
  }
}

function editMachine(machine?: Machine) {
  Object.assign(machineForm, { id: '', name: '远程服务器', type: 'ssh', host: '', port: 22, user: '', workspace: '', sshKey: '', codexBin: '', proxy: '' }, machine ?? {})
  showMachineForm.value = true
}
async function refreshThreads() { try { await codex.loadThreads() } catch (error) { codex.notify(String(error)) } }
async function restore(thread: ThreadSummary) { try { await codex.restoreThread(thread.id) } catch (error) { codex.notify(String(error)) } }

async function remove(thread: ThreadSummary) {
  openThreadMenu.value = null
  if (!confirm('永久删除这个会话？')) return
  try {
    await codex.removeThread(thread.id)
  } catch (error) {
    codex.notify(error instanceof Error ? error.message : String(error))
  }
}

function toggleActivity(item: ActivityItem) {
  item.expanded = !item.expanded
}

async function copyText(text: string) {
  await navigator.clipboard.writeText(text)
  codex.notify('已复制')
}

function relativeTime(value?: number) {
  if (!value) return ''
  const timestamp = value < 10_000_000_000 ? value * 1000 : value
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} 天前`
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function machineLabel(machine?: Machine) {
  if (!machine) return '选择机器'
  if (machine.type === 'local') return '本机'
  return machine.name
}

function projectName(project: string) {
  return project.split(/[\\/]/).filter(Boolean).at(-1) || project
}

function diffLines(diff: string) {
  return diff.split('\n').slice(-2000).map((text, index) => ({
    key: `${index}-${text}`,
    text,
    kind: text.startsWith('+') && !text.startsWith('+++')
      ? 'add'
      : text.startsWith('-') && !text.startsWith('---')
        ? 'remove'
        : text.startsWith('@@')
          ? 'hunk'
          : 'plain',
  }))
}
</script>

<template>
  <div v-if="!state.paired" class="pair-screen">
    <button class="icon-button theme-toggle pair-theme" :aria-label="theme === 'dark' ? '切换到白天模式' : '切换到夜间模式'" :title="theme === 'dark' ? '白天模式' : '夜间模式'" @click="toggleTheme">
      <Sun v-if="theme === 'dark'" :size="19" /><Moon v-else :size="19" />
    </button>
    <div class="pair-glow pair-glow-one" />
    <div class="pair-glow pair-glow-two" />
    <section class="pair-card">
      <div class="brand-mark"><Bot :size="27" /></div>
      <p class="eyebrow">CODEX REMOTE</p>
      <h1>你的代码工作台，<br />随时在线。</h1>
      <p class="pair-copy">连接电脑上的 Codex，在手机上继续会话、审批操作和查看代码变更。</p>
      <form class="pair-form" @submit.prevent="pair">
        <label for="pair-token">配对码</label>
        <input id="pair-token" v-model="pairToken" autocomplete="one-time-code" inputmode="numeric" placeholder="输入服务端显示的配对码" />
        <button class="primary-button" :disabled="state.connecting">
          <LoaderCircle v-if="state.connecting" class="spin" :size="18" />
          <Wifi v-else :size="18" />
          {{ state.connecting ? '正在连接' : '连接工作台' }}
        </button>
      </form>
      <p v-if="state.pairError" class="form-error">{{ state.pairError }}</p>
    </section>
  </div>

  <div v-else class="app-shell">
    <aside class="sidebar" :class="{ 'mobile-hidden': state.screen === 'chat' }">
      <header class="sidebar-header">
        <div class="brand-lockup">
          <div class="brand-mark small"><Bot :size="19" /></div>
          <div><strong>Codex Remote</strong><span>精简工作台</span></div>
        </div>
        <div class="header-actions">
          <button class="icon-button theme-toggle" :aria-label="theme === 'dark' ? '切换到白天模式' : '切换到夜间模式'" @click="toggleTheme"><Sun v-if="theme === 'dark'" :size="18" /><Moon v-else :size="18" /></button>
          <button class="icon-button" aria-label="机器管理" @click="state.drawer = 'machines'"><Settings2 :size="19" /></button>
        </div>
      </header>

      <button class="machine-switch" @click="state.drawer = 'machines'">
        <span class="machine-icon"><Server v-if="currentMachine?.type === 'ssh'" :size="17" /><Monitor v-else :size="17" /></span>
        <span class="machine-copy"><strong>{{ machineLabel(currentMachine) }}</strong><small>{{ state.machineReady[state.machineId] ? 'Codex 已连接' : '正在连接 Codex' }}</small></span>
        <span class="status-dot" :class="{ online: state.machineReady[state.machineId] }" />
        <ChevronDown :size="16" />
      </button>

      <div class="thread-toolbar">
        <div class="search-field"><Search :size="16" /><input v-model="search" placeholder="搜索会话" /></div>
        <button class="new-thread-button" aria-label="新建会话" :disabled="state.loadingChat" @click="prepareThread"><MessageSquarePlus :size="19" /></button>
      </div>

      <div v-if="projects.length" class="project-strip" aria-label="项目筛选">
        <button :class="{ active: !projectFilter }" @click="projectFilter = ''">全部</button>
        <button v-for="project in projects" :key="project" :class="{ active: projectFilter === project }" :title="project" @click="projectFilter = project">{{ projectName(project) }}</button>
      </div>

      <div class="section-label">
        <button class="quiet-button archive-toggle" @click="codex.showArchived(!state.archived)">{{ state.archived ? '归档会话 · 返回最近' : '最近会话 · 查看归档' }}</button>
        <button class="quiet-button" :class="{ spin: state.loadingThreads }" @click="refreshThreads"><RefreshCw :size="14" /></button>
      </div>

      <div class="thread-list">
        <div v-for="thread in visibleThreads" :key="thread.id" class="thread-row" :class="{ active: state.threadId === thread.id }" role="button" tabindex="0" @click="openThread(thread)" @keydown.enter="openThread(thread)">
          <span class="thread-main">
            <strong>{{ thread.name || thread.preview || '未命名会话' }}</strong>
            <small>{{ thread.cwd || thread.id.slice(0, 12) }}</small>
          </span>
          <span class="thread-side">
            <time>{{ relativeTime(thread.updatedAt) }}</time>
            <button class="thread-menu-button" aria-label="会话菜单" @click.stop="openThreadMenu = openThreadMenu === thread.id ? null : thread.id"><MoreHorizontal :size="17" /></button>
            <span v-if="openThreadMenu === thread.id" class="thread-menu" @click.stop>
              <button v-if="state.archived" @click="restore(thread)"><Archive :size="14" />恢复</button>
              <button v-else @click="archive(thread)"><Archive :size="14" />归档</button>
              <button class="danger" @click="remove(thread)"><Trash2 :size="14" />删除</button>
            </span>
          </span>
        </div>
        <div v-if="!state.loadingThreads && !visibleThreads.length" class="empty-state compact">
          <WifiOff v-if="currentMachineError" :size="28" />
          <MessageSquarePlus v-else :size="28" />
          <p v-if="currentMachineError" class="machine-error-text">{{ currentMachineError }}</p>
          <p v-else>{{ search ? '没有匹配的会话' : '还没有会话' }}</p>
          <button v-if="currentMachineError" @click="refreshThreads">重新连接</button>
          <button v-else-if="!search && !state.archived" @click="prepareThread">创建第一个会话</button>
        </div>
        <button v-if="state.threadsCursor" class="load-more-button" :disabled="state.threadsLoadingMore" @click="codex.loadMoreThreads">{{ state.threadsLoadingMore ? '正在加载…' : '加载更多会话' }}</button>
      </div>

      <footer class="sidebar-footer">
        <span><span class="status-dot" :class="{ online: state.connected }" />{{ state.connected ? '网关在线' : '正在重连' }}</span>
      </footer>
    </aside>

    <main class="workspace" :class="{ 'mobile-hidden': state.screen === 'threads' }">
      <header class="workspace-header">
        <button class="icon-button mobile-only" aria-label="返回" @click="state.screen = 'threads'"><ArrowLeft :size="20" /></button>
        <div class="workspace-title">
          <strong>{{ state.threadTitle }}</strong>
          <span><span class="status-dot" :class="{ online: state.machineReady[state.machineId] }" />{{ currentMachine?.name || '本机' }}</span>
        </div>
        <div class="workspace-actions">
          <button class="icon-button theme-toggle" :aria-label="theme === 'dark' ? '切换到白天模式' : '切换到夜间模式'" @click="toggleTheme"><Sun v-if="theme === 'dark'" :size="18" /><Moon v-else :size="18" /></button>
          <button class="activity-button" @click="state.drawer = 'activity'">
            <TerminalSquare :size="17" /><span>运行活动</span>
            <b v-if="state.activities.length">{{ state.activities.length }}</b>
          </button>
          <button class="icon-button" aria-label="设置" @click="state.drawer = 'settings'"><Settings2 :size="19" /></button>
          <button class="icon-button" aria-label="机器管理" @click="state.drawer = 'machines'"><Cpu :size="19" /></button>
        </div>
      </header>

      <section ref="messagesEl" class="message-stream" @scroll.passive="onMessageScroll">
        <div v-if="state.loadingChat" class="loading-state"><LoaderCircle class="spin" :size="24" /><span>正在载入会话</span></div>
        <button v-if="hasEarlier && !state.loadingChat" class="load-more-button history-more" :disabled="state.historyLoadingMore" @click="loadEarlier">{{ state.historyLoadingMore ? '正在加载…' : '加载更早消息' }}</button>
        <div v-if="!state.loadingChat && !state.messages.length" class="empty-state hero-empty">
          <div class="empty-orbit"><Code2 :size="30" /></div>
          <h2>从这里继续开发</h2>
          <button v-if="!state.threadId" class="primary-button" @click="prepareThread">选择项目并新建会话</button>
          <p>描述要实现的内容，Codex 会在 <strong>{{ currentMachine?.name || '本机' }}</strong> 上开始工作。</p>
          <div class="prompt-suggestions">
            <button @click="messageText = '检查当前项目并告诉我下一步最值得做什么'">检查项目进度<ChevronRight :size="15" /></button>
            <button @click="messageText = '运行测试并修复发现的问题'">运行并修复测试<ChevronRight :size="15" /></button>
          </div>
        </div>

        <article v-for="message in visibleMessages" :key="message.id" v-memo="[message.text, message.reasoning, message.images, message.delivery, message.error]" class="message" :class="`message-${message.role}`">
          <div v-if="message.role === 'assistant'" class="assistant-avatar"><Bot :size="17" /></div>
          <div class="message-body">
            <div class="message-meta">{{ message.role === 'user' ? '你' : message.role === 'assistant' ? 'Codex' : '系统' }}</div>
            <details v-if="message.reasoning" class="reasoning-block">
              <summary>思考过程</summary><pre>{{ message.reasoning }}</pre>
            </details>
            <div v-if="message.text" class="message-text" v-html="markdown(message.text)" />
            <p v-if="message.delivery === 'sending'" class="delivery-status">发送中…</p>
            <p v-else-if="message.delivery === 'failed'" class="delivery-status failed">{{ message.error || '发送失败' }} <button @click="codex.retryMessage(message)">重试</button></p>
            <small v-else-if="message.role === 'user' && message.delivery === 'sent'" class="delivery-status">已发送</small>
            <div v-if="message.images?.length" class="message-images">
              <img v-for="image in message.images" :key="image.url" :src="image.url" :alt="image.name" />
            </div>
            <button v-if="message.text" class="copy-message" title="复制" @click="copyText(message.text)"><Clipboard :size="13" /></button>
          </div>
        </article>

        <section v-if="state.activities.length" class="inline-activity">
          <div class="inline-activity-head"><span>本回合活动</span><button @click="state.drawer = 'activity'">查看全部</button></div>
          <button v-for="item in state.activities.slice(-3)" :key="item.id" class="activity-summary" @click="state.drawer = 'activity'">
            <span class="activity-kind"><TerminalSquare v-if="item.type === 'terminal'" :size="15" /><FileDiff v-else :size="15" /></span>
            <span><strong>{{ item.title }}</strong><small>{{ item.type === 'terminal' ? '命令输出' : '文件差异' }}</small></span>
            <span class="activity-status" :class="item.status"><LoaderCircle v-if="item.status === 'running'" class="spin" :size="14" /><Check v-else-if="item.status === 'done'" :size="14" /><X v-else :size="14" /></span>
          </button>
        </section>

        <div v-if="state.running" class="working-indicator"><span /><span /><span /> Codex 正在工作</div>
        <button v-if="showJumpBottom" class="jump-bottom" @click="jumpToBottom">回到底部 ↓</button>
      </section>

      <section v-if="state.queue.length" class="queue-strip">
        <span>队列中有 {{ state.queue.length }} 条消息</span>
        <div class="queue-chips">
          <button v-for="(item, index) in state.queue" :key="index" @click="codex.removeQueued(index)">{{ item.text.slice(0, 24) || '图片消息' }}<X :size="12" /></button>
        </div>
      </section>

      <footer class="composer-wrap">
        <div v-if="images.length" class="attachment-row">
          <div v-for="(image, index) in images" :key="image.url" class="attachment"><img :src="image.url" :alt="image.name" /><button @click="images.splice(index, 1)"><X :size="13" /></button></div>
        </div>
        <div class="composer">
          <button class="composer-icon" :disabled="images.length >= 4" aria-label="添加图片" @click="fileInput?.click()"><ImagePlus :size="20" /></button>
          <input ref="fileInput" hidden type="file" accept="image/*" multiple @change="onFiles" />
          <textarea v-model="messageText" rows="1" :disabled="state.loadingChat || state.readOnly || !state.threadId" :placeholder="state.readOnly ? '此会话只读' : !state.threadId ? '请先新建或打开会话' : '给 Codex 发消息…'" @keydown="onComposerKeydown" />
          <button v-if="state.running" class="send-button stop" aria-label="停止" @click="codex.interrupt"><CircleStop :size="20" /></button>
          <button v-if="state.running" class="queue-send" :disabled="(!messageText.trim() && !images.length) || !state.connected || state.readOnly" @click="sendMessage">加入队列</button>
          <button v-else class="send-button" :disabled="(!messageText.trim() && !images.length) || state.loadingChat || state.readOnly || !state.connected || !state.threadId" aria-label="发送" @click="sendMessage"><Send :size="18" /></button>
        </div>
        <div v-if="state.running" class="steer-row"><input v-model="steerText" placeholder="运行中插话…" @keydown.enter.prevent="steer" /><button @click="steer">插话</button></div>
        <p>Enter 发送 · Shift + Enter 换行 <span v-if="state.running">· 新消息会自动排队</span></p>
      </footer>
    </main>

    <div v-if="state.drawer" class="drawer-backdrop" @click="state.drawer = null" />

    <aside v-if="state.drawer === 'activity'" class="drawer activity-drawer">
      <header class="drawer-header"><div><span class="eyebrow">LIVE OUTPUT</span><h2>运行活动</h2></div><button class="icon-button" @click="state.drawer = null"><X :size="20" /></button></header>
      <nav class="segmented-tabs">
        <button :class="{ active: activityTab === 'all' }" @click="activityTab = 'all'">全部 <span>{{ state.activities.length }}</span></button>
        <button :class="{ active: activityTab === 'terminal' }" @click="activityTab = 'terminal'">终端 <span>{{ terminalCount }}</span></button>
        <button :class="{ active: activityTab === 'diff' }" @click="activityTab = 'diff'">Diff <span>{{ diffCount }}</span></button>
      </nav>
      <div class="activity-list">
        <article v-for="item in visibleActivities" :key="item.id" class="activity-card" :class="{ open: item.expanded }">
          <button class="activity-card-head" @click="toggleActivity(item)">
            <span class="activity-kind"><TerminalSquare v-if="item.type === 'terminal'" :size="16" /><FileDiff v-else :size="16" /></span>
            <span class="activity-title"><strong>{{ item.title }}</strong><small>{{ item.status === 'running' ? '运行中' : item.status === 'failed' ? '执行失败' : '已完成' }}</small></span>
            <span class="activity-status" :class="item.status"><LoaderCircle v-if="item.status === 'running'" class="spin" :size="14" /><Check v-else-if="item.status === 'done'" :size="14" /><X v-else :size="14" /></span>
            <ChevronDown :size="16" />
          </button>
          <div v-if="item.expanded" class="activity-content">
            <small v-if="item.truncated">内容较长，仅保留末尾 20 万字符。</small>
            <button class="copy-activity" @click="copyText(item.content)"><Clipboard :size="13" />复制</button>
            <pre v-if="item.type === 'terminal'" class="terminal-output">{{ item.content || '等待输出…' }}</pre>
            <small v-if="item.type === 'diff' && item.content.split('\n').length > 2000">显示末尾 2000 行，复制可获取当前缓存内容。</small>
            <pre v-if="item.type === 'diff'" class="diff-output"><span v-for="line in diffLines(item.content)" :key="line.key" :class="`diff-${line.kind}`">{{ line.text }}
</span></pre>
          </div>
        </article>
        <div v-if="!visibleActivities.length" class="empty-state compact"><TerminalSquare :size="28" /><p>当前还没有运行活动</p></div>
      </div>
    </aside>

    <aside v-if="state.drawer === 'settings'" class="drawer settings-drawer">
      <header class="drawer-header"><div><span class="eyebrow">CODEX CONTROL</span><h2>会话设置</h2></div><button class="icon-button" @click="state.drawer = null"><X :size="20" /></button></header>
      <div class="settings-form">
        <p class="delivery-status">工作目录：{{ state.projectCwd || '服务器默认目录' }}</p>
        <label>模型<select :value="state.settings.model" @change="changeSetting('model', $event)"><option value="">默认模型</option><option v-for="model in state.models" :key="model.id" :value="model.id">{{ model.displayName || model.id }}</option></select></label>
        <label>推理强度<select :value="state.settings.effort" @change="changeSetting('effort', $event)"><option value="">默认</option><option v-for="effort in supportedEfforts" :key="effort" :value="effort">{{ effortLabel(effort) }}</option></select></label>
        <label>沙箱权限<select :value="state.settings.sandboxMode" @change="changeSetting('sandboxMode', $event)"><option value="">默认</option><option value="read-only">只读</option><option value="workspace-write">工作区可写</option><option value="danger-full-access">完全访问</option></select></label>
        <div class="usage-card"><strong>用量</strong><span v-if="state.rateLimits?.primary">主要额度已用 {{ state.rateLimits.primary.usedPercent ?? 0 }}%</span><span v-else>暂无额度数据</span></div>
        <div class="settings-actions"><button :disabled="!state.threadId" @click="compact">压缩上下文</button><button :disabled="!state.threadId" @click="rename">重命名会话</button></div>
      </div>
    </aside>

    <aside v-if="state.drawer === 'machines'" class="drawer machine-drawer">
      <header class="drawer-header"><div><span class="eyebrow">WORKSPACES</span><h2>运行机器</h2></div><button class="icon-button" @click="state.drawer = null"><X :size="20" /></button></header>
      <div class="machine-list">
        <div v-for="machine in state.machines" :key="machine.id" class="machine-card" :class="{ active: machine.id === state.machineId }" role="button" tabindex="0" @click="codex.switchMachine(machine.id)" @keydown.enter="codex.switchMachine(machine.id)">
          <span class="machine-icon large"><Server v-if="machine.type === 'ssh'" :size="19" /><Monitor v-else :size="19" /></span>
          <span class="machine-copy"><strong>{{ machine.name }}</strong><small>{{ machine.type === 'ssh' ? `${machine.user || 'user'}@${machine.host}` : '当前电脑' }}</small></span>
          <span class="status-dot" :class="{ online: state.machineReady[machine.id] }" />
          <Check v-if="machine.id === state.machineId" :size="17" />
            <button class="machine-delete" aria-label="重新连接" @click.stop="codex.reconnectMachine(machine.id)"><RefreshCw :size="15" /></button>
            <button v-if="machine.type === 'ssh'" class="machine-delete" aria-label="编辑机器" @click.stop="editMachine(machine)"><Settings2 :size="15" /></button>
            <button v-if="machine.type === 'ssh'" class="machine-delete" aria-label="删除机器" @click.stop="codex.deleteMachine(machine.id)"><Trash2 :size="15" /></button>
          </div>
          <p v-if="currentMachineError" class="form-error">{{ currentMachineError }}</p>
      </div>

      <button v-if="!showMachineForm" class="add-machine-button" @click="editMachine()"><Plus :size="18" />添加 SSH 服务器</button>
      <form v-else class="machine-form" @submit.prevent="submitMachine">
        <div class="form-title"><strong>{{ machineForm.id ? '编辑 SSH 服务器' : '添加 SSH 服务器' }}</strong><button type="button" @click="showMachineForm = false"><X :size="17" /></button></div>
        <label>名称<input v-model="machineForm.name" placeholder="远程服务器" /></label>
        <label>服务器地址<input v-model="machineForm.host" required placeholder="server.example.com" /></label>
        <div class="form-grid"><label>用户<input v-model="machineForm.user" required placeholder="devuser" /></label><label>端口<input v-model.number="machineForm.port" required type="number" min="1" max="65535" placeholder="22" /></label></div>
        <label>工作目录<input v-model="machineForm.workspace" placeholder="/home/devuser" /></label>
        <label>Codex 路径（可选）<input v-model="machineForm.codexBin" placeholder="/home/devuser/.local/bin/codex" /></label>
        <label>代理（可选）<input v-model="machineForm.proxy" placeholder="http://127.0.0.1:7890" /></label>
        <label>SSH 私钥（可选）<input v-model="machineForm.sshKey" :placeholder="machineForm.id ? '留空保持现有配置' : '留空使用当前用户默认私钥'" /></label>
        <button class="primary-button"><Server :size="17" />保存并连接</button>
      </form>

      <div class="drawer-note"><WifiOff :size="16" /><span>远程机器会优先启动 SSH 登录用户目录中的 Codex，不会优先使用 root 的全局安装。</span></div>
      <button class="logout-button" @click="codex.logout">清除配对并退出</button>
    </aside>

    <aside v-if="state.drawer === 'new'" class="drawer settings-drawer">
      <header class="drawer-header"><h2>新建会话</h2><button class="icon-button" @click="state.drawer = null"><X :size="20" /></button></header>
      <form class="machine-form" @submit.prevent="createThread">
        <label>项目工作目录<input v-model="projectInput" list="recent-projects" placeholder="输入绝对路径，留空使用服务器默认目录" /></label>
        <datalist id="recent-projects"><option v-for="project in projects" :key="project" :value="project" /></datalist>
        <p class="delivery-status">{{ currentMachine?.name }} · 也可选择最近项目的目录</p>
        <button class="primary-button" :disabled="state.loadingChat || !state.connected">创建会话</button>
      </form>
    </aside>

    <div v-if="state.approval" class="approval-backdrop">
      <section class="approval-sheet">
        <div class="approval-icon"><TerminalSquare :size="23" /></div>
        <span class="eyebrow">APPROVAL REQUIRED</span>
        <h2>{{ state.approval.title }}</h2>
        <pre>{{ state.approval.detail }}</pre>
        <p>请求来自 {{ state.machines.find((item) => item.id === state.approval?.machineId)?.name || state.approval.machineId }}<span v-if="state.approvals.length > 1"> · 还有 {{ state.approvals.length - 1 }} 条待处理</span></p>
        <div class="approval-actions"><button class="decline-button" @click="codex.answerApproval('decline')">拒绝</button><button class="approve-button" @click="codex.answerApproval('accept')"><Check :size="17" />允许执行</button></div>
      </section>
    </div>

    <Transition name="toast"><div v-if="state.toast" class="toast">{{ state.toast }}</div></Transition>
  </div>
</template>
