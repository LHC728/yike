import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseAdapter } from '../cloud/SupabaseAdapter'
import { saveCloudConfig } from '../cloud/cloudConfig'

const clientState = vi.hoisted(() => ({ value: null as SupabaseClient | null }))
vi.mock('../cloud/supabaseClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../cloud/supabaseClient')>(),
  getSupabaseClient: () => clientState.value,
}))
type Row = Record<string, unknown>
interface Query {
  userId: string | null
  afterId: string | null
  order: string | null
  limit: string | null
}
const T0 = '2026-10-06T00:00:00.000Z'
const T1 = '2026-10-06T01:00:00.000Z'

beforeEach(() => {
  localStorage.clear()
  saveCloudConfig({ provider: 'supabase', url: 'https://keyset.supabase.co', anonKey: 'key' })
  clientState.value = { auth: { getSession: async () => ({ data: { session: { access_token: 'token-a', user: { id: 'user-a' } } }, error: null }) } } as unknown as SupabaseClient
})
afterEach(() => {
  clientState.value = null
  vi.unstubAllGlobals()
  localStorage.clear()
})

function row(id: string, owner = 'user-a', overrides: Row = {}): Row {
  return {
    id, user_id: owner, type: 'idea', content: id, progress: null, deadline_local_date: null, parent_id: null,
    created_at_utc: T0, created_timezone: 'Asia/Shanghai', created_local_date: '2026-10-06',
    updated_at_utc: T0, updated_timezone: 'Asia/Shanghai', completed_at_utc: null, completed_timezone: null,
    deleted_at_utc: null, version: 1, server_updated_at: T0, ...overrides,
  }
}

function mockPostgrest(rows: Row[], failAt: number | null = null, cap = 1): Query[] {
  const queries: Query[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    expect(url.pathname).toBe('/rest/v1/records')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token-a')
    const owner = url.searchParams.get('user_id')?.replace(/^eq\./, '') ?? null
    const after = url.searchParams.get('id')?.replace(/^gt\./, '') ?? null
    queries.push({ userId: owner, afterId: after, order: url.searchParams.get('order'), limit: url.searchParams.get('limit') })
    if (queries.length === failAt) return new Response(JSON.stringify({ message: 'second_page_failed' }), { status: 500 })
    const columns = (url.searchParams.get('select') ?? '').split(',')
    expect(columns).toContain('parent_id')
    // 实际 SDK 发出的协议经此模拟 PostgREST；独立响应上限用于重现短页仍有后页的情况。
    const selected = rows.filter((item) => item['user_id'] === owner && (after === null || String(item['id']) > after)).slice(0, Math.min(cap, Number(url.searchParams.get('limit'))))
    return new Response(JSON.stringify(selected.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => columns.includes(key))))), { status: 200 })
  }))
  return queries
}

describe('实际 Supabase SDK 的完整 keyset 拉取', () => {
  it('实际 SDK 拉完 50001 条后另读空页，末尾项目、进展、软删和归属完整', async () => {
    const cloudRows = Array.from({ length: 50001 }, (_, index) => row(`r-${String(index + 1).padStart(5, '0')}`))
    cloudRows[49999] = row('r-50000', 'user-a', { type: 'project', progress: 65, deadline_local_date: '2026-10-31' })
    cloudRows[50000] = row('r-50001', 'user-a', { type: 'log', progress: 0, parent_id: 'r-50000', deleted_at_utc: T1 })
    cloudRows.push(row('r-99999', 'user-b'))
    const queries = mockPostgrest(cloudRows, null, 500)
    const rows = await new SupabaseAdapter().pullAll('user-a')
    expect(rows).toHaveLength(50001)
    expect(new Set(rows.map((item) => item.id)).size).toBe(50001)
    expect(rows.at(-2)).toMatchObject({ id: 'r-50000', progress: 65, deadlineLocalDate: '2026-10-31' })
    expect(rows.at(-1)).toMatchObject({ id: 'r-50001', type: 'log', progress: 0, parentId: 'r-50000', deletedAtUtc: T1 })
    expect(rows.every((item) => item.userId === 'user-a')).toBe(true)
    expect(queries).toHaveLength(102)
    expect(queries[100]?.afterId).toBe('r-50000')
    expect(queries[101]?.afterId).toBe('r-50001')
    expect(queries.every((query) => query.userId === 'user-a' && query.order === 'id.asc' && query.limit === '500')).toBe(true)
  })

  it('服务端 cap1 仍读到空页；进度、截止日、末条 log/软删及账号范围保留', async () => {
    const queries = mockPostgrest([
      row('a', 'user-a', { type: 'project', content: '大事', progress: 65, deadline_local_date: '2026-12-31' }),
      row('b', 'user-a', { type: 'log', content: '末尾进展', progress: 0, parent_id: 'a', deleted_at_utc: T1 }),
      row('c', 'user-b', { content: '其他账号' }),
    ])
    const rows = await new SupabaseAdapter().pullAll('user-a')
    expect(rows.map((item) => item.id)).toEqual(['a', 'b'])
    expect(rows[0]).toMatchObject({ progress: 65, deadlineLocalDate: '2026-12-31', userId: 'user-a' })
    expect(rows[1]).toMatchObject({ type: 'log', progress: 0, parentId: 'a', deletedAtUtc: T1, userId: 'user-a' })
    expect(queries).toEqual([
      { userId: 'user-a', afterId: null, order: 'id.asc', limit: '500' },
      { userId: 'user-a', afterId: 'a', order: 'id.asc', limit: '500' },
      { userId: 'user-a', afterId: 'b', order: 'id.asc', limit: '500' },
    ])
  })
  it('第二页查询错误时抛错，不返回第一条', async () => {
    const queries = mockPostgrest([row('a'), row('b')], 2)
    await expect(new SupabaseAdapter().pullAll('user-a')).rejects.toThrow('second_page_failed')
    expect(queries).toHaveLength(2)
  })
})
