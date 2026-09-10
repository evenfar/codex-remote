export interface Machine {
  id: string
  name: string
  type: 'local' | 'ssh'
  host?: string
  port?: number
  user?: string
  workspace?: string
  sshKey?: string
  sshKeyConfigured?: boolean
  codexBin?: string
  proxy?: string
}

export interface ThreadSummary {
  id: string
  name?: string
  preview?: string
  cwd?: string
  updatedAt?: number
  createdAt?: number
}

export interface PageResult<T> {
  data?: T[]
  nextCursor?: string | null
}

export type ImageAttachment = { url: string; name: string }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  images?: ImageAttachment[]
  reasoning?: string
  delivery?: 'sending' | 'sent' | 'failed'
  error?: string
}

export interface ActivityItem {
  id: string
  type: 'terminal' | 'diff'
  title: string
  content: string
  status: 'running' | 'done' | 'failed'
  expanded?: boolean
  truncated?: boolean
}

export interface ApprovalRequest {
  id: string | number
  method: string
  machineId: string
  title: string
  detail: string
  receivedAt?: number
}

export interface DraftPayload {
  text: string
  images: ImageAttachment[]
}

export interface CodexSettings {
  model?: string
  effort?: string
  sandboxMode?: string
}

export interface UsageInfo {
  tokenUsage?: any
  rateLimits?: any
}
