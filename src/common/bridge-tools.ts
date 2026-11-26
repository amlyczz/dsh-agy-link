import type { PluginConfig } from './types/config.ts'

type Scope = PluginConfig['mcpBridgeScope']
type Tool = { name: string }

// Exact names only. A plugin's read_ticket or terminal_report remains a host tool.
const BASIC_TOOLS = new Set([
  'read', 'read_image', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'ls',
  'bash', 'pwsh', 'sh', 'shell', 'job_list', 'job_output', 'job_kill',
  'terminal_open', 'terminal_close', 'terminal_list', 'terminal_read', 'terminal_send', 'terminal_signal',
  'read_file', 'view_file', 'open_file', 'write_file', 'write_to_file', 'create_file', 'delete_file',
  'edit_file', 'replace_file_content', 'multi_replace_file_content', 'list_dir', 'list_directory',
  'grep_search', 'find_by_name', 'search_files', 'search_file_content', 'run_command', 'execute_command',
])

export const INTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set(['agy_ask', 'agy_tool', 'agy_image'])

export function bridgeAllows(scope: Scope, allowlist: string): (name: string) => boolean {
  const allowed = new Set(allowlist.split(',').map(s => s.trim()).filter(Boolean))
  return name => !INTERNAL_TOOL_NAMES.has(name) && (scope === 'all' || !BASIC_TOOLS.has(name)) &&
    (allowed.size === 0 || allowed.has(name))
}

/** MCP tool names are [a-zA-Z0-9_-]; distinct DSH names may normalize to the same label. */
export function toMcpName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function projectBridgeTools<T extends Tool>(schemas: readonly T[], allows: (name: string) => boolean) {
  const used = new Set<string>()
  return schemas.filter(tool => allows(tool.name)).map(tool => {
    const base = toMcpName(tool.name)
    let name = base
    for (let i = 2; used.has(name); i++) name = base + '__' + i
    used.add(name)
    return { tool, name }
  })
}

export interface BridgeDiagnostic {
  hostTools: string[]
  disabledSettings: ('mcpBridge' | 'forwardSystemPrompt')[]
}

export function diagnoseBridge(cfg: PluginConfig, tools: readonly Tool[] | undefined,
  warnOnce: (key: string, message: string) => void): BridgeDiagnostic | null {
  if (!tools?.length || (cfg.mcpBridge && cfg.forwardSystemPrompt)) return null
  const hostTools = [...new Set(tools.map(t => t.name).filter(n => !BASIC_TOOLS.has(n) && !INTERNAL_TOOL_NAMES.has(n)))].sort()
  if (!hostTools.length) return null
  const disabledSettings = (['mcpBridge', 'forwardSystemPrompt'] as const).filter(key => !cfg[key])
  const diagnostic = { hostTools, disabledSettings }
  const issues = []
  if (!cfg.mcpBridge) issues.push('mcpBridge=false prevents calls through the DSH bridge')
  if (!cfg.forwardSystemPrompt) issues.push('forwardSystemPrompt=false omits DSH system instructions')
  warnOnce('bridge:' + JSON.stringify(diagnostic), 'DSH host tools [' + hostTools.join(', ') + ']: ' + issues.join('. '))
  return diagnostic
}
