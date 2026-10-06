// @vitest-environment node
/**
 * D1 迁移的验证 —— 在**真实 SQLite** 上，从老 schema + 真实数据一路跑到新 schema。
 *
 * 为什么必须单独测这个文件：
 *   0002（大事）与 0003（进展）都是**需要重建 records 表**的迁移
 *   （SQLite 改不了 CHECK 约束）。重建表 = drop 触发器 + rename + 建新表 +
 *   搬数据 + drop 旧表 + 重建索引和触发器。这里面任何一步写漏都**不会报错**：
 *     · 索引忘了重建  → 查询悄悄退化成全表扫描，功能看着一切正常
 *     · 触发器忘了重建 → 「创建时间不可变」「只能软删除」这些红线**直接消失**
 *     · 列顺序写错    → 数据静默串列（content 里装着时间戳）
 *     · 搬数据时漏带某一列 → 用户的大事进度**凭空归零**，而且没有报错
 *   这些错人工核对都看不出来，所以必须让机器逐条验。
 *
 * 另外这里还钉住两件事：
 *   ① **迁移后的表结构必须与全新安装（schema.sql）逐列一致**。否则
 *      「老用户升级上来的库」和「新用户的库」会长得不一样，而这种差异
 *      通常要到几个月后某个查询出错才会暴露。
 *   ② **冻结副本没有被跟着改**。如果哪天有人顺手把 __fixtures__ 里的
 *      老 schema 更新成新的，这个文件就变成「拿新表结构测新表结构」，
 *      彻底失去意义 —— 所以下面有一组用例专门盯住它。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

const SCHEMA = readFileSync(resolve(process.cwd(), 'worker/schema.sql'), 'utf8')

/**
 * ⚠️ 这三个都是**冻结副本**（连 users / access_tokens / applied_mutations
 * 和全部触发器一起），作为迁移测试的输入。
 * 它们是历史事实，**永远不要跟着 worker/schema.sql 一起改** ——
 * 改了就等于拿新表结构去测新表结构。
 *
 * 只留一张 records 表的残缺样本会得出「触发器数量不一致」「索引集合不一致」
 * 这种假警报 —— 实测踩过。
 */
const LEGACY_0001 = readFileSync(
  resolve(process.cwd(), 'worker/migrations/__fixtures__/schema-0001.sql'),
  'utf8',
)
const FROZEN_0002 = readFileSync(
  resolve(process.cwd(), 'worker/migrations/__fixtures__/schema-0002.sql'),
  'utf8',
)
const FROZEN_0003 = readFileSync(
  resolve(process.cwd(), 'worker/migrations/__fixtures__/schema-0003.sql'),
  'utf8',
)

const MIGRATION_0002 = readFileSync(
  resolve(process.cwd(), 'worker/migrations/0002_project_type.sql'),
  'utf8',
)
const MIGRATION_0003 = readFileSync(
  resolve(process.cwd(), 'worker/migrations/0003_log_type.sql'),
  'utf8',
)

const MIGRATION_0004 = readFileSync(resolve(process.cwd(), 'worker/migrations/0004_record_invariants.sql'), 'utf8')

/** 线上库里的真实形态：活的 idea、活的 todo、一条软删除的墓碑 */
const SEED = [
  { id: 'r-idea', type: 'idea', content: '一个点子', deleted: null, version: 3 },
  { id: 'r-todo', type: 'todo', content: '一件事', deleted: null, version: 1 },
  {
    id: 'r-gone',
    type: 'idea',
    content: '删掉的',
    deleted: '2026-09-29T00:00:00.000Z',
    version: 5,
  },
]

