// Windows Credential Manager primitives & System Proxy auto-detection.
//
// On Windows, `agy.exe` resolves its Google credential from the single
// process-global store `gemini:antigravity` (via `zalando/go-keyring` ->
// CredRead/CredWrite). HOME/USERPROFILE are ignored there, so per-account
// directory isolation does NOT isolate credentials.
//
// The safe handoff of that shared slot — serialization, identity verification
// and guaranteed restoration — lives in ./credential-slot.ts. This module only
// exposes the raw read/write/delete primitives plus proxy detection; it holds
// no policy, so it can never pick an account on its own.
//
// System Proxy Auto-Detection:
// On Windows GUI hosts (Electron / DSH Desktop), process.env lacks terminal
// HTTP_PROXY/HTTPS_PROXY. We detect proxy settings from the Windows Registry
// (`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`).
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from '../common/config.ts'

const IS_WIN = process.platform === 'win32'

const WIN_CRED_CS_SRC = `using System;
using System.Runtime.InteropServices;

public static class WinCredCli {
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredDelete(string target, int type, int flags);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr cred);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public long LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  public static int Main(string[] args) {
    if (args.Length < 2) return 2;
    string action = args[0];
    string target = args[1];
    string user = args.Length > 2 ? args[2] : "antigravity";
    if (action == "read") {
      IntPtr p;
      if (!CredRead(target, 1, 0, out p)) return 0;
      try {
        CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
        byte[] b = new byte[c.CredentialBlobSize];
        if (c.CredentialBlobSize > 0 && c.CredentialBlob != IntPtr.Zero) {
          Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize);
        }
        Console.Out.Write(Convert.ToBase64String(b));
      } finally {
        CredFree(p);
      }
      return 0;
    }
    if (action == "write") {
      string payload = Console.In.ReadToEnd().Trim();
      byte[] secret = Convert.FromBase64String(payload);
      CREDENTIAL c = new CREDENTIAL();
      c.Type = 1;
      c.TargetName = target;
      c.UserName = user;
      c.Persist = 2;
      c.CredentialBlobSize = secret.Length;
      IntPtr p = Marshal.AllocHGlobal(secret.Length);
      Marshal.Copy(secret, 0, p, secret.Length);
      c.CredentialBlob = p;
      bool ok;
      try {
        ok = CredWrite(ref c, 0);
      } finally {
        Marshal.FreeHGlobal(p);
      }
      Console.Out.Write(ok ? "True" : "False");
      return ok ? 0 : 1;
    }
    if (action == "delete") {
      bool ok = CredDelete(target, 1, 0);
      Console.Out.Write(ok ? "True" : "False");
      return 0;
    }
    return 2;
  }
}
`

const WIN_CRED_HASH = createHash('sha256').update(WIN_CRED_CS_SRC).digest('hex').slice(0, 8)
let helperDisabled = false
let cachedHelperPath: string | null = null

