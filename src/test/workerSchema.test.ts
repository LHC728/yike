// @vitest-environment node
/**
 * Cloudflare D1 建表脚本的静态校验。
 *
 * 与 supabase 版的 schema.test.ts 是一对：
 * 那边用文本断言钉住 RLS 与 RPC，这边除了钉触发器，还多做一件事 ——
 * **逐列比对两套后端的表结构是否一致**。
 *
 * 为什么要比对：产品承诺「两套后端可以互换，客户端同步引擎不感知差别」。
 * 这句话很容易在半年后被一次「顺手加个字段」破坏：只改了 D1 没改 Supabase
 * （或反过来），于是换后端时某台设备的字段悄悄变空。列名集合一致是最低门槛，
 * 用测试钉住比写在文档里可靠。
 *
 * 这里还真的把 schema.sql 加载进 SQLite 跑一遍 ——
 * 语法写错、触发器写错，在这一步就会炸，而不是等到部署时才发现。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './sqliteD1'

const d1Sql = readFileSync(resolve(process.cwd(), 'worker/schema.sql'), 'utf8').toLowerCase()
const pgSql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0001_init.sql'),
  'utf8',
).toLowerCase()
const pgMigrationSql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0002_project_type.sql'),
  'utf8',
).toLowerCase()
const pgMigration3Sql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0003_log_type.sql'),
  'utf8',
).toLowerCase()

/** 从 Postgres 建表语句里抠出列名 */
function pgColumns(table: string): string[] {
  const match = new RegExp(
    `create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`,
  ).exec(pgSql)
  const body = match?.[1]
  if (body === undefined) throw new Error(`没找到 public.${table} 的建表语句`)
  const columns = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('--'))
    .map((line) => line.split(/\s+/)[0] ?? '')

  // 0002 / 0003 之后，真表结构 = 0001 的建表语句 + 后续每一次迁移里的
  // add column。只读 0001 会得出「D1 多出几列」的假警报 —— 而真实原因是迁移。
  for (const migration of [pgMigrationSql, pgMigration3Sql]) {
    const added = migration.matchAll(
      new RegExp(`alter table public\\.${table} add column if not exists (\\w+)`, 'g'),
    )
    for (const item of added) {
      const name = item[1]
      if (name !== undefined && !columns.includes(name)) columns.push(name)
    }
  }
  return columns
}

/** 从真实 SQLite 里读出 D1 的列名 */
function d1Columns(table: string): string[] {
  const db = createSqliteD1()
  try {
    return db.rows<{ name: string }>(`pragma table_info(${table})`).map((row) => row.name)
  } finally {
    db.close()
  }
}

// =====================================================================
describe('schema.sql 能被 SQLite 加载', () => {
  it('四张表都建出来了', () => {
    const db = createSqliteD1()
    const names = db
      .rows<{ name: string }>("select name from sqlite_master where type = 'table'")
      .map((row) => row.name)
    db.close()

    for (const table of ['users', 'access_tokens', 'records', 'applied_mutations']) {
      expect(names).toContain(table)
    }
  })

  it('四个触发器都建出来了（名字与顺序都钉住）', () => {
    const db = createSqliteD1()
    const names = db
      .rows<{ name: string }>("select name from sqlite_master where type = 'trigger' order by name")
      .map((row) => row.name)
    db.close()

    expect(names.toSorted()).toEqual([
      'applied_mutations_no_rewrite',
      'records_created_fields_immutable',
      'records_no_hard_delete',
      'records_version_must_increase',
    ])
  })
})

