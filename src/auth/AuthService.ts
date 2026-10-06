/**
 * 账号服务（方案 §62、§63）。
 *
 * - 已配置云端：首次使用要求登录
 *     · supabase   → 邮箱验证码 / Magic Link
 *     · cloudflare → 粘贴访问令牌
 * - 未配置云端：进入本机模式，用固定的 LOCAL_USER_ID，一切照常可用
 * - 从本机模式首次登录时，把本机记录归入该账号，绝不丢数据（§81）
 *
 * 关键取舍：**离线必须能用**。
 * Cloudflare 那条路把 userId 缓存在本机，启动时立刻可用，
 * 再在后台向服务器确认令牌是否还有效 —— 否则断网就永远拿不到 userId，
 * 「离线正常」这条承诺会直接失效。
 */
import { invalidateCloudSession, SessionChangedError } from '../cloud/sessionScope'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseClient } from '../cloud/supabaseClient'
import {
  readCloudConfig,
  saveCloudConfig,
  type CloudProviderKind,
} from '../cloud/cloudConfig'
import { readCloudflareSession, saveCloudflareSession } from '../cloud/cloudflareSession'
import { cfRequest, CloudRequestError } from '../cloud/cloudflareClient'
import { LOCAL_USER_ID, migrateLocalRecordsToUser } from '../db/recordRepository'

export type AuthMode = 'local' | 'cloud'

export interface AuthUser {
  id: string
  email: string | null
}

export interface AuthState {
  ready: boolean
  /** 验证/退出期间保留表单，但禁止旧身份写入和启动同步。 */
  transitioning: boolean
  mode: AuthMode
  user: AuthUser | null
  cloudConfigured: boolean
  /** 当前配置的后端类型；本机模式为 null */
  provider: CloudProviderKind | null
  /** 登录时自动并入账号的本机记录数 */
  migratedCount: number
}

interface MeResponse {
  userId?: string
  email?: string | null
  error?: string
}

function userFromSession(session: Session | null): AuthUser | null {
  const user = session?.user
  if (!user) return null
  return { id: user.id, email: user.email ?? null }
}

/**
 * 应用所在的完整地址（**含子路径**）。
 *
 * ⚠️ 不能用 `location.origin` —— 线上部署在 GitHub Pages 的子路径 `/yike/` 下，
 * origin 只有 `https://lhc728.github.io`，而应用实际在 `/yike/`。
 * 邮件里的登录链接会落到站点根目录，直接 404。
 * 必须把 Vite 的 `BASE_URL` 拼进去（本地为 `/`，线上为 `/yike/`）。
 */
function appBaseUrl(): string | undefined {
  const origin = globalThis.location?.origin
  if (!origin) return undefined
  try {
    return new URL(import.meta.env?.BASE_URL ?? '/', origin).toString()
  } catch {
    return origin
  }
}

