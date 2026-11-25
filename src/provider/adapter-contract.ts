// The dependency contract between the host composition root and AgyAdapter.
//
// Moved verbatim out of src/host/adapter.ts so the adapter file stays a thin
// orchestrator. The adapter re-exports this type, so `import type {
// AgyAdapterDeps } from '.../adapter.ts'` keeps working for hosts and tests.
import type { AgyGenerateOptions, BridgeLease } from '../common/protocol.ts'
import type { BackgroundTurnObserver } from '../common/background-types.ts'
import type { ManagedAccount } from '../common/pool-types.ts'
import type { PluginConfig } from '../common/types.ts'
import type { ModelCatalog } from '../host/models.ts'
import type { SessionStore } from '../host/sessions.ts'
import type { AccountPoolManager } from '../host/pool.ts'
import type { ModelFamily } from '../common/pool-types.ts'
import type { RunRecording, RunRegistry } from '../host/recording.ts'
import type { StreamJsonParser } from '../host/parser.ts'
import type { ImageRefLike } from '../host/media.ts'
import type { AcpSessionNotice, AttemptDeps, AttemptInput, AttemptSlot } from './attempt.ts'

export interface AgyAdapterDeps {
  enterBridgeStep?: (options: AgyGenerateOptions) => BridgeLease | undefined
  getConfig: () => PluginConfig
  catalog: ModelCatalog
  store: SessionStore
  pool?: AccountPoolManager
  bin: () => string | null
  /** Shared semaphore for cross-session concurrency (ADR-12). */
  acquire: (signal?: AbortSignal) => Promise<() => void>
  log?: (msg: string) => void
  /**
   * Re-poll pool quotas and the model catalog. Used ONLY as a self-heal when
   * every enabled account is denied purely because the requested model is
   * missing from its per-model snapshot (issue #125).
   */
  refreshQuota?: () => Promise<void>
  /** Refresh ONLY one account's quota (throttled by the host). */
  onAccountUsed?: (accountId: string, family: ModelFamily) => void
  /**
   * Bring an isolated account's own OAuth token into agy's safety window before
   * spawning (host-injected; it needs the credential store). Without this a
   * stale token makes agy fall back to the machine-wide keyring and silently
   * run as another account.
   */
  ensureFreshToken?: (account: ManagedAccount) => Promise<boolean>
  /** Recordings shared with the agy_tool mirror (native tool-card mirroring). */
  runs: RunRegistry
  /**
   * Live check that the `agy_tool` mirror is currently registered in DSH's
   * tools service and visible to `sessionId`'s agent scope. Evaluated both at
   * span entry and right before emitting a tool-call cut so startup races,
   * scope restrictions, and mid-span plugin reloads never emit a doomed
   * `agy_tool` call (`Error: unknown tool "agy_tool"`). Defaults to `true`
   * when omitted (standalone unit tests).
   */
  isMirrorToolAvailable?: (sessionId?: string) => boolean
  /**
   * Resolve the DSH session's working directory. Called with the raw
   * session id; return an absolute path to run agy inside that workspace.
   * Explicit config `workspaceRoot` still wins over this value.
   */
  sessionCwd?: (sessionId: string) => string | undefined
  /**
   * Resolve the live goal info (goalId, revision) for this session.
   * `null` means "authoritatively no active, armed goal"; `undefined` means the
   * live goal service is unavailable and history detection may be used instead.
   */
  sessionGoal?: (sessionId: string) => { goalId: string; revision: number } | null | undefined
  /**
   * Resolve the live DSH plan-mode flag for this session (`true` = active/pending,
   * `false` = inactive, `undefined` = plan-mode service unavailable so prompt/message
   * signals decide).
   */
  sessionPlanMode?: (sessionId: string) => boolean | undefined
  /** Consume a one-shot `/aplan` read-only guard armed for the upcoming turn. */
  consumeForcedPlanMode?: (sessionId: string) => boolean
  /** Resolve the latest selected Antigravity model for this session (honored by compaction when DSH passes stale lastUsed). */
  sessionPendingModel?: (sessionId: string) => string | undefined
  /** Last-run telemetry surfaced by /agy status. Process completion and tool failures are distinct. */
  onRun?: (info: {
    processOk: boolean
    processCode: string
    toolErrors: readonly string[]
    durationMs: number
    model: string
    /** Output-token speed over this run's generation steps (see RunRecording.speedStats). */
    tokenSpeed: ReturnType<RunRecording['speedStats']>
  }) => void
  /** Reads image bytes from DSH attachment storage (multimodal staging). */
  readImage?: (ref: ImageRefLike) => Promise<Uint8Array | null>
  /** Called with each run's parser so the host can keep the last stdout ring for /agy doctor. */
  onParser?: (parser: StreamJsonParser) => void
  /** Base URL of the media route, e.g. http://127.0.0.1:PORT/plugins/agy-link/media */
  getMediaBaseUrl?: () => string | null
  /** Synchronizes active model selection back to DSH input box / session */
  syncSessionModel?: (sessionId: string, model: string, effort?: string) => void
  /**
   * Models already known to reject `--effort` (learned from an agy refusal and
   * persisted by the host, so a restart does not repeat the failed attempt).
   */
  effortUnsupported?: () => readonly string[]
  /**
   * A model refused `--effort`: persist it and let the picker re-read the
   * capabilities it advertises (its effort row must disappear).
   */
  onEffortUnsupported?: (model: string) => void
  /** Optional persistent ACP attempt runner wired from host services. */
  runAcp?: (deps: AttemptDeps, input: AttemptInput, slot: AttemptSlot) => Promise<RunRecording | null>
  /** Cached `agy --version` string (used to gate SSH_CONNECTION credential-slot bypass on agy >= 1.5). */
  agyVersion?: () => string | null
  /** Cross-turn background wake observer (tracks schedule timers & background tasks). */
  backgroundObserver?: BackgroundTurnObserver
  /**
   * Persist a user-visible ACP notice (session reset / rebuild) into the
   * conversation. The client half renders it as a chat card, so it never enters
   * the model-visible surface and never splits the answer's text block.
   */
  appendAcpNotice?: (sessionKey: string, notice: AcpSessionNotice) => void
  /**
   * Note an ACP report written straight into the transcript (方案 A) with the
   * record seq it landed at, so the same narration arriving again through the
   * brain-poll channel does not wake the model a second time.
   */
  noteAcpReport?: (sessionKey: string, text: string, seq: number) => void
  /**
   * Rewrite the machine-wide Windows credential slot with one account's
   * credential. Used by gate 2 after agy reports a different identity than the
   * account we dispatched.
   */
  reinstallCredentialSlot?: (account: ManagedAccount) => boolean
}