// Shared status snapshot types for WarmupService, /status HTTP payload, and the client console.

export interface WarmupAccountSummary {
  accountId: string
  alias: string
  probed: number
  succeeded: number
  skipped: number
  failed: number
  lastError?: string
}

export interface WarmupLastRunSnapshot {
  scope: 'all' | string
  startedAt: number
  finishedAt: number
  succeeded: number
  skipped: number
  failed: number
  accounts: WarmupAccountSummary[]
}

export interface WarmupAuditEntry {
  timestamp: number
  accountId: string
  alias: string
  model: string
  window: 'weekly' | '5h' | 'manual'
  trigger: 'auto' | 'daily' | 'interval' | 'manual' | 'sliding-idle'
  success: boolean
  skipped?: boolean
  durationMs: number
  error?: string
  skipReason?: string
}

export interface WarmupStatusSnapshot {
  running: boolean
  scope: 'all' | string | null
  activeAccountIds: string[]
  currentAccountId: string | null
  startedAt: number | null
  completed: number
  total: number
  lastRun: WarmupLastRunSnapshot | null
  recentHistory?: WarmupAuditEntry[]
}
