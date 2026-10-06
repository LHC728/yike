// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pullAll, pullPage, type PullPageOutput } from '../../worker/src/core'
import worker from '../../worker/src/index'
import { createSqliteD1, seedUser, type SqliteD1 } from './sqliteD1'
import { CloudflareAdapter } from '../cloud/CloudflareAdapter'
import { saveCloudConfig } from '../cloud/cloudConfig'
import { saveCloudflareSession } from '../cloud/cloudflareSession'

const USER_A = 'page-a'
const USER_B = 'page-b'
const TOKEN_A = 'token-page-aaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = 'token-page-bbbbbbbbbbbbbbbbbbbbbbbb'
const T0 = '2026-10-06T01:00:00.000Z'
const T1 = '2026-10-06T02:00:00.000Z'
let db: SqliteD1

beforeEach(async () => {
  db = createSqliteD1()
  await seedUser(db, { userId: USER_A, token: TOKEN_A })
  await seedUser(db, { userId: USER_B, token: TOKEN_B })
})

afterEach(() => { db.close(); vi.unstubAllGlobals() })

function configureCloudflareAdapter(): CloudflareAdapter {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  })
  saveCloudConfig({ provider: 'cloudflare', url: 'https://draft.invalid' })
  saveCloudflareSession({ token: TOKEN_A, userId: USER_A, email: null })
  return new CloudflareAdapter()
}

function seedRows(count: number): void {
  // 用真实 SQLite 一次生成大样本，不把 50001 次网络或幂等写入混进分页测试。
  db.exec(`
    with recursive sequence(n) as (
      select 1 union all select n + 1 from sequence where n < ${count}
    )
    insert into records (
      id, user_id, type, content, progress, deadline_local_date, parent_id,
      created_at_utc, created_timezone, created_local_date, updated_at_utc,
      updated_timezone, completed_at_utc, completed_timezone, deleted_at_utc,
      version, server_updated_at
    ) select
      printf('r-%05d', n), '${USER_A}',
      case n when 50000 then 'project' when 50001 then 'log' else 'idea' end,
      printf('记录 %d', n),
      case n when 50000 then 65 when 50001 then 0 else null end,
      case n when 50000 then '2026-10-31' else null end,
      case n when 50001 then 'r-50000' else null end,
      '${T0}', 'Asia/Shanghai', '2026-10-06', '${T0}', 'Asia/Shanghai', null, null,
      case n when 50001 then '${T1}' else null end,
      1, '${T0}' from sequence
  `)
  db.exec(`insert into records (
    id, user_id, type, content, created_at_utc, created_timezone,
    created_local_date, updated_at_utc, updated_timezone, version, server_updated_at
  ) values ('r-99999', '${USER_B}', 'idea', '其他账号的记录', '${T0}', 'Asia/Shanghai',
    '2026-10-06', '${T0}', 'Asia/Shanghai', 1, '${T0}')`)
}

