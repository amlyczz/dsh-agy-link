// Child-process console code-page decoding.
//
// MOVED VERBATIM from src/host/runner.ts (Phase 5h). Windows pipes carry bytes
// in the CHILD's console code page, so line decoding consults the OEM page.
import { execFileSync } from 'node:child_process'

/**
 * Windows pipes carry bytes in the CHILD's console code page: agy captures
 * pwsh tool output as CP936 (GBK) bytes on a zh-CN Windows, so decoding them
 * as UTF-8 mangles every non-ASCII character - and the mangled text is what
 * agy stores in its conversation database, so it can never be repaired later
 * (issue #37: the Chinese refusal text arrives mangled).
 */
const OEM_ENCODINGS: Record<number, string> = {
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  65001: 'utf-8',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
}

let consoleEncoding: string | null = null

/**
 * Console/OEM code page of this process as a TextDecoder label ('utf-8' off
 * Windows). Probed once; the child inherits our console, so its tool output is
 * written in this page.
 */
export function consoleOutputEncoding(platform: string = process.platform): string {
  if (platform !== 'win32') return 'utf-8'
  if (consoleEncoding !== null) return consoleEncoding
  consoleEncoding = 'utf-8'
  try {
    const out = execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'chcp'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
    })
    const m = /([0-9]{3,5})/.exec(out)
    const cp = m ? Number(m[1]) : Number.NaN
    const mapped = OEM_ENCODINGS[cp]
    if (mapped !== undefined) consoleEncoding = mapped
  } catch {
    // keep utf-8
  }
  return consoleEncoding
}

/**
 * Decode one LINE of child output: UTF-8 first, and when that produces
 * replacement characters re-decode those bytes with the console code page.
 * Lines (not raw chunks) are the unit on purpose - a multi-byte character can
 * straddle a chunk boundary but never a newline, in UTF-8 or the OEM pages.
 */
export function decodeConsoleLine(bytes: Buffer, encoding: string = consoleOutputEncoding()): string {
  const text = bytes.toString('utf8')
  if (encoding === 'utf-8' || !text.includes('\uFFFD')) return text
  try {
    const alt = new TextDecoder(encoding).decode(bytes)
    return alt.includes('\uFFFD') ? text : alt
  } catch {
    return text
  }
}

/** Byte stream to decoded line text, holding an unterminated tail back. */
export function makeLineDecoder(encoding: string): { push: (chunk: Buffer) => string; flush: () => string } {
  let rest: Buffer = Buffer.alloc(0)
  return {
    push(chunk: Buffer): string {
      rest = rest.length === 0 ? chunk : Buffer.concat([rest, chunk])
      let out = ''
      let nl: number
      while ((nl = rest.indexOf(0x0a)) >= 0) {
        out += decodeConsoleLine(rest.subarray(0, nl + 1), encoding)
        rest = rest.subarray(nl + 1)
      }
      return out
    },
    flush(): string {
      if (rest.length === 0) return ''
      const out = decodeConsoleLine(rest, encoding)
      rest = Buffer.alloc(0)
      return out
    },
  }
}