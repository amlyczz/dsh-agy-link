// Typed plugin extensions to dsh-llm's GenerateOptions.
//
// `GenerateOptions.purpose` is the host's own union ('compaction' |
// 'session-title'); this plugin adds two private routes. Extending the
// interface is impossible (the unions would intersect to never), so the
// adapter accepts the host type at the boundary and narrows to this alias
// internally. Before this file every access was an `options as { agyX?: ... }`
// cast (six of them in the adapter alone).
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AgyEvent, PermissionMode } from './types.ts'

export type AgyPurpose = 'compaction' | 'session-title' | 'translation' | 'image'

export interface AgyTranslateSession {
  /** Persona + how to read the DSH session history; sent once per conversation. */
  setup: string
  /** The reply being translated; sent on every call. */
  text: string
}

export interface AgyAccountInfo {
  id: string
  /** HOME agy actually used for this run (isolated dir or the system HOME). */
  home: string
}

export type AgyGenerateOptions = Omit<GenerateOptions, 'purpose'> & {
  purpose?: AgyPurpose
  agyTranslateSession?: AgyTranslateSession
  agyImagePrompt?: string
  agyPermissionMode?: PermissionMode
  agyOnEvent?: (ev: AgyEvent) => void
  agyOnAccount?: (info: AgyAccountInfo) => void
}
