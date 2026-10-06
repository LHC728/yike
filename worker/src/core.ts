/**
 * 一刻 — Cloudflare 同步后端的核心逻辑。
 *
 * 这里刻意与 HTTP 层分离：路由和 CORS 在 index.ts，本文件只关心
 * 「鉴权」和「原子应用一次 Mutation」这两件事，方便直接写单测。
 *
 * 语义必须与 supabase/migrations/0001_init.sql 里的 apply_record_mutation
 * 逐条对齐 —— 两套后端是可互换的，客户端的同步引擎不该感知到差别。
 */

// ---------------------------------------------------------------
// D1 的最小类型声明
//
// 故意不引 @cloudflare/workers-types：本项目的主 tsconfig 只带 DOM lib，
// 引它要多一套 tsconfig 和一个新依赖，而这里真正用到的只有 4 个方法。
// 需要完整 Workers 类型时再引也不迟。
// ---------------------------------------------------------------

export interface D1Result<T = unknown> {
  results: T[]
  success: boolean
  meta: { changes?: number }
}

export interface D1Statement {
  bind(...values: unknown[]): D1Statement
  first<T = unknown>(): Promise<T | null>
  run(): Promise<D1Result>
  all<T = unknown>(): Promise<D1Result<T>>
}

export interface D1Database {
  prepare(query: string): D1Statement
  batch(statements: D1Statement[]): Promise<D1Result[]>
}

export interface Env {
  DB: D1Database
  /** 逗号分隔的允许来源；不设则允许全部（令牌鉴权，无 Cookie，不涉及 CSRF） */
  ALLOWED_ORIGINS?: string
}

// ---------------------------------------------------------------
// 行 / 返回结构
// ---------------------------------------------------------------

export interface RecordRow {
  id: string
  user_id: string
  type: string
  content: string
  progress: number | null
  deadline_local_date: string | null
  parent_id: string | null
  created_at_utc: string
  created_timezone: string
  created_local_date: string
  updated_at_utc: string
  updated_timezone: string | null
  completed_at_utc: string | null
  completed_timezone: string | null
  deleted_at_utc: string | null
  version: number
  server_updated_at: string
}

/** 与客户端 CloudRecord 一一对应（下划线转驼峰）。
 *  updatedTimezone 在客户端是必填 string，所以这里也补齐默认值，
 *  两边形状完全一致，客户端就不必再做一次防御性归一。 */
export interface CloudRecordOut {
  id: string
  userId: string
  type: 'idea' | 'todo' | 'project' | 'log'
  content: string
  progress: number | null
  deadlineLocalDate: string | null
  parentId: string | null
  createdAtUtc: string
  createdTimezone: string
  createdLocalDate: string
  updatedAtUtc: string
  updatedTimezone: string
  completedAtUtc: string | null
  completedTimezone: string | null
  deletedAtUtc: string | null
  version: number
  serverUpdatedAt: string
}

/** 只认四种类型，其余一律降级成 idea —— 与客户端 clampRecordType 同一套语义 */
function asType(value: unknown): 'idea' | 'todo' | 'project' | 'log' {
  if (value === 'todo' || value === 'project' || value === 'log') return value
  return 'idea'
}

/**
 * parentId 归一：只接受非空字符串，其余当「没有父级」。
 *
 * 空字符串尤其要挡掉 —— 它既不等于 null，又匹配不到任何大事的 id，
 * 放进去会让那条进展在所有设备上都「挂在一个不存在的大事下」，
 * 界面上表现为进展凭空消失。
 */
function asParentId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 进度归一：夹到 0–100 的整数，非法值当 null。
 *
 * 与客户端 `clampProgress` 是同一套规则，故意抄了一份而不是共享 ——
 * worker 有独立的 tsconfig，不引 src/ 下的任何东西（那边带 DOM lib）。
 * 改这里时记得同步改 `src/domain/record.ts`。
 */
function asProgress(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return null
  return Math.min(100, Math.max(0, Math.round(num)))
}

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0
}

