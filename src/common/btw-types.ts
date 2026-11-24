// Shared `/btw` side-question domain types (imported by host, features, transport, and client).

export type BtwStatus = 'running' | 'done' | 'error' | 'aborted'

export interface BtwToolStep {
  stepKey: string
  name: string
  target?: string
  state: 'running' | 'done' | 'error'
  error?: string
}

export interface BtwEntry {
  id: string
  question: string
  answer: string
  thinking: string
  tools: BtwToolStep[]
  status: BtwStatus
  error?: string
  model: string
  effort: string
  accountId?: string
  conversationId: string | null
  startedAt: number
  finishedAt?: number
  durationMs: number
}

export interface BtwSessionView {
  sessionId: string
  open: boolean
  activeIndex: number
  entries: BtwEntry[]
  revision: number
}

export interface BtwAskOptions {
  sessionId: string
  question: string
  followUp?: boolean
  newThread?: boolean
  model?: string
  effort?: string
}