export class AuthService {
  private listeners = new Set<() => void>()
  private snapshot: AuthState = {
    ready: false, transitioning: false, mode: readCloudConfig() ? 'cloud' : 'local', user: null,
    cloudConfigured: readCloudConfig() !== null, provider: readCloudConfig()?.provider ?? null,
    migratedCount: 0,
  }
  private unsubscribeAuth: (() => void) | null = null
  private initialized = false
  private revision = 0
  private lifetime = 0
  private eventSequence = 0
  private intentPending = false
  private pendingSdkWrites = 0
  private sdkWrites: Promise<void> = Promise.resolve()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): AuthState => this.snapshot

  private emit(next: Partial<AuthState>): void {
    const merged = { ...this.snapshot, ...next }
    if (
      merged.ready === this.snapshot.ready && merged.transitioning === this.snapshot.transitioning && merged.mode === this.snapshot.mode &&
      merged.cloudConfigured === this.snapshot.cloudConfigured && merged.provider === this.snapshot.provider &&
      merged.migratedCount === this.snapshot.migratedCount && merged.user?.id === this.snapshot.user?.id &&
      merged.user?.email === this.snapshot.user?.email
    ) return
    if (!merged.transitioning) this.intentPending = false
    this.snapshot = merged
    for (const listener of this.listeners) listener()
  }

  private beginOperation(kind: 'startup' | 'intent' = 'intent'): { checkCurrent: () => void; previous: AuthState } {
    const previous = this.snapshot
    const revision = ++this.revision
    invalidateCloudSession()
    this.intentPending = kind === 'intent'
    // UI 写入守护要马上看到身份正在切换，不能在等待验证时捕获旧账号的新代次。
    this.emit({ transitioning: true })
    return {
      previous,
      checkCurrent: () => {
        if (revision !== this.revision) throw new SessionChangedError()
      },
    }
  }

  private restoreAfterFailure(previous: AuthState, checkCurrent: () => void): void {
    try {
      checkCurrent()
      invalidateCloudSession()
      this.emit({ ...previous, ready: true, transitioning: false })
    } catch {
      // 新登录/退出已经接管状态，旧操作的失败不能把界面拉回去。
    }
  }

  private async restoreSupabaseAfterFailure(client: SupabaseClient, checkCurrent: () => void): Promise<void> {
    try {
      checkCurrent()
      const { data, error } = await client.auth.getSession()
      checkCurrent()
      invalidateCloudSession()
      // 较早的验证码可能已让 SDK 落盘；后一次失败时不能只恢复旧 UI，造成令牌与账号错配。
      this.emit({ ready: true, transitioning: false, mode: 'cloud', cloudConfigured: true, provider: 'supabase', user: error ? null : userFromSession(data.session) })
      await this.adoptLocalRecords(error ? null : data.session?.user.id ?? null, checkCurrent)
    } catch {
      try {
        checkCurrent()
        invalidateCloudSession()
        // 本地会话也读不出来时回到可重试登录，不能让未知身份一直锁住界面。
        this.emit({ ready: true, transitioning: false, mode: 'cloud', cloudConfigured: true, provider: 'supabase', user: null })
      } catch {
        // 新操作已接管身份，晚到的失败恢复只允许结束自身。
      }
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    const { checkCurrent } = this.beginOperation('startup')
    const config = readCloudConfig()
    try {
      if (!config) {
        this.emit({ ready: true, transitioning: false, mode: 'local', cloudConfigured: false, provider: null, user: { id: LOCAL_USER_ID, email: null } })
      } else if (config.provider === 'cloudflare') {
        await this.initCloudflare(config.url.replace(/\/+$/, ''), checkCurrent)
      } else {
        await this.initSupabase(checkCurrent)
      }
    } catch (error) {
      if (!(error instanceof SessionChangedError)) throw error
    }
  }

  private async initCloudflare(url: string, checkCurrent: () => void): Promise<void> {
    const session = readCloudflareSession()
    if (!session) {
      this.emit({ ready: true, transitioning: false, mode: 'cloud', cloudConfigured: true, provider: 'cloudflare', user: null })
      return
    }
    const checkStoredSession = () => {
      checkCurrent()
      const current = readCloudflareSession()
      const config = readCloudConfig()
      if (current?.token !== session.token || current.userId !== session.userId || config?.provider !== 'cloudflare' || config.url.replace(/\/+$/, '') !== url) {
        throw new SessionChangedError()
      }
    }
    this.emit({ ready: true, transitioning: false, mode: 'cloud', cloudConfigured: true, provider: 'cloudflare', user: { id: session.userId, email: session.email } })
    await this.adoptLocalRecords(session.userId, checkStoredSession)
    checkStoredSession()
    try {
      // 缓存离线可用；后台确认必须固定启动时的地址和令牌，旧 401 也只属于旧会话。
      const me = await cfRequest<MeResponse>('/api/me', { client: { url, token: session.token } })
      checkStoredSession()
      if (me.userId && me.userId !== session.userId) {
        saveCloudflareSession(null)
        this.emit({ user: null })
        return
      }
      if (me.userId) {
        saveCloudflareSession({ token: session.token, userId: me.userId, email: me.email ?? null })
        this.emit({ user: { id: me.userId, email: me.email ?? null } })
      }
    } catch (error) {
      checkStoredSession()
      if (error instanceof CloudRequestError && error.status === 401) {
        saveCloudflareSession(null)
        this.emit({ user: null })
      }
    }
  }

  async signInWithCloudflare(url: string, token: string): Promise<void> {
    const trimmedUrl = url.trim().replace(/\/+$/, '')
    const trimmedToken = token.trim()
    if (trimmedUrl === '' || trimmedToken === '') throw new Error('missing_credentials')
    const { checkCurrent, previous } = this.beginOperation()
    try {
      const me = await cfRequest<MeResponse>('/api/me', { client: { url: trimmedUrl, token: trimmedToken } })
      checkCurrent()
      if (!me.userId) throw new Error(me.error ?? 'invalid_token')
      saveCloudConfig({ provider: 'cloudflare', url: trimmedUrl })
      saveCloudflareSession({ token: trimmedToken, userId: me.userId, email: me.email ?? null })
      // 先发布新身份，使旧 local-device handler 失效；迁移事务随后只允许当前操作提交。
      this.emit({ ready: true, transitioning: false, mode: 'cloud', cloudConfigured: true, provider: 'cloudflare', user: { id: me.userId, email: me.email ?? null } })
      await this.adoptLocalRecords(me.userId, checkCurrent)
      checkCurrent()
    } catch (error) {
      this.restoreAfterFailure(previous, checkCurrent)
      if (!(error instanceof SessionChangedError)) throw error
    }
  }

  private async initSupabase(checkCurrent: () => void): Promise<void> {
    const client = getSupabaseClient()
    if (!client) {
      this.emit({ ready: true, transitioning: false, mode: 'local', cloudConfigured: false, provider: null, user: { id: LOCAL_USER_ID, email: null } })
      return
    }
    const lifetime = this.lifetime
    const { data: subscription } = client.auth.onAuthStateChange((_event, session) => {
      // SDK 的 verifyOtp/signOut 本身会落盘；串行操作结束后由调用方统一发布，避免回调抢先恢复旧身份。
      if (lifetime !== this.lifetime || this.pendingSdkWrites > 0 || this.intentPending || readCloudConfig()?.provider !== 'supabase') return
      const sequence = ++this.eventSequence
      const revision = ++this.revision
      const nextUser = userFromSession(session)
      if (nextUser?.id !== this.snapshot.user?.id) invalidateCloudSession()
      const checkEvent = () => {
        if (lifetime !== this.lifetime || revision !== this.revision || sequence !== this.eventSequence) throw new SessionChangedError()
      }
      this.emit({ ready: true, transitioning: false, mode: 'cloud', cloudConfigured: true, provider: 'supabase', user: nextUser })
      void this.adoptLocalRecords(nextUser?.id ?? null, checkEvent).catch(() => undefined)
    })
    this.unsubscribeAuth = () => subscription.subscription.unsubscribe()
    const eventSequence = this.eventSequence
    const { data, error } = await client.auth.getSession()
    checkCurrent()
    if (eventSequence !== this.eventSequence) return
    if (error) {
      this.emit({ ready: true, transitioning: false, mode: 'cloud', cloudConfigured: true, provider: 'supabase', user: null })
      return
    }
    const session = data.session ?? null
    this.emit({ ready: true, transitioning: false, mode: 'cloud', cloudConfigured: true, provider: 'supabase', user: userFromSession(session) })
    await this.adoptLocalRecords(session?.user.id ?? null, checkCurrent)
  }

  private async adoptLocalRecords(userId: string | null, checkCurrent: () => void): Promise<void> {
    checkCurrent()
    if (!userId) return
    try {
      const count = await migrateLocalRecordsToUser(userId, checkCurrent)
      checkCurrent()
      if (count > 0) this.emit({ migratedCount: count })
    } catch (error) {
      checkCurrent()
      if (error instanceof SessionChangedError) throw error
      // 普通迁移失败不阻塞登录；原事务回滚，本机记录和 outbox 仍完整保留。
    }
  }

  private async serializeSdk<T>(work: () => Promise<T>): Promise<T> {
    this.pendingSdkWrites += 1
    const next = this.sdkWrites.catch(() => undefined).then(work)
    this.sdkWrites = next.then(() => undefined, () => undefined)
    try {
      return await next
    } finally {
      this.pendingSdkWrites -= 1
    }
  }

  clearMigratedCount(): void {
    this.emit({ migratedCount: 0 })
  }

  async sendEmailCode(email: string): Promise<void> {
    const client = getSupabaseClient()
    if (!client) throw new Error('cloud_not_configured')
    const redirectTo = appBaseUrl()
    const { error } = await client.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true, ...(redirectTo === undefined ? {} : { emailRedirectTo: redirectTo }) } })
    if (error) throw new Error(error.message)
  }

  async verifyEmailCode(email: string, token: string): Promise<void> {
    const client = getSupabaseClient()
    if (!client) throw new Error('cloud_not_configured')
    const { checkCurrent } = this.beginOperation()
    try {
      const { data, error } = await this.serializeSdk(async () => {
        checkCurrent()
        return client.auth.verifyOtp({ email: email.trim(), token: token.trim(), type: 'email' })
      })
      checkCurrent()
      if (error) throw new Error(error.message)
      this.emit({ ready: true, transitioning: false, mode: 'cloud', cloudConfigured: true, provider: 'supabase', user: userFromSession(data.session) })
      await this.adoptLocalRecords(data.user?.id ?? null, checkCurrent)
    } catch (error) {
      await this.restoreSupabaseAfterFailure(client, checkCurrent)
      if (!(error instanceof SessionChangedError)) throw error
    }
  }

  async signOut(): Promise<void> {
    const provider = this.snapshot.provider
    const client = getSupabaseClient()
    const { checkCurrent, previous } = this.beginOperation()
    try {
      if (provider === 'cloudflare') {
        saveCloudflareSession(null)
        this.emit({ ready: true, transitioning: false, user: null })
        return
      }
      this.emit({ user: null })
      if (client) {
        const { error } = await this.serializeSdk(async () => {
          checkCurrent()
          return client.auth.signOut()
        })
        checkCurrent()
        if (error) throw new Error(error.message)
      }
      checkCurrent()
      this.emit({ ready: true, transitioning: false, user: null })
    } catch (error) {
      if (client) await this.restoreSupabaseAfterFailure(client, checkCurrent)
      else this.restoreAfterFailure(previous, checkCurrent)
      if (!(error instanceof SessionChangedError)) throw error
    }
  }

  dispose(): void {
    this.lifetime += 1
    this.revision += 1
    this.eventSequence += 1
    invalidateCloudSession()
    this.unsubscribeAuth?.()
    this.unsubscribeAuth = null
    this.initialized = false
  }
}

export const authService = new AuthService()

/** 当前生效的 userId（登录用户或本机账号） */
export function currentUserId(state: AuthState): string | null {
  if (state.mode === 'local') return LOCAL_USER_ID
  return state.user?.id ?? null
}
