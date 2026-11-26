import { lastHistoryIndex } from '../../provider/history-boundary.ts'
// Rebuilding a session agy can no longer find.
//
// A stale session id must never be silently replaced by an empty one: the new
// session is created with the same ADR-7 history digest the first-turn path
// uses, and the conversation is told why the context looks new. Split out of
// run-attempt.ts to keep that file inside the module size budget.
import { resolveModelSlug } from '../../host/models.ts'
import type { AttemptDeps, AttemptInput } from '../../provider/attempt.ts'
import { deliverContext } from '../../provider/context-delivery.ts'
import { buildDigest, utf8Bytes, wrapLiveRequest } from '../../provider/prompt-text.ts'
import type { AcpProcess } from './client.ts'

/**
 * Rebuild the ACP session from the conversation history.
 *
 * The stored binding pointed at the session agy just told us it cannot find, so
 * it is cleared first: leaving it there would make the CLI fallback spawn with a
 * dead `--conversation` argument and let finalize keep the old sentImageIds.
 */
export async function rebuildAcpSession(opts: {
  deps: AttemptDeps
  input: AttemptInput
  proc: AcpProcess
  previousSid: string
  workspaceRoot: string
}): Promise<{ sid: string; prompt: string }> {
  const { deps, input, proc, previousSid, workspaceRoot } = opts
  const { cfg } = input
  deps.log?.(`acp session ${previousSid} could not be restored — rebuilding with a full history digest`)
  try {
    deps.store.delete(input.sessionAccountKey)
  } catch {
    // a store that refuses the delete must not block the rebuild
  }
  input.binding = undefined
  deps.appendAcpNotice?.(input.sessionKey, {
    kind: 'acp-reset',
    text:
      '原常驻会话已重置（agy 侧已找不到该会话），已自动携历史上下文重建新会话。' +
      '\nThe persistent ACP session was reset; a new one was created with the conversation history carried over.',
  })
  const history = input.messages.slice(0, lastHistoryIndex(input.messages) + 1)
  const digest = buildDigest(history, 0, cfg.contextTransferMaxChars, {
    maxBytes: cfg.contextTransferFileMaxBytes,
    maxLineBytes: 40_000,
    includeTaskLine: false,
  })
  const extraDirs: string[] = []
  const liveWrapped = wrapLiveRequest(input.prompt)
  const delivered = digest === ''
    ? ''
    : await deliverContext(digest, input.sessionKey, extraDirs, cfg, { liveRequestBytes: utf8Bytes(liveWrapped) })
  const prompt = delivered === '' ? input.prompt : liveWrapped + delivered
  let sid = previousSid
  if (extraDirs.length > 0) {
    // The digest was spilled to a file; agy needs that directory in scope.
    const reopened = await proc.openSession({
      cwd: workspaceRoot,
      addDirs: [...input.addDirs, ...extraDirs],
      model: resolveModelSlug(input.activeModel || cfg.defaultModel),
      ...(input.effort ? { effort: input.effort } : {}),
      mode: input.permissionMode,
    })
    sid = reopened.sessionId
  }
  return { sid, prompt }
}
