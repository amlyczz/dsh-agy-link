// Shared types for Antigravity customization ecosystem inventory & multi-account sync.

export type EcosystemSource = 'global' | 'workspace' | 'plugin'

export interface EcosystemMcpServer {
  name: string
  transport: 'stdio' | 'http'
  target: string
  disabled: boolean
  source: EcosystemSource
  pluginName?: string
}

export interface EcosystemPlugin {
  id: string
  name: string
  enabled: boolean
  description?: string
  version?: string
  source: 'global' | 'workspace'
  hasMcp: boolean
  hasHooks: boolean
  skillCount: number
  ruleCount: number
  path: string
}

export interface EcosystemSkill {
  name: string
  description: string
  source: EcosystemSource
  pluginName?: string
  path: string
}

export interface EcosystemRule {
  name: string
  path: string
  bytes: number
  source: EcosystemSource
  pluginName?: string
}

export interface EcosystemAgent {
  name: string
  description: string
  source: 'global' | 'workspace'
  path: string
}

export interface EcosystemSnapshot {
  primaryHome: string
  workspaceRoot?: string
  plugins: readonly EcosystemPlugin[]
  mcpServers: readonly EcosystemMcpServer[]
  skills: readonly EcosystemSkill[]
  rules: readonly EcosystemRule[]
  agents: readonly EcosystemAgent[]
  syncedAccountCount: number
  lastSyncAt: number | null
}

export interface EcosystemSyncReport {
  primaryHome: string
  syncedAccounts: string[]
  skippedAccounts: string[]
  copiedFiles: number
  removedFiles: number
  errors: Array<{ accountId: string; error: string }>
  syncedAt: number
}
