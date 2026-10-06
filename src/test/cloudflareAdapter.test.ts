/**
 * CloudflareAdapter —— 客户端侧的适配器。
 *
 * 这一层是「网络来的脏数据」与「领域层的干净数据」之间的唯一闸门，
 * 所以重点测两件事：
 *   1. 字段归一：网络上任何形状的 JSON 进来，出去都得是合法的 CloudRecord
 *   2. 失败不装成功：非 2xx 必须抛错，绝不能返回一个「看起来应用了」的结果
 *
 * 第 2 条是本项目的命门。同步引擎只要把失败当成成功，
 * outbox 里那条 mutation 就会被删掉 —— 那是真正的数据丢失，且无声无息。
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { CloudflareAdapter, cloudflareAdapter } from '../cloud/CloudflareAdapter'
import { CloudRequestError } from '../cloud/cloudflareClient'
import { saveCloudConfig } from '../cloud/cloudConfig'
import { saveCloudflareSession } from '../cloud/cloudflareSession'
import { clampDeadlineLocalDate, clampProgress, clampRecordType } from '../domain/record'

const WORKER_URL = 'https://yike-sync.example.workers.dev'
const TOKEN = 'token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

/**
 * 明确写出 fetch 的签名。
 * 交给 `vi.fn` 自己推断的话，一个「没有参数的实现」会被推成 0 元签名，
 * 于是 `toHaveBeenCalledWith(url, init)` 会报「Expected 0 arguments」——
 * 明明调用是对的，类型却在撒谎。
 */
type FetchMock = Mock<(input: string, init?: RequestInit) => Promise<Response>>

let adapter: CloudflareAdapter

beforeEach(() => {
  localStorage.clear()
  saveCloudConfig({ provider: 'cloudflare', url: `${WORKER_URL}/` }) // 故意带结尾斜杠
  saveCloudflareSession({ token: TOKEN, userId: 'user-a', email: 'a@example.com' })
  adapter = new CloudflareAdapter()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** 装一个假的 fetch，返回给定的 JSON */
function stubFetch(payload: unknown, init: { status?: number } = {}): FetchMock {
  const status = init.status ?? 200
  const mock: FetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status }))
  vi.stubGlobal('fetch', mock)
  return mock
}

function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'r-1', userId: 'user-a', type: 'idea', content: '原文', version: 1,
    progress: null, deadlineLocalDate: null, parentId: null,
    createdAtUtc: '2026-10-01T00:00:00.000Z', createdTimezone: 'UTC', createdLocalDate: '2026-10-01',
    updatedAtUtc: '2026-10-01T00:00:00.000Z', updatedTimezone: 'UTC',
    completedAtUtc: null, completedTimezone: null, deletedAtUtc: null, serverUpdatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  }
}

// =====================================================================
describe('是否已配置', () => {
  it('地址与令牌都齐了才算配置好', () => {
    expect(adapter.isConfigured()).toBe(true)
  })

  it('没配地址 → 未配置', () => {
    localStorage.clear()
    saveCloudflareSession({ token: TOKEN, userId: 'user-a', email: null })
    expect(adapter.isConfigured()).toBe(false)
  })

  it('没登录（没有令牌）→ 未配置', () => {
    localStorage.clear()
    saveCloudConfig({ provider: 'cloudflare', url: WORKER_URL })
    expect(adapter.isConfigured()).toBe(false)
  })

  it('配置的是 Supabase 时，Cloudflare 适配器不认（两套配置不串台）', () => {
    localStorage.clear()
    saveCloudConfig({ provider: 'supabase', url: 'https://x.supabase.co', anonKey: 'key' })
    saveCloudflareSession({ token: TOKEN, userId: 'user-a', email: null })
    expect(adapter.isConfigured()).toBe(false)
  })
})

