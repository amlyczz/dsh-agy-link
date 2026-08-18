// Config resolution: env (DSH_AGY_*) > runtime overrides file > cordis
// entry config > defaults (spec ADR-13). The overrides file backs /agy
// hot changes and survives restarts; the env is read per call so a changed
// process environment is honored without reload.
import { defaultConfig, type PermissionMode, type PluginConfig } from './types.ts'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface OverridesFile { [key: string]: unknown }

export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function stateDir(): string {
  return join(dshHome(), 'agy-link')
}

export function overridesPath(): string {
  return join(stateDir(), 'runtime-overrides.json')
}

function readJson(file: string): Record<string, unknown> {
  try {
    if (!existsSync(file)) return {}
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function readOverrides(file = overridesPath()): OverridesFile {
  return readJson(file)
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v === 'true' || v === '1'
  return undefined
}

function asNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

const MODES: readonly PermissionMode[] = ['skip', 'plan', 'accept-edits']

function asMode(v: unknown): PermissionMode | undefined {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v)
    ? (v as PermissionMode)
    : undefined
}

/** Layered config read; cheap enough to call per request (thunk pattern). */
export function resolveConfig(
  entry: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
  overrides: OverridesFile = readOverrides(),
): PluginConfig {
  const base = defaultConfig()
  const e = entry ?? {}
  const layers: Array<Record<string, unknown>> = [e, overrides]
  const get = (k: string): unknown => {
    for (const l of layers) if (l[k] !== undefined && l[k] !== null && l[k] !== '') return l[k]
    return undefined
  }
  const cfg: PluginConfig = {
    ...base,
    enabled: asBool(get('enabled')) ?? base.enabled,
    agyBin: asString(get('agyBin')) ?? base.agyBin,
    extraArgs: Array.isArray(get('extraArgs'))
      ? (get('extraArgs') as unknown[]).filter((x): x is string => typeof x === 'string')
      : base.extraArgs,
    permissionMode: asMode(get('permissionMode')) ?? base.permissionMode,
    defaultModel: asString(get('defaultModel')) ?? base.defaultModel,
    defaultEffort: asString(get('defaultEffort')) ?? base.defaultEffort,
    timeoutMs: asNum(get('timeoutMs')) ?? base.timeoutMs,
    maxConcurrent: asNum(get('maxConcurrent')) ?? base.maxConcurrent,
    contextWindowDefault: asNum(get('contextWindowDefault')) ?? base.contextWindowDefault,
    maxTokensDefault: asNum(get('maxTokensDefault')) ?? base.maxTokensDefault,
    forwardSystemPrompt: asBool(get('forwardSystemPrompt')) ?? base.forwardSystemPrompt,
    digestMaxChars: asNum(get('digestMaxChars')) ?? base.digestMaxChars,
    modelsCacheTtlMs: asNum(get('modelsCacheTtlMs')) ?? base.modelsCacheTtlMs,
    allowAuxiliary: asBool(get('allowAuxiliary')) ?? base.allowAuxiliary,
    compactionMaxChars: asNum(get('compactionMaxChars')) ?? base.compactionMaxChars,
    workspaceRoot: asString(get('workspaceRoot')) ?? base.workspaceRoot,
    fallbackModels: Array.isArray(get('fallbackModels'))
      ? (get('fallbackModels') as unknown[]).filter(
          (x): x is PluginConfig['fallbackModels'][number] =>
            !!x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string',
        )
      : base.fallbackModels,
    askTool: asBool(get('askTool')) ?? base.askTool,
  }
  // Env wins last (spec ADR-13).
  if (env.DSH_AGY_ENABLED !== undefined) cfg.enabled = asBool(env.DSH_AGY_ENABLED) ?? cfg.enabled
  if (env.DSH_AGY_BIN) cfg.agyBin = env.DSH_AGY_BIN
  if (env.DSH_AGY_MODE) {
    const m = asMode(env.DSH_AGY_MODE)
    if (m) cfg.permissionMode = m
  }
  if (env.DSH_AGY_SKIP_PERMISSIONS !== undefined) {
    const skip = asBool(env.DSH_AGY_SKIP_PERMISSIONS)
    if (skip !== undefined) cfg.permissionMode = skip ? 'skip' : 'plan'
  }
  if (env.DSH_AGY_DEFAULT_MODEL) cfg.defaultModel = env.DSH_AGY_DEFAULT_MODEL
  if (env.DSH_AGY_DEFAULT_EFFORT) cfg.defaultEffort = env.DSH_AGY_DEFAULT_EFFORT
  if (env.DSH_AGY_TIMEOUT_MS) {
    const t = asNum(env.DSH_AGY_TIMEOUT_MS)
    if (t && t > 0) cfg.timeoutMs = t
  }
  if (env.DSH_AGY_EXTRA_ARGS) {
    cfg.extraArgs = env.DSH_AGY_EXTRA_ARGS.split(/\s+/).filter(Boolean)
  }
  return cfg
}
