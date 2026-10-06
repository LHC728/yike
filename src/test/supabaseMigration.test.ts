// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, boot, applyMigration, asUser, rpc, seed, B, PROJECT, LOG, ORPHAN, FOREIGN } from './postgresHarness'

async function invariants(): Promise<void> {
  await applyMigration('0004_creation_validation.sql')
  await applyMigration('0005_record_invariants.sql')
}

beforeEach(async () => { await boot() })
afterEach(async () => { await db.close() })

describe('R19：真实 PostgreSQL + 非owner authenticated', () => {
  it('测试角色非superuser、非BYPASSRLS、非表owner，并只读到自己行', async () => {
    await seed()
    await invariants()
    const role = await asUser<{ role: string; superuser: boolean; bypass: boolean; owner: string }>(`
      select current_user as role, r.rolsuper as superuser, r.rolbypassrls as bypass,
        (select tableowner from pg_tables where schemaname='public' and tablename='records') as owner
      from pg_roles r where r.rolname=current_user
    `)
    expect(role.rows[0]).toMatchObject({ role: 'authenticated', superuser: false, bypass: false })
    expect(role.rows[0]?.owner).not.toBe('authenticated')
    expect((await asUser<{ id: string }>('select id from public.records')).rows.map(row => row.id)).not.toContain(FOREIGN)
    expect((await asUser('update public.records set content=\'越权修改\' where id=$1::uuid returning id', [FOREIGN])).rows).toEqual([])
    expect((await asUser('delete from public.records where id=$1::uuid returning id', [LOG])).rows).toEqual([])
    expect((await rpc(FOREIGN, 'update', 1, { content: '越权' })).status).toBe('record_not_found')
  })

  it('独立0005前向迁移逐列保留records、applied_mutations和索引，不触发数据更新时间', async () => {
    await seed()
    await applyMigration('0004_creation_validation.sql')
    const records = await db.query('select to_jsonb(r) as row from public.records r order by id')
    const mutations = await db.query('select to_jsonb(m) as row from public.applied_mutations m order by mutation_id')
    const indexes = await db.query("select indexname,indexdef from pg_indexes where schemaname='public' order by indexname")
    await applyMigration('0005_record_invariants.sql')
    expect((await db.query('select to_jsonb(r) as row from public.records r order by id')).rows).toEqual(records.rows)
    expect((await db.query('select to_jsonb(m) as row from public.applied_mutations m order by mutation_id')).rows).toEqual(mutations.rows)
    expect((await db.query("select indexname,indexdef from pg_indexes where schemaname='public' order by indexname")).rows).toEqual(indexes.rows)
  })

  it('非表owner的authenticated不能改写或删除自己的已应用流水，流水逐列原样', async () => {
    await seed()
    await invariants()
    const ownBefore = await asUser('select to_jsonb(m) as row from public.applied_mutations m order by mutation_id')
    const allBefore = await db.query('select to_jsonb(m) as row from public.applied_mutations m order by mutation_id')
    expect(ownBefore.rows).toHaveLength(3)
    expect(allBefore.rows).toHaveLength(4)
    // 已授予 CRUD；零行来自真实 RLS 缺少 UPDATE/DELETE 策略，不能用权限错误假装保护已生效。
    const rewritten = await asUser("update public.applied_mutations set result_version=99,applied_at='2025-01-01T00:00:00Z' where user_id=auth.uid() returning mutation_id")
    const deleted = await asUser('delete from public.applied_mutations where user_id=auth.uid() returning mutation_id')
    expect(rewritten.rows).toEqual([])
    expect(rewritten.affectedRows).toBe(0)
    expect(deleted.rows).toEqual([])
    expect(deleted.affectedRows).toBe(0)
    expect((await asUser('select to_jsonb(m) as row from public.applied_mutations m order by mutation_id')).rows).toEqual(ownBefore.rows)
    expect((await db.query('select to_jsonb(m) as row from public.applied_mutations m order by mutation_id')).rows).toEqual(allBefore.rows)
  })

  for (const assignment of [
    "id='77777777-7777-4777-8777-777777777777'::uuid", `user_id='${B}'::uuid`, "type='idea'",
    "created_at_utc='2025-01-01T00:00:00Z'::timestamptz", "created_local_date='2025-01-01'::date", "created_timezone='UTC'",
    'parent_id=null', "parent_id='77777777-7777-4777-8777-777777777777'::uuid",
  ]) {
    it(`直接更新拒绝不可变字段：${assignment}`, async () => {
      await seed()
      await invariants()
      await expect(asUser(`update public.records set ${assignment},version=version+1 where id=$1::uuid`, [LOG])).rejects.toMatchObject({ code: '23514' })
      expect((await asUser<{ content: string }>('select content from public.records where id=$1::uuid', [LOG])).rows[0]?.content).toBe('已有的进展和墓碑')
    })
  }

  it('NULL父级也不能后挂；相同NULL和相同非NULL保持可正常更新', async () => {
    await seed()
    await invariants()
    await expect(asUser('update public.records set parent_id=$1::uuid,version=version+1 where id=$2::uuid', [PROJECT, ORPHAN])).rejects.toMatchObject({ code: '23514' })
    await asUser('update public.records set parent_id=parent_id,content=\'正常修改\' where id=$1::uuid', [LOG])
    await asUser('update public.records set parent_id=null,content=\'NULL不变\' where id=$1::uuid', [ORPHAN])
    expect((await asUser<{ version: string | number }>('select version from public.records where id=$1::uuid', [LOG])).rows.map(row => Number(row.version))).toEqual([2])
  })

  it('较低version拒绝；未显式提升版本的自有UPDATE自动+1，RPC显式+1不会重复加', async () => {
    await seed()
    await invariants()
    await asUser('update public.records set version=5 where id=$1::uuid', [PROJECT])
    await expect(asUser('update public.records set version=1,content=\'旧版本\' where id=$1::uuid', [PROJECT])).rejects.toMatchObject({ code: '23514' })
    await asUser('update public.records set content=\'合法直接修改\' where id=$1::uuid', [PROJECT])
    const changed = await rpc(PROJECT, 'update', 6, { content: 'RPC修改' })
    expect(changed).toMatchObject({ status: 'applied', version: 7 })
  })

  it('正常软删/恢复、版本冲突与同ID重试保留原RPC语义', async () => {
    await seed()
    await invariants()
    const mutationId = randomUUID()
    const applied = await rpc(PROJECT, 'delete', 1, { deletedAtUtc: '2026-10-06T00:00:00Z' }, mutationId)
    expect(applied).toMatchObject({ status: 'applied', version: 2 })
    const retried = await rpc(PROJECT, 'delete', 1, { deletedAtUtc: 'bad' }, mutationId)
    expect(retried).toMatchObject({ status: 'already_applied', version: 2 })
    expect((await rpc(PROJECT, 'update', 1, { content: '过期' })).status).toBe('version_conflict')
    const restored = await rpc(PROJECT, 'update', 2, { deletedAtUtc: null })
    expect(restored.record?.['deleted_at_utc']).toBeNull()
    expect(restored.version).toBe(3)
  })
})
