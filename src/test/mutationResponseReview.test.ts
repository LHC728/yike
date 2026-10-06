import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CloudflareAdapter } from '../cloud/CloudflareAdapter'
import { SupabaseAdapter } from '../cloud/SupabaseAdapter'
import { mutationToParams, type ApplyMutationParams } from '../cloud/CloudAdapter'
import { saveCloudConfig } from '../cloud/cloudConfig'
import { saveCloudflareSession } from '../cloud/cloudflareSession'
import { db } from '../db/db'
import { createRecord } from '../db/recordRepository'
import { pushPending } from '../sync/PushService'
import { cleanupDevices, openDevice } from './fakeCloudServer'
import worker from '../../worker/src/index'
import { applyMutation } from '../../worker/src/core'
import { createSqliteD1, seedUser, type SqliteD1 } from './sqliteD1'
import { snapshotOf, snapshotOfCloud, type CloudRecord, type LocalRecord } from '../domain/record'
import { reconcileMany, reconcileOne } from '../sync/ReconcileService'

const fixture = vi.hoisted(() => ({ client: null as SupabaseClient | null }))
vi.mock('../cloud/supabaseClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../cloud/supabaseClient')>(),
  getSupabaseClient: () => fixture.client,
}))
let server: SqliteD1 | null = null

beforeEach(async () => {
  localStorage.clear()
  await openDevice(`review-${crypto.randomUUID()}`)
})
afterEach(async () => {
  server?.close()
  server = null
  fixture.client = null
  vi.unstubAllGlobals()
  localStorage.clear()
  await cleanupDevices()
})

function configure(provider: 'cloudflare' | 'supabase', owner = 'user-a'): CloudflareAdapter | SupabaseAdapter {
  saveCloudConfig(provider === 'cloudflare' ? { provider, url: 'https://review.invalid' } : { provider, url: 'https://review.supabase.co', anonKey: 'key' })
  saveCloudflareSession({ token: 'token-a', userId: owner, email: null })
  fixture.client = { auth: { getSession: async () => ({ data: { session: { access_token: 'token-a', user: { id: owner } } }, error: null }) } } as unknown as SupabaseClient
  return provider === 'cloudflare' ? new CloudflareAdapter() : new SupabaseAdapter()
}