/**
 * 截止日归一：必须是**真实存在的日历日**，否则当没有。
 *
 * ⚠️ 只测格式（`\d{4}-\d{2}-\d{2}`）是不够的 —— `2026-13-45` 和
 * `2026-02-30` 都完全符合那个正则，但它们不是日期。放出去以后客户端
 * 会算出一个荒谬的倒计时，或者渲染出不存在的「13月45日」。
 * 所以这里做的是与客户端 `parseLocalDate` 完全相同的日历校验（含闰年），
 * 故意抄一份而不是共享 —— worker 有独立 tsconfig，不引 src/ 下的任何东西。
 * 改这里时记得同步改 `src/domain/record.ts` 的 `clampDeadlineLocalDate`。
 */
function asDeadline(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = LOCAL_DATE_PATTERN.exec(value)
  if (!match) return null
  const [, rawYear, rawMonth, rawDay] = match
  if (rawYear === undefined || rawMonth === undefined || rawDay === undefined) return null
  const year = Number(rawYear)
  const month = Number(rawMonth)
  const day = Number(rawDay)
  if (month < 1 || month > 12) return null
  if (day < 1 || day > daysInMonth(year, month)) return null
  return value
}

export function toCloudRecord(row: RecordRow): CloudRecordOut {
  return {
    id: row.id,
    userId: row.user_id,
    type: asType(row.type),
    content: row.content,
    progress: asProgress(row.progress),
    deadlineLocalDate: asDeadline(row.deadline_local_date),
    parentId: asParentId(row.parent_id),
    createdAtUtc: row.created_at_utc,
    createdTimezone: row.created_timezone,
    createdLocalDate: row.created_local_date,
    updatedAtUtc: row.updated_at_utc,
    updatedTimezone: row.updated_timezone ?? 'UTC',
    completedAtUtc: row.completed_at_utc,
    completedTimezone: row.completed_timezone,
    deletedAtUtc: row.deleted_at_utc,
    version: Number(row.version),
    serverUpdatedAt: row.server_updated_at,
  }
}

const RECORD_COLUMNS = [
  'id',
  'user_id',
  'type',
  'content',
  'progress',
  'deadline_local_date',
  'parent_id',
  'created_at_utc',
  'created_timezone',
  'created_local_date',
  'updated_at_utc',
  'updated_timezone',
  'completed_at_utc',
  'completed_timezone',
  'deleted_at_utc',
  'version',
  'server_updated_at',
].join(', ')

// ---------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  let hex = ''
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/**
 * 令牌 → userId。
 * 库里只存 SHA-256，所以即使数据库被看到也无法反推出可用的令牌。
 */
export async function resolveUser(db: D1Database, token: string): Promise<string | null> {
  if (token === '') return null
  const hash = await sha256Hex(token)
  const row = await db
    .prepare('select user_id, revoked_at from access_tokens where token_hash = ?')
    .bind(hash)
    .first<{ user_id: string; revoked_at: string | null }>()
  if (!row) return null
  if (row.revoked_at !== null) return null
  return row.user_id
}

// ---------------------------------------------------------------
// 读
// ---------------------------------------------------------------

export interface UserInfo {
  userId: string
  email: string | null
}

/**
 * 令牌对应的账号信息。
 *
 * 客户端必须知道自己的 userId —— 本机已有的记录要在首次登录时
 * 归到这个账号下（§81），userId 搞错了记录就会挂到别人名下。
 */
export async function readUser(db: D1Database, userId: string): Promise<UserInfo | null> {
  const row = await db
    .prepare('select id, email from users where id = ?')
    .bind(userId)
    .first<{ id: string; email: string | null }>()
  if (!row) return null
  return { userId: row.id, email: row.email }
}

export async function readRecord(
  db: D1Database,
  userId: string,
  recordId: string,
): Promise<CloudRecordOut | null> {
  const row = await db
    .prepare(`select ${RECORD_COLUMNS} from records where id = ? and user_id = ?`)
    .bind(recordId, userId)
    .first<RecordRow>()
  return row ? toCloudRecord(row) : null
}

