import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CloudflareAdapter } from '../cloud/CloudflareAdapter'
import { SupabaseAdapter } from '../cloud/SupabaseAdapter'
import { saveCloudConfig } from '../cloud/cloudConfig'
import { saveCloudflareSession } from '../cloud/cloudflareSession'
import { db } from '../db/db'
import { createRecord } from '../db/recordRepository'
import { pushPending } from '../sync/PushService'
import { cleanupDevices, openDevice } from './fakeCloudServer'
import { snapshotOf, type CloudRecord, type LocalRecord } from '../domain/record'

const fixture = vi.hoisted(() => ({ client: null as SupabaseClient | null }))
vi.mock('../cloud/supabaseClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../cloud/supabaseClient')>(),
  getSupabaseClient: () => fixture.client,
}))

function responseRecord(provider: 'cloudflare' | 'supabase', local: LocalRecord): Record<string, unknown> {
  const cloud: CloudRecord = { id: local.id, userId: local.userId, ...snapshotOf(local), version: 1, serverUpdatedAt: local.updatedAtUtc }
  return Object.fromEntries(Object.entries(cloud).map(([key, value]) => [provider === 'cloudflare' ? key : key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value]))
}

const invalidReplies: { label: string; body: unknown }[] = [
  { label: '未知状态', body: { status: 'weird_new_status', version: 1, record: null } },
  { label: '缺少状态', body: { version: 1, record: null } },
  { label: '200 错误对象', body: { error: 'storage_failed' } },
  { label: '空对象', body: {} },
  { label: 'null', body: null },
  { label: '数组', body: [] },
  { label: '缺少版本', body: { status: 'applied', record: null } },
  { label: '非法版本', body: { status: 'applied', version: 'not-a-version', record: null } },
  { label: '没有确认记录', body: { status: 'applied', version: 1, record: null } },
  { label: '零版本', body: { status: 'applied', version: 0, record: {} } },
  { label: '负版本', body: { status: 'applied', version: -1, record: {} } },
  { label: '小数版本', body: { status: 'applied', version: 1.5, record: {} } },
]

beforeEach(async () => {
  localStorage.clear()
  fixture.client = null
  await openDevice(`response-${crypto.randomUUID()}`)
})
afterEach(async () => {
  fixture.client = null
  vi.unstubAllGlobals()
  localStorage.clear()
  await cleanupDevices()
})

for (const provider of ['cloudflare', 'supabase'] as const) {
  describe(`${provider} 的异常成功响应不会让草稿出队`, () => {
    for (const { label, body } of invalidReplies) {
      it(label, async () => {
        if (provider === 'cloudflare') {
          saveCloudConfig({ provider, url: 'https://response.invalid' })
          saveCloudflareSession({ token: 'token-a', userId: 'user-a', email: null })
        } else {
          saveCloudConfig({ provider, url: 'https://response.supabase.co', anonKey: 'key' })
          fixture.client = { auth: { getSession: async () => ({ data: { session: { access_token: 'token-a', user: { id: 'user-a' } } }, error: null }) } } as unknown as SupabaseClient
        }
        const record = await createRecord({ userId: 'user-a', type: 'idea', content: '唯一的本机草稿' })
        const original = (await db.outbox.toArray())[0]
        if (!original) throw new Error('missing_test_mutation')
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })))
        const adapter = provider === 'cloudflare' ? new CloudflareAdapter() : new SupabaseAdapter()
        await expect(pushPending(adapter, 'user-a')).rejects.toThrow('cloud_invalid_mutation_response')
        expect(await db.outbox.get(original.mutationId)).toMatchObject({ state: 'failed', payload: original.payload, attempted: true })
        expect(await db.records.get(record.id)).toMatchObject({ content: '唯一的本机草稿', userId: 'user-a', serverVersion: null })
      })
    }

    for (const fault of ['wrong-owner', 'wrong-id', 'old-record-version'] as const) {
      it(`${fault} 回执保留唯一草稿`, async () => {
        saveCloudConfig(provider === 'cloudflare' ? { provider, url: 'https://response.invalid' } : { provider, url: 'https://response.supabase.co', anonKey: 'key' })
        saveCloudflareSession({ token: 'token-a', userId: 'user-a', email: null })
        fixture.client = { auth: { getSession: async () => ({ data: { session: { access_token: 'token-a', user: { id: 'user-a' } } }, error: null }) } } as unknown as SupabaseClient
        const local = await createRecord({ userId: 'user-a', type: 'idea', content: '不能确认别人的回执' })
        const id = fault === 'wrong-id' ? 'unrelated' : local.id
        const owner = fault === 'wrong-owner' ? 'user-b' : 'user-a'
        const record = responseRecord(provider, local)
        record['id'] = id
        record[provider === 'cloudflare' ? 'userId' : 'user_id'] = owner
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'applied', version: fault === 'old-record-version' ? 2 : 1, record }), { status: 200 })))
        await expect(pushPending(provider === 'cloudflare' ? new CloudflareAdapter() : new SupabaseAdapter(), 'user-a')).rejects.toThrow('cloud_invalid_mutation_response')
        expect(await db.outbox.count()).toBe(1)
        expect(await db.records.count()).toBe(1)
        expect((await db.records.get(local.id))?.content).toBe('不能确认别人的回执')
      })
    }

    for (const status of ['applied', 'already_applied'] as const) {
      it(`${status} 的完整确认正常出队，较新的 Record 版本仍可接受`, async () => {
        saveCloudConfig(provider === 'cloudflare' ? { provider, url: 'https://response.invalid' } : { provider, url: 'https://response.supabase.co', anonKey: 'key' })
        saveCloudflareSession({ token: 'token-a', userId: 'user-a', email: null })
        fixture.client = { auth: { getSession: async () => ({ data: { session: { access_token: 'token-a', user: { id: 'user-a' } } }, error: null }) } } as unknown as SupabaseClient
        const local = await createRecord({ userId: 'user-a', type: 'idea', content: '正常的完整确认' })
        const fields = { id: local.id, type: local.type, content: local.content, progress: null, version: 3 }
        const record = provider === 'cloudflare'
          ? { ...fields, userId: local.userId, parentId: null, deadlineLocalDate: null, createdAtUtc: local.createdAtUtc, createdTimezone: local.createdTimezone, createdLocalDate: local.createdLocalDate, updatedAtUtc: local.updatedAtUtc, updatedTimezone: local.updatedTimezone, completedAtUtc: null, completedTimezone: null, deletedAtUtc: null, serverUpdatedAt: local.updatedAtUtc }
          : { ...fields, user_id: local.userId, parent_id: null, deadline_local_date: null, created_at_utc: local.createdAtUtc, created_timezone: local.createdTimezone, created_local_date: local.createdLocalDate, updated_at_utc: local.updatedAtUtc, updated_timezone: local.updatedTimezone, completed_at_utc: null, completed_timezone: null, deleted_at_utc: null, server_updated_at: local.updatedAtUtc }
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status, version: '1', record }), { status: 200 })))
        await pushPending(provider === 'cloudflare' ? new CloudflareAdapter() : new SupabaseAdapter(), 'user-a')
        expect(await db.outbox.count()).toBe(0)
        expect(await db.records.get(local.id)).toMatchObject({ content: local.content, serverVersion: 3, syncState: 'synced' })
      })
    }
  })
}