function wireKey(provider: 'cloudflare' | 'supabase', key: string): string {
  return provider === 'cloudflare' ? key : key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

function completeWire(provider: 'cloudflare' | 'supabase', local: LocalRecord): Record<string, unknown> {
  const cloud: CloudRecord = { id: local.id, userId: local.userId, ...snapshotOf(local), version: 1, serverUpdatedAt: local.updatedAtUtc }
  return Object.fromEntries(Object.entries(cloud).map(([key, value]) => [wireKey(provider, key), value]))
}

const missingCore = ['type', 'content', 'createdAtUtc', 'createdTimezone', 'createdLocalDate', 'updatedAtUtc', 'updatedTimezone', 'completedAtUtc', 'completedTimezone', 'deletedAtUtc', 'serverUpdatedAt']
const malformedFields: { field: string; value: unknown; label: string }[] = [
  { field: 'type', value: 'unknown', label: '未知记录类型' },
  { field: 'content', value: null, label: 'null 正文' },
  { field: 'content', value: ['原文'], label: '数组正文' },
  { field: 'createdAtUtc', value: '2026-02-30T00:00:00Z', label: '不存在的创建日' },
  { field: 'createdAtUtc', value: '2026-10-01T00:00:00+08:00', label: '非 UTC 创建时间' },
  { field: 'updatedAtUtc', value: '2026-10-01T24:00:00Z', label: '溢出的编辑时间' },
  { field: 'serverUpdatedAt', value: 'infinity', label: '非法服务端时间' },
  { field: 'completedAtUtc', value: '', label: '空串完成时间' },
  { field: 'deletedAtUtc', value: '2026-02-29T00:00:00Z', label: '不存在的软删时间' },
  { field: 'createdLocalDate', value: '2026-02-30', label: '不存在的归档日' },
  { field: 'createdTimezone', value: null, label: 'null 创建时区' },
  { field: 'updatedTimezone', value: 'invalid/zone', label: '非法编辑时区' },
  { field: 'completedTimezone', value: false, label: '布尔完成时区' },
  { field: 'progress', value: '0', label: '字符串进度' },
  { field: 'progress', value: 101, label: '越界进度' },
  { field: 'progress', value: 1.5, label: '小数进度' },
  { field: 'deadlineLocalDate', value: '2026-02-30', label: '不存在的截止日' },
  { field: 'parentId', value: 7, label: '数字父级' },
]

for (const provider of ['cloudflare', 'supabase'] as const) {
  describe(`${provider} 完整拉取边界`, () => {
    for (const mode of ['all', 'one'] as const) {
      for (const fault of ['missing-content', 'wrong-owner', 'empty-id'] as const) {
        it(`${mode} ${fault} 拒绝对账，不改已同步正文`, async () => {
          const adapter = configure(provider)
          const local = await createRecord({ userId: 'user-a', type: 'log', content: '已经同步的完整正文', progress: 0, parentId: 'project-a' })
          await db.outbox.clear()
          await db.records.update(local.id, { syncState: 'synced', serverVersion: 1 })
          const record = completeWire(provider, local)
          record['version'] = 2
          if (fault === 'missing-content') delete record['content']
          else if (fault === 'wrong-owner') record[wireKey(provider, 'userId')] = 'user-b'
          else record['id'] = ''
          const body = provider === 'cloudflare' ? mode === 'all' ? { records: [record] } : { record } : mode === 'all' ? [record] : record
          vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
          const sync = async () => {
            if (mode === 'all') await reconcileMany(await adapter.pullAll('user-a'))
            else {
              const pulled = await adapter.pullOne('user-a', local.id)
              if (pulled) await reconcileOne(pulled)
            }
          }
          await expect(sync()).rejects.toThrow('cloud_invalid_record_response')
          expect(await db.records.get(local.id)).toMatchObject({ ...snapshotOf(local), serverVersion: 1, syncState: 'synced' })
          expect(await db.records.count()).toBe(1)
        })
      }
      it(`${mode} 整个 Record 缺核心字段不能归一成空记录`, async () => {
        const adapter = configure(provider)
        const local = await createRecord({ userId: 'user-a', type: 'log', content: '旧复现的完整正文', progress: 0, parentId: 'project-a' })
        await db.outbox.clear()
        await db.records.update(local.id, { syncState: 'synced', serverVersion: 1 })
        const identity = provider === 'cloudflare' ? { id: local.id, userId: local.userId, version: 2 } : { id: local.id, user_id: local.userId, version: 2 }
        const body = provider === 'cloudflare' ? mode === 'all' ? { records: [identity] } : { record: identity } : mode === 'all' ? [identity] : identity
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
        await expect(mode === 'all' ? adapter.pullAll('user-a') : adapter.pullOne('user-a', local.id)).rejects.toThrow('cloud_invalid_record_response')
        expect(await db.records.get(local.id)).toMatchObject({ ...snapshotOf(local), serverVersion: 1 })
      })
    }
    for (const shape of [null, {}, { error: 'storage_failed' }] as const) {
      it(`列表非法形状 ${JSON.stringify(shape)} 不能伪装成空库`, async () => {
        const adapter = configure(provider)
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(shape), { status: 200 })))
        await expect(adapter.pullAll('user-a')).rejects.toThrow('cloud_invalid_record_response')
      })
    }
    it('列表末尾损坏时，前面完整行也不能部分对账', async () => {
      const adapter = configure(provider)
      const local = await createRecord({ userId: 'user-a', type: 'idea', content: '完整本机仍须保留' })
      await db.outbox.clear()
      await db.records.update(local.id, { syncState: 'synced', serverVersion: 1 })
      const valid = completeWire(provider, local)
      valid['version'] = 2
      valid['content'] = '尚不能接受的远端正文'
      const records = [valid, { id: 'broken', [wireKey(provider, 'userId')]: 'user-a', version: 2 }]
      const body = provider === 'cloudflare' ? { records } : records
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
      await expect((async () => reconcileMany(await adapter.pullAll('user-a')))()).rejects.toThrow('cloud_invalid_record_response')
      expect(await db.records.get(local.id)).toMatchObject({ content: local.content, serverVersion: 1 })
    })
    it('定点查询返回其他 id 时拒绝，即使归属与结构都完整', async () => {
      const adapter = configure(provider)
      const local = await createRecord({ userId: 'user-a', type: 'idea', content: '不能收错记录' })
      const record = completeWire(provider, local)
      record['id'] = 'another-id'
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(provider === 'cloudflare' ? { record } : record), { status: 200 })))
      await expect(adapter.pullOne('user-a', local.id)).rejects.toThrow('cloud_invalid_record_response')
    })
    it('明确单条 null 表示不存在，仍是合法协议', async () => {
      const adapter = configure(provider)
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(provider === 'cloudflare' ? { record: null } : null), { status: 200 })))
      expect(await adapter.pullOne('user-a', 'none')).toBeNull()
    })
    for (const type of ['idea', 'todo'] as const) {
      it(`旧 ${type} Pull 可缺新增三列，仍保留完整核心字段`, async () => {
        const adapter = configure(provider)
        const local = await createRecord({ userId: 'user-a', type, content: '旧协议完整核心' })
        const record = completeWire(provider, local)
        for (const field of ['progress', 'deadlineLocalDate', 'parentId']) delete record[wireKey(provider, field)]
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(provider === 'cloudflare' ? { records: [record] } : [record]), { status: 200 })))
        const rows = await adapter.pullAll('user-a')
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ ...snapshotOf(local), id: local.id, userId: local.userId })
      })
    }
  })
  describe(`${provider} 不完整 Record 回执`, () => {
    for (const field of missingCore) {
      it(`缺 ${field} 保留草稿与原 payload`, async () => {
        const adapter = configure(provider)
        const local = await createRecord({ userId: 'user-a', type: 'project', content: '核心字段缺失不能抹掉正文', progress: 65, deadlineLocalDate: '2026-12-31' })
        const mutation = (await db.outbox.toArray())[0]
        if (!mutation) throw new Error('missing_test_mutation')
        const record = completeWire(provider, local)
        delete record[wireKey(provider, field)]
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'applied', version: 1, record }), { status: 200 })))
        await expect(pushPending(adapter, 'user-a')).rejects.toThrow('cloud_invalid_mutation_response')
        expect(await db.outbox.get(mutation.mutationId)).toMatchObject({ payload: mutation.payload, state: 'failed' })
        expect(await db.records.get(local.id)).toMatchObject({ ...snapshotOf(local), serverVersion: null })
      })
    }
    for (const type of ['project', 'log'] as const) {
      for (const field of ['progress', 'deadlineLocalDate', 'parentId']) {
        it(`${type} 缺 ${field} 不能误作 null`, async () => {
          const adapter = configure(provider)
          const local = await createRecord({ userId: 'user-a', type, content: '新类型不能省略业务字段', parentId: 'project-a', progress: 0 })
          const record = completeWire(provider, local)
          delete record[wireKey(provider, field)]
          vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'applied', version: 1, record }), { status: 200 })))
          await expect(pushPending(adapter, 'user-a')).rejects.toThrow('cloud_invalid_mutation_response')
          expect(await db.outbox.count()).toBe(1)
          expect(await db.records.get(local.id)).toMatchObject(snapshotOf(local))
        })
      }
    }
    for (const { field, value, label } of malformedFields) {
      it(`${label} 保留本机数据`, async () => {
        const adapter = configure(provider)
        const type = field === 'parentId' ? 'log' : 'project'
        const local = await createRecord({ userId: 'user-a', type, content: '非法回执不能删除草稿', parentId: 'project-a', progress: 65 })
        const record = completeWire(provider, local)
        record[wireKey(provider, field)] = value
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'applied', version: 1, record }), { status: 200 })))
        await expect(pushPending(adapter, 'user-a')).rejects.toThrow('cloud_invalid_mutation_response')
        expect(await db.outbox.count()).toBe(1)
        expect(await db.records.get(local.id)).toMatchObject({ ...snapshotOf(local), serverVersion: null })
      })
    }
    for (const type of ['idea', 'todo'] as const) {
      it(`旧 ${type} 回执缺新增三列仍可确认，nullable 编辑时区归一 UTC`, async () => {
        const adapter = configure(provider)
        const local = await createRecord({ userId: 'user-a', type, content: '旧协议的合法回执' })
        const record = completeWire(provider, local)
        for (const field of ['progress', 'deadlineLocalDate', 'parentId']) delete record[wireKey(provider, field)]
        record[wireKey(provider, 'updatedTimezone')] = null
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'applied', version: 1, record }), { status: 200 })))
        await pushPending(adapter, 'user-a')
        expect(await db.outbox.count()).toBe(0)
        expect(await db.records.get(local.id)).toMatchObject({ content: local.content, updatedTimezone: 'UTC', progress: null, deadlineLocalDate: null, parentId: null })
      })
    }
    for (const parentId of [null, '']) {
      it(`旧 log 的显式 ${String(parentId)} 父级保留 null 兼容`, async () => {
        const adapter = configure(provider)
        const local = await createRecord({ userId: 'user-a', type: 'log', content: '旧 orphan 仍能确认', progress: 0 })
        const record = completeWire(provider, local)
        record[wireKey(provider, 'parentId')] = parentId
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'applied', version: 1, record }), { status: 200 })))
        await pushPending(adapter, 'user-a')
        expect(await db.outbox.count()).toBe(0)
        expect(await db.records.get(local.id)).toMatchObject({ type: 'log', parentId: null, progress: 0, content: local.content })
      })
    }
    it('身份版本正确，但缺字段仍不能让唯一进展草稿出队', async () => {
      const adapter = configure(provider)
      const local = await createRecord({ userId: 'user-a', type: 'log', content: '唯一的进展正文', parentId: 'project-a', progress: 65 })
      const identity = provider === 'cloudflare' ? { id: local.id, userId: local.userId, version: 1 } : { id: local.id, user_id: local.userId, version: 1 }
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'applied', version: 1, record: identity }), { status: 200 })))
      await expect(pushPending(adapter, 'user-a')).rejects.toThrow('cloud_invalid_mutation_response')
      expect(await db.outbox.count()).toBe(1)
      expect((await db.outbox.toArray())[0]).toMatchObject({ state: 'failed', attempted: true })
      expect(await db.records.get(local.id)).toMatchObject({ content: local.content, type: 'log', parentId: 'project-a', progress: 65, createdAtUtc: local.createdAtUtc, serverVersion: null })
    })
    it('真实 record_not_found 契约保留草稿并重建完整 create', async () => {
      const adapter = configure(provider)
      const local = await createRecord({ userId: 'user-a', type: 'project', content: '重建不能丢', progress: 65, deadlineLocalDate: '2026-12-31' })
      await db.outbox.toCollection().modify({ operation: 'update', baseServerVersion: 1 })
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'record_not_found', version: null, record: null }), { status: 200 })))
      await pushPending(adapter, 'user-a')
      expect((await db.outbox.toArray())[0]).toMatchObject({ operation: 'create', state: 'pending', payload: { content: local.content, progress: 65, deadlineLocalDate: '2026-12-31' } })
      expect((await db.records.get(local.id))?.content).toBe(local.content)
    })
  })
}