export const PULL_PAGE_SIZE = 500
export const PULL_MAX_PAGE_SIZE = 1000

export interface PullPageInput {
  afterId: string | null
  pageSize: number
}

export interface PullPageOutput {
  records: CloudRecordOut[]
  nextCursor: string | null
}

/** 旧记录 ID 不必是 UUID；只校验游标形状，不重写历史标识。 */
export function parsePullPageInput(body: unknown): PullPageInput | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const raw = body as Record<string, unknown>
  const afterId = raw.afterId
  const pageSize = raw.pageSize
  if (afterId !== null && (typeof afterId !== 'string' || afterId.length === 0)) return null
  if (typeof pageSize !== 'number' || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PULL_MAX_PAGE_SIZE) return null
  return { afterId, pageSize }
}

/**
 * id 永不变、记录永不硬删，因此编辑与软删不会把已有记录移出分页范围。
 * server_updated_at 会随写入移动，按它或 offset 翻页会漏掉正在变化的记录。
 */
export async function pullPage(
  db: D1Database,
  userId: string,
  input: PullPageInput,
): Promise<PullPageOutput> {
  if (parsePullPageInput(input) === null) throw new Error('invalid_pull_page')
  const { afterId, pageSize } = input
  const result = await db
    .prepare(
      `select ${RECORD_COLUMNS} from records where user_id = ? and id > ? order by id asc limit ?`,
    )
    .bind(userId, afterId ?? '', pageSize + 1)
    .all<RecordRow>()
  if (!result.success || !Array.isArray(result.results)) throw new Error('pull_page_failed')
  const rows = result.results
  const records = rows.slice(0, pageSize).map(toCloudRecord)
  const last = records.at(-1)
  return { records, nextCursor: rows.length > pageSize && last ? last.id : null }
}

/** 兼容缓存旧客户端：旧端点仍返回完整数组，不把第一页冒充成全部。 */
export async function pullAll(db: D1Database, userId: string): Promise<CloudRecordOut[]> {
  const records: CloudRecordOut[] = []
  let afterId: string | null = null
  while (true) {
    const page = await pullPage(db, userId, { afterId, pageSize: PULL_PAGE_SIZE })
    records.push(...page.records)
    if (page.nextCursor === null) break
    afterId = page.nextCursor
  }
  // 原接口的排序语义保留；新分页端点用 id，避免变动时间影响游标。
  return records.toSorted((a, b) => {
    if (a.serverUpdatedAt !== b.serverUpdatedAt) return a.serverUpdatedAt < b.serverUpdatedAt ? -1 : 1
    return a.id < b.id ? -1 : a.id === b.id ? 0 : 1
  })
}

// ---------------------------------------------------------------
// 写：原子应用一次 Mutation
// ---------------------------------------------------------------

export type MutationOperation =
  | 'create'
  | 'update'
  | 'complete'
  | 'uncomplete'
  | 'delete'
  | 'restore'

export type ApplyMutationStatus =
  | 'applied'
  | 'already_applied'
  | 'version_conflict'
  | 'record_not_found'

export interface ApplyMutationInput {
  mutationId: string
  recordId: string
  operation: MutationOperation
  expectedVersion: number | null
  payload: Record<string, unknown>
}

export interface ApplyMutationOutput {
  status: ApplyMutationStatus
  version: number | null
  record: CloudRecordOut | null
}

function has(payload: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(payload, key)
}

