// End-of-turn "in-progress announcement" guard.
//
// agy routinely ends a turn with a STATUS LINE instead of a result:
//
//   "正在运行 Windows Vulkan RTX 2080 Ti 实机多场景截帧以进行逐帧视觉验收，完成后立即审图与精修。"
//
// Nothing is left running inside agy (no live tool step, no background task, no
// scheduled timer), so the turn closes as `completed` and the session goes
// silent — the promised screenshot review never happens and the user waits
// indefinitely (observed 2026-11-23 00:46: the turn ended on exactly that
// sentence and stayed idle for 16 hours until the user asked "好了吗").
//
// The bridge cannot make agy execute the action, but it CAN refuse to treat a
// promise as a finished turn: `isInProgressAnnouncement` recognises the shape
// and the background watcher spends ONE bounded follow-up turn to make agy do
// what it said it was doing. Everything here is pure and side-effect free.
import type { ReadableRecordingLike } from './background-types.ts'

/**
 * How long the final text may be and still count as a status line. A real
 * report is structured and long; an announcement is one or two sentences.
 */
const MAX_ANNOUNCEMENT_CHARS = 320

/** Chinese/English markers that a turn stopped mid-work on purpose. */
const IN_PROGRESS_PATTERNS: readonly RegExp[] = [
  // "正在运行 / 正在截帧 / 正在跑测试 / 正在构建 …"
  /正在(?:运行|执行|跑|抓|截|生成|构建|编译|测试|等待|处理|扫描|加载|启动|渲染|录制)/,
  // "完成后立即审图 / 结束后马上汇报 / 跑完就 …"
  /(?:完成|结束|跑完|执行完|抓完|截完|生成完)(?:后|之后)?\s*(?:立即|马上|随后|随即|就)\s*(?:审|看|汇报|报告|反馈|更新|给出|继续|处理)/,
  // "稍后给出 / 稍后汇报 / 稍后更新"
  /稍后\s*(?:会|将)?\s*(?:给出|汇报|报告|反馈|更新|处理|通知)/,
  // "等待任务完成后再 …"
  /(?:等待|等)(?:其|任务|命令|结果|后台任务)?\s*完成(?:后|之后|再)/,
  // English equivalents
  /\b(?:is|are|now|currently)\s+(?:running|capturing|rendering|building|executing)\b/i,
  /\b(?:will|I'll)\s+(?:report|follow\s?up|update|check)\b[^.]{0,40}\b(?:once|after|when it)\b/i,
  /\bonce (?:it|that|this|the \w+)\s+(?:finishes|completes|is done)\b/i,
]

/**
 * A markdown-shaped answer (headings, lists, fenced code) is a report even when
 * it happens to mention something still running — never nudge those.
 */
const REPORT_SHAPE_RE = /(?:^|\n)\s*(?:#{1,6}\s|[-*]\s|```|\d+\.\s)/

/**
 * True when `text` looks like "I am still doing X and will report later" and is
 * therefore NOT a finished turn's answer.
 */
export function isInProgressAnnouncement(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false
  if (trimmed.length > MAX_ANNOUNCEMENT_CHARS) return false
  if (REPORT_SHAPE_RE.test(trimmed)) return false
  if (trimmed.includes('```')) return false
  return IN_PROGRESS_PATTERNS.some((re) => re.test(trimmed))
}

/**
 * The assistant's final answer text of a turn ('' when it produced none).
 *
 * Text steps are collected as a contiguous run from the end: acp/CLI may split
 * one answer into fragments (`fragment: true` = append), so taking only the last
 * step would inspect a sentence tail and miss the announcement's subject.
 */
export function finalAssistantText(rec: ReadableRecordingLike): string {
  const parts: string[] = []
  let index = rec.length - 1
  while (index >= 0 && parts.length < 20) {
    const ev = rec.eventAt(index)
    if (ev === undefined || ev.kind !== 'step') break
    if (ev.stepKind !== 'text') break
    if (typeof ev.text === 'string' && ev.text !== '') parts.push(ev.text)
    index -= 1
  }
  if (parts.length === 0) return ''
  return parts.reverse().join('')
}

/**
 * True when the turn actually did some work before announcing. A pure chat
 * answer ("我一会儿再看这个问题") must not trigger a continuation: only a turn
 * that was already executing tools earns the one extra nudge.
 */
export function hasToolActivity(rec: ReadableRecordingLike): boolean {
  for (let i = 0; i < rec.length; i++) {
    const ev = rec.eventAt(i)
    if (ev !== undefined && ev.kind === 'step' && ev.stepKind === 'tool' && ev.tool !== undefined) return true
  }
  return false
}

/** The follow-up instruction spent on a stalled turn (one per turn, bounded). */
export function buildAnnouncementNudgeText(announcement: string, clips = 200): string {
  const quoted = announcement.replace(/\r/g, '').replace(/\s+/g, ' ').trim()
  const shown = quoted.length <= clips ? quoted : quoted.slice(0, clips) + '…'
  return [
    '[Continue · dsh-agy-link]',
    'Your previous message ended the turn with a status announcement instead of a result:',
    '',
    '> ' + shown,
    '',
    'Nothing was left running, so the promised follow-up never happened and the user is waiting.',
    'Do the work NOW in this turn: execute the tool calls (command / capture / build / edit) you just announced,',
    'read their real output, and answer with the result. Do not repeat the announcement, and do not end the turn',
    'again before the promised step has actually run and been verified.',
    'If the action is genuinely impossible, say exactly why and stop — but never answer "still running" alone.',
  ].join('\n')
}