// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, boot, applyMigration, rpc, seed, PROJECT, LOG } from './postgresHarness'
import { INVALID_CREATION_FIELDS, VALID_CREATION_DATES, VALID_CREATION_TIMEZONES, VALID_CREATION_UTC } from './creationContractCases'
import { isValidCreationTimezone } from '../../worker/src/creationValidation'

async function invariants(): Promise<void> {
  await applyMigration('0004_creation_validation.sql')
}

beforeEach(async () => { await boot() })
afterEach(async () => { await db.close() })

describe('R21：两端共用创建事实case表', () => {
  it('独立0004前向迁移逐列保留存量records、applied_mutations与索引', async () => {
    // 先用历史1→3写入真实非空库，再迁移；新库通过不能证明旧进度、父级与墓碑安全。
    await seed()
    const records = await db.query<{ row: Record<string, unknown> }>('select to_jsonb(r) as row from public.records r order by id')
    const mutations = await db.query('select to_jsonb(m) as row from public.applied_mutations m order by mutation_id')
    const indexes = await db.query("select indexname,indexdef from pg_indexes where schemaname='public' order by indexname")
    expect(records.rows).toHaveLength(4)
    expect(mutations.rows).toHaveLength(4)
    expect(indexes.rows.length).toBeGreaterThan(0)
    expect(records.rows.find(({ row }) => row['id'] === PROJECT)?.row).toMatchObject({
      type: 'project', progress: 39, deadline_local_date: '2026-12-31', created_timezone: 'Asia/Shanghai',
    })
    expect(records.rows.find(({ row }) => row['id'] === LOG)?.row).toMatchObject({
      type: 'log', progress: 62, parent_id: PROJECT,
      created_at_utc: '2026-10-02T01:02:03.123456+00:00', deleted_at_utc: '2026-10-04T00:00:00+00:00',
    })
    await invariants()
    expect((await db.query('select to_jsonb(r) as row from public.records r order by id')).rows).toEqual(records.rows)
    expect((await db.query('select to_jsonb(m) as row from public.applied_mutations m order by mutation_id')).rows).toEqual(mutations.rows)
    expect((await db.query("select indexname,indexdef from pg_indexes where schemaname='public' order by indexname")).rows).toEqual(indexes.rows)
  })

  for (const [field, value] of INVALID_CREATION_FIELDS) {
    it(`拒绝 ${field}=${String(value)} 且记录/幂等两表均不新增`, async () => {
      await invariants()
      const recordId = randomUUID(), mutationId = randomUUID()
      await expect(rpc(recordId, 'create', null, { [field]: value }, mutationId)).rejects.toMatchObject({ code: '22023' })
      expect((await db.query('select id from public.records where id=$1::uuid',[recordId])).rows).toEqual([])
      expect((await db.query('select mutation_id from public.applied_mutations where mutation_id=$1::uuid',[mutationId])).rows).toEqual([])
    })
  }

  it('合法IANA别名保留原字符串', async () => {
    await invariants()
    for (const timezone of VALID_CREATION_TIMEZONES) {
      const result = await rpc(randomUUID(), 'create', null, { createdAtUtc:'2024-02-29T23:59:59.123456+00:00',createdLocalDate:'2024-02-29',createdTimezone:timezone })
      expect(result.status).toBe('applied')
      expect(result.record?.['created_timezone']).toBe(timezone)
    }
  })

  it('合法UTC边界年、微秒与+00:00仍可用', async () => {
    await invariants()
    for (const createdAtUtc of VALID_CREATION_UTC) {
      expect((await rpc(randomUUID(), 'create', null, { createdAtUtc })).status).toBe('applied')
    }
  })

  it('合法纯日期边界年与闰日原样保留', async () => {
    await invariants()
    for (const createdLocalDate of VALID_CREATION_DATES) {
      const result = await rpc(randomUUID(), 'create', null, { createdLocalDate })
      expect(result.status).toBe('applied')
      expect(result.record?.['created_local_date']).toBe(createdLocalDate)
    }
  })

  it('缺字段或JSON null沿用历史默认值', async () => {
    await invariants()
    for (const payload of [{}, { createdAtUtc: null, createdLocalDate: null, createdTimezone: null }]) {
      const result = await rpc(randomUUID(), 'create', null, payload)
      expect(result.status).toBe('applied')
      expect(result.record?.['created_timezone']).toBe('UTC')
      expect(result.record?.['updated_timezone']).toBeNull()
      const timestamp = result.record?.['created_at_utc']
      if (typeof timestamp !== 'string') throw new Error('missing_created_timestamp')
      expect(result.record?.['created_local_date']).toBe(timestamp.slice(0, 10))
    }
  })

  it('已应用的旧ID先幂等返回，重新提交非法创建字段不能破坏其确认', async () => {
    await invariants()
    const mutationId=randomUUID(),recordId=randomUUID()
    await rpc(recordId,'create',null,{content:'已有记录'},mutationId)
    const result=await rpc(recordId,'create',null,{createdAtUtc:'invalid',createdTimezone:'invalid/zone'},mutationId)
    expect(result).toMatchObject({status:'already_applied',version:1})
    expect(result.record?.['content']).toBe('已有记录')
  })

  it('非法created字段在已有记录更新中被忽略，创建校验不会改写旧协议更新语义', async () => {
    await invariants()
    const recordId = randomUUID()
    const created = await rpc(recordId, 'create', null, { createdAtUtc: '2026-10-06T00:00:00Z', createdLocalDate: '2026-10-06', createdTimezone: 'Asia/Shanghai' })
    const updated = await rpc(recordId, 'update', 1, { content: '合法更新', createdAtUtc: 'bad', createdLocalDate: 'bad', createdTimezone: 'invalid/zone' })
    expect(updated).toMatchObject({ status: 'applied', version: 2 })
    for (const field of ['created_at_utc', 'created_local_date', 'created_timezone']) expect(updated.record?.[field]).toBe(created.record?.[field])
  })

  it('禁止POSIX/right和无slash缩写；大小写与Etc/US历史别名按原字符串保留', async () => {
    await invariants()
    for (const createdTimezone of ['posix/Asia/Shanghai', 'right/UTC', 'PST', 'Asia//Shanghai']) {
      await expect(rpc(randomUUID(), 'create', null, { createdTimezone })).rejects.toMatchObject({ code: '22023' })
    }
    for (const createdTimezone of ['utc', 'gmt', 'asia/shanghai', 'Etc/GMT+8', 'US/Eastern']) {
      const result = await rpc(randomUUID(), 'create', null, { createdTimezone })
      expect(result.record?.['created_timezone']).toBe(createdTimezone)
    }
  })

  it('从PG时区全集逐一对照D1运行时，保留别名并及时发现两端tzdata漂移', async () => {
    await invariants()
    const zones = await db.query<{ name: string }>('select name from pg_timezone_names order by name')
    const allowedPgNames = zones.rows.map(row => row.name).filter(name =>
      /^(?:UTC|GMT|[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/i.test(name) && !/^(?:posix|right)\//i.test(name),
    )
    expect(allowedPgNames.length).toBeGreaterThan(400)
    const pgOnly = allowedPgNames.filter(name => !isValidCreationTimezone(name))
    expect(pgOnly).toEqual([])
    const allPgNames = new Set(zones.rows.map(row => row.name.toLowerCase()))
    const intlOnly = Intl.supportedValuesOf('timeZone').filter(name => isValidCreationTimezone(name) && !allPgNames.has(name.toLowerCase()))
    expect(intlOnly).toEqual([])
  })
})
