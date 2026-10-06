/** 同步顺序固定为 Pull → Reconcile → Push → Pull，旧会话只能结束自己的任务。 */
import type { CloudAdapter } from '../cloud/CloudAdapter'
import { createCloudAdapter } from '../cloud/cloudProvider'
import { cloudSessionRevision, SessionChangedError, type SessionScope } from '../cloud/sessionScope'
import type { AuthMode } from '../auth/AuthService'
import { pullAll, pullOne } from './PullService'
import { reconcileMany, reconcileOne } from './ReconcileService'
import { pushPending, resetStaleSending } from './PushService'
import { RealtimeService } from './RealtimeService'
import { NetworkWatcher, isOnline, type SyncTriggerReason } from './NetworkWatcher'
import { FRIENDLY_SYNC_ERROR, syncStatusStore } from './syncStatus'
import { nowIso } from '../utils/time'

const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000]

interface EngineConfig {
  adapter: CloudAdapter
  userId: string | null
  mode: AuthMode
}

interface RunContext extends SessionScope {
  userId: string
  source: CloudAdapter
  controller: AbortController
}

export class SyncEngine {
  private adapter: CloudAdapter = createCloudAdapter()
  private userId: string | null = null
  private mode: AuthMode = 'local'
  private generation = 0
  private activeRun: RunContext | null = null
  private pendingSync = new Set<Promise<void>>()
  private pendingRealtime = new Set<Promise<void>>()
  private controllers = new Set<AbortController>()
  private rerunRequested = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private backoffIndex = 0
  private lastFullSyncAt = 0
  private started = false
  private realtime = new RealtimeService()
  private network = new NetworkWatcher()
  onAfterSync: (() => void) | null = null

  private isCurrent(context: RunContext): boolean {
    try {
      context.checkCurrent()
      return true
    } catch {
      return false
    }
  }

  private context(): RunContext | null {
    const userId = this.userId
    if (!userId || !this.adapter.isConfigured()) return null
    const source = this.adapter
    const generation = this.generation
    const authRevision = cloudSessionRevision()
    const controller = new AbortController()
    this.controllers.add(controller)
    return {
      userId, source, controller, signal: controller.signal,
      checkCurrent: () => {
        if (controller.signal.aborted || generation !== this.generation || authRevision !== cloudSessionRevision()) {
          throw new SessionChangedError()
        }
      },
    }
  }

  private invalidate(): void {
    this.generation += 1
    for (const controller of this.controllers) controller.abort()
    this.activeRun = null
    this.rerunRequested = false
    this.backoffIndex = 0
    this.clearRetry()
    this.realtime.stop()
  }

  configure(config: Partial<EngineConfig>): void {
    this.invalidate()
    if (config.adapter) this.adapter = config.adapter
    if ('userId' in config) this.userId = config.userId ?? null
    if (config.mode) this.mode = config.mode
    this.refreshRealtime()
    this.refreshIdlePhase()
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.network.start((reason) => {
      if (reason === 'offline') {
        syncStatusStore.set({ phase: 'offline', online: false, message: null })
        return
      }
      syncStatusStore.set({ online: true })
      void this.sync(reason)
    })
    void this.sync('startup')
  }

  stop(): void {
    this.started = false
    this.invalidate()
    this.network.stop()
    // 保留真实任务集合，waitIdle 不能把尚未返回的网络请求谎报为空闲。
  }

  private refreshIdlePhase(): void {
    if (!this.adapter.isConfigured()) {
      syncStatusStore.set({ phase: 'local', message: null })
    } else if (this.mode === 'cloud' && !this.userId) {
      syncStatusStore.set({ phase: 'signed-out', message: null })
    } else if (!this.activeRun) {
      syncStatusStore.set({ phase: 'idle', message: null })
    }
  }

  private refreshRealtime(): void {
    if (!this.adapter.isConfigured() || !this.userId) return
    const generation = this.generation
    const revision = cloudSessionRevision()
    this.realtime.start(this.adapter, this.userId, (recordId) => {
      if (generation !== this.generation || revision !== cloudSessionRevision()) return
      const context = this.context()
      if (!context) return
      const task = this.runRealtimeHit(context, recordId).finally(() => {
        this.pendingRealtime.delete(task)
        this.controllers.delete(context.controller)
      })
      this.pendingRealtime.add(task)
    })
  }