function findCscExe(): string | null {
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows'
  const candidates = [
    join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  for (const cand of candidates) {
    if (existsSync(cand)) return cand
  }
  return null
}

/**
 * Compile and cache a tiny standalone .NET Win32 helper once per source hash so
 * Credential Manager reads/writes take ~15ms instead of ~1.5-3s per powershell.exe
 * Add-Type cold compilation. Falls back cleanly to PowerShell if csc.exe is absent.
 */
function ensureWinCredHelper(): string | null {
  if (!IS_WIN || helperDisabled) return null
  if (cachedHelperPath && existsSync(cachedHelperPath)) return cachedHelperPath
  const csc = findCscExe()
  if (!csc) {
    helperDisabled = true
    return null
  }
  const binDir = join(stateDir(), 'bin')
  const finalExe = join(binDir, `wincred-v1-${WIN_CRED_HASH}.exe`)
  if (existsSync(finalExe)) {
    cachedHelperPath = finalExe
    return finalExe
  }
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const tmpCs = join(binDir, `wincred-${stamp}.cs`)
  const tmpExe = join(binDir, `wincred-${stamp}.exe`)
  try {
    mkdirSync(binDir, { recursive: true })
    writeFileSync(tmpCs, WIN_CRED_CS_SRC, 'utf8')
    execFileSync(
      csc,
      ['/nologo', '/optimize+', '/target:exe', `/out:${tmpExe}`, tmpCs],
      { timeout: 20_000, windowsHide: true, stdio: 'ignore' },
    )
    try {
      renameSync(tmpExe, finalExe)
    } catch {
      if (!existsSync(finalExe)) throw new Error('failed to finalize wincred helper')
    }
    cachedHelperPath = finalExe
    return finalExe
  } catch {
    helperDisabled = true
    return null
  } finally {
    try { rmSync(tmpCs, { force: true }) } catch { /* ignore */ }
    try { rmSync(tmpExe, { force: true }) } catch { /* ignore */ }
  }
}

// Embedded PowerShell script using Win32 advapi32 CredRead/CredWrite/CredDelete.
// Uses base64 encoding for safe binary / JSON payload transfer.
const WIN_CRED_SCRIPT = `
param($target, $user, $action, $payload)

$sig = @'
using System;
using System.Runtime.InteropServices;

public class WinCred {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);

  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);

  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredDelete(string target, int type, int flags);

  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern void CredFree(IntPtr cred);

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public long LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  public static bool Write(string target, string userName, byte[] secret) {
    CREDENTIAL c = new CREDENTIAL();
    c.Type = 1; // Generic
    c.TargetName = target;
    c.UserName = userName;
    c.Persist = 2; // Local machine
    c.CredentialBlobSize = secret.Length;
    IntPtr p = Marshal.AllocHGlobal(secret.Length);
    Marshal.Copy(secret, 0, p, secret.Length);
    c.CredentialBlob = p;
    try {
      return CredWrite(ref c, 0);
    } finally {
      Marshal.FreeHGlobal(p);
    }
  }

  public static byte[] Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
    byte[] b = new byte[c.CredentialBlobSize];
    Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize);
    CredFree(p);
    return b;
  }

  public static bool Delete(string target) {
    return CredDelete(target, 1, 0);
  }
}
'@
Add-Type -TypeDefinition $sig -ErrorAction Stop

if ($action -eq "write") {
  $bytes = [System.Convert]::FromBase64String($payload)
  $ok = [WinCred]::Write($target, $user, $bytes)
  [Console]::Out.Write($ok)
} elseif ($action -eq "read") {
  $bytes = [WinCred]::Read($target)
  if ($bytes -ne $null) {
    [Console]::Out.Write([System.Convert]::ToBase64String($bytes))
  }
} elseif ($action -eq "delete") {
  $ok = [WinCred]::Delete($target)
  [Console]::Out.Write($ok)
}
`

/** Execute an action against Windows Credential Manager (fast cached .exe with PowerShell fallback). */
function runWinCred(target: string, user: string, action: 'read' | 'write' | 'delete', payload = ''): string {
  const timeout = action === 'write' ? 30_000 : 8000
  const helper = ensureWinCredHelper()
  if (helper) {
    try {
      const args = action === 'write' ? [action, target, user] : [action, target]
      return execFileSync(helper, args, {
        encoding: 'utf8',
        timeout,
        windowsHide: true,
        input: action === 'write' ? payload : undefined,
        stdio: [action === 'write' ? 'pipe' : 'ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      // Disable helper on unexpected failure and transparently fall back to PowerShell
      helperDisabled = true
    }
  }
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& { ${WIN_CRED_SCRIPT} }`, target, user, action, payload],
    // A cold start compiles the C# P/Invoke shim via Add-Type: ~1-2s idle, and
    // many seconds while agy runs and builds compete for CPU.
    { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim()
}

function execFileUtf8(
  file: string,
  args: readonly string[],
  timeout: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: 'utf8', timeout, windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve((stdout ?? '').trim())
    })
  })
}

async function runWinCredReadAsync(target: string): Promise<string> {
  const helper = ensureWinCredHelper()
  if (helper) {
    try {
      return await execFileUtf8(helper, ['read', target], 8000)
    } catch {
      helperDisabled = true
    }
  }
  return execFileUtf8(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& { ${WIN_CRED_SCRIPT} }`, target, 'antigravity', 'read', ''],
    8000,
  )
}

let cachedWinCredRaw: { target: string; val: string | null; time: number } | null = null

export function invalidateWindowsCredentialCache(): void {
  cachedWinCredRaw = null
}

/** Read raw UTF-8 credential blob from Windows Credential Manager (with short-lived in-memory caching). */
export function readWindowsCredentialRaw(target = 'gemini:antigravity', maxAgeMs = 2500): string | null {
  if (!IS_WIN) return null
  const now = Date.now()
  if (cachedWinCredRaw && cachedWinCredRaw.target === target && (now - cachedWinCredRaw.time) < maxAgeMs) {
    return cachedWinCredRaw.val
  }
  try {
    const out = runWinCred(target, 'antigravity', 'read')
    const val = out ? Buffer.from(out, 'base64').toString('utf8') : null
    cachedWinCredRaw = { target, val, time: now }
    return val
  } catch {
    return null
  }
}

/** Async non-blocking variant of `readWindowsCredentialRaw` for polling paths. */
export async function readWindowsCredentialRawAsync(target = 'gemini:antigravity', maxAgeMs = 2500): Promise<string | null> {
  if (!IS_WIN) return null
  const now = Date.now()
  if (cachedWinCredRaw && cachedWinCredRaw.target === target && (now - cachedWinCredRaw.time) < maxAgeMs) {
    return cachedWinCredRaw.val
  }
  try {
    const out = await runWinCredReadAsync(target)
    const val = out ? Buffer.from(out, 'base64').toString('utf8') : null
    cachedWinCredRaw = { target, val, time: Date.now() }
    return val
  } catch {
    return null
  }
}

/** Write UTF-8 credential blob into Windows Credential Manager. */
export function writeWindowsCredentialRaw(
  secret: string,
  target = 'gemini:antigravity',
  userName = 'antigravity',
): boolean {
  if (!IS_WIN) return false
  try {
    const b64 = Buffer.from(secret, 'utf8').toString('base64')
    const out = runWinCred(target, userName, 'write', b64)
    const ok = out.toLowerCase() === 'true'
    if (ok) {
      cachedWinCredRaw = { target, val: secret, time: Date.now() }
    }
    return ok
  } catch {
    return false
  }
}

/** Delete a credential from Windows Credential Manager. */
export function deleteWindowsCredentialRaw(target = 'gemini:antigravity'): boolean {
  if (!IS_WIN) return false
  try {
    const out = runWinCred(target, 'antigravity', 'delete')
    const ok = out.toLowerCase() === 'true'
    if (ok) {
      cachedWinCredRaw = { target, val: null, time: Date.now() }
    }
    return ok
  } catch {
    return false
  }
}

// ---- System Proxy Detection -----------------------------------------------

/** Parse Windows WinINet ProxyServer string (supports single or multi-protocol format). */
export function parseWindowsProxyServer(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  if (s.includes('=') || s.includes(';')) {
    const parts = s.split(';').map((p) => p.trim()).filter(Boolean)
    const map = new Map<string, string>()
    for (const part of parts) {
      const eq = part.indexOf('=')
      if (eq !== -1) {
        map.set(part.slice(0, eq).toLowerCase(), part.slice(eq + 1).trim())
      }
    }
    const target = map.get('https') || map.get('http') || map.get('socks') || parts[0] || ''
    if (!target) return ''
    return /^https?:\/\//i.test(target) ? target : `http://${target}`
  }
  return /^https?:\/\//i.test(s) ? s : `http://${s}`
}

/**
 * Parse macOS `scutil --proxy` dictionary output.
 * Keys of interest:
 *   HTTPEnable : 1
 *   HTTPPort : 7890
 *   HTTPProxy : 127.0.0.1
 *   HTTPSEnable : 1
 *   HTTPSPort : 7890
 *   HTTPSProxy : 127.0.0.1
 *   SOCKSEnable : 1
 *   SOCKSPort : 7890
 *   SOCKSProxy : 127.0.0.1
 */
export function parseMacScutilProxy(raw: string): string | undefined {
  if (!raw.trim()) return undefined
  const lines = raw.split('\n')
  const dict: Record<string, string> = {}
  for (const line of lines) {
    const m = /^\s*([A-Za-z0-9_]+)\s*:\s*(.+)$/.exec(line)
    if (m && m[1] && m[2]) {
      dict[m[1]] = m[2].trim()
    }
  }
  // HTTPS takes priority, then HTTP, then SOCKS
  if (dict.HTTPSEnable === '1' && dict.HTTPSProxy && dict.HTTPSPort) {
    return `http://${dict.HTTPSProxy}:${dict.HTTPSPort}`
  }
  if (dict.HTTPEnable === '1' && dict.HTTPProxy && dict.HTTPPort) {
    return `http://${dict.HTTPProxy}:${dict.HTTPPort}`
  }
  if (dict.SOCKSEnable === '1' && dict.SOCKSProxy && dict.SOCKSPort) {
    return `socks5://${dict.SOCKSProxy}:${dict.SOCKSPort}`
  }
  return undefined
}

let cachedProxy: { value: string | undefined; expiresAt: number } | null = null

/** Invalidate cached proxy detection (useful in tests). */
export function invalidateProxyCache(): void {
  cachedProxy = null
}

/**
 * Detect system proxy configuration across Windows, macOS, and Linux.
 * Priority:
 * 1. Standard environment variables (HTTPS_PROXY, HTTP_PROXY, ALL_PROXY, and lowercase)
 * 2. Windows Registry (HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings)
 * 3. macOS scutil (--proxy)
 * 4. Linux desktop system proxy (GNOME gsettings)
 * Results are cached for 5 minutes (300s) to minimize subprocess and registry queries.
 */
export function detectSystemProxy(platform: NodeJS.Platform = process.platform): string | undefined {
  const now = Date.now()
  if (cachedProxy && cachedProxy.expiresAt > now) {
    return cachedProxy.value
  }

  // 1. Standard environment variables across all platforms
  const envProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy
  if (envProxy?.trim()) {
    const val = envProxy.trim()
    cachedProxy = { value: val, expiresAt: now + 300_000 }
    return val
  }

  // 2. Windows registry
  if (platform === 'win32') {
    try {
      const out = execFileSync(
        'reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      )
      const enableMatch = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(out)
      const enableHex = enableMatch?.[1]
      if (enableHex && parseInt(enableHex, 16) === 1) {
        const serverMatch = /ProxyServer\s+REG_SZ\s+(.+)/.exec(out)
        const serverRaw = serverMatch?.[1]?.trim()
        if (serverRaw) {
          const val = parseWindowsProxyServer(serverRaw)
          if (val) {
            cachedProxy = { value: val, expiresAt: now + 300_000 }
            return val
          }
        }
      }
    } catch {
      // Best-effort
    }
  }

  // 3. macOS system proxy (scutil --proxy)
  if (platform === 'darwin') {
    try {
      const out = execFileSync('scutil', ['--proxy'], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const val = parseMacScutilProxy(out)
      if (val) {
        cachedProxy = { value: val, expiresAt: now + 300_000 }
        return val
      }
    } catch {
      // Best-effort
    }
  }

  // 4. Linux desktop system proxy (GNOME gsettings)
  if (platform === 'linux') {
    try {
      const mode = execFileSync('gsettings', ['get', 'org.gnome.system.proxy', 'mode'], {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().replace(/^'|'$/g, '')
      if (mode === 'manual') {
        const host = execFileSync('gsettings', ['get', 'org.gnome.system.proxy.https', 'host'], {
          encoding: 'utf8',
          timeout: 1000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim().replace(/^'|'$/g, '')
        const port = execFileSync('gsettings', ['get', 'org.gnome.system.proxy.https', 'port'], {
          encoding: 'utf8',
          timeout: 1000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim()
        if (host && port && port !== '0') {
          const val = `http://${host}:${port}`
          cachedProxy = { value: val, expiresAt: now + 300_000 }
          return val
        }
      }
    } catch {
      // Best-effort
    }
  }

  cachedProxy = { value: undefined, expiresAt: now + 300_000 }
  return undefined
}