function insertLegacy(
  db: DatabaseSync,
  row: (typeof SEED)[number],
): void {
  db.prepare(
    `insert into records (
       id, user_id, type, content,
       created_at_utc, created_timezone, created_local_date,
       updated_at_utc, updated_timezone,
       completed_at_utc, completed_timezone, deleted_at_utc,
       version, server_updated_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    'u-1',
    row.type,
    row.content,
    '2026-09-30T01:00:00.000Z',
    'Asia/Shanghai',
    '2026-09-30',
    '2026-09-30T01:00:00.000Z',
    'Asia/Shanghai',
    null,
    null,
    row.deleted,
    row.version,
    '2026-09-30T01:00:00.000Z',
  )
}

/** 0002 之后才存在的形状：大事带进度与截止日 */
function insertProject(db: DatabaseSync, id: string, progress: number, deadline: string): void {
  db.prepare(
    `insert into records (
       id, user_id, type, content, progress, deadline_local_date,
       created_at_utc, created_timezone, created_local_date,
       updated_at_utc, updated_timezone,
       completed_at_utc, completed_timezone, deleted_at_utc,
       version, server_updated_at
     ) values (?, 'u-1', 'project', '毕业论文', ?, ?,
       '2026-10-01T01:00:00.000Z', 'Asia/Shanghai', '2026-10-01',
       '2026-10-01T01:00:00.000Z', 'Asia/Shanghai',
       null, null, null, 2, '2026-10-01T01:00:00.000Z')`,
  ).run(id, progress, deadline)
}

/** 0003 之后才存在的形状：进展挂在某件大事下，带当时的进度快照 */
function insertLog(db: DatabaseSync, id: string, parentId: string): void {
  db.prepare(
    `insert into records (
       id, user_id, type, content, progress, parent_id,
       created_at_utc, created_timezone, created_local_date,
       updated_at_utc, updated_timezone,
       completed_at_utc, completed_timezone, deleted_at_utc,
       version, server_updated_at
     ) values (?, 'u-1', 'log', '限位搞定了', 50, ?,
       '2026-10-02T01:00:00.000Z', 'Asia/Shanghai', '2026-10-02',
       '2026-10-02T01:00:00.000Z', 'Asia/Shanghai',
       null, null, null, 1, '2026-10-02T01:00:00.000Z')`,
  ).run(id, parentId)
}

/** 老库 + 真实数据 + 0002 —— 相当于「线上 2026-10-03 那天」的库 */
function dbAfter0002(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(LEGACY_0001)
  for (const row of SEED) insertLegacy(db, row)
  db.exec(MIGRATION_0002)
  return db
}

/** 全链：老库 + 真实数据 + 0002 + 0003 + 0004 */
function migratedDb(): DatabaseSync {
  const db = dbAfter0002()
  db.exec(MIGRATION_0003)
  db.exec(MIGRATION_0004)
  return db
}

/** 全新安装（等价于 createSqliteD1 的建库步骤，但要拿到原生 DatabaseSync） */
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  return db
}

function columns(db: DatabaseSync, table: string): string[] {
  return db.prepare(`pragma table_info(${table})`).all().map((row) => String(row['name']))
}

function names(db: DatabaseSync, type: string): string[] {
  return db
    .prepare(`select name from sqlite_master where type = ? and name not like 'sqlite_%' order by name`)
    .all(type)
    .map((row) => String(row['name']))
}

// =====================================================================
describe('迁移前：老库确实装不下 project（先确认这个前提成立）', () => {
  it('老表的 CHECK 约束会拒绝 project', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(LEGACY_0001)
    expect(() => insertLegacy(db, { id: 'r-p', type: 'project', content: 'x', deleted: null, version: 1 }))
      .toThrow(/constraint/i)
    db.close()
  })
})

describe('迁移后：数据一条不少、一列不串', () => {
  it('三条记录逐字段与迁移前完全一致', () => {
    const db = migratedDb()
    const rows = db
      .prepare(
        `select id, user_id, type, content, created_at_utc, created_timezone,
                created_local_date, updated_at_utc, updated_timezone,
                completed_at_utc, completed_timezone, deleted_at_utc,
                version, server_updated_at
           from records order by id`,
      )
      .all()

    expect(rows).toHaveLength(SEED.length)
    const byId = new Map(rows.map((row) => [String(row['id']), row]))
    for (const seed of SEED) {
      const row = byId.get(seed.id)
      expect(row?.['type']).toBe(seed.type)
      expect(row?.['content']).toBe(seed.content)
      expect(row?.['deleted_at_utc']).toBe(seed.deleted)
      expect(row?.['version']).toBe(seed.version)
      expect(row?.['created_local_date']).toBe('2026-09-30')
    }
    db.close()
  })

  it('新列存在，且老数据一律补成 null', () => {
    const db = migratedDb()
    for (const column of ['progress', 'deadline_local_date', 'parent_id']) {
      expect(columns(db, 'records')).toContain(column)
    }

    const rows = db.prepare('select progress, deadline_local_date, parent_id from records').all()
    for (const row of rows) {
      expect(row['progress']).toBeNull()
      expect(row['deadline_local_date']).toBeNull()
      expect(row['parent_id']).toBeNull()
    }
    db.close()
  })

  it('留底表 records_legacy 已被清掉（不留垃圾）', () => {
    const db = migratedDb()
    expect(names(db, 'table')).not.toContain('records_legacy')
    db.close()
  })
})

describe('迁移后：索引与触发器一个都不能少', () => {
  it('四个索引都还在，且挂在 records 上', () => {
    const db = migratedDb()
    const rows = db
      .prepare("select name, tbl_name from sqlite_master where type = 'index' and name not like 'sqlite_%'")
      .all()
    const map = new Map(rows.map((row) => [String(row['name']), String(row['tbl_name'])]))
    for (const index of [
      'records_user_id_idx',
      'records_user_local_date_idx',
      'records_user_type_idx',
      'records_user_server_updated_idx',
    ]) {
      expect(map.get(index)).toBe('records')
    }
    db.close()
  })

  it('四个触发器都重建了（一个都不能少）', () => {
    const db = migratedDb()
    expect(names(db, 'trigger')).toEqual([
      'applied_mutations_no_rewrite',
      'records_created_fields_immutable',
      'records_no_hard_delete',
      'records_version_must_increase',
    ])
    db.close()
  })
})

describe('★ 迁移后红线依然有效（触发器真的在工作，不是只建了个名字）', () => {
  it('物理删除依然被拒', () => {
    const db = migratedDb()
    expect(() => db.exec("delete from records where id = 'r-idea'")).toThrow(
      /records_must_be_soft_deleted/,
    )
    expect(db.prepare('select count(*) as n from records').get()?.['n']).toBe(SEED.length)
    db.close()
  })

  it('created_at / created_local_date / type 依然改不动', () => {
    const db = migratedDb()
    expect(() =>
      db.exec("update records set created_at_utc = '1999-01-01T00:00:00.000Z', version = 9 where id = 'r-idea'"),
    ).toThrow(/created_fields_are_immutable/)
    expect(() =>
      db.exec("update records set type = 'todo', version = 9 where id = 'r-idea'"),
    ).toThrow(/created_fields_are_immutable/)
    db.close()
  })

  it('version 依然必须单调递增', () => {
    const db = migratedDb()
    expect(() => db.exec("update records set content = 'x', version = 1 where id = 'r-idea'")).toThrow(
      /version_must_increase/,
    )
    // 正常 +1 必须放行 —— 否则就是「把红线做成了拦路虎」
    db.exec("update records set content = 'x', version = 4 where id = 'r-idea'")
    expect(db.prepare("select content from records where id = 'r-idea'").get()?.['content']).toBe('x')
    db.close()
  })
})

describe('迁移后：新能力真的可用', () => {
  it('可以插入 project，并带进度与截止日', () => {
    const db = migratedDb()
    db.prepare(
      `insert into records (
         id, user_id, type, content, progress, deadline_local_date,
         created_at_utc, created_timezone, created_local_date,
         updated_at_utc, updated_timezone,
         completed_at_utc, completed_timezone, deleted_at_utc,
         version, server_updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'r-project',
      'u-1',
      'project',
      '毕业论文',
      60,
      '2026-10-12',
      '2026-10-01T01:00:00.000Z',
      'Asia/Shanghai',
      '2026-10-01',
      '2026-10-01T01:00:00.000Z',
      'Asia/Shanghai',
      null,
      null,
      null,
      1,
      '2026-10-01T01:00:00.000Z',
    )

    const row = db.prepare("select progress, deadline_local_date from records where id = 'r-project'").get()
    expect(row?.['progress']).toBe(60)
    expect(row?.['deadline_local_date']).toBe('2026-10-12')
    db.close()
  })

  it('灵感 / 待办不许带进度和截止日（约束真的在拦）', () => {
    const db = migratedDb()
    expect(() =>
      db.exec(
        "update records set progress = 50, version = 9 where id = 'r-idea'",
      ),
    ).toThrow(/constraint/i)
    expect(() =>
      db.exec(
        "update records set deadline_local_date = '2026-10-12', version = 9 where id = 'r-todo'",
      ),
    ).toThrow(/constraint/i)
    db.close()
  })

  it('进度越界被拒（0–100 之外一律不接受）', () => {
    const db = migratedDb()
    db.exec(
      `insert into records (id, user_id, type, content, progress, created_at_utc,
         created_timezone, created_local_date, updated_at_utc, version, server_updated_at)
       values ('r-p', 'u-1', 'project', 'p', 50, '2026-10-01T00:00:00.000Z',
         'UTC', '2026-10-01', '2026-10-01T00:00:00.000Z', 1, '2026-10-01T00:00:00.000Z')`,
    )
    expect(() => db.exec("update records set progress = 140, version = 2 where id = 'r-p'")).toThrow(
      /constraint/i,
    )
    expect(() => db.exec("update records set progress = -1, version = 2 where id = 'r-p'")).toThrow(
      /constraint/i,
    )
    db.close()
  })
})

