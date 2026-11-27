import { createHash } from 'node:crypto'
import { lstat, mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicTmpPath } from '../common/atomic-write.ts'
import { stateDir } from '../common/config.ts'
import { sweepDir } from '../host/media.ts'

export const CONTEXT_FILE_TTL_MS = 86_400_000

/** Stable content paths keep identical in-flight requests identical for steer
 * detection. Atomic replacement also refreshes the lifetime of a re-sent file. */
export async function writeContextTransferFile(sessionKey: string, body: string): Promise<string | null> {
  const dir = join(stateDir(), 'context-transfer')
  const hash = createHash('sha256').update(JSON.stringify(sessionKey)).update(body).digest('hex')
  const file = join(dir, hash + '.md')
  const temp = atomicTmpPath(file) + '.md'
  try {
    await mkdir(dir, { recursive: true })
    await sweepDir(dir, CONTEXT_FILE_TTL_MS)
    await writeFile(temp, body, { flag: 'wx', mode: 0o400 })
    try {
      await rename(temp, file)
    } catch (error) {
      // Windows cannot replace an existing read-only file. Its content hash
      // is identical; renew its lease, or use our completed private copy.
      if (process.platform !== 'win32' || !(await lstat(file).catch(() => null))?.isFile()) throw error
      const now = new Date()
      try { await utimes(file, now, now) } catch { return temp }
      await rm(temp, { force: true })
    }
    return file
  } catch {
    await rm(temp, { force: true }).catch(() => {})
    return null
  }
}
