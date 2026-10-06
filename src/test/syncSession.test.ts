import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { mutationToParams, type CloudAdapter } from '../cloud/CloudAdapter'
import type { CloudRecord } from '../domain/record'
import { CloudflareAdapter } from '../cloud/CloudflareAdapter'
import { SupabaseAdapter } from '../cloud/SupabaseAdapter'
import { saveCloudConfig } from '../cloud/cloudConfig'
import { saveCloudflareSession } from '../cloud/cloudflareSession'
import { db } from '../db/db'
import { createRecord } from '../db/recordRepository'
import { SyncEngine } from '../sync/SyncEngine'
import { pushPending, resetStaleSending } from '../sync/PushService'
import { reconcileOne } from '../sync/ReconcileService'
import { syncStatusStore } from '../sync/syncStatus'
import { cleanupDevices, FakeCloudServer, openDevice } from './fakeCloudServer'

const fixture = vi.hoisted(() => ({ client: null as SupabaseClient | null }))
vi.mock('../cloud/supabaseClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../cloud/supabaseClient')>(),
  getSupabaseClient: () => fixture.client,
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 })
}

function configureAccount(userId: string): void {
  saveCloudConfig({ provider: 'cloudflare', url: 'https://worker.invalid' })
  saveCloudflareSession({ token: `token-${userId}`, userId, email: null })
}

let engine: SyncEngine
beforeEach(async () => {
  localStorage.clear()
  fixture.client = null
  engine = new SyncEngine()
  await openDevice(`sync-session-${crypto.randomUUID()}`)
})
afterEach(async () => {
  engine.stop()
  await engine.waitIdle(100)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  await cleanupDevices()
})

describe('Cloudflare 在途同步的会话隔离', () => {
  it('A 的首轮 Pull 晚返回后，不把 A 草稿用 B 凭据发送或改归属', async () => {
    configureAccount('A')
    const record = await createRecord({ userId: 'A', type: 'idea', content: 'A 的私密草稿' })
    const oldPull = deferred<Response>()
    const started = deferred<void>()
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
      const owner = new Headers(init.headers).get('authorization')
      if (input.endsWith('/pull') && owner === 'Bearer token-A') {
        started.resolve(undefined)
        return oldPull.promise
      }
      if (input.endsWith('/mutate')) requests.push(owner ?? '')
      return json({ records: [] })
    }))
    const adapter = new CloudflareAdapter()
    engine.configure({ adapter, userId: 'A', mode: 'cloud' })
    const old = engine.sync('manual')
    await started.promise
    engine.stop()
    configureAccount('B')
    engine.configure({ adapter, userId: 'B', mode: 'cloud' })
    await engine.sync('manual')
    oldPull.resolve(json({ records: [] }))
    await old
    expect(requests).toEqual([])
    expect((await db.records.get(record.id))?.userId).toBe('A')
    expect(await db.outbox.where('userId').equals('A').count()).toBe(1)
  })

  it('A 的 Mutate 已执行但响应晚到，切到 B 后不出队，回 A 原 ID 幂等确认', async () => {
    configureAccount('A')
    const record = await createRecord({ userId: 'A', type: 'idea', content: '只能保存到 A' })
    const original = (await db.outbox.toArray())[0]
    if (!original) throw new Error('expected_mutation')
    const server = new FakeCloudServer()
    const late = deferred<Response>()
    const started = deferred<void>()
    let delay = true
    const ownerLog: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
      const owner = new Headers(init.headers).get('authorization') === 'Bearer token-A' ? 'A' : 'B'
      if (input.endsWith('/pull')) return json({ records: await server.pullAll(owner) })
      ownerLog.push(owner)
      const result = await server.applyMutation(owner, JSON.parse(String(init.body)))
      if (delay) { delay = false; started.resolve(undefined); return late.promise }
      return json(result)
    }))
    const adapter = new CloudflareAdapter()
    engine.configure({ adapter, userId: 'A', mode: 'cloud' })
    const old = engine.sync('manual')
    await started.promise
    engine.stop()
    configureAccount('B')
    engine.configure({ adapter, userId: 'B', mode: 'cloud' })
    await engine.sync('manual')
    late.resolve(json({ status: 'applied', version: 1, record: await server.pullOne('A', record.id) }))
    await old
    expect((await db.outbox.get(original.mutationId))?.state).toBe('sending')
    expect((await db.records.get(record.id))?.serverVersion).toBeNull()
    expect(syncStatusStore.getSnapshot().phase).toBe('synced')
    configureAccount('A')
    await resetStaleSending('A')
    await pushPending(adapter, 'A')
    expect(await db.outbox.get(original.mutationId)).toBeUndefined()
    expect(server.rows.get(record.id)?.version).toBe(1)
    expect(new Set(server.received)).toEqual(new Set([original.mutationId]))
    expect(ownerLog).toEqual(['A', 'A'])
  })

  it('旧 finally 不能清理正在等待的 B 同步或将 B 状态改成 synced', async () => {
    configureAccount('A')
    const a = deferred<Response>()
    const b = deferred<Response>()
    const aStarted = deferred<void>()
    const bStarted = deferred<void>()
    let bPulls = 0
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init: RequestInit) => {
      if (new Headers(init.headers).get('authorization') === 'Bearer token-A') {
        aStarted.resolve(undefined)
        return a.promise
      }
      bPulls += 1
      if (bPulls === 1) { bStarted.resolve(undefined); return b.promise }
      return json({ records: [] })
    }))
    const adapter = new CloudflareAdapter()
    engine.configure({ adapter, userId: 'A', mode: 'cloud' })
    const old = engine.sync('manual')
    await aStarted.promise
    engine.stop()
    configureAccount('B')
    engine.configure({ adapter, userId: 'B', mode: 'cloud' })
    const fresh = engine.sync('manual')
    await bStarted.promise
    a.resolve(json({ records: [] }))
    await old
    expect(syncStatusStore.getSnapshot().phase).toBe('syncing')
    await engine.sync('manual')
    expect(bPulls).toBe(1)
    b.resolve(json({ records: [] }))
    await fresh
    await engine.waitIdle()
    expect(bPulls).toBe(4)
  })

  it('未绑定适配器拒绝拿 B 令牌发送 A 的参数', async () => {
    configureAccount('B')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(new CloudflareAdapter().pullAll('A')).rejects.toThrow('cloud_session_changed')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('跨标签页直接改存储，固定会话也拒绝旧响应', async () => {
    configureAccount('A')
    const gate = deferred<Response>()
    const started = deferred<void>()
    vi.stubGlobal('fetch', vi.fn(async () => { started.resolve(undefined); return gate.promise }))
    const bound = await new CloudflareAdapter().bindSession('A', { checkCurrent: () => undefined, signal: new AbortController().signal })
    const pull = bound.pullAll('A')
    const rejected = expect(pull).rejects.toThrow('cloud_session_changed')
    await started.promise
    localStorage.setItem('inspiration-todo/cf-session', JSON.stringify({ token: 'token-B', userId: 'B', email: null }))
    gate.resolve(json({ records: [] }))
    await rejected
  })
})

