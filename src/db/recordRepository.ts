/**
 * Record 仓库 —— 本地唯一写入口（方案 §29、§34、§43）。
 *
 * 规则：
 *  1. UI 只调用这里，绝不直接碰 Supabase。
 *  2. 每次变化 = 写 Record + 写 Outbox Mutation，同一个 IndexedDB transaction。
 *  3. created_at 一旦写入永不改变（§10）。
 *  4. 完成 ≠ 删除（§20）；删除永远是 Soft Delete（§15）。
 */
import { db } from './db'
import { enqueueMutation } from './outboxRepository'
import type {
  CloudRecord,
  LocalRecord,
  RecordSnapshot,
  RecordType,
  SyncState,
} from '../domain/record'
import { snapshotOf, clampDeadlineLocalDate, clampParentId, clampProgress, PROGRESS_MIN } from '../domain/record'
import { createPayloadOf, type Mutation, type MutationOperation, type MutationPayload } from '../domain/mutation'
import { uuidv4 } from '../utils/id'
import { captureNow } from '../utils/timezone'

/** 未连接云端时使用的本机账号 ID */
export const LOCAL_USER_ID = 'local-device'

export interface CreateRecordInput {
  userId: string
  type: RecordType
  content: string
  /** 大事的初始进度，默认 0；进展传 null 表示「这条不记进度」；其余忽略 */
  progress?: number | null
  /** 大事的截止日 `YYYY-MM-DD`；非大事忽略 */
  deadlineLocalDate?: string | null
  /** 进展所属的大事 id；只有 type = 'log' 才生效，其余忽略 */
  parentId?: string | null
  /** 用于测试注入；默认取当前时刻 */
  nowUtc?: string
  timezone?: string | null
}

interface CommitContext {
  utc: string
  timezone: string
}

// ---------------------------------------------------------------
// 创建
// ---------------------------------------------------------------

export async function createRecord(input: CreateRecordInput): Promise<LocalRecord> {
  const captured = captureNow(input.nowUtc, input.timezone)
  const content = input.content.trim()

  // 哪些字段对哪种类型有意义，全部在这里一次性裁决：
  //   进度   → 大事、进展（进展记的是「写下这条时的进度」，是快照）
  //   截止日 → 只有大事
  //   parentId → 只有进展
  // 其余组合即使调用方传了值也一律丢弃 —— 「灵感有 30% 进度」是没有意义的，
  // 让它落库只会在以后到处长出分支（数据库层也用 CHECK 钉住了同一件事）。
  const isProject = input.type === 'project'
  const isLog = input.type === 'log'

  // 大事没传进度时默认 0（新建就是「还没开始」）；
  // 进展没传时保持 null —— 「这条进展没记进度」和「记了 0%」是两回事。
  const progress = isProject
    ? (clampProgress(input.progress ?? PROGRESS_MIN) ?? PROGRESS_MIN)
    : isLog
      ? clampProgress(input.progress)
      : null
  const deadlineLocalDate = isProject ? clampDeadlineLocalDate(input.deadlineLocalDate) : null
  const parentId = isLog ? clampParentId(input.parentId) : null

  const record: LocalRecord = {
    id: uuidv4(),
    userId: input.userId,
    type: input.type,
    content,
    progress,
    deadlineLocalDate,
    parentId,
    createdAtUtc: captured.utc,
    createdTimezone: captured.timezone,
    createdLocalDate: captured.localDate,
    updatedAtUtc: captured.utc,
    updatedTimezone: captured.timezone,
    completedAtUtc: null,
    completedTimezone: null,
    deletedAtUtc: null,
    serverVersion: null,
    syncState: 'pending',
  }

  const mutation: Mutation = {
    mutationId: uuidv4(),
    userId: record.userId,
    recordId: record.id,
    operation: 'create',
    baseServerVersion: null,
    baseSnapshot: { ...snapshotOf(record), content: '' },
    payload: createPayloadOf(record),
    createdAt: captured.utc,
    retryCount: 0,
    state: 'pending',
    attempted: false,
  }

  await db.transaction('rw', db.records, db.outbox, async () => {
    await db.records.put(record)
    await enqueueMutation(mutation)
  })

  return record
}

// ---------------------------------------------------------------
// 编辑
// ---------------------------------------------------------------

/** 编辑正文。created_at 不动，只更新 updated_at（§13）。 */
export async function updateContent(
  recordId: string,
  content: string,
  nowUtc?: string,
  timezone?: string | null,
): Promise<LocalRecord | null> {
  const next = content.trim()
  return commitChange(recordId, 'update', nowUtc, timezone, (record, ctx) => {
    if (record.content === next) return null
    record.content = next
    record.updatedAtUtc = ctx.utc
    record.updatedTimezone = ctx.timezone
    return { content: next, updatedAtUtc: ctx.utc, updatedTimezone: ctx.timezone }
  })
}

// ---------------------------------------------------------------
// 大事：进度 / 截止日
// ---------------------------------------------------------------

/**
 * 更新大事的进度。
 *
 * 返回值同为 null 有两种情况：值没变（不必写库），或这条不是大事。
 * 两者对调用方都是「什么都不用做」。
 */
