import { bridgeAllows, projectBridgeTools } from '../common/bridge-tools.ts'
import { lastHistoryIndex } from './history-boundary.ts'
// Prompt assembly (ADR-7): turn DSH messages into the single agy prompt for
// this hop (trailing user/tool selection, binding lookup/invalidation, history
// digest delivery, image staging, and final prompt branches).
import { LlmError, type Message } from '@deepseek-ai/dsh-llm'
import { Err, type PluginConfig } from '../common/types.ts'
import type { AgyGenerateOptions } from '../common/protocol.ts'
import type { ManagedAccount } from '../common/pool-types.ts'
import { resolvePromptBinding, type PromptPlanDeps } from './prompt-binding.ts'
export type { ActiveRunView, PromptPlanDeps } from './prompt-binding.ts'
import { protectTrailingRequest } from './live-last-request.ts'
import { promptBudgetBytes } from './prompt-budget.ts'
import type { SessionBinding } from '../host/sessions.ts'
import type { CompactionNotice } from '../common/compaction.ts'
import type { CallContext } from './call-context.ts'
import { buildCompactionPrompt } from './compaction-prompt.ts'
import { toolCallIdOf } from './continuation.ts'
import { ASK_BRIDGE_PREFIX, askAnswerPrompt, askQuestionsOfCall } from '../host/dsh-ask.ts'
import { stageHistoricalAttachments, stageLivePromptMedia } from './history-media.ts'
import { plannedWatermarks, systemDelta, systemPrefix, type SystemWatermarks } from './system-budget.ts'
import { deliverSystemPrompt } from './system-delivery.ts'
import { extractLeadingAgySlash, formatWithLeadingAgySlash } from './leading-slash.ts'
import type { PurposePolicy } from './purpose-policy.ts'
import {
  buildDigest,
  isForeignAssistant,
  isSyntheticHarnessMessage,
  isToolResultMessage,
  latestUserMessageAny,
  latestUserTaskText,
  textOf,
  utf8Bytes,
  wrapLiveRequest,
} from './prompt-text.ts'

export interface PromptPlanInput {
  bridgeServer?: string
  options: AgyGenerateOptions
  cfg: PluginConfig
  ctx: CallContext
  policy: PurposePolicy
  account: ManagedAccount | undefined
  model: string
  activeModel: string
  deps: PromptPlanDeps
}

export interface PromptPlan extends SystemWatermarks {
  prompt: string
  /** Roots added because the prompt staged images (mirrors the old stagedDirs). */
  stagedDirs: string[]
  /** Final --add-dir list (workspace root + stagedDirs, deduped). */
  addDirs: string[]
  binding: SessionBinding | undefined
  bindingKey: string
  persistBinding: boolean
  sessionAccountKey: string
  currentModel: string
  compactionNotice: CompactionNotice | undefined
  newlySentImageIds: string[]
  stagedImages: Array<{ path: string; mediaType: string }>
  messages: readonly Message[]
  lastAssistantIdx: number
}

// agy dispatches unqualified calls to its own runtime, which has different session state.
const AGY_BUILTIN_TOOLS = new Set([
  'send_message', 'invoke_subagent', 'define_subagent', 'manage_subagents', 'schedule', 'swarm',
  'run_workflow', 'read_file', 'view_file', 'write_file', 'write_to_file', 'edit_file', 'run_command',
  'list_dir', 'grep_search', 'find_by_name', 'replace_file_content', 'multi_replace_file_content',
  'manage_task', 'update_steps', 'update_focus', 'search_web', 'read_url_content', 'generate_image',
])

function bridgeRouting(server: string, tools: NonNullable<AgyGenerateOptions['tools']>, cfg: PluginConfig): string {
  const exposed = projectBridgeTools(tools, bridgeAllows(cfg.mcpBridgeScope, cfg.mcpToolAllowlist))
  if (!exposed.length) return ''
  const colliding = exposed.filter(({ tool, name }) => AGY_BUILTIN_TOOLS.has(tool.name) || AGY_BUILTIN_TOOLS.has(name))
  let hint = `For this DSH session, use the tools exposed on MCP server ${server}. Use its advertised tool names and schemas for the current step.`
  if (colliding.length) {
    const labels = colliding.map(({ tool, name }) => tool.name === name ? name : `${tool.name} (MCP name ${name})`)
    hint += ` For ${labels.join(', ')}, you MUST use MCP server ${server} in this DSH session. Never call AGY's same-named built-in tools for these operations.`
  }
  return hint + '\n\n'
}

