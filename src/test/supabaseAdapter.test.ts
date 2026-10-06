import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseAdapter } from '../cloud/SupabaseAdapter'
import { saveCloudConfig } from '../cloud/cloudConfig'

const fixture = vi.hoisted(() => ({ client: null as SupabaseClient | null }))
vi.mock('../cloud/supabaseClient', async (importOriginal) => ({
  ...await importOriginal<typeof import('../cloud/supabaseClient')>(),
  getSupabaseClient: () => fixture.client,
}))

const row = {
  id: 'log-1', user_id: 'user-a', type: 'log', content: '所属大事不能消失',
  progress: 0, deadline_local_date: null, parent_id: 'project-1',
  created_at_utc: '2026-10-01T00:00:00.000Z', created_timezone: 'Asia/Shanghai', created_local_date: '2026-10-01',
  updated_at_utc: '2026-10-01T00:00:00.000Z', updated_timezone: 'Asia/Shanghai',
  completed_at_utc: null, completed_timezone: null, deleted_at_utc: null,
  version: 3, server_updated_at: '2026-10-01T00:00:00.000Z',
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  localStorage.clear()
  saveCloudConfig({ provider: 'supabase', url: 'https://adapter.supabase.co', anonKey: 'public-key' })
  fixture.client = { auth: { getSession: async () => ({ data: { session: { access_token: 'token-a', user: { id: 'user-a' } } }, error: null }) } } as unknown as SupabaseClient
})
afterEach(() => {
  fixture.client = null
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('真实 Supabase SDK 的读取投影', () => {
  for (const mode of ['all', 'one'] as const) {
    it(`${mode} 拉取保留进展的 parentId 和 0% 快照`, async () => {
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input))
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token-a')
        expect(url.searchParams.get('user_id')).toBe('eq.user-a')
        // 真实 PostgREST 只返回 select 指定列；不能用总是返回整行的 mock 掩盖漏列。
        const columns = (url.searchParams.get('select') ?? '').split(',')
        const projected = Object.fromEntries(Object.entries(row).filter(([key]) => columns.includes(key)))
        return json(mode === 'all' ? [projected] : projected)
      }))
      const adapter = new SupabaseAdapter()
      const result = mode === 'all' ? (await adapter.pullAll('user-a'))[0] : await adapter.pullOne('user-a', row.id)
      expect(result).toMatchObject({ id: row.id, userId: 'user-a', type: 'log', parentId: 'project-1', progress: 0 })
    })
  }
})
