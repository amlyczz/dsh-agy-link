// One-shot quota endpoint diagnosis: calls the same two endpoints the
// plugin's QuotaService uses, with the primary account's stored token, and
// dumps raw shapes so we can see which one broke and what it returns now.
import { homedir } from 'node:os'
import { AccountPoolManager } from '../src/host/pool.ts'
import { QuotaService } from '../src/host/quota.ts'

const pool = new AccountPoolManager()
const quota = new QuotaService(pool)
const acc = pool.getAccounts().find((a) => a.systemHome) ?? pool.getAccounts()[0]!
console.log('account:', acc.id, acc.email, 'systemHome:', !!acc.systemHome)

const tok = await quota.getValidAccessToken(acc)
console.log('accessToken:', tok ? tok.slice(0, 18) + '…(' + tok.length + ' chars)' : 'NULL')
if (!tok) process.exit(1)

const summary = await (quota as unknown as { fetchQuotaSummary: (t: string, p?: string) => Promise<unknown> }).fetchQuotaSummary(tok, acc.proxyUrl)
console.log('\n=== retrieveUserQuotaSummary ===')
console.log(JSON.stringify(summary, null, 2)?.slice(0, 2200))

const models = await (quota as unknown as { fetchAvailableModels: (t: string, p?: string) => Promise<unknown> }).fetchAvailableModels(tok, acc.proxyUrl)
console.log('\n=== fetchAvailableModels (quotaInfo only) ===')
const m = models as { models?: Record<string, { quotaInfo?: unknown }> } | null
if (m?.models) {
  for (const [id, entry] of Object.entries(m.models).slice(0, 5)) {
    console.log(id, '→', JSON.stringify(entry.quotaInfo))
  }
} else {
  console.log('NULL or no models:', JSON.stringify(models)?.slice(0, 300))
}