type DigestMode = 'none' | 'first' | 'foreign'

/** Index of the last assistant message plus the user/tool messages after it. */
function trailingSpanOf(messages: readonly Message[]): { lastAssistantIdx: number; trailingUser: Message[] } {
  const lastAssistantIdx = lastHistoryIndex(messages)
  // Include tool-role messages (dsh-llm 0.1.7+) in the trailing span. A
  // post-tool hop's trailing run is otherwise empty and the call is dispatched
  // with no task at all (issue #34).
  const trailingUser = messages.slice(lastAssistantIdx + 1).filter((m) => {
    const role = (m as { role?: string }).role
    return role === 'user' || role === 'tool'
  })
  return { lastAssistantIdx, trailingUser }
}

/**
 * agy does not treat process cwd as its Active Workspace — it requires
 * --add-dir. Attach the resolved workspace root (issue #26), EXCEPT for
 * pure-text aux calls: their neutral cwd is deliberately empty and re-adding it
 * would reintroduce project context.
 */
function resolveAddDirs(workspaceRoot: string, stagedDirs: string[], neutralAuxWorkspace: boolean): string[] {
  if (neutralAuxWorkspace) return [...stagedDirs]
  if (workspaceRoot === '') return stagedDirs
  return stagedDirs.includes(workspaceRoot) ? stagedDirs : [workspaceRoot, ...stagedDirs]
}

/**
 * Assemble everything needed to spawn one agy call for this hop. The adapter
 * calls this once; nothing here touches process state or account selection.
 */
export async function buildPromptPlan(input: PromptPlanInput, freshConversation = false): Promise<PromptPlan> {
  const { options, cfg, ctx, policy, account, activeModel, deps } = input
  const { isAux, isTranslateSession, translateSession, sessionKey, isImage, workspaceRoot, neutralAuxWorkspace } = ctx
  const messages = options.messages
  const { lastAssistantIdx, trailingUser } = trailingSpanOf(messages)
  const bindingKey = isTranslateSession && sessionKey !== '' ? `${sessionKey}#tsl` : sessionKey
  const persistBinding = policy.persistBinding(isTranslateSession)
  const sessionAccountKey = account ? `${bindingKey}:${account.id}` : bindingKey
  const currentModel = activeModel === '' ? cfg.defaultModel : activeModel

  const { binding, compactionNotice } = freshConversation ? { binding: undefined, compactionNotice: undefined } : resolvePromptBinding({
    cfg, ctx, account, activeModel, currentModel, persistBinding,
    bindingKey, sessionAccountKey, messages, lastAssistantIdx, deps,
  })
  const stagedDirs: string[] = []
  const branch = buildBranchPrompt({
    options, cfg, ctx, translateSession, isTranslateSession, isImage, binding, lastAssistantIdx, messages,
  })
  let prompt = branch.prompt
  const leadingSlash = !isAux && !isImage && !isTranslateSession ? extractLeadingAgySlash(prompt) : null
  if (leadingSlash) prompt = leadingSlash.rest

  let historicalStagedIds: string[] = []
  let coveredHistory = false
  if (branch.digest !== 'none') {
    const digestRes = await applyContextDigest({
      mode: branch.digest, cfg, ctx, binding, messages, lastAssistantIdx, prompt, stagedDirs, deps,
    })
    prompt = digestRes.prompt
    historicalStagedIds = digestRes.stagedIds
    coveredHistory = digestRes.coveredHistory
  }

  const newlySentImageIds: string[] = [...historicalStagedIds]
  const stagedImages: Array<{ path: string; mediaType: string }> = []
  if (!isAux) {
    const staged = await stageLivePromptMedia({
      cfg, sessionKey, messages, trailingUser, lastAssistantIdx, binding,
      coveredHistory, extraSentIds: historicalStagedIds, prompt,
      ...(deps.readImage ? { readImage: deps.readImage } : {}),
    })
    prompt = staged.prompt
    if (staged.stagedDir !== null && !stagedDirs.includes(staged.stagedDir)) stagedDirs.push(staged.stagedDir)
    newlySentImageIds.push(...staged.stagedIds)
    stagedImages.push(...staged.stagedImages)
  }
  const routing = input.bridgeServer && options.tools?.length ? bridgeRouting(input.bridgeServer, options.tools, cfg) : ''
  const forward = (cfg.forwardSystemPrompt && !isAux) || ctx.isReview || ctx.isTitle
  const reusable = persistBinding && (!binding?.prefixFilesExpireAt || binding.prefixFilesExpireAt > Date.now()) ? binding : undefined
  const delta = forward ? systemDelta(options.system, messages, cfg.cloakSystemPrompt, !isAux, reusable) : undefined
  const maxBytes = promptBudgetBytes(cfg)
  if (delta && !isAux) {
    delta.nextPrefixFilesExpireAt = reusable?.prefixFilesExpireAt
    const slashBytes = leadingSlash ? utf8Bytes(leadingSlash.commandLine) + 2 : 0
    const latest = utf8Bytes(prompt) + slashBytes + utf8Bytes(routing) > maxBytes ? latestUserTaskText(messages) : undefined
    const delivered = await deliverSystemPrompt(delta, prompt, routing, sessionKey, stagedDirs, slashBytes, maxBytes, latest)
    prompt = delivered.prompt
    delta.nextPrefixFilesExpireAt = delivered.expiresAt
  } else {
    const prefix = delta ? systemPrefix(delta.system, delta.snapshots) : ''
    prompt = routing + [prefix, prompt].filter(Boolean).join('\n\n')
  }
  if (leadingSlash) prompt = formatWithLeadingAgySlash({ ...leadingSlash, rest: '' }, prompt)
  if (prompt.trim() === '') {
    throw new LlmError(isAux ? 'request carries no user text to forward to agy' : 'request carries no user text or images to forward to agy', Err.AGY_ERROR)
  }

  // "Live-last" requests (no assistant anchor: DSH's auto-review, session titles)
  // carry their decisive content at the tail. Fit them to the budget here, as the
  // last shaping step, so the generic tail trim downstream never sees them.
  if (lastAssistantIdx < 0 && !isImage && !isTranslateSession && !(isAux && options.purpose === 'compaction')) {
    prompt = protectTrailingRequest(prompt, messages, maxBytes)
  }
  if (compactionNotice && compactionNotice.afterTokens <= 0) {
    compactionNotice.afterTokens = Math.max(100, Math.round(prompt.length / 3.5))
  }
  const addDirs = resolveAddDirs(workspaceRoot, stagedDirs, neutralAuxWorkspace)
  return {
    prompt, stagedDirs, addDirs, binding, bindingKey, persistBinding, sessionAccountKey,
    ...(delta ? plannedWatermarks(delta) : {}),
    currentModel, compactionNotice, newlySentImageIds, stagedImages, messages, lastAssistantIdx,
  }
}