function call(path: string, body?: unknown): Promise<Response> {
  return worker.fetch(new Request(`https://draft.invalid${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN_A}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { DB: db })
}

describe('完整拉取兼容与大数据量', () => {
  it('旧版全量接口超过 50000 条时仍保留末尾进展和软删除', async () => {
    seedRows(50001)
    const rows = await pullAll(db, USER_A)
    expect(rows).toHaveLength(50001)
    expect(rows.find((row) => row.id === 'r-50000')).toMatchObject({
      progress: 65, deadlineLocalDate: '2026-10-31', parentId: null,
    })
    expect(rows.find((row) => row.id === 'r-50001')).toMatchObject({
      type: 'log', progress: 0, parentId: 'r-50000', deletedAtUtc: T1, userId: USER_A,
    })
    expect(rows.some((row) => row.userId === USER_B)).toBe(false)
    const response = await call('/api/sync/pull')
    expect(response.status).toBe(200)
    const body = await response.json() as { records: typeof rows }
    expect(Object.keys(body)).toEqual(['records'])
    expect(body.records).toHaveLength(50001)
    expect(body.records.find((row) => row.id === 'r-50000')).toMatchObject({ progress: 65, deadlineLocalDate: '2026-10-31' })
    expect(body.records.find((row) => row.id === 'r-50001')).toMatchObject({ type: 'log', progress: 0, parentId: 'r-50000', deletedAtUtc: T1, userId: USER_A })
    expect(body.records.some((row) => row.userId === USER_B)).toBe(false)
  })

  it('旧 HTTP 端点保持完整数组形状，新端点单独提供游标', async () => {
    seedRows(3)
    const old = await call('/api/sync/pull')
    const oldBody = await old.json() as { records: unknown[] }
    expect(Object.keys(oldBody)).toEqual(['records'])
    expect(oldBody.records).toHaveLength(3)
    const page = await call('/api/sync/pull-page', { afterId: null, pageSize: 2 })
    expect(page.status).toBe(200)
    expect(await page.json()).toMatchObject({ records: [{ id: 'r-00001' }, { id: 'r-00002' }], nextCursor: 'r-00002' })
  })

  it('真实适配器经 Worker HTTP 汇总 50001 条，末页进展、软删和进度全部保留', async () => {
    seedRows(50001)
    const adapter = configureCloudflareAdapter()
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) =>
      worker.fetch(new Request(input, init), { DB: db }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const rows = await adapter.pullAll(USER_A)

    expect(rows).toHaveLength(50001)
    expect(new Set(rows.map((row) => row.id)).size).toBe(50001)
    expect(rows.at(-1)).toMatchObject({
      id: 'r-50001', type: 'log', progress: 0, parentId: 'r-50000', deletedAtUtc: T1, userId: USER_A,
    })
    expect(rows.at(-2)).toMatchObject({ progress: 65, deadlineLocalDate: '2026-10-31' })
    expect(rows.every((row) => row.userId === USER_A)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(101)
    expect(fetchMock.mock.calls[100]?.[1]?.body).toBe(JSON.stringify({ afterId: 'r-50000', pageSize: 500 }))
  })

  it('真实适配器第二页 HTTP 失败，完整拉取抛错而不是返回前 500 条', async () => {
    seedRows(501)
    const adapter = configureCloudflareAdapter()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      calls += 1
      if (calls === 2) return new Response(JSON.stringify({ error: 'internal_error' }), { status: 500 })
      return worker.fetch(new Request(input, init), { DB: db })
    }))
    await expect(adapter.pullAll(USER_A)).rejects.toThrow('cloud_request_failed 500')
    expect(calls).toBe(2)
  })

  it('新适配器连到未升级 Worker 时明确失败，不退回旧的截断接口', async () => {
    const adapter = configureCloudflareAdapter()
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(adapter.pullAll(USER_A)).rejects.toThrow('cloud_request_failed 404')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('不可变 id 游标与 HTTP 校验', () => {
  it('所有更新时间相同也不重读或漏读，最后一页恰好满页时正确结束', async () => {
    seedRows(4)
    const first = await pullPage(db, USER_A, { afterId: null, pageSize: 2 })
    const last = await pullPage(db, USER_A, { afterId: first.nextCursor, pageSize: 2 })
    expect(first.nextCursor).toBe('r-00002')
    expect(last.nextCursor).toBeNull()
    expect([...first.records, ...last.records].map((row) => row.id)).toEqual(['r-00001', 'r-00002', 'r-00003', 'r-00004'])
  })

  it('翻页期间未读取的记录被编辑或软删，仍按原 id 出现', async () => {
    seedRows(4)
    const first = await pullPage(db, USER_A, { afterId: null, pageSize: 2 })
    db.exec(`update records set content = '分页途中编辑', version = 2, server_updated_at = '${T1}' where id = 'r-00003'`)
    db.exec(`update records set deleted_at_utc = '${T1}', version = 2, server_updated_at = '${T1}' where id = 'r-00004'`)
    const last = await pullPage(db, USER_A, { afterId: first.nextCursor, pageSize: 2 })
    expect(last.records.map((row) => row.id)).toEqual(['r-00003', 'r-00004'])
    expect(last.records[0]?.content).toBe('分页途中编辑')
    expect(last.records[1]?.deletedAtUtc).toBe(T1)
    expect(last.nextCursor).toBeNull()
  })

  it('分页端点只返回令牌所属用户，游标不会改变账号范围', async () => {
    seedRows(4)
    const response = await worker.fetch(new Request('https://draft.invalid/api/sync/pull-page', {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN_B}`, 'content-type': 'application/json' },
      body: JSON.stringify({ afterId: 'r-00001', pageSize: 2 }),
    }), { DB: db })
    const page = await response.json() as PullPageOutput
    expect(page.records.map((row) => row.id)).toEqual(['r-99999'])
    expect(page.records[0]?.userId).toBe(USER_B)
    expect(page.nextCursor).toBeNull()
  })

  it.each([
    null, [], {}, { pageSize: 2 }, { afterId: null }, { afterId: '', pageSize: 2 },
    { afterId: 7, pageSize: 2 }, { afterId: {}, pageSize: 2 },
    { afterId: null, pageSize: '2' }, { afterId: null, pageSize: 0 },
    { afterId: null, pageSize: -1 }, { afterId: null, pageSize: 1.5 }, { afterId: null, pageSize: 1001 },
  ])('非法游标或页大小 %j 返回 400，不当成第一页', async (body) => {
    const response = await call('/api/sync/pull-page', body)
    expect(response.status).toBe(400)
  })

  it('非法 JSON 返回 400，鉴权失败仍返回 401', async () => {
    const invalidJson = await worker.fetch(new Request('https://draft.invalid/api/sync/pull-page', {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN_A}` }, body: '{',
    }), { DB: db })
    expect(invalidJson.status).toBe(400)
    const noSession = await worker.fetch(new Request('https://draft.invalid/api/sync/pull-page', {
      method: 'POST', body: JSON.stringify({ afterId: null, pageSize: 2 }),
    }), { DB: db })
    expect(noSession.status).toBe(401)
  })
})