describe('真实 Cloudflare HTTP + SQLite 回执兼容', () => {
  for (const scenario of ['applied', 'already_applied', 'version_conflict', 'record_not_found'] as const) {
    it(scenario, async () => {
      const adapter = configure('cloudflare')
      server = createSqliteD1()
      await seedUser(server, { userId: 'user-a', token: 'token-a' })
      const local = await createRecord({ userId: 'user-a', type: 'log', content: '真实后端进展正文', parentId: 'project-a', progress: 0 })
      const mutation = (await db.outbox.toArray())[0]
      if (!mutation) throw new Error('missing_test_mutation')
      if (scenario === 'already_applied') {
        await applyMutation(server, 'user-a', mutationToParams(mutation), local.updatedAtUtc)
        await applyMutation(server, 'user-a', { mutationId: 'another-update', recordId: local.id, operation: 'update', expectedVersion: 1, payload: { content: local.content } }, local.updatedAtUtc)
      } else if (scenario === 'version_conflict') {
        await applyMutation(server, 'user-a', { ...mutationToParams(mutation), mutationId: 'another-create', payload: { ...mutation.payload, content: '其他设备的正文' } }, local.updatedAtUtc)
      } else if (scenario === 'record_not_found') {
        await db.outbox.update(mutation.mutationId, { operation: 'update', baseServerVersion: 1 })
      }
      const statuses: string[] = []
      const d1 = server
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await worker.fetch(new Request(String(input), init), { DB: d1 })
        const body = await response.clone().json() as { status: string }
        statuses.push(body.status)
        return response
      }))
      await pushPending(adapter, 'user-a')
      expect(statuses).toEqual([scenario])
      const retained = await db.records.get(local.id)
      expect(retained).toMatchObject({ content: local.content, type: 'log', parentId: 'project-a', progress: 0 })
      if (scenario === 'applied' || scenario === 'already_applied') {
        expect(await db.outbox.count()).toBe(0)
        expect(retained?.serverVersion).toBe(scenario === 'applied' ? 1 : 2)
        expect(server.row<{ count: number }>('select count(*) as count from applied_mutations')?.count).toBe(scenario === 'applied' ? 1 : 2)
      } else {
        expect(await db.outbox.count()).toBe(1)
        expect((await db.outbox.toArray())[0]?.state).toBe('pending')
      }
      const all = await adapter.pullAll('user-a')
      const one = await adapter.pullOne('user-a', local.id)
      if (scenario === 'record_not_found') {
        expect(all).toEqual([])
        expect(one).toBeNull()
      } else {
        expect(all).toHaveLength(1)
        expect(one).toMatchObject({ id: local.id, userId: 'user-a', type: 'log', parentId: 'project-a', progress: 0 })
      }
    })
  }
})

