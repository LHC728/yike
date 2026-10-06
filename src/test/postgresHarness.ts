import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

export const A = '11111111-1111-4111-8111-111111111111'
export const B = '22222222-2222-4222-8222-222222222222'
export const PROJECT = '33333333-3333-4333-8333-333333333333'
export const LOG = '44444444-4444-4444-8444-444444444444'
export const ORPHAN = '55555555-5555-4555-8555-555555555555'
export const FOREIGN = '66666666-6666-4666-8666-666666666666'
const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8')
const history = ['0001_init.sql', '0002_project_type.sql', '0003_log_type.sql']
export let db: PGlite

export async function boot(): Promise<void> {
  db = new PGlite({ extensions: { pgcrypto } })
  await db.exec(`
    set timezone = 'UTC';
    create role authenticated nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    create publication supabase_realtime;
    grant usage on schema public, auth to authenticated;
    insert into auth.users values ('${A}','a@example.com'),('${B}','b@example.com');
  `)
  for (const file of history) await db.exec(read(`supabase/migrations/${file}`))
  // grant CRUD 让测试真正经过 RLS；不能靠未授权或以表 owner 身份测试来假装隔离已通过。
  await db.exec('grant select,insert,update,delete on public.records,public.applied_mutations to authenticated')
}

export async function asUser<T>(sql: string, params: (string | number | null)[] = [], userId = A) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role authenticated')
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [userId])
    return tx.query<T>(sql, params)
  })
}

interface RpcData {
  status: string
  version: number | null
  record: Record<string, unknown> | null
}
export async function rpc(
  recordId: string,
  operation = 'create',
  version: number | null = null,
  payload: Record<string, unknown> = {},
  mutationId = randomUUID(),
  userId = A,
): Promise<RpcData> {
  const result = await asUser<{ result: RpcData }>(
    'select public.apply_record_mutation($1::uuid,$2::uuid,$3,$4::bigint,$5::jsonb) as result',
    [mutationId, recordId, operation, version, JSON.stringify(payload)], userId,
  )
  const value = result.rows[0]?.result
  if (!value) throw new Error('expected_rpc_result')
  return value
}

export async function seed(): Promise<void> {
  await rpc(PROJECT, 'create', null, { type: 'project', content: '迁移前的大事', progress: 39, deadlineLocalDate: '2026-12-31', createdAtUtc: '2026-10-01T01:02:03.456Z', createdLocalDate: '2026-10-01', createdTimezone: 'Asia/Shanghai' })
  await rpc(LOG, 'create', null, { type: 'log', parentId: PROJECT, progress: 62, content: '已有的进展和墓碑', createdAtUtc: '2026-10-02T01:02:03.123456+00:00', createdLocalDate: '2026-10-02', createdTimezone: 'Asia/Shanghai', deletedAtUtc: '2026-10-04T00:00:00Z' })
  await rpc(ORPHAN, 'create', null, { type: 'log', parentId: null, content: '历史NULL父级' })
  await rpc(FOREIGN, 'create', null, { content: 'B的私密记录' }, randomUUID(), B)
}

export async function applyMigration(file: string): Promise<void> {
  await db.exec(read(`supabase/migrations/${file}`))
}
