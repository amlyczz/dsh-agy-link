import type { BridgeLease } from '../common/protocol.ts'
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

export type StepSchemas = NonNullable<GenerateOptions['tools']>
export interface StepToolSet {
  view(scope?: unknown): ReadonlyMap<string, unknown>
}
interface AssemblyStep {
  agent: { session: { id: string } }
  signal: AbortSignal
  toolSet: StepToolSet
}
export interface BridgeStep extends AssemblyStep {
  schemas: StepSchemas
}

// The host owns the admitted set. Only an active generation may borrow it.
export class BridgeSteps {
  private readonly assemblies = new WeakMap<object, AssemblyStep>()
  private readonly owners = new WeakMap<object, { key: string; token: string }>()
  private readonly leases = new WeakMap<object, AbortController>()
  private readonly active = new Map<string, BridgeStep & { stop: AbortController }>()

  private revoke(token: string): void {
    this.active.get(token)?.stop.abort()
    this.active.delete(token)
  }

  capture(context: Partial<AssemblyStep>): void {
    const { agent, signal, toolSet } = context
    if (agent && signal && toolSet) {
      const previous = this.owners.get(agent)
      if (previous && this.assemblies.get(agent)?.toolSet !== toolSet) this.revoke(previous.token)
      this.assemblies.set(agent, { agent, signal, toolSet })
    }
  }

  enter(agent: object | undefined, options: Pick<GenerateOptions, 'tools' | 'signal'> & { sessionId?: string; purpose?: string }) {
    const assembly = agent && this.assemblies.get(agent)
    if (!agent || !assembly || assembly.signal.aborted || !options.signal ||
      options.signal !== assembly.signal || String(options.sessionId) !== String(assembly.agent.session.id) ||
      (options.purpose && options.purpose !== 'chat')) return
    this.leases.get(agent)?.abort()
    const stop = new AbortController()
    this.leases.set(agent, stop)
    const step = { ...assembly, schemas: options.tools ?? [], signal: AbortSignal.any([assembly.signal, stop.signal]), stop }
    let token: string | undefined
    const close = () => {
      stop.abort()
      if (token && this.active.get(token) === step) this.revoke(token)
    }
    const bind = (key: string) => {
      step.signal.throwIfAborted()
      if (this.assemblies.get(agent) !== assembly) throw new Error('The host step has ended')
      let owner = this.owners.get(agent)
      if (!owner || owner.key !== key) {
        if (owner) this.revoke(owner.token)
        owner = { key, token: randomBytes(32).toString('hex') }
        this.owners.set(agent, owner)
      }
      token = owner.token
      if (this.active.get(token) !== step) this.revoke(token)
      this.active.set(token, step)
      return token
    }
    return { bind, close, resume: () => {
      const owner = this.owners.get(agent)
      if (owner) bind(owner.key)
    } }
  }

  resolve(token: string): BridgeStep | undefined {
    const step = this.active.get(token)
    return step && !step.signal.aborted ? step : undefined
  }
}

export function observeBridgeAssemblies(ctx: Context, steps: BridgeSteps, enabled: () => boolean): void {
  // Older SDKs do not declare the 0.2.2 assembly overload.
  const events = ctx as unknown as { on(event: 'system-prompt/assemble',
    fn: (presentation: unknown, context: Partial<AssemblyStep>, next: () => Promise<unknown>) => Promise<unknown>): void }
  events.on('system-prompt/assemble', async (_presentation, context, next) => {
    if (enabled()) steps.capture(context)
    return next()
  })
}

export function enterHostStep(ctx: Context, steps: BridgeSteps, options: Parameters<BridgeSteps['enter']>[1], serverName = '') {
  if (!options.sessionId) return
  const agents = ctx.get('agents') as { get(id: unknown): object | undefined } | undefined
  const lease = steps.enter(agents?.get(options.sessionId), options)
  return lease && { ...lease, serverName }
}

export async function* withBridgeStep<T>(lease: BridgeLease | undefined, run: (lease?: BridgeLease) => AsyncIterable<T>) {
  try {
    yield* run(lease)
  } finally {
    lease?.close()
  }
}