interface BranchPromptInput {
  options: AgyGenerateOptions
  cfg: PluginConfig
  ctx: CallContext
  translateSession: CallContext['translateSession']
  isTranslateSession: boolean
  isImage: boolean
  binding: SessionBinding | undefined
  lastAssistantIdx: number
  messages: readonly Message[]
}

/**
 * Build the branch-specific base prompt text (before digest / system /
 * images). Returns the digest mode the chat branch still needs applied.
 */
function buildBranchPrompt(input: BranchPromptInput): { prompt: string; digest: DigestMode } {
  const { options, cfg, ctx, translateSession, isTranslateSession, isImage, binding, lastAssistantIdx, messages } = input
  const imagePromptRaw = options.agyImagePrompt
  if (isImage) {
    // Verbatim: the CLI's bridge prompt already pins the tool arguments and
    // the machine-readable reply contract. No session context is mixed in.
    return { prompt: typeof imagePromptRaw === 'string' ? imagePromptRaw : '', digest: 'none' }
  }
  if (isTranslateSession) {
    // The persona (role, the DSH session id, where its history lives and how to
    // read it) travels with the FIRST message only. Once agy owns the
    // conversation, every later translation is just the source text.
    const lastMessage = messages[messages.length - 1] ?? messages[0]
    const text = translateSession !== null && translateSession.text !== ''
      ? translateSession.text
      : lastMessage === undefined ? '' : textOf(lastMessage)
    const prompt = binding === undefined && translateSession !== null
      ? translateSession.setup + (translateSession.setup === '' ? '' : '\n\n=====\n\n') + text
      : text
    return { prompt, digest: 'none' }
  }
  if (ctx.isAux && options.purpose === 'compaction') {
    return { prompt: buildCompactionPrompt(messages, cfg.compactionMaxChars, promptBudgetBytes(cfg)), digest: 'none' }
  }

  return { prompt: buildChatPromptText({ binding, lastAssistantIdx, messages }), digest: binding === undefined ? (lastAssistantIdx >= 0 ? 'first' : 'none') : 'foreign' }
}

