import type { Message } from '@deepseek-ai/dsh-llm'
import { isSyntheticHarnessMessage, isToolResultMessage } from './prompt-text.ts'

// Preserve a trailing tool-only continuation. When a new user/report follows,
// the preceding tool result belongs to history.
export function lastHistoryIndex(messages: readonly Message[]): number {
  let pendingUser = false
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'assistant' || (pendingUser && isToolResultMessage(message))) return i
    if (message.role === 'user' && !isToolResultMessage(message) && !isSyntheticHarnessMessage(message)) pendingUser = true
  }
  return -1
}
