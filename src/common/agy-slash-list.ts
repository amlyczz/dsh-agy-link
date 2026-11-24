/** Top-level `a`-prefix commands that dispatch directly into the current DSH conversation. */
export const DIRECT_AGY_SLASH_COMMANDS = [
  'aplan',
  'agoal',
  'agrill',
  'aboost',
  'aswarm',
  'ateamwork',
  'aschedule',
  'abrowser',
  'acmd',
] as const

export type DirectAgySlashCommand = (typeof DIRECT_AGY_SLASH_COMMANDS)[number]