describe('★ 迁移结果必须与全新安装逐列一致', () => {
  it('records 的列名、类型、非空、默认值全部相同', () => {
    const migrated = migratedDb()
    const fresh = freshDb()

    const shape = (rows: Record<string, unknown>[]) =>
      rows
        .map((row) => ({
          name: String(row['name']),
          type: String(row['type']),
          notnull: Number(row['notnull']),
          dflt: row['dflt_value'] === null ? null : String(row['dflt_value']),
          pk: Number(row['pk']),
        }))
        .toSorted((a, b) => (a.name < b.name ? -1 : 1))

    expect(shape(migrated.prepare('pragma table_info(records)').all())).toEqual(
      shape(fresh.prepare('pragma table_info(records)').all()),
    )

    fresh.close()
    migrated.close()
  })

  it('触发器定义逐字相同（空白归一后）', () => {
    const migrated = migratedDb()
    const fresh = freshDb()

    const triggers = (db: DatabaseSync) =>
      db
        .prepare("select name, sql from sqlite_master where type = 'trigger' order by name")
        .all()
        .map((row) => [String(row['name']), String(row['sql']).replace(/\s+/g, ' ').trim()])

    expect(triggers(migrated)).toEqual(triggers(fresh))
    expect(triggers(migrated)).toHaveLength(4)

    fresh.close()
    migrated.close()
  })

  it('索引集合与全新安装一致', () => {
    const migrated = migratedDb()
    const fresh = freshDb()
    const indexNames = (db: DatabaseSync) =>
      db
        .prepare("select name from sqlite_master where type = 'index' and name not like 'sqlite_%' order by name")
        .all()
        .map((row) => String(row['name']))

    expect(indexNames(migrated)).toEqual(indexNames(fresh))

    fresh.close()
    migrated.close()
  })
})