/** 取字符串值；缺失、null、非字符串一律当作「没有值」 */
function str(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/** 与 Supabase 版 `coalesce(payload->>'content', content)` 等价 */
function strOr(payload: Record<string, unknown>, key: string, fallback: string): string {
  return str(payload, key) ?? fallback
}

/** 只有「键存在」才算要改 —— 显式传 null 表示清空（取消完成 / 取消删除） */
function present(payload: Record<string, unknown>, key: string): string | null {
  return str(payload, key)
}

export async function applyMutation(
  db: D1Database,
  userId: string,
  input: ApplyMutationInput,
  now: string,
): Promise<ApplyMutationOutput> {
  const { mutationId, recordId, operation, expectedVersion, payload } = input

  // ---------- 1. 幂等：同一个 mutationId 只允许生效一次 ----------
  const applied = await db
    .prepare('select result_version from applied_mutations where mutation_id = ? and user_id = ?')
    .bind(mutationId, userId)
    .first<{ result_version: number }>()

  if (applied && Number(applied.result_version) > 0) {
    return {
      status: 'already_applied',
      version: Number(applied.result_version),
      record: await readRecord(db, userId, recordId),
    }
  }

  // ---------- 2. 当前状态 ----------
  const current = await readRecord(db, userId, recordId)

  // ---------- 3. 不存在 ----------
  if (current === null) {
    if (operation !== 'create') {
      return { status: 'record_not_found', version: null, record: null }
    }

    const type = asType(str(payload, 'type'))
    // 哪些字段对哪种类型有意义，与客户端 `createRecord` 逐条对齐：
    //   progress  → 大事、进展
    //   deadline  → 只有大事
    //   parentId  → 只有进展
    // 这是数据库那几条 CHECK（「非大事不许有截止日」等）能一直成立的前提。
    const keepsProgress = type === 'project' || type === 'log'
    const isProject = type === 'project'
    const isLog = type === 'log'

    const insertRecord = db
      .prepare(
        `insert into records (
           id, user_id, type, content,
           progress, deadline_local_date, parent_id,
           created_at_utc, created_timezone, created_local_date,
           updated_at_utc, updated_timezone,
           completed_at_utc, completed_timezone, deleted_at_utc,
           version, server_updated_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         on conflict (id) do nothing`,
      )
      .bind(
        recordId,
        userId,
        type,
        strOr(payload, 'content', ''),
        keepsProgress ? asProgress(payload['progress']) : null,
        isProject ? asDeadline(payload['deadlineLocalDate']) : null,
        isLog ? asParentId(payload['parentId']) : null,
        str(payload, 'createdAtUtc') ?? now,
        str(payload, 'createdTimezone') ?? 'UTC',
        str(payload, 'createdLocalDate') ?? now.slice(0, 10),
        str(payload, 'updatedAtUtc') ?? now,
        present(payload, 'updatedTimezone'),
        present(payload, 'completedAtUtc'),
        present(payload, 'completedTimezone'),
        present(payload, 'deletedAtUtc'),
        now,
      )

    // 幂等记录只在「这一条 INSERT 确实写进去了」时才写。
    //
    // 为什么用 changes() 而不是 `where exists (select 1 from records ...)`：
    // 后者会误判。设想两台设备同时新建了同一条记录（同一个 id、两个 mutationId）：
    // 先到的那条把行写进去了，后到的那条 INSERT 被 `on conflict do nothing`
    // 悄悄跳过 —— 但 exists 依然为真，于是后到的那条也会被记成「已应用」，
    // 而它带的（更新的）内容被丢掉了。客户端以为推送成功，之后 Pull 回来
    // 覆盖本地 —— 这就是**静默丢数据**，正是本项目最不能接受的事。
    //
    // changes() 返回上一条 INSERT/UPDATE/DELETE 实际改动的行数，
    // 在同一个 batch（同一连接、同一事务）里就是这条 INSERT 的真实结果：
    // 写进去了是 1，被冲突跳过是 0。判据从此和事实一致。
    const claimCreate = db
      .prepare(
        `insert into applied_mutations (mutation_id, user_id, record_id, result_version, applied_at)
         select ?, ?, ?, 1, ?
         where changes() = 1`,
      )
      .bind(mutationId, userId, recordId, now)

    await db.batch([insertRecord, claimCreate])
  } else {
    // ---------- 4. 已存在 ----------
    // 乐观并发：期望版本对不上就交给客户端做三方比较（§36）
    if (expectedVersion === null || expectedVersion !== current.version) {
      return { status: 'version_conflict', version: current.version, record: current }
    }

    const setContent = str(payload, 'content') !== null
    // type 在数据库层是不可变的，所以用当前行的 type 判断即可 ——
    // 非大事 / 非进展的 progress 一律当没传，保持与客户端同一套语义。
    // ⚠️ parent_id 刻意**不在这里处理**：进展「属于哪件大事」是写下的
    //    那一刻定死的，服务端把它当不可变字段（触发器也钉住了），
    //    更新路径根本不看它，这样任何 payload 都改不动它。
    const keepsProgress = current.type === 'project' || current.type === 'log'
    const isProject = current.type === 'project'
    const setProgress = keepsProgress && has(payload, 'progress')
    const setDeadline = isProject && has(payload, 'deadlineLocalDate')
    const setUpdatedAt = str(payload, 'updatedAtUtc') !== null
    const setUpdatedTz = str(payload, 'updatedTimezone') !== null
    const setCompletedAt = has(payload, 'completedAtUtc')
    const setCompletedTz = has(payload, 'completedTimezone')
    const setDeletedAt = has(payload, 'deletedAtUtc')

    const nextVersion = expectedVersion + 1

    // version = version + 1 写在 SET 里，WHERE 里再钉一次 version = ?，
    // 于是「检查版本」与「写入」是同一条语句 —— 不存在先查后写的竞态。
    const updateRecord = db
      .prepare(
        `update records set
           content            = case when ? = 1 then ? else content end,
           progress           = case when ? = 1 then ? else progress end,
           deadline_local_date= case when ? = 1 then ? else deadline_local_date end,
           updated_at_utc     = case when ? = 1 then ? else updated_at_utc end,
           updated_timezone   = case when ? = 1 then ? else updated_timezone end,
           completed_at_utc   = case when ? = 1 then ? else completed_at_utc end,
           completed_timezone = case when ? = 1 then ? else completed_timezone end,
           deleted_at_utc     = case when ? = 1 then ? else deleted_at_utc end,
           version            = version + 1,
           server_updated_at  = ?
         where id = ? and user_id = ? and version = ?`,
      )
      .bind(
        setContent ? 1 : 0,
        str(payload, 'content'),
        setProgress ? 1 : 0,
        asProgress(payload['progress']),
        setDeadline ? 1 : 0,
        asDeadline(payload['deadlineLocalDate']),
        setUpdatedAt ? 1 : 0,
        str(payload, 'updatedAtUtc'),
        setUpdatedTz ? 1 : 0,
        str(payload, 'updatedTimezone'),
        setCompletedAt ? 1 : 0,
        present(payload, 'completedAtUtc'),
        setCompletedTz ? 1 : 0,
        present(payload, 'completedTimezone'),
        setDeletedAt ? 1 : 0,
        present(payload, 'deletedAtUtc'),
        now,
        recordId,
        userId,
        expectedVersion,
      )

    // 与 create 同理：changes() 是「这条 UPDATE 到底改了几行」的真实答案。
    // 用 `where exists(... version = nextVersion)` 会误判 —— 并发的另一次
    // update 也可能把版本推到同一个 nextVersion，于是没写成功的这次
    // 会被记成「已应用」。
    const claimUpdate = db
      .prepare(
        `insert into applied_mutations (mutation_id, user_id, record_id, result_version, applied_at)
         select ?, ?, ?, ?, ?
         where changes() = 1`,
      )
      .bind(mutationId, userId, recordId, nextVersion, now)

    await db.batch([updateRecord, claimUpdate])
  }

  // ---------- 5. 以「幂等记录是否落库」为准判定结果 ----------
  // 两条语句在同一个 batch 里，batch 是事务，所以不会出现半截状态。
  const after = await db
    .prepare('select result_version from applied_mutations where mutation_id = ? and user_id = ?')
    .bind(mutationId, userId)
    .first<{ result_version: number }>()

  const finalRecord = await readRecord(db, userId, recordId)

  if (after && Number(after.result_version) > 0) {
    return { status: 'applied', version: Number(after.result_version), record: finalRecord }
  }

  // 没写进去 → 条件更新没命中 → 版本已被别人改过
  return {
    status: 'version_conflict',
    version: finalRecord?.version ?? null,
    record: finalRecord,
  }
}