export async function updateProjectProgress(
  recordId: string,
  progress: number,
  nowUtc?: string,
  timezone?: string | null,
): Promise<LocalRecord | null> {
  const next = clampProgress(progress)
  if (next === null) return null

  return commitChange(recordId, 'update', nowUtc, timezone, (record, ctx) => {
    if (record.type !== 'project') return null
    if (record.progress === next) return null
    record.progress = next
    // 进度变化确实是一次编辑，updatedAt 要跟着走 ——
    // 否则「最后编辑」会停在上一次改正文的时候，看着像没保存成功。
    record.updatedAtUtc = ctx.utc
    record.updatedTimezone = ctx.timezone
    return { progress: next, updatedAtUtc: ctx.utc, updatedTimezone: ctx.timezone }
  })
}

/** 设置或清除大事的截止日；传 null 表示清除 */
export async function updateDeadline(
  recordId: string,
  deadlineLocalDate: string | null,
  nowUtc?: string,
  timezone?: string | null,
): Promise<LocalRecord | null> {
  const next = clampDeadlineLocalDate(deadlineLocalDate)

  return commitChange(recordId, 'update', nowUtc, timezone, (record, ctx) => {
    if (record.type !== 'project') return null
    if (record.deadlineLocalDate === next) return null
    record.deadlineLocalDate = next
    record.updatedAtUtc = ctx.utc
    record.updatedTimezone = ctx.timezone
    return { deadlineLocalDate: next, updatedAtUtc: ctx.utc, updatedTimezone: ctx.timezone }
  })
}

// ---------------------------------------------------------------
// 完成 / 取消完成（§19、§21）
// ---------------------------------------------------------------

export async function completeTodo(
  recordId: string,
  nowUtc?: string,
  timezone?: string | null,
): Promise<LocalRecord | null> {
  return commitChange(recordId, 'complete', nowUtc, timezone, (record, ctx) => {
    if (record.type !== 'todo' || record.completedAtUtc !== null || record.deletedAtUtc !== null) {
      return null
    }
    record.completedAtUtc = ctx.utc
    record.completedTimezone = ctx.timezone
    return { completedAtUtc: ctx.utc, completedTimezone: ctx.timezone }
  })
}

export async function uncompleteTodo(
  recordId: string,
  nowUtc?: string,
  timezone?: string | null,
): Promise<LocalRecord | null> {
  return commitChange(recordId, 'uncomplete', nowUtc, timezone, (record) => {
    if (record.completedAtUtc === null) return null
    record.completedAtUtc = null
    record.completedTimezone = null
    return { completedAtUtc: null, completedTimezone: null }
  })
}

// ---------------------------------------------------------------
// 软删除 / 恢复（§15、§59、§60）
// ---------------------------------------------------------------

export async function softDelete(recordId: string, nowUtc?: string): Promise<LocalRecord | null> {
  return commitChange(recordId, 'delete', nowUtc, undefined, (record, ctx) => {
    if (record.deletedAtUtc !== null) return null
    record.deletedAtUtc = ctx.utc
    return { deletedAtUtc: ctx.utc }
  })
}

export async function restoreRecord(
  recordId: string,
  nowUtc?: string,
  timezone?: string | null,
): Promise<LocalRecord | null> {
  return commitChange(recordId, 'restore', nowUtc, timezone, (record) => {
    if (record.deletedAtUtc === null) return null
    record.deletedAtUtc = null
    return { deletedAtUtc: null }
  })
}

// ---------------------------------------------------------------
// 内部：统一的“改 + 入队”事务
// ---------------------------------------------------------------

type ChangeBuilder = (
  record: LocalRecord,
  ctx: CommitContext,
) => MutationPayload | null

async function commitChange(
  recordId: string,
  operation: MutationOperation,
  nowUtc: string | undefined,
  timezone: string | null | undefined,
  build: ChangeBuilder,
): Promise<LocalRecord | null> {
  let result: LocalRecord | null = null

  await db.transaction('rw', db.records, db.outbox, async () => {
    const record = await db.records.get(recordId)
    if (!record) return

    const captured = captureNow(nowUtc, timezone ?? record.updatedTimezone)
    const baseSnapshot = snapshotOf(record)

    const patch = build(record, captured)
    if (patch === null) {
      result = record
      return
    }

    record.syncState = 'pending'
    await db.records.put(record)

    await enqueueMutation({
      mutationId: uuidv4(),
      userId: record.userId,
      recordId: record.id,
      operation,
      baseServerVersion: record.serverVersion,
      baseSnapshot,
      payload: patch,
      createdAt: captured.utc,
      retryCount: 0,
      state: 'pending',
      attempted: false,
    })

    result = record
  })

  return result
}

// ---------------------------------------------------------------
// 来自服务器的写入
// ---------------------------------------------------------------

