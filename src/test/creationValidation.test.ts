// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import worker from '../../worker/src/index'
import { applyMutation } from '../../worker/src/core'
import { createSqliteD1, seedUser, type SqliteD1 } from './sqliteD1'
import { INVALID_CREATION_FIELDS, VALID_CREATION_DATES, VALID_CREATION_TIMEZONES, VALID_CREATION_UTC } from './creationContractCases'

const USER = 'creation-user'
const TOKEN = 'token-creation-aaaaaaaaaaaaaaaaaaaaaaaa'
const NOW = '2026-10-06T02:00:00.000Z'
let db: SqliteD1

beforeEach(async () => {
  db = createSqliteD1()
  await seedUser(db, { userId: USER, token: TOKEN })
})
afterEach(() => { db.close() })

function body(fields: Record<string, unknown>, mutationId = 'creation-m', recordId = 'creation-r') {
  return { mutationId, recordId, operation: 'create' as const, expectedVersion: null, payload: fields }
}

function payload(): Record<string, unknown> {
  return { type: 'idea', content: '保留创建事实', createdAtUtc: '2026-10-06T01:00:00.000Z',
    createdTimezone: 'Asia/Shanghai', createdLocalDate: '2026-10-06' }
}

async function call(input: ReturnType<typeof body>): Promise<Response> {
  return worker.fetch(new Request('https://draft.invalid/api/sync/mutate', {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }), { DB: db })
}

describe('非法提供值不允许污染不可变字段', () => {
  it.each(INVALID_CREATION_FIELDS)('%s=%j 返回 HTTP 400，两张数据表都不新增', async (field, value) => {
    const response = await call(body({ ...payload(), [field]: value }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_creation_fields', field })
    expect(db.row<{ count: number }>('select count(*) as count from records')?.count).toBe(0)
    expect(db.row<{ count: number }>('select count(*) as count from applied_mutations')?.count).toBe(0)
  })
})

describe('兼容旧协议、有效历史值和幂等顺序', () => {
  it.each(['missing', 'null'] as const)('%s 创建字段保持已有默认，不影响旧客户端', async (mode) => {
    const input = mode === 'missing'
      ? { type: 'idea', content: '旧协议' }
      : { type: 'idea', content: '旧协议', createdAtUtc: null, createdLocalDate: null, createdTimezone: null }
    const result = await applyMutation(db, USER, body(input), NOW)
    expect(result.status).toBe('applied')
    expect(result.record).toMatchObject({ createdAtUtc: NOW, createdLocalDate: '2026-10-06', createdTimezone: 'UTC' })
  })

  it.each(VALID_CREATION_UTC)('有效 UTC 创建时刻 %s 保留原字符串，不被 now 顶替', async (value) => {
    const result = await applyMutation(db, USER, body({ ...payload(), createdAtUtc: value }), NOW)
    expect(result.status).toBe('applied')
    expect(result.record?.createdAtUtc).toBe(value)
  })

  it.each(VALID_CREATION_DATES)('有效历史日期 %s 原样归档', async (value) => {
    const result = await applyMutation(db, USER, body({ ...payload(), createdLocalDate: value }), NOW)
    expect(result.status).toBe('applied')
    expect(result.record?.createdLocalDate).toBe(value)
  })

  it.each(VALID_CREATION_TIMEZONES)('有效常用时区或别名 %s 保留原字符串', async (value) => {
    const result = await applyMutation(db, USER, body({ ...payload(), createdTimezone: value }), NOW)
    expect(result.status).toBe('applied')
    expect(result.record?.createdTimezone).toBe(value)
  })

  it('同 ID 已应用后，新 payload 非法也先返回 already_applied，不能改历史事实', async () => {
    const first = await applyMutation(db, USER, body(payload()), NOW)
    const repeated = await call(body({ ...payload(), createdAtUtc: 'not-a-date', createdLocalDate: '2026-99-99', createdTimezone: {} }))
    expect(repeated.status).toBe(200)
    expect(await repeated.json()).toMatchObject({ status: 'already_applied', version: 1 })
    expect(await applyMutation(db, USER, body(payload()), NOW)).toEqual({ ...first, status: 'already_applied' })
    expect(db.row<{ count: number }>('select count(*) as count from applied_mutations')?.count).toBe(1)
    expect(db.row<{ created_at_utc: string }>('select created_at_utc from records')?.created_at_utc).toBe(payload().createdAtUtc)
  })

  it('已有记录的 update 忽略创建字段，不能用校验改写原创建事实', async () => {
    await applyMutation(db, USER, body(payload()), NOW)
    const result = await applyMutation(db, USER, {
      mutationId: 'update-m', recordId: 'creation-r', operation: 'update', expectedVersion: 1,
      payload: { content: '修改正文', createdAtUtc: 'bad', createdLocalDate: '', createdTimezone: {} },
    }, NOW)
    expect(result.status).toBe('applied')
    expect(result.record).toMatchObject({ content: '修改正文', createdAtUtc: payload().createdAtUtc,
      createdLocalDate: payload().createdLocalDate, createdTimezone: payload().createdTimezone })
  })
})