interface ChatPromptInput {
  binding: SessionBinding | undefined
  lastAssistantIdx: number
  messages: readonly Message[]
}

/**
 * Chat-branch prompt text (before digest). Two corrections over a naive
 * "flatten everything after the last assistant message":
 *
 * 1. REDUNDANCY: tool-result payloads are not re-sent when a live agy
 *    conversation already owns them (agy executed those tools itself).
 * 2. STALE TASK: the prompt task is the LAST user message, never an older one.
 *
 * When returning to an established conversation, start strictly after the
 * watermark so an aborted/interrupted prior message is not dragged in.
 */
function buildChatPromptText(input: ChatPromptInput): string {
  const { binding, lastAssistantIdx, messages } = input
  const trailingStart = binding !== undefined
    ? Math.max(Math.min(binding.lastMessageCount, messages.length), lastAssistantIdx + 1)
    : lastAssistantIdx + 1

  const effectiveTrailingUser = messages.slice(trailingStart).filter((m) => {
    const role = (m as { role?: string }).role
    if (role !== 'user' && role !== 'tool') return false
    if (isSyntheticHarnessMessage(m)) return false
    return true
  })

  // Real task first; the any-message fallback only fires when the sniffing
  // filtered out every user message (a pasted reminder block IS the task).
  const taskText = latestUserTaskText(messages) || latestUserMessageAny(messages)
  const dropToolPayloads = binding !== undefined
  const isBridgeToolResult = (m: Message): boolean => {
    if (!isToolResultMessage(m)) return false
    const callId = toolCallIdOf(m)
    return callId !== null && callId.startsWith('agytc-bridge-')
  }
  // The answer to the bridge's question (issue #236) is a host result object;
  // agy gets it as readable Q/A lines quoting the question it asked.
  const bridgeText = (m: Message): string => {
    const callId = toolCallIdOf(m)
    if (callId === null || !callId.startsWith(ASK_BRIDGE_PREFIX)) return textOf(m)
    return askAnswerPrompt(textOf(m), askQuestionsOfCall(callId, messages) ?? [])
  }
  const trailingText = effectiveTrailingUser
    .filter((m) => !(dropToolPayloads && isToolResultMessage(m) && !isBridgeToolResult(m)))
    .map(bridgeText)
    .filter((s) => s.trim() !== '')
  const hasBridgeToolResult = effectiveTrailingUser.some(isBridgeToolResult)
  const trailingJoined = trailingText.join('\n\n')
  let prompt: string
  if (hasBridgeToolResult && trailingJoined !== '') {
    // A bridge-synthesized tool result (e.g. exit_plan_mode approval or keep-planning
    // feedback) was executed by DSH, not agy — send it directly instead of repeating
    // the earlier human prompt.
    prompt = trailingJoined
  } else if (taskText !== '') {
    prompt = trailingText.includes(taskText) || trailingJoined.includes(taskText)
      ? trailingJoined
      : (trailingJoined === '' ? taskText : taskText + '\n\n' + trailingJoined)
  } else {
    prompt = trailingJoined
  }
  if (prompt === '' && dropToolPayloads && effectiveTrailingUser.length > 0) {
    // Everything this hop carried was agy's own tool output, which the live
    // conversation already contains: nudge instead of piping it back.
    prompt = '[continue — the tool output for your last tool call is already in this conversation]'
  }
  return prompt
}

interface DigestInput {
  mode: Exclude<DigestMode, 'none'>
  cfg: PluginConfig
  ctx: CallContext
  binding: SessionBinding | undefined
  messages: readonly Message[]
  lastAssistantIdx: number
  prompt: string
  stagedDirs: string[]
  deps: PromptPlanDeps
}