it('旧 Realtime 定点 Pull 晚返回不能把 A 的记录落进当前界面数据库', async () => {
  const server = new FakeCloudServer()
  const local = await createRecord({ userId: 'A', type: 'idea', content: '远端 A 记录' })
  const mutation = (await db.outbox.toArray())[0]
  if (!mutation) throw new Error('expected_mutation')
  const result = await server.applyMutation('A', mutationToParams(mutation))
  await db.outbox.clear()
  await db.records.clear()
  const hit = deferred<CloudRecord | null>()
  const started = deferred<void>()
  let notify: ((id: string) => void) | null = null
  const adapter: CloudAdapter = {
    kind: 'delayed', isConfigured: () => true,
    pullAll: async () => [],
    pullOne: async () => { started.resolve(undefined); return hit.promise },
    applyMutation: (userId, params) => server.applyMutation(userId, params),
    subscribe: (_userId, callback) => { notify = callback; return () => undefined },
  }
  engine.configure({ adapter, userId: 'A', mode: 'cloud' })
  const emit = notify as ((id: string) => void) | null
  emit?.(local.id)
  await started.promise
  engine.stop()
  engine.configure({ adapter, userId: 'B', mode: 'cloud' })
  hit.resolve(result.record)
  await engine.waitIdle()
  expect(await db.records.count()).toBe(0)
})

it('对账事务尾会话失效时，新落地记录完整回滚', async () => {
  const server = new FakeCloudServer()
  await createRecord({ userId: 'A', type: 'idea', content: '不能半落地' })
  const mutation = (await db.outbox.toArray())[0]
  if (!mutation) throw new Error('expected_mutation')
  const result = await server.applyMutation('A', mutationToParams(mutation))
  if (!result.record) throw new Error('expected_cloud_record')
  await db.outbox.clear()
  await db.records.clear()
  let checks = 0
  await expect(reconcileOne(result.record, undefined, () => {
    checks += 1
    if (checks > 1) throw new Error('obsolete')
  })).rejects.toThrow('obsolete')
  expect(await db.records.count()).toBe(0)
})

it('Supabase 固定客户端真实发出的 RPC 保留 A 令牌，动态单例换到 B 也不能串号', async () => {
  saveCloudConfig({ provider: 'supabase', url: 'https://x.supabase.co', anonKey: 'key' })
  let current = { access_token: 'token-A', user: { id: 'A' } }
  fixture.client = { auth: { getSession: async () => ({ data: { session: current }, error: null }) } } as unknown as SupabaseClient
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init: RequestInit) => {
    requests.push(new Headers(init.headers).get('authorization') ?? '')
    return json({ status: 'applied', version: 1, record: null })
  }))
  const adapter = new SupabaseAdapter()
  const bound = await adapter.bindSession('A', { checkCurrent: () => undefined, signal: new AbortController().signal })
  current = { access_token: 'token-B', user: { id: 'B' } }
  await bound.applyMutation('A', { mutationId: 'm', recordId: 'r', operation: 'create', expectedVersion: null, payload: { content: 'A 私密' } })
  expect(requests).toEqual(['Bearer token-A'])
  await expect(adapter.applyMutation('A', { mutationId: 'm2', recordId: 'r', operation: 'update', expectedVersion: 1, payload: { content: 'A 后续' } })).rejects.toThrow('cloud_session_changed')
  expect(requests).toHaveLength(1)
})
