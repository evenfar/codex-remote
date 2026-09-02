export interface Machine {
  id: string
  name: string
  type: 'local' | 'ssh'
  host?: string
  port?: number
  user?: string
  workspace?: string
  sshKey?: string
  codexBin?: string
}

export interface ThreadSummary {
  id: string
  name?: string
  preview?: string
  cwd?: string
  updatedAt?: number
  createdAt?: number
}

export type ImageAttachment = { url: string; name: string }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  images?: ImageAttachment[]
  reasoning?: string
}

export interface ActivityItem {
  id: string
  type: 'terminal' | 'diff'
  title: string
  content: string
  status: 'running' | 'done' | 'failed'
  expanded?: boolean
}

export interface ApprovalRequest {
  id: string | number
  method: string
  machineId: string
  title: string
  detail: string
}

export interface DraftPayload {
  text: string
  images: ImageAttachment[]
}
