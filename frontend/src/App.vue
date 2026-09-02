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
const pairToken = ref(state.token)
const search = ref('')
const projectFilter = ref('')
const messageText = ref('')
const images = ref<ImageAttachment[]>([])
const messagesEl = ref<HTMLElement>()
const fileInput = ref<HTMLInputElement>()
const activityTab = ref<'all' | 'terminal' | 'diff'>('all')
const showMachineForm = ref(false)
const openThreadMenu = ref<string | null>(null)
const machineForm = reactive({
  name: '远程服务器',
  type: 'ssh' as const,
  host: '',
  port: 22,
  user: '',
  workspace: '',
  sshKey: '',
  codexBin: '',
})

const projects = computed(() => [...new Set(state.threads.map((thread) => thread.cwd).filter(Boolean) as string[])])
const visibleThreads = computed(() => codex.filteredThreads(search.value).filter((thread) =>
  !projectFilter.value || thread.cwd === projectFilter.value,
))
const visibleActivities = computed(() => state.activities.filter((item) =>
  activityTab.value === 'all' || item.type === activityTab.value,
))
const currentMachineError = computed(() => state.machineErrors[state.machineId])
const terminalCount = computed(() => state.activities.filter((item) => item.type === 'terminal').length)
const diffCount = computed(() => state.activities.filter((item) => item.type === 'diff').length)

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
  () => nextTick(() => messagesEl.value?.scrollTo({ top: messagesEl.value.scrollHeight, behavior: 'smooth' })),
)
watch(() => state.machineId, () => { projectFilter.value = ''; search.value = '' })

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
  messagesEl.value?.scrollTo({ top: messagesEl.value.scrollHeight })
}

async function sendMessage() {
  const payload = { text: messageText.value.trim(), images: [...images.value] }
  if (!payload.text && !payload.images.length) return
  messageText.value = ''
  images.value = []
  await codex.send(payload)
}

function onComposerKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    sendMessage()
  }
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
  codex.addMachine({ ...machineForm, name: machineForm.name.trim() || machineForm.host.trim() })
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
  return diff.split('\n').map((text, index) => ({
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
      <a class="legacy-link" href="/legacy/">使用旧版界面</a>
    </section>
  </div>

  <div v-else class="app-shell">
    <aside class="sidebar" :class="{ 'mobile-hidden': state.screen === 'chat' }">
      <header class="sidebar-header">
        <div class="brand-lockup">
          <div class="brand-mark small"><Bot :size="19" /></div>
          <div><strong>Codex Remote</strong><span>精简工作台</span></div>
        </div>
        <button class="icon-button" aria-label="机器管理" @click="state.drawer = 'machines'">
          <Settings2 :size="19" />
        </button>
      </header>

      <button class="machine-switch" @click="state.drawer = 'machines'">
        <span class="machine-icon"><Server v-if="currentMachine?.type === 'ssh'" :size="17" /><Monitor v-else :size="17" /></span>
        <span class="machine-copy"><strong>{{ machineLabel(currentMachine) }}</strong><small>{{ state.machineReady[state.machineId] ? 'Codex 已连接' : '正在连接 Codex' }}</small></span>
        <span class="status-dot" :class="{ online: state.machineReady[state.machineId] }" />
        <ChevronDown :size="16" />
      </button>

      <div class="thread-toolbar">
        <div class="search-field"><Search :size="16" /><input v-model="search" placeholder="搜索会话" /></div>
        <button class="new-thread-button" @click="codex.newThread"><MessageSquarePlus :size="19" /></button>
      </div>

      <div v-if="projects.length" class="project-strip" aria-label="项目筛选">
        <button :class="{ active: !projectFilter }" @click="projectFilter = ''">全部</button>
        <button v-for="project in projects" :key="project" :class="{ active: projectFilter === project }" :title="project" @click="projectFilter = project">{{ projectName(project) }}</button>
      </div>

      <div class="section-label">
        <span>最近会话</span>
        <button class="quiet-button" :class="{ spin: state.loadingThreads }" @click="codex.loadThreads"><RefreshCw :size="14" /></button>
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
              <button @click="archive(thread)"><Archive :size="14" />归档</button>
              <button class="danger" @click="remove(thread)"><Trash2 :size="14" />删除</button>
            </span>
          </span>
        </div>
        <div v-if="!state.loadingThreads && !visibleThreads.length" class="empty-state compact">
          <WifiOff v-if="currentMachineError" :size="28" />
          <MessageSquarePlus v-else :size="28" />
          <p v-if="currentMachineError" class="machine-error-text">{{ currentMachineError }}</p>
          <p v-else>{{ search ? '没有匹配的会话' : '还没有会话' }}</p>
          <button v-if="currentMachineError" @click="codex.loadThreads">重新连接</button>
          <button v-else-if="!search" @click="codex.newThread">创建第一个会话</button>
        </div>
      </div>

      <footer class="sidebar-footer">
        <span><span class="status-dot" :class="{ online: state.connected }" />{{ state.connected ? '网关在线' : '正在重连' }}</span>
        <a href="/legacy/">旧版</a>
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
          <button class="activity-button" @click="state.drawer = 'activity'">
            <TerminalSquare :size="17" /><span>运行活动</span>
            <b v-if="state.activities.length">{{ state.activities.length }}</b>
          </button>
          <button class="icon-button" aria-label="机器管理" @click="state.drawer = 'machines'"><Cpu :size="19" /></button>
        </div>
      </header>

      <section ref="messagesEl" class="message-stream">
        <div v-if="state.loadingChat" class="loading-state"><LoaderCircle class="spin" :size="24" /><span>正在载入会话</span></div>
        <div v-else-if="!state.messages.length" class="empty-state hero-empty">
          <div class="empty-orbit"><Code2 :size="30" /></div>
          <h2>从这里继续开发</h2>
          <p>描述要实现的内容，Codex 会在 <strong>{{ currentMachine?.name || '本机' }}</strong> 上开始工作。</p>
          <div class="prompt-suggestions">
            <button @click="messageText = '检查当前项目并告诉我下一步最值得做什么'">检查项目进度<ChevronRight :size="15" /></button>
            <button @click="messageText = '运行测试并修复发现的问题'">运行并修复测试<ChevronRight :size="15" /></button>
          </div>
        </div>

        <article v-for="message in state.messages" :key="message.id" class="message" :class="`message-${message.role}`">
          <div v-if="message.role === 'assistant'" class="assistant-avatar"><Bot :size="17" /></div>
          <div class="message-body">
            <div class="message-meta">{{ message.role === 'user' ? '你' : message.role === 'assistant' ? 'Codex' : '系统' }}</div>
            <details v-if="message.reasoning" class="reasoning-block">
              <summary>思考过程</summary><pre>{{ message.reasoning }}</pre>
            </details>
            <pre v-if="message.text" class="message-text">{{ message.text }}</pre>
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
          <textarea v-model="messageText" rows="1" placeholder="给 Codex 发消息…" @keydown="onComposerKeydown" />
          <button v-if="state.running" class="send-button stop" aria-label="停止" @click="codex.interrupt"><CircleStop :size="20" /></button>
          <button v-else class="send-button" :disabled="!messageText.trim() && !images.length" aria-label="发送" @click="sendMessage"><Send :size="18" /></button>
        </div>
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
            <button class="copy-activity" @click="copyText(item.content)"><Clipboard :size="13" />复制</button>
            <pre v-if="item.type === 'terminal'" class="terminal-output">{{ item.content || '等待输出…' }}</pre>
            <pre v-else class="diff-output"><span v-for="line in diffLines(item.content)" :key="line.key" :class="`diff-${line.kind}`">{{ line.text }}
</span></pre>
          </div>
        </article>
        <div v-if="!visibleActivities.length" class="empty-state compact"><TerminalSquare :size="28" /><p>当前还没有运行活动</p></div>
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
          <button v-if="machine.type === 'ssh'" class="machine-delete" aria-label="删除机器" @click.stop="codex.deleteMachine(machine.id)"><Trash2 :size="15" /></button>
        </div>
      </div>

      <button v-if="!showMachineForm" class="add-machine-button" @click="showMachineForm = true"><Plus :size="18" />添加 SSH 服务器</button>
      <form v-else class="machine-form" @submit.prevent="submitMachine">
        <div class="form-title"><strong>添加 SSH 服务器</strong><button type="button" @click="showMachineForm = false"><X :size="17" /></button></div>
        <label>名称<input v-model="machineForm.name" placeholder="远程服务器" /></label>
        <label>服务器地址<input v-model="machineForm.host" required placeholder="server.example.com" /></label>
        <div class="form-grid"><label>用户<input v-model="machineForm.user" placeholder="devuser" /></label><label>端口<input v-model.number="machineForm.port" type="number" placeholder="22" /></label></div>
        <label>工作目录<input v-model="machineForm.workspace" placeholder="/home/devuser" /></label>
        <label>Codex 路径（可选）<input v-model="machineForm.codexBin" placeholder="$HOME/.local/bin/codex" /></label>
        <label>SSH 私钥（可选）<input v-model="machineForm.sshKey" placeholder="留空使用当前用户默认私钥" /></label>
        <button class="primary-button"><Server :size="17" />保存并连接</button>
      </form>

      <div class="drawer-note"><WifiOff :size="16" /><span>远程机器会优先启动 SSH 登录用户目录中的 Codex，不会优先使用 root 的全局安装。</span></div>
      <button class="logout-button" @click="codex.logout">清除配对并退出</button>
    </aside>

    <div v-if="state.approval" class="approval-backdrop">
      <section class="approval-sheet">
        <div class="approval-icon"><TerminalSquare :size="23" /></div>
        <span class="eyebrow">APPROVAL REQUIRED</span>
        <h2>{{ state.approval.title }}</h2>
        <pre>{{ state.approval.detail }}</pre>
        <p>请求来自 {{ state.machines.find((item) => item.id === state.approval?.machineId)?.name || state.approval.machineId }}</p>
        <div class="approval-actions"><button class="decline-button" @click="codex.answerApproval('decline')">拒绝</button><button class="approve-button" @click="codex.answerApproval('accept')"><Check :size="17" />允许执行</button></div>
      </section>
    </div>

    <Transition name="toast"><div v-if="state.toast" class="toast">{{ state.toast }}</div></Transition>
  </div>
</template>
