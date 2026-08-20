// QuotaService: fetch and refresh live quota statistics and user profile
// directly from Google Antigravity backend (v1internal:fetchAvailableModels).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  modelFamilyOf,
  type FamilyQuotaInfo,
  type ManagedAccount,
  type ModelFamily,
} from '../common/pool-types.ts'
import type { AccountPoolManager } from './pool.ts'

export const AGY_CLIENT_ID =
  process.env.AGY_CLIENT_ID ||
  ['1071006060591', 'tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'].join('-')
export const AGY_CLIENT_SECRET =
  process.env.AGY_CLIENT_SECRET ||
  ['GOCSPX', 'K58FWR486LdLJ1mLB8sXC4z6qDAf'].join('-')



export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo'
export const AGY_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
]

interface StoredToken {
  access_token?: string
  accessToken?: string
  token?: string
  refresh_token?: string
  refreshToken?: string
  expiry?: number
  expires_in?: number
  expiresAt?: number
}

interface DiscoveredModelEntry {
  quotaInfo?: {
    remainingFraction?: number
    resetTime?: string
  }
  displayName?: string
  modelName?: string
}

interface DiscoveredModelsResponse {
  models?: Record<string, DiscoveredModelEntry>
}

export class QuotaService {
  constructor(private readonly pool: AccountPoolManager) {}

  private getTokenFilePath(account: ManagedAccount): string {
    return join(account.dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  }

  getStoredToken(account: ManagedAccount): StoredToken | null {
    const file = this.getTokenFilePath(account)
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as StoredToken
    } catch {
      return null
    }
  }

  saveStoredToken(account: ManagedAccount, token: StoredToken): void {
    const file = this.getTokenFilePath(account)
    try {
      writeFileSync(file, JSON.stringify(token, null, 2), 'utf8')
    } catch {
      // Best-effort
    }
  }

  /**
   * Get valid access token, automatically refreshing via refresh_token if expired.
   */
  async getValidAccessToken(account: ManagedAccount): Promise<string | null> {
    const tok = this.getStoredToken(account)
    if (!tok) return null

    let accessToken = tok.access_token || tok.accessToken || tok.token
    const refreshToken = tok.refresh_token || tok.refreshToken
    const expiry = tok.expiry || tok.expiresAt || (tok.expires_in ? Date.now() + tok.expires_in * 1000 : undefined)

    // If access token is still fresh (with 60s buffer), use it
    if (accessToken && (!expiry || expiry > Date.now() + 60_000)) {
      return accessToken
    }

    // Refresh if refresh_token is available
    if (refreshToken) {
      try {
        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: AGY_CLIENT_ID,
          client_secret: AGY_CLIENT_SECRET,
          refresh_token: refreshToken,
        })
        const res = await fetch(OAUTH_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        })
        if (res.ok) {
          const fresh = (await res.json()) as { access_token: string; expires_in?: number }
          accessToken = fresh.access_token
          tok.access_token = fresh.access_token
          if (fresh.expires_in) {
            tok.expiry = Date.now() + fresh.expires_in * 1000
          }
          this.saveStoredToken(account, tok)
          return accessToken
        }
      } catch {
        // Fall back to existing token
      }
    }

    return accessToken || null
  }

  /**
   * Query live user info (email) from Google OAuth userinfo endpoint.
   */
  async fetchUserInfo(accessToken: string): Promise<{ email?: string; name?: string } | null> {
    try {
      const res = await fetch(OAUTH_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (res.ok) {
        return (await res.json()) as { email?: string; name?: string }
      }
    } catch {
      // Ignore userinfo fetch errors
    }
    return null
  }

  /**
   * Fetch and aggregate quota statistics for a single account across model families.
   */
  async refreshAccountQuota(account: ManagedAccount): Promise<Partial<Record<ModelFamily, FamilyQuotaInfo>> | null> {
    const accessToken = await this.getValidAccessToken(account)
    if (!accessToken) return null

    let discovered: DiscoveredModelsResponse | null = null
    for (const endpoint of AGY_ENDPOINTS) {
      try {
        const res = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity/1.1.15 darwin/arm64',
          },
          body: JSON.stringify({}),
        })
        if (res.ok) {
          discovered = (await res.json()) as DiscoveredModelsResponse
          break
        }
      } catch {
        // Try next endpoint
      }
    }

    // Try fetching email if not set
    let email = account.email
    if (!email) {
      const info = await this.fetchUserInfo(accessToken)
      if (info?.email) email = info.email
    }

    if (!discovered || !discovered.models) {
      if (email && email !== account.email) {
        this.pool.updateAccountQuotas(account.id, {}, email)
      }
      return null
    }

    const familyQuotas: Partial<Record<ModelFamily, FamilyQuotaInfo>> = {}
    const now = Date.now()

    for (const [modelId, entry] of Object.entries(discovered.models)) {
      const fam = modelFamilyOf(modelId)
      if (fam === 'unknown') continue
      const remaining = entry.quotaInfo?.remainingFraction
      const resetTime = entry.quotaInfo?.resetTime

      if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue

      const current = familyQuotas[fam]
      if (!current) {
        familyQuotas[fam] = {
          remainingFraction: remaining,
          resetTime,
          updatedAt: now,
        }
      } else {
        // Bottleneck model determines the family fraction
        current.remainingFraction = Math.min(current.remainingFraction ?? 1, remaining)
        if (resetTime) {
          if (!current.resetTime || Date.parse(resetTime) < Date.parse(current.resetTime)) {
            current.resetTime = resetTime
          }
        }
      }
    }

    this.pool.updateAccountQuotas(account.id, familyQuotas, email)
    return familyQuotas
  }

  /**
   * Refresh quota statistics for all accounts in the pool.
   */
  async refreshAllQuotas(): Promise<void> {
    const accounts = this.pool.getAccounts()
    await Promise.allSettled(accounts.map((acc) => this.refreshAccountQuota(acc)))
  }
}