  private async bound(context: RunContext): Promise<CloudAdapter> {
    context.checkCurrent()
    const adapter = context.source.bindSession
      ? await context.source.bindSession(context.userId, context)
      : context.source
    context.checkCurrent()
    return adapter
  }

  private async runRealtimeHit(context: RunContext, recordId: string): Promise<void> {
    try {
      const adapter = await this.bound(context)
      const cloud = await pullOne(adapter, context.userId, recordId)
      context.checkCurrent()
      if (cloud) await reconcileOne(cloud, undefined, context.checkCurrent)
      context.checkCurrent()
      void this.sync('realtime')
    } catch {
      // Realtime 只是加速器，完整 Pull 会补齐；旧会话不再操作本地库。
    }
  }

  async waitIdle(timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.pendingSync.size === 0 && this.pendingRealtime.size === 0 && !this.rerunRequested) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  async sync(_reason: SyncTriggerReason): Promise<void> {
    if (!this.adapter.isConfigured()) {
      syncStatusStore.set({ phase: 'local', message: null })
      return
    }
    if (!this.userId) {
      syncStatusStore.set({ phase: 'signed-out', message: null })
      return
    }
    if (this.activeRun && this.isCurrent(this.activeRun)) {
      this.rerunRequested = true
      return
    }
    const context = this.context()
    if (!context) return
    this.activeRun = context
    syncStatusStore.set({ phase: 'syncing', message: null, online: isOnline() })
    const task = this.execute(context)
    this.pendingSync.add(task)
    try {
      await task
    } finally {
      this.pendingSync.delete(task)
      this.controllers.delete(context.controller)
    }
  }

  private async execute(context: RunContext): Promise<void> {
    try {
      await this.runSync(context)
      context.checkCurrent()
      this.backoffIndex = 0
      this.lastFullSyncAt = Date.now()
      syncStatusStore.set({ phase: 'synced', message: null, lastSyncedAt: nowIso(), online: true, failureCount: 0 })
      this.onAfterSync?.()
    } catch {
      if (!this.isCurrent(context)) return
      const online = isOnline()
      syncStatusStore.set({ phase: online ? 'error' : 'offline', message: online ? FRIENDLY_SYNC_ERROR : null, online, failureCount: this.backoffIndex + 1 })
      this.scheduleRetry()
    } finally {
      // 旧任务的 finally 晚到时，新账号可能已经在同步；不能清它的锁或发起它的重跑。
      if (this.activeRun === context) {
        this.activeRun = null
        const rerun = this.rerunRequested && this.isCurrent(context)
        this.rerunRequested = false
        if (rerun) void this.sync('local-change')
      }
    }
  }

  private async runSync(context: RunContext): Promise<void> {
    const adapter = await this.bound(context)
    const { userId, checkCurrent } = context
    await resetStaleSending(userId, checkCurrent)
    checkCurrent()
    const clouds = await pullAll(adapter, userId)
    checkCurrent()
    await reconcileMany(clouds, checkCurrent)
    let pushError: unknown = null
    try {
      await pushPending(adapter, userId, checkCurrent)
    } catch (error) {
      pushError = error
    }
    checkCurrent()
    const after = await pullAll(adapter, userId)
    checkCurrent()
    await reconcileMany(after, checkCurrent)
    checkCurrent()
    if (pushError) throw pushError
  }

  private scheduleRetry(): void {
    this.clearRetry()
    if (!this.started || this.backoffIndex >= BACKOFF_MS.length) return
    const delay = BACKOFF_MS[Math.min(this.backoffIndex, BACKOFF_MS.length - 1)]
    this.backoffIndex += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.sync('retry')
    }, delay)
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  notifyLocalChange(): void {
    if (this.started) void this.sync('local-change')
  }

  get lastSyncAt(): number {
    return this.lastFullSyncAt
  }
}

export const syncEngine = new SyncEngine()
