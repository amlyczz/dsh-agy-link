// Fallback text for a tool step that is still running when the span is cut.
//
// Kept out of event-mapper.ts: it is a pure function of (tool name, args) with
// no mapper state, and event-mapper sat at the 600-line budget where every new
// behaviour meant deleting a comment to fit.
import { unwrapMcpTool } from '../../host/mirror-tool.ts'

export function formatRunningToolFallback(toolName: string, rawArgs: unknown): string {
  const unwrapped = unwrapMcpTool(toolName, rawArgs)
  const a = unwrapped.input
  const str = (...keys: string[]): string => {
    for (const k of keys) {
      const v = a[k]
      if (typeof v === 'string' && v.trim() !== '') return v.trim()
      if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    }
    return ''
  }
  if (unwrapped.tool === 'schedule') {
    const cron = str('CronExpression', 'cron_expression')
    const dur = str('DurationSeconds', 'duration_seconds')
    const prompt = str('Prompt', 'prompt')
    const timing = cron ? `cron ${cron}` : dur ? `${dur}s timer` : 'schedule'
    return prompt ? `Schedule active (${timing}): ${prompt}` : `Schedule active (${timing})`
  }
  const cmd = str('CommandLine', 'command_line', 'command', 'cmd')
  const taskId = str('TaskId', 'taskId', 'task_id', 'bgTaskId')
  if (cmd !== '') {
    return `Tool is running as a background task${taskId ? ` (${taskId})` : ''}: ${cmd}`
  }
  return taskId ? `Tool is running as a background task (${taskId})` : 'Tool is running as a background task'
}