describe('★ 两套后端的表结构必须一致（否则「可互换」是句空话）', () => {
  it('records 的列名逐列相同', () => {
    expect(d1Columns('records').toSorted()).toEqual(pgColumns('records').toSorted())
  })

  it('applied_mutations 的列名逐列相同', () => {
    expect(d1Columns('applied_mutations').toSorted()).toEqual(pgColumns('applied_mutations').toSorted())
  })

  it('records 的四个索引名与 Supabase 版一致', () => {
    const db = createSqliteD1()
    const names = db
      .rows<{ name: string }>(
        "select name from sqlite_master where type = 'index' and tbl_name = 'records'",
      )
      .map((row) => row.name)
    db.close()

    for (const index of [
      'records_user_id_idx',
      'records_user_local_date_idx',
      'records_user_type_idx',
      'records_user_server_updated_idx',
    ]) {
      expect(names).toContain(index)
      expect(pgSql).toContain(index)
    }
  })

  it('type 允许 idea / todo / project / log 四种', () => {
    expect(d1Sql).toContain("check (type in ('idea', 'todo', 'project', 'log'))")
    // Supabase 那边是 0003 用 alter 放宽的约束
    expect(pgMigration3Sql).toContain("check (type in ('idea', 'todo', 'project', 'log'))")
  })

  it('大事与进展的字段两端都有，且约束一致', () => {
    for (const sql of [d1Sql, pgMigration3Sql]) {
      expect(sql).toContain('progress')
      expect(sql).toContain('deadline_local_date')
      expect(sql).toContain('parent_id')
    }
    const columns = d1Columns('records')
    for (const column of ['progress', 'deadline_local_date', 'parent_id']) {
      expect(columns).toContain(column)
    }

    // 「哪种类型能带哪个字段」这三条红线两端都要有
    expect(d1Sql).toContain("check (type = 'project' or deadline_local_date is null)")
    expect(d1Sql).toContain("check (type in ('project', 'log') or progress is null)")
    expect(d1Sql).toContain("check (type = 'log' or parent_id is null)")
    for (const constraint of [
      'records_deadline_project_only',
      'records_progress_project_or_log',
      'records_parent_log_only',
    ]) {
      expect(pgMigration3Sql).toContain(constraint)
    }
    // 0002 那条大 CHECK 必须被 0003 拆掉 —— 不拆的话 log 带进度会被它拦住，
    // 而进展记的恰恰就是「写下这条时的进度」。
    expect(pgMigration3Sql).toContain('drop constraint if exists records_project_fields_only')
  })

  it('进度范围约束两端都有', () => {
    expect(d1Sql).toContain('check (progress is null or (progress between 0 and 100))')
    expect(pgMigrationSql).toContain('check (progress is null or (progress between 0 and 100))')
  })

  it('两端都把 version 默认成 1', () => {
    expect(d1Sql).toContain('version            integer not null default 1')
    expect(pgSql).toContain('version            bigint not null default 1')
  })
})

describe('产品红线写成了数据库约束', () => {
  it('1. 物理删除被触发器禁掉', () => {
    expect(d1Sql).toContain('create trigger records_no_hard_delete')
    expect(d1Sql).toContain('before delete on records')
    expect(d1Sql).toContain("select raise(abort, 'records_must_be_soft_deleted')")
  })

  it('2. 创建时间与身份字段永不改变', () => {
    expect(d1Sql).toContain('create trigger records_created_fields_immutable')
    for (const column of [
      'new.created_at_utc     is not old.created_at_utc',
      'new.created_local_date is not old.created_local_date',
      'new.created_timezone   is not old.created_timezone',
      'new.id                 is not old.id',
      'new.user_id            is not old.user_id',
      'new.type               is not old.type',
      'new.parent_id          is not old.parent_id',
    ]) {
      expect(d1Sql).toContain(column)
    }
    expect(d1Sql).toContain("select raise(abort, 'created_fields_are_immutable')")
  })

  it('3. version 单调递增', () => {
    expect(d1Sql).toContain('create trigger records_version_must_increase')
    expect(d1Sql).toContain('when new.version <= old.version')
    expect(d1Sql).toContain("select raise(abort, 'version_must_increase')")
  })

  it('4. 幂等结果一旦落定不可改写', () => {
    expect(d1Sql).toContain('create trigger applied_mutations_no_rewrite')
    expect(d1Sql).toContain('when old.result_version > 0')
    expect(d1Sql).toContain("select raise(abort, 'mutation_result_is_final')")
  })
})

describe('令牌安全', () => {
  it('库里只有 token_hash，没有明文令牌列', () => {
    const columns = d1Columns('access_tokens')
    expect(columns).toContain('token_hash')
    expect(columns).not.toContain('token')
    expect(columns).not.toContain('plain_token')
  })

  it('令牌可吊销（有 revoked_at）', () => {
    expect(d1Columns('access_tokens')).toContain('revoked_at')
  })

  it('注释里说明了只存 SHA-256', () => {
    expect(d1Sql).toContain('sha-256')
  })
})

describe('注释与实现不许漂移', () => {
  it('applied_mutations 的注释讲的是 changes()，不是已经废弃的「占位行」方案', () => {
    // 曾经这里写着「先插入负数版本号的占位行抢所有权」，
    // 但代码从未那样实现 —— 这种漂移比没注释更误导人。
    expect(d1Sql).toContain('changes()')
    expect(d1Sql).not.toContain('result_version 为负数')
  })

  it('注释里没有留下未替换的占位符', () => {
    expect(d1Sql).not.toMatch(/todo:|fixme|xxx|replace_with/i)
  })
})
