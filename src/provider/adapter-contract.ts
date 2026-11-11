// The dependency contract between the host composition root and AgyAdapter.
//
// Moved verbatim out of src/host/adapter.ts so the adapter file stays a thin
// orchestrator. The adapter re-exports this type, so `import type {
// AgyAdapterDeps } from '.../adapter.ts'` keeps working for hosts and tests.
import type { PluginConfig } from '../common/types.ts'
import type { ModelCatalog } from '../host/models.ts'
import type { SessionStore } from '../host/sessions.ts'
import type { AccountPoolManager } from '../host/pool.ts'
import type { RunRecording, RunRegistry } from '../host/recording.ts'
import type { StreamJsonParser } from '../host/parser.ts'
import type { ImageRefLike } from '../host/media.ts'

export interface AgyAdapterDeps {
  getConfig: () => PluginConfig
  catalog: ModelCatalog
  store: SessionStore
  pool?: AccountPoolManager
  bin: () => string | null
  /** Shared semaphore for cross-session concurrency (ADR-12). */
  acquire: (signal?: AbortSignal) => Promise<() => void>
  log?: (msg: string) => void
  /** Recordings shared with the agy_tool mirror (native tool-card mirroring). */
  runs: RunRegistry
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
}