// Persona, prompt and chunk building for translations. Pure string assembly;
// no I/O and no service state.
import { MIN_TEXT_LIMIT, type TranslationSetupInput } from './types.ts'

/**
 * The block agy receives ONCE, when its translation conversation is created:
 * who it is, which DSH session it serves, where that session's history lives and
 * how to read it, plus a bounded digest so the first translation already has
 * context. Later translations send only the source text (see the adapter's
 * `agyTranslateSession` handling).
 */
export function buildTranslationSetup(input: TranslationSetupInput): string {
  const lang = input.targetLanguage.trim() === '' ? '中文（简体）' : input.targetLanguage.trim()
  const lines = [
    '你是「人话翻译器」，长期服务于 DSH 的一个会话。以后我只把需要翻译的原文发给你，你直接把它讲成人话。',
    '',
    '- DSH 会话 id：' + (input.sessionId === '' ? '(未知)' : input.sessionId),
  ]
  if (input.cwd !== undefined && input.cwd !== '') lines.push('- 该会话的工作目录：' + input.cwd)
  if (input.digest !== undefined && input.digest.trim() !== '') {
    lines.push('', '该会话到目前为止的摘要（供你理解上下文，不必翻译它）：', '', '<digest>', input.digest.trim(), '</digest>')
  }
  if (input.logPath !== undefined && input.logPath !== '') {
    lines.push(
      '',
      '需要完整历史时可以自己读：原始日志在 ' + input.logPath + '（zstd 压缩的 JSONL，每行一个事件）。读取示例：',
      "  zstd -dc '" + input.logPath + "' | jq -c 'select(.type==\"assistant/message\") | {turn:.data.turn, text:([.data.message.content[]?.text] | join(\"\"))}' | tail -40",
      '没有 jq 就用 python3 逐行 json.loads 过滤；不要修改这些文件。',
    )
  }
  lines.push(
    '',
    '规则：',
    '1. 每次我只发来「当前这一条」AI 回复的原文：只讲这一条，别去翻历史里的其它回答来顶替它。',
    '2. 说' + lang + '的大白话，像当面给同事解释：口语、短句、怎么顺口怎么来；不要标题，不要分点罗列，不要写成报告。',
    '3. 别用行话、缩写和「首先 / 其次 / 综上 / 因此 / 旨在 / 该方案」这类书面词；遇到术语先用日常说法讲清它大概是干什么的。',
    '4. 原文说了多少就讲多少：结论、条件、谁做了什么都要留着，别为了短把细节吞掉，也别替它下结论。',
    '5. 只输出讲解本身，不要前言、不要复述我发的内容、不要反问我。',
  )
  return lines.join('\n')
}

/** The translator instruction. Kept in the user message (aux calls drop
 * `options.system` unless `forwardSystemPrompt` is on), and deliberately
 * explicit about "never invent facts": a cheerful paraphrase that adds a
 * promise the agent never made is worse than no translation at all.
 */
export function buildTranslationPrompt(text: string, targetLanguage: string, maxChars: number, sessionId?: string): string {
  const lang = targetLanguage.trim() === '' ? '中文（简体）' : targetLanguage.trim()
  const limit = Math.max(MIN_TEXT_LIMIT, Math.round(maxChars))
  // Deliberately a short instruction with NO format mandate. The earlier rule
  // list ("结论先行 / 去黑话 / 输出 Markdown …") made the model write a book
  // report: headings, bullet lists, formal register. What the reader wants is
  // the same thing said out loud, so the constraints only stop it drifting:
  // spoken register, keep the meaning, invent nothing, and answer with the
  // explanation alone. "该长就长" is explicit because the reader asked for the
  // real content volume — a long answer must not be compressed into three
  // bullet conclusions.
  const long = text.length > Math.min(2_000, Math.floor(limit / 4))
  const where = sessionId === undefined || sessionId.trim() === '' ? '' : '（DSH 会话 ' + sessionId.trim() + '）'
  const lines = [
    '把下面这段「当前这一条 AI 回复」的原文，用' + lang + '讲成大白话，就像当面跟同事解释：',
    '说人话、用短句，怎么顺口怎么来；别用行话、缩写和「首先 / 其次 / 综上 / 因此」这类书面词，遇到术语先用日常说法讲清它大概是干什么的。',
    '原文说了多少就讲多少，该长就长、该短就短，别压成几句结论，也别写成标题或分点报告。',
    '只讲这一条回复' + where + '本身，别把历史里别的回复混进来；别改原意，别加原文没有的内容，别替它下结论。',
    ...(long ? ['原文比较长，按它自己的顺序一步步讲完，别漏掉关键条件。'] : []),
    '只输出讲解本身，不要复述我发的内容，不要提问。',
    '',
    '<content>',
    text,
    '</content>',
  ]
  return lines.join('\n')
}

/**
 * Per-turn request for a BOUND translation conversation.
 *
 * The persona (`buildTranslationSetup`) goes out once, when that conversation is
 * created; every later turn receives only this line plus the source. Keeping the
 * request on every turn is what pins the model to the reply it is looking at now
 * instead of translating something it remembers from an earlier turn.
 */
export function buildTranslationRequest(text: string, targetLanguage: string, maxChars: number): string {
  const lang = targetLanguage.trim() === '' ? '中文（简体）' : targetLanguage.trim()
  const long = text.length > Math.min(2_000, Math.floor(Math.max(MIN_TEXT_LIMIT, Math.round(maxChars)) / 4))
  return [
    '把「当前这一条 AI 回复」的下面这段原文，用' + lang + '讲成大白话：说人话、短句，别用行话和书面腔（不要「首先 / 其次 / 综上 / 因此」），术语先用日常说法解释。',
    '原文说了多少就讲多少，按它自己的顺序讲，该长就长，别压成几句结论，也别写成标题或分点报告；别改原意，别加原文没有的内容。',
    ...(long ? ['原文比较长，一步步讲完，别漏掉关键条件。'] : []),
    '只讲这一条，别把前面几轮的内容混进来；只输出讲解本身。',
    '',
    '<content>',
    text,
    '</content>',
  ].join('\n')
}

/**
 * Split long answers on paragraph boundaries. A single paragraph longer than
 * the cap is hard-split so one giant code block cannot blow the request limit.
 */
export function chunkText(text: string, maxChars: number): string[] {
  const cap = Math.max(MIN_TEXT_LIMIT, Math.round(maxChars))
  if (text.length <= cap) return [text]
  const chunks: string[] = []
  let current = ''
  for (const para of text.split(/\n{2,}/)) {
    const piece = para.trim()
    if (piece === '') continue
    if (piece.length > cap) {
      if (current !== '') {
        chunks.push(current)
        current = ''
      }
      for (let i = 0; i < piece.length; i += cap) chunks.push(piece.slice(i, i + cap))
      continue
    }
    const next = current === '' ? piece : current + '\n\n' + piece
    if (next.length > cap) {
      chunks.push(current)
      current = piece
    } else {
      current = next
    }
  }
  if (current !== '') chunks.push(current)
  return chunks.length === 0 ? [text] : chunks
}