// =====================================================================
describe('★ 0003 必须把大事的进度原样带过去（0002 那次只能补 null）', () => {
  /**
   * 这是 0003 最危险的一处：它和 0002 一样是「重建表 + 搬数据」，
   * 但搬的东西不一样 —— 0002 时 progress 是**刚加的新列**，补 null 是对的；
   * 0003 时线上已经有大事带着真实进度了，照抄 0002 的 `select null`
   * 会把用户填过的进度全部清零，而且**不报任何错**。
   */

  it('前提：0002 之后的库装不下 log（两处都挡着）', () => {
    const db = dbAfter0002()
    // 第一处：连 parent_id 这一列都还没有
    expect(() => insertLog(db, 'r-log', 'p-1')).toThrow(/no column named parent_id/i)
    // 第二处：type 的 CHECK 也不认 'log'
    expect(() =>
      db.exec(
        `insert into records (id, user_id, type, content,
           created_at_utc, created_timezone, created_local_date,
           updated_at_utc, version, server_updated_at)
         values ('r-log-2', 'u-1', 'log', 'x',
           '2026-10-02T00:00:00.000Z', 'UTC', '2026-10-02',
           '2026-10-02T00:00:00.000Z', 1, '2026-10-02T00:00:00.000Z')`,
      ),
    ).toThrow(/constraint/i)
    db.close()
  })

  it('前提：0002 之后的库里大事确实带着真实进度', () => {
    const db = dbAfter0002()
    insertProject(db, 'r-proj', 60, '2026-10-12')
    const row = db.prepare("select progress from records where id = 'r-proj'").get()
    expect(row?.['progress']).toBe(60)
    db.close()
  })

  it('跑完 0003，进度与截止日一个都没丢', () => {
    const db = dbAfter0002()
    insertProject(db, 'r-proj', 60, '2026-10-12')
    db.exec(MIGRATION_0003)
    db.exec(MIGRATION_0004)

    const row = db
      .prepare("select type, progress, deadline_local_date, parent_id from records where id = 'r-proj'")
      .get()
    expect(row?.['type']).toBe('project')
    expect(row?.['progress']).toBe(60)
    expect(row?.['deadline_local_date']).toBe('2026-10-12')
    // 老数据里不可能有 log，所以 parent_id 补 null 是对的
    expect(row?.['parent_id']).toBeNull()
    db.close()
  })

  it('跑完 0003，可以插入 log，并带 parentId 与进度快照', () => {
    const db = migratedDb()
    insertLog(db, 'r-log', 'p-1')

    const row = db
      .prepare("select type, progress, parent_id, deadline_local_date from records where id = 'r-log'")
      .get()
    expect(row?.['type']).toBe('log')
    expect(row?.['progress']).toBe(50)
    expect(row?.['parent_id']).toBe('p-1')
    expect(row?.['deadline_local_date']).toBeNull()
    db.close()
  })

  it('0003 之后：非 log 不许带 parent_id，log 不许带截止日', () => {
    const db = migratedDb()
    // 灵感带 parent_id
    expect(() =>
      db.exec(
        `insert into records (id, user_id, type, content, parent_id,
           created_at_utc, created_timezone, created_local_date,
           updated_at_utc, version, server_updated_at)
         values ('r-bad-1', 'u-1', 'idea', 'x', 'p-1',
           '2026-10-02T00:00:00.000Z', 'UTC', '2026-10-02',
           '2026-10-02T00:00:00.000Z', 1, '2026-10-02T00:00:00.000Z')`,
      ),
    ).toThrow(/constraint/i)
    // 进展带截止日
    expect(() =>
      db.exec(
        `insert into records (id, user_id, type, content, deadline_local_date, parent_id,
           created_at_utc, created_timezone, created_local_date,
           updated_at_utc, version, server_updated_at)
         values ('r-bad-2', 'u-1', 'log', 'x', '2026-10-12', 'p-1',
           '2026-10-02T00:00:00.000Z', 'UTC', '2026-10-02',
           '2026-10-02T00:00:00.000Z', 1, '2026-10-02T00:00:00.000Z')`,
      ),
    ).toThrow(/constraint/i)
    db.close()
  })
})