interface PgAckFixture {
  label: string
  request: ApplyMutationParams & { userId: string }
  body: { status: string; version: number; record: Record<string, unknown> }
}
// 样本由真实 PostgreSQL RPC 生成，保留 +00:00、六位微秒与 NULL，不仿造服务端格式。
const pgAcks = JSON.parse(readFileSync(resolve(process.cwd(), 'src/test/fixtures/pg-mutation-acks.json'), 'utf8')) as { cases: PgAckFixture[] }
describe('真实 PostgreSQL JSON 经 Supabase SDK 与 Push 确认', () => {
  for (const { label, request, body } of pgAcks.cases) {
    for (const mode of ['all', 'one'] as const) {
      it(`${label} 的 ${mode} 拉取原样保留微秒与归属`, async () => {
        const adapter = configure('supabase', request.userId)
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(mode === 'all' ? [body.record] : body.record), { status: 200 })))
        const record = mode === 'all' ? (await adapter.pullAll(request.userId))[0] : await adapter.pullOne(request.userId, request.recordId)
        expect(record).toMatchObject({ id: request.recordId, userId: request.userId, progress: 0, createdAtUtc: body.record['created_at_utc'], updatedAtUtc: body.record['updated_at_utc'], completedAtUtc: body.record['completed_at_utc'], deletedAtUtc: body.record['deleted_at_utc'], parentId: body.record['parent_id'] })
      })
    }
    it(label, async () => {
      const adapter = configure('supabase', request.userId)
      const sent: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(new Headers(init?.headers).get('authorization') ?? '')
        return new Response(JSON.stringify(body), { status: 200 })
      }))
      const result = await adapter.applyMutation(request.userId, request)
      const record = result.record
      if (!record) throw new Error('missing_pg_fixture_record')
      expect(record.createdAtUtc).toBe(body.record['created_at_utc'])
      expect(record.updatedAtUtc).toBe(body.record['updated_at_utc'])
      expect(record.completedAtUtc).toBe(body.record['completed_at_utc'])
      expect(record.deletedAtUtc).toBe(body.record['deleted_at_utc'])
      expect(record.progress).toBe(0)
      await db.records.put({ id: request.recordId, userId: request.userId, ...snapshotOfCloud(record), serverVersion: request.expectedVersion, syncState: 'pending' })
      await db.outbox.put({
        mutationId: request.mutationId, userId: request.userId, recordId: request.recordId, operation: request.operation,
        baseSnapshot: snapshotOfCloud(record), baseServerVersion: request.expectedVersion, payload: request.payload,
        createdAt: record.createdAtUtc, state: 'pending', retryCount: 0, attempted: false,
      })
      await pushPending(adapter, request.userId)
      expect(sent).toEqual(['Bearer token-a', 'Bearer token-a'])
      const adopted = await db.records.get(request.recordId)
      expect(adopted).toMatchObject(snapshotOfCloud(record))
      if (body.status === 'version_conflict') {
        expect(await db.outbox.count()).toBe(1)
        expect((await db.outbox.toArray())[0]?.state).toBe('pending')
      } else {
        expect(await db.outbox.count()).toBe(0)
        expect(adopted?.serverVersion).toBe(body.version)
      }
    })
  }
})

it('Supa 第二页损坏时不能把第一页提前交给对账', async () => {
  const adapter = configure('supabase')
  const local = await createRecord({ userId: 'user-a', type: 'idea', content: '必须等完整扫描成功' })
  await db.outbox.clear()
  await db.records.update(local.id, { syncState: 'synced', serverVersion: 1 })
  const first = completeWire('supabase', local)
  first['content'] = '第一页新正文'
  first['version'] = 2
  const page = Array.from({ length: 500 }, (_value, index) => ({ ...first, id: index === 0 ? local.id : `other-${index}` }))
  let pages = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    pages += 1
    return new Response(JSON.stringify(pages === 1 ? page : [{ id: 'broken', user_id: 'user-a', version: 2 }]), { status: 200 })
  }))
  await expect((async () => reconcileMany(await adapter.pullAll('user-a')))()).rejects.toThrow('cloud_invalid_record_response')
  expect(pages).toBe(2)
  expect(await db.records.get(local.id)).toMatchObject({ content: local.content, serverVersion: 1 })
})
