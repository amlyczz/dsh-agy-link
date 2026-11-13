// Short human previews for recorded tool steps (Code Mode titles, degraded
// result labels).
//
// MOVED VERBATIM from src/host/mirror-tool.ts (Phase 5h).
import { unwrapMcpTool } from './args.ts'

/** Short human preview for a recorded tool step (used in Code Mode titles). */
export function toolStepBrief(toolName: string, args: unknown, server?: string): string {
  const unwrapped = unwrapMcpTool(toolName, args)
  const effTool = unwrapped.tool
  const a = unwrapped.input
  const effServer = server ?? unwrapped.server
  const pickStr = (...keys: string[]): string => {
    for (const k of keys) {
      const v = a[k]
      if (typeof v === 'string' && v.trim() !== '') return v.trim()
    }
    return ''
  }
  if (effTool === 'run_command' || effTool === 'execute_command' || effTool === 'ops_bash' || effTool === 'bash' || effTool === 'sh' || effTool === 'shell') {
    const cmd = pickStr('CommandLine', 'command_line', 'Command', 'command', 'Cmd', 'cmd')
    return cmd !== '' ? '$ ' + cmd.slice(0, 80) : 'run command'
  }
  if (effTool === 'view_file' || effTool === 'read_file' || effTool === 'read') {
    return 'read ' + (pickStr('AbsolutePath', 'absolute_path', 'Path', 'path', 'TargetFile', 'File') || 'file')
  }
  if (effTool === 'write_to_file' || effTool === 'create_file' || effTool === 'write_file') {
    return 'write ' + (pickStr('TargetFile', 'target_file', 'Path', 'path', 'AbsolutePath', 'File') || 'file')
  }
  if (effTool === 'replace_file_content' || effTool === 'edit_file' || effTool === 'edit') {
    return 'edit ' + (pickStr('TargetFile', 'target_file', 'Path', 'path', 'AbsolutePath', 'File') || 'file')
  }
  if (effTool === 'grep_search' || effTool === 'search' || effTool === 'ops_grep' || effTool === 'ops_glob' || effTool === 'glob' || effTool === 'find_by_name' || effTool === 'search_files' || effTool === 'search_file_content' || effTool === 'grep') {
    const rawPat = a.pattern ?? a.Pattern ?? a.query ?? a.Query ?? a.SearchPattern
    const pat = Array.isArray(rawPat) ? rawPat.join(', ') : (typeof rawPat === 'string' ? rawPat.trim() : '')
    return pat !== '' ? 'search ' + pat.slice(0, 80) : 'search'
  }
  if (effTool === 'search_web' || effTool === 'web_search') {
    return 'search web ' + (pickStr('query', 'Query', 'search_query', 'q') || '')
  }
  if (effTool === 'read_url_content' || effTool === 'web_fetch' || effTool === 'fetch_web_page') {
    return 'fetch ' + (pickStr('Url', 'url', 'target_url', 'targetUrl') || 'url')
  }
  if (effTool === 'list_dir' || effTool === 'list_directory' || effTool === 'ls') {
    return 'ls ' + (pickStr('DirectoryPath', 'directory_path', 'Path', 'path', 'AbsolutePath') || '.')
  }
  if (effTool === 'manage_task') {
    const action = pickStr('Action', 'action') || 'manage'
    const id = pickStr('TaskId', 'taskId', 'task_id')
    return id !== '' ? 'task ' + action + ' ' + id : 'task ' + action
  }
  if (effTool === 'schedule') {
    const prompt = pickStr('Prompt', 'prompt')
    const cron = pickStr('CronExpression', 'cron_expression')
    const dur = pickStr('DurationSeconds', 'duration_seconds')
    const timing = cron ? 'cron ' + cron : dur ? dur + 's' : ''
    return timing ? 'schedule ' + timing : (prompt ? 'schedule ' + prompt.slice(0, 40) : 'schedule')
  }
  if (effTool === 'invoke_subagent') {
    const subs = a.Subagents ?? a.subagents
    const firstRole = Array.isArray(subs) && subs.length > 0 && typeof (subs[0] as { Role?: unknown }).Role === 'string'
      ? (subs[0] as { Role: string }).Role
      : ''
    const directRole = pickStr('Role', 'role', 'TypeName', 'typeName')
    const role = firstRole || directRole
    return role ? 'subagent: ' + role : 'invoke subagent'
  }
  if (effTool === 'send_message') {
    const recipient = pickStr('Recipient', 'recipient', 'to')
    return recipient ? 'msg ' + recipient : 'send message'
  }
  return effServer ? effServer + ': ' + effTool : effTool
}