// =====================================================================
describe('★ 冻结副本没有被跟着改（否则这个文件会彻底失去意义）', () => {
  it('schema-0001.sql 里连 progress 都没有（那是 0002 才加的）', () => {
    expect(LEGACY_0001).not.toContain('progress')
    expect(LEGACY_0001).toContain("check (type in ('idea', 'todo'))")
  })

  it('schema-0002.sql 里有 progress，但没有 parent_id（那是 0003 才加的）', () => {
    expect(FROZEN_0002).toContain('progress')
    expect(FROZEN_0002).toContain("check (type in ('idea', 'todo', 'project'))")
    expect(FROZEN_0002).not.toContain('parent_id')
  })

  it('前两个副本都与当前 schema.sql 不同（说明它们真的是历史快照）', () => {
    expect(LEGACY_0001).not.toBe(SCHEMA)
    expect(FROZEN_0002).not.toBe(SCHEMA)
  })

  it('schema-0003仍保留上线时的NULL比较缺陷，不能跟着修成新触发器', () => {
    expect(FROZEN_0003).toMatch(/new\.parent_id\s+<>\s+old\.parent_id/)
    expect(FROZEN_0003).not.toMatch(/new\.parent_id\s+is not\s+old\.parent_id/)
    expect(FROZEN_0003).not.toBe(SCHEMA)
  })
})