describe('请求怎么发出去', () => {
  it('地址结尾的斜杠被去掉，路径不重复', async () => {
    const mock = stubFetch({ records: [], nextCursor: null })
    await adapter.pullAll('user-a')
    expect(mock).toHaveBeenCalledWith(
      `${WORKER_URL}/api/sync/pull-page`,
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('带上 Bearer 令牌', async () => {
    const mock = stubFetch({ records: [], nextCursor: null })
    await adapter.pullAll('user-a')
    const headers = (mock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as
      | Record<string, string>
      | undefined
    expect(headers?.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('recordId 会做 URL 编码', async () => {
    const mock = stubFetch({ record: null })
    await adapter.pullOne('user-a', 'a/b?c=d&e')
    expect(mock.mock.calls[0]?.[0]).toBe(
      `${WORKER_URL}/api/sync/record?id=${encodeURIComponent('a/b?c=d&e')}`,
    )
  })

  it('没配置就调用 → 立刻报错，不发请求', async () => {
    localStorage.clear()
    const mock = stubFetch({ records: [], nextCursor: null })
    await expect(adapter.pullAll('user-a')).rejects.toThrow('cloud_not_configured')
    expect(mock).not.toHaveBeenCalled()
  })
})

describe('pullAll 的字段归一', () => {
  it('完整的一行原样映射（含大事的进度与截止日）', async () => {
    stubFetch({
      nextCursor: null,
      records: [
        {
          id: 'r-1',
          userId: 'user-a',
          type: 'project',
          content: '毕业论文',
          progress: 40,
          deadlineLocalDate: '2026-10-12',
          parentId: null,
          createdAtUtc: '2026-09-30T01:00:00.000Z',
          createdTimezone: 'Asia/Shanghai',
          createdLocalDate: '2026-09-30',
          updatedAtUtc: '2026-09-30T01:00:00.000Z',
          updatedTimezone: 'Asia/Shanghai',
          completedAtUtc: null,
          completedTimezone: null,
          deletedAtUtc: null,
          version: 3,
          serverUpdatedAt: '2026-09-30T02:00:00.000Z',
        },
      ],
    })

    expect(await adapter.pullAll('user-a')).toEqual([
      {
        id: 'r-1',
        userId: 'user-a',
        type: 'project',
        content: '毕业论文',
        progress: 40,
        deadlineLocalDate: '2026-10-12',
        parentId: null,
        createdAtUtc: '2026-09-30T01:00:00.000Z',
        createdTimezone: 'Asia/Shanghai',
        createdLocalDate: '2026-09-30',
        updatedAtUtc: '2026-09-30T01:00:00.000Z',
        updatedTimezone: 'Asia/Shanghai',
        completedAtUtc: null,
        completedTimezone: null,
        deletedAtUtc: null,
        version: 3,
        serverUpdatedAt: '2026-09-30T02:00:00.000Z',
      },
    ])
  })

  it('缺字段的老记录：进度、截止日、parentId 补成 null，不是 undefined', async () => {
    // 关键：必须是 null 而不是 undefined。
    // snapshotEquals 用的是严格相等，undefined ≠ null 会在下一次同步时
    // 凭空造出一个「删除冲突」弹窗（Dexie v2 / v3 迁移存在的全部理由）。
    const legacy = validRecord()
    delete legacy['progress']
    delete legacy['deadlineLocalDate']
    delete legacy['parentId']
    stubFetch({ records: [legacy], nextCursor: null })
    const [record] = await adapter.pullAll('user-a')
    expect(record?.progress).toBeNull()
    expect(record?.deadlineLocalDate).toBeNull()
    expect(record?.parentId).toBeNull()
    expect(record?.progress).not.toBeUndefined()
  })

  it('进展：parentId 原样透出，空字符串当「没有父级」', async () => {
    stubFetch({
      nextCursor: null,
      records: [
        validRecord({ id: 'r-001-log', type: 'log', progress: 50, parentId: 'p-1' }),
        validRecord({ id: 'r-002-null', type: 'log', parentId: '' }),
      ],
    })
    const [log, bad] = await adapter.pullAll('user-a')
    expect(log?.type).toBe('log')
    expect(log?.progress).toBe(50)
    expect(log?.parentId).toBe('p-1')
    expect(bad?.parentId).toBeNull()
  })

  it('叶子函数仍能收敛脏进度与日期，网络接口拒绝把脏记录当成完整事实', async () => {
    stubFetch({
      nextCursor: null,
      records: [
        validRecord({ id: 'r-1', type: 'project', progress: 999, deadlineLocalDate: '2026-13-45' }),
        validRecord({ id: 'r-2', type: 'project', progress: 'abc', deadlineLocalDate: '' }),
      ],
    })
    await expect(adapter.pullAll('user-a')).rejects.toThrow('cloud_invalid_record_response')
    expect(clampProgress(999)).toBe(100)
    expect(clampDeadlineLocalDate('2026-13-45')).toBeNull()
    expect(clampProgress('abc')).toBeNull()
    expect(clampDeadlineLocalDate('')).toBeNull()
  })

  it('字段缺失 / 类型不对的网络记录必须拒绝，叶子类型归一仍保留', async () => {
    stubFetch({
      nextCursor: null,
      records: [
        {
          // 缺 id / content / 各种时间
          type: 'garbage',
          version: 'not-a-number',
          createdTimezone: null,
          updatedTimezone: undefined,
        },
      ],
    })

    await expect(adapter.pullAll('user-a')).rejects.toThrow('cloud_invalid_record_response')
    expect(clampRecordType('garbage')).toBe('idea')
  })

  it('网络回执的空字符串时间不是明确 null，不能静默清除已有完成或软删事实', async () => {
    stubFetch({
      nextCursor: null,
      records: [
        validRecord({ completedAtUtc: '', completedTimezone: '', deletedAtUtc: '' }),
      ],
    })
    await expect(adapter.pullAll('user-a')).rejects.toThrow('cloud_invalid_record_response')
  })

  it('响应里没有 records 字段必须拒绝，不能伪装成完整空库', async () => {
    stubFetch({})
    await expect(adapter.pullAll('user-a')).rejects.toThrow('cloud_invalid_record_response')
  })

  it('records 是 null 必须拒绝，只有显式数组才是完整列表', async () => {
    stubFetch({ records: null, nextCursor: null })
    await expect(adapter.pullAll('user-a')).rejects.toThrow('cloud_invalid_record_response')
  })
})

describe('pullOne', () => {
  it('有记录就返回，字段照样归一', async () => {
    stubFetch({ record: validRecord({ type: 'todo', version: 2 }) })
    const record = await adapter.pullOne('user-a', 'r-1')
    expect(record?.id).toBe('r-1')
    expect(record?.type).toBe('todo')
    expect(record?.version).toBe(2)
  })

  it('record 为 null → 返回 null（表示「服务端没这条」，不是「请求失败」）', async () => {
    stubFetch({ record: null })
    expect(await adapter.pullOne('user-a', 'r-1')).toBeNull()
  })
})

describe('applyMutation 的状态透传', () => {
  const confirmedRecord = (version: number) => ({
    id: 'r-1', userId: 'user-a', type: 'idea', content: 'x', version,
    progress: null, deadlineLocalDate: null, parentId: null,
    createdAtUtc: '2026-10-01T00:00:00.000Z', createdTimezone: 'UTC', createdLocalDate: '2026-10-01',
    updatedAtUtc: '2026-10-01T00:00:00.000Z', updatedTimezone: 'UTC',
    completedAtUtc: null, completedTimezone: null, deletedAtUtc: null, serverUpdatedAt: '2026-10-01T00:00:00.000Z',
  })
  const params = {
    mutationId: 'm-1',
    recordId: 'r-1',
    operation: 'create' as const,
    expectedVersion: null,
    payload: { content: 'x' },
  }

  it('把请求参数原样送到后端', async () => {
    const mock = stubFetch({ status: 'applied', version: 1, record: confirmedRecord(1) })
    await adapter.applyMutation('user-a', params)

    const body = JSON.parse(String((mock.mock.calls[0]?.[1] as RequestInit | undefined)?.body)) as
      Record<string, unknown>
    expect(body).toEqual({
      mutationId: 'm-1',
      recordId: 'r-1',
      operation: 'create',
      expectedVersion: null,
      payload: { content: 'x' },
    })
  })

  for (const status of ['applied', 'already_applied', 'version_conflict', 'record_not_found'] as const) {
    it(`${status} 原样透传`, async () => {
      stubFetch(status === 'record_not_found'
        ? { status, version: null, record: null }
        : { status, version: 2, record: confirmedRecord(2) })
      const result = await adapter.applyMutation('user-a', params)
      expect(result.status).toBe(status)
      expect(result.version).toBe(status === 'record_not_found' ? null : 2)
    })
  }

  it('后端返回了没见过的 status → 拒绝确认，不能静默删除本机队列', async () => {
    stubFetch({ status: 'weird_new_status', version: 1, record: null })
    await expect(adapter.applyMutation('user-a', params)).rejects.toThrow('cloud_invalid_mutation_response')
  })

  it('version 是字符串时转成数字，null 保持 null', async () => {
    stubFetch({ status: 'applied', version: '7', record: confirmedRecord(7) })
    expect((await adapter.applyMutation('user-a', params)).version).toBe(7)

    stubFetch({ status: 'record_not_found', version: null, record: null })
    expect((await adapter.applyMutation('user-a', params)).version).toBeNull()
  })

  it('确认记录类型不合法时不能把它归一成灵感并当成成功', async () => {
    stubFetch({ status: 'applied', version: 1, record: { ...confirmedRecord(1), type: 'garbage' } })
    await expect(adapter.applyMutation('user-a', params)).rejects.toThrow('cloud_invalid_mutation_response')
  })
})

describe('★ 失败绝不装成成功', () => {
  const params = {
    mutationId: 'm-1',
    recordId: 'r-1',
    operation: 'create' as const,
    expectedVersion: null,
    payload: {},
  }

  for (const status of [400, 401, 403, 404, 500, 502]) {
    it(`${status} → 抛 CloudRequestError 且带上状态码`, async () => {
      stubFetch({ error: 'nope' }, { status })
      const error = await adapter.applyMutation('user-a', params).catch((thrown: unknown) => thrown)
      expect(error).toBeInstanceOf(CloudRequestError)
      expect((error as CloudRequestError).status).toBe(status)
    })
  }

  it('401 能被识别出来（AuthService 靠它判断「令牌失效」）', async () => {
    stubFetch({ error: 'unauthorized' }, { status: 401 })
    const error = await adapter.pullAll('user-a').catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(CloudRequestError)
    expect((error as CloudRequestError).status).toBe(401)
  })

  it('响应体不是 JSON 也能拿到状态码（例如网关的错误页）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 })),
    )
    const error = await adapter.pullAll('user-a').catch((thrown: unknown) => thrown)
    expect((error as CloudRequestError).status).toBe(502)
  })

  it('断网（fetch 直接 reject）→ 原样抛出，不吞掉', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(adapter.pullAll('user-a')).rejects.toThrow('Failed to fetch')
  })
})

describe('subscribe', () => {
  it('Worker 没有推送通道，返回一个可调用的空取消函数', () => {
    const unsubscribe = adapter.subscribe('user-a', () => undefined)
    expect(typeof unsubscribe).toBe('function')
    expect(() => unsubscribe()).not.toThrow()
  })

  it('kind 是 cloudflare —— 同步引擎据此判断能力差异', () => {
    expect(cloudflareAdapter.kind).toBe('cloudflare')
  })
})