function fromCloud(cloud: CloudRecord, syncState: SyncState): LocalRecord {
  return {
    id: cloud.id,
    userId: cloud.userId,
    type: cloud.type,
    content: cloud.content,
    // 远端可能来自一个还没跑过迁移的旧库（列不存在 → undefined），
    // 也可能存着越界的脏值。统一在这里收敛，别让脏数据进到领域模型。
    progress: clampProgress(cloud.progress),
    deadlineLocalDate: clampDeadlineLocalDate(cloud.deadlineLocalDate),
    parentId: clampParentId(cloud.parentId),
    createdAtUtc: cloud.createdAtUtc,
    createdTimezone: cloud.createdTimezone,
    createdLocalDate: cloud.createdLocalDate,
    updatedAtUtc: cloud.updatedAtUtc,
    updatedTimezone: cloud.updatedTimezone,
    completedAtUtc: cloud.completedAtUtc,
    completedTimezone: cloud.completedTimezone,
    deletedAtUtc: cloud.deletedAtUtc,
    serverVersion: cloud.version,
    syncState,
  }
}

/**
 * 采用服务器版本。
 *
 * - 本机已无待发送改动且没有未决冲突 → 完整采用服务器业务字段（含软删除 Tombstone，防复活）
 * - 本机仍有改动或冲突 → 只更新 serverVersion，业务字段留给 Reconcile / 用户决定
 */
export async function applyCloudRecord(cloud: CloudRecord): Promise<void> {
  await db.transaction('rw', db.records, db.outbox, db.conflicts, async () => {
    const local = await db.records.get(cloud.id)
    if (!local) {
      await db.records.put(fromCloud(cloud, 'synced'))
      return
    }

    const pending = await db.outbox.where('[recordId+state]').equals([cloud.id, 'pending']).count()
    const sending = await db.outbox.where('[recordId+state]').equals([cloud.id, 'sending']).count()
    const failed = await db.outbox.where('[recordId+state]').equals([cloud.id, 'failed']).count()
    const conflict = await db.conflicts.get(cloud.id)

    if (pending + sending + failed === 0 && !conflict) {
      await db.records.put(fromCloud(cloud, 'synced'))
    } else {
      await db.records.put({ ...local, serverVersion: cloud.version })
    }
  })
}

/** 只更新本机记录的 serverVersion（Push 成功后） */
export async function setServerVersion(recordId: string, version: number): Promise<void> {
  await db.records.where('id').equals(recordId).modify((record) => {
    record.serverVersion = version
  })
}

/** 把本地记录整体替换为某个快照（安全合并 / 冲突裁决使用） */
export async function replaceWithSnapshot(
  recordId: string,
  snapshot: RecordSnapshot,
  syncState: SyncState,
  serverVersion?: number | null,
): Promise<void> {
  await db.records.where('id').equals(recordId).modify((record) => {
    record.type = snapshot.type
    record.content = snapshot.content
    record.progress = snapshot.progress
    record.deadlineLocalDate = snapshot.deadlineLocalDate
    record.parentId = snapshot.parentId
    record.createdAtUtc = snapshot.createdAtUtc
    record.createdTimezone = snapshot.createdTimezone
    record.createdLocalDate = snapshot.createdLocalDate
    record.updatedAtUtc = snapshot.updatedAtUtc
    record.updatedTimezone = snapshot.updatedTimezone
    record.completedAtUtc = snapshot.completedAtUtc
    record.completedTimezone = snapshot.completedTimezone
    record.deletedAtUtc = snapshot.deletedAtUtc
    record.syncState = syncState
    if (serverVersion !== undefined) record.serverVersion = serverVersion
  })
}

// ---------------------------------------------------------------
// 查询（UI 通过 useLiveQuery 直接读表，这里提供少量辅助）
// ---------------------------------------------------------------

export async function getRecord(recordId: string): Promise<LocalRecord | undefined> {
  return db.records.get(recordId)
}

export async function countRecords(userId: string): Promise<number> {
  return db.records.where('userId').equals(userId).count()
}

// ---------------------------------------------------------------
// 本机模式 → 账号迁移（保证“数据不丢”优先级最高，§81）
// ---------------------------------------------------------------

/**
 * 把本机（未登录）创建的记录归入某个账号。
 * 这些记录从未上过服务器，因此重置 serverVersion 并改用 create Mutation。
 */
export async function migrateLocalRecordsToUser(targetUserId: string): Promise<number> {
  let migrated = 0

  await db.transaction('rw', db.records, db.outbox, db.conflicts, async () => {
    const locals = await db.records.where('userId').equals(LOCAL_USER_ID).toArray()
    if (locals.length === 0) return

    for (const record of locals) {
      await db.outbox.where('recordId').equals(record.id).delete()
      await db.conflicts.delete(record.id)

      const next: LocalRecord = { ...record, userId: targetUserId, serverVersion: null, syncState: 'pending' }
      await db.records.put(next)

      await db.outbox.put({
        mutationId: uuidv4(),
        userId: targetUserId,
        recordId: record.id,
        operation: 'create',
        baseServerVersion: null,
        baseSnapshot: { ...snapshotOf(next), content: '' },
        payload: createPayloadOf(next),
        createdAt: next.createdAtUtc,
        retryCount: 0,
        state: 'pending',
        attempted: false,
      })
      migrated += 1
    }
  })

  return migrated
}