describe('R18：0003存量库前向升级，不搬一行数据', () => {
  function seeded0003(): DatabaseSync {
    const db = new DatabaseSync(':memory:')
    db.exec(FROZEN_0003)
    insertProject(db, 'r-existing-project', 39, '2026-12-31')
    insertLog(db, 'r-existing-log', 'r-existing-project')
    insertLog(db, 'r-null-parent', 'r-existing-project')
    // 在旧库允许的NULL漏洞下构造历史形态；新迁移应保留它，只禁止再次改归属。
    db.exec("update records set parent_id=null,version=2 where id='r-null-parent'")
    db.exec("update records set progress=62,deleted_at_utc='2026-10-04T00:00:00.000Z',version=2 where id='r-existing-log'")
    db.exec("insert into applied_mutations(mutation_id,user_id,record_id,result_version,applied_at) values ('m-existing','u-1','r-existing-log',2,'2026-10-04T00:00:00.000Z')")
    return db
  }

  it('记录、墓碑、进度、截止日、parent与幂等记录逐列不变，索引/列形状也不变', () => {
    const db = seeded0003()
    const records = db.prepare('select * from records order by id').all()
    const mutations = db.prepare('select * from applied_mutations order by mutation_id').all()
    const indexes = db.prepare("select name,sql from sqlite_master where type='index' order by name").all()
    const shape = db.prepare('pragma table_info(records)').all()
    db.exec(MIGRATION_0004)
    expect(db.prepare('select * from records order by id').all()).toEqual(records)
    expect(db.prepare('select * from applied_mutations order by mutation_id').all()).toEqual(mutations)
    expect(db.prepare("select name,sql from sqlite_master where type='index' order by name").all()).toEqual(indexes)
    expect(db.prepare('pragma table_info(records)').all()).toEqual(shape)
    db.close()
  })

  for (const assignment of ['parent_id=null', "parent_id='other-project'", 'id=null']) {
    it(`升级后的NULL安全比较拒绝 ${assignment}`, () => {
      const db = seeded0003()
      db.exec(MIGRATION_0004)
      expect(() => db.exec(`update records set ${assignment},version=3 where id='r-existing-log'`)).toThrow(/created_fields_are_immutable/)
      expect(db.prepare("select parent_id,progress from records where id='r-existing-log'").get()).toMatchObject({ parent_id: 'r-existing-project', progress: 62 })
      db.close()
    })
  }

  it('历史NULL父级不能后挂；相同NULL/非NULL仍可正常更新', () => {
    const db = seeded0003()
    db.exec(MIGRATION_0004)
    expect(() => db.exec("update records set parent_id='r-existing-project',version=3 where id='r-null-parent'")).toThrow(/created_fields_are_immutable/)
    db.exec("update records set parent_id=null,content='NULL不变',version=3 where id='r-null-parent'")
    db.exec("update records set parent_id=parent_id,content='非NULL不变',version=3 where id='r-existing-log'")
    expect(db.prepare("select content from records where id='r-null-parent'").get()?.['content']).toBe('NULL不变')
    expect(db.prepare("select content from records where id='r-existing-log'").get()?.['content']).toBe('非NULL不变')
    db.close()
  })
})