/** Apply the ADR-7 history digest for the chat branch (first contact / foreign turns). */
async function applyContextDigest(input: DigestInput): Promise<{
  prompt: string
  stagedIds: string[]
  coveredHistory: boolean
}> {
  const { mode, cfg, ctx, binding, messages, lastAssistantIdx, prompt, stagedDirs, deps } = input
  if (mode === 'first') {
    // First contact / account switch / model switch / compaction re-seed: the
    // new agy conversation has seen NOTHING, so seed it with a history digest.
    // A single user message is truncated at 192,000 bytes at the TAIL, so the
    // live request goes FIRST (wrapLiveRequest) and the digest after it; beyond
    // `contextTransferFileAboveBytes` we inline the newest turns and spill only
    // the older overflow to a readable `.md` archive.
    const hist = !ctx.isAux && lastAssistantIdx >= 0
      ? await stageHistoricalAttachments({
          cfg,
          sessionKey: ctx.sessionKey,
          messages: messages.slice(0, lastAssistantIdx + 1),
          alreadySentIds: [],
          ...(deps.readImage ? { readImage: deps.readImage } : {}),
        })
      : { attachmentsByMessage: new Map(), stagedDir: null, stagedIds: [] }
    if (hist.stagedDir !== null && !stagedDirs.includes(hist.stagedDir)) stagedDirs.push(hist.stagedDir)
    const digest = buildDigest(messages.slice(0, lastAssistantIdx + 1), 0, cfg.contextTransferMaxChars, {
      maxBytes: cfg.contextTransferFileMaxBytes,
      maxLineBytes: 40_000,
      includeTaskLine: false,
      ...(hist.attachmentsByMessage.size > 0 ? { attachmentsByMessage: hist.attachmentsByMessage } : {}),
    })
    const liveWrapped = wrapLiveRequest(prompt)
    const delivered = await deps.deliverContext(digest, ctx.sessionKey, stagedDirs, {
      liveRequestBytes: utf8Bytes(liveWrapped),
    })
    return {
      prompt: delivered !== '' ? liveWrapped + delivered : prompt,
      stagedIds: hist.stagedIds,
      coveredHistory: true,
    }
  }

  if (binding === undefined) return { prompt, stagedIds: [], coveredHistory: false }
  // Returning session: digest only the foreign turns since our watermark (the
  // user may have talked to another model or another agy account in between).
  // Uses the same inline-first / hybrid tail-inline + archive-file delivery
  // channel as first contact so A→B→A catch-up is never clipped at 8,000 chars.
  const from = Math.min(binding.lastMessageCount, messages.length)
  const end = Math.max(from, lastAssistantIdx + 1)
  const currentConvId = binding.conversationId
  const span = messages
    .slice(from, end)
    .filter((m) => m.role !== 'assistant' || isForeignAssistant(m, currentConvId))
  let out = prompt
  let stagedIds: string[] = []
  let coveredHistory = false
  if (span.some((m) => m.role === 'assistant')) {
    coveredHistory = true
    const hist = !ctx.isAux
      ? await stageHistoricalAttachments({
          cfg,
          sessionKey: ctx.sessionKey,
          messages: span,
          alreadySentIds: binding.sentImageIds ?? [],
          ...(deps.readImage ? { readImage: deps.readImage } : {}),
        })
      : { attachmentsByMessage: new Map(), stagedDir: null, stagedIds: [] }
    if (hist.stagedDir !== null && !stagedDirs.includes(hist.stagedDir)) stagedDirs.push(hist.stagedDir)
    stagedIds = hist.stagedIds
    const foreignDigest = buildDigest(span, 0, cfg.contextTransferMaxChars, {
      maxBytes: cfg.contextTransferFileMaxBytes,
      maxLineBytes: 40_000,
      includeTaskLine: false,
      ...(hist.attachmentsByMessage.size > 0 ? { attachmentsByMessage: hist.attachmentsByMessage } : {}),
    })
    if (foreignDigest !== '') {
      const liveWrapped = wrapLiveRequest(out)
      const delivered = await deps.deliverContext(foreignDigest, ctx.sessionKey, stagedDirs, {
        liveRequestBytes: utf8Bytes(liveWrapped),
      })
      if (delivered !== '') out = liveWrapped + delivered
    }
  }
  if (binding.interrupted === true) {
    // The previous turn was cut mid-flight (Stop / steer / watchdog): agy's
    // conversation still ends with an unanswered user turn, so without this
    // boundary the model treats THAT as the live question.
    out = '[the previous turn was interrupted before it finished — do not continue or answer that unfinished work; respond only to the newest request below]\n\n' + out
  }
  return { prompt: out, stagedIds, coveredHistory }
}
