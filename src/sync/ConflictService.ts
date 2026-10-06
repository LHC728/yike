/**
 * 冲突处理（方案 §36、§47 - §53）。
 *
 * 两条铁律：
 *  1. 绝不使用简单 Last Write Wins（§37）
 *  2. 用户完成选择以前，Base / Local / Remote 三个版本一个都不能丢（§51）
 *
 * 这里的 merge 是纯函数，便于测试。
 */
import { db, type ConflictEntry, type ConflictKind } from '../db/db'
import {
  dropPendingForRecord,
  enqueueMutation,
} from '../db/outboxRepository'
import {
  replaceWithSnapshot,
} from '../db/recordRepository'
import type {
  CloudRecord,
  LocalRecord,
  RecordSnapshot,
} from '../domain/record'
import { snapshotEquals, snapshotOf, snapshotOfCloud } from '../domain/record'
import type { Mutation, MutationOperation, MutationPayload } from '../domain/mutation'
import { uuidv4 } from '../utils/id'
import { nowIso } from '../utils/time'

/** 参与三方合并的业务字段 */
export type MergeField =
  | 'content'
  | 'progress'
  | 'deadlineLocalDate'
  | 'completedAtUtc'
  | 'deletedAtUtc'

export interface MergeResult {
  /** 无冲突时的最终结果；有冲突时冲突字段取 base（即"未决"） */
  autoMerged: RecordSnapshot
  /** 冲突字段取本机的结果 */
  merged: RecordSnapshot
  /** 真正冲突的字段 */
  conflicts: MergeField[]
}

function eq(a: string | null, b: string | null): boolean {
  return a === b
}

/** 取两侧较新的编辑时间，保证「最后编辑」展示正确 */
function pickUpdated(base: RecordSnapshot, local: RecordSnapshot, remote: RecordSnapshot): {
  updatedAtUtc: string
  updatedTimezone: string
} {
  const localChanged = local.updatedAtUtc !== base.updatedAtUtc
  const remoteChanged = remote.updatedAtUtc !== base.updatedAtUtc
  if (localChanged && remoteChanged) {
    return new Date(local.updatedAtUtc).getTime() >= new Date(remote.updatedAtUtc).getTime()
      ? { updatedAtUtc: local.updatedAtUtc, updatedTimezone: local.updatedTimezone }
      : { updatedAtUtc: remote.updatedAtUtc, updatedTimezone: remote.updatedTimezone }
  }
  if (localChanged) {
    return { updatedAtUtc: local.updatedAtUtc, updatedTimezone: local.updatedTimezone }
  }
  if (remoteChanged) {
    return { updatedAtUtc: remote.updatedAtUtc, updatedTimezone: remote.updatedTimezone }
  }
  return { updatedAtUtc: base.updatedAtUtc, updatedTimezone: base.updatedTimezone }
}

/**
 * 三方安全合并（§48）。
 *
 * Base / Local / Remote 都改同一字段且结果不同 → 真冲突。
 * 改的是不同字段 → 自动合并，不打扰用户（§53）。
 */
export function threeWayMerge(
  base: RecordSnapshot,
  local: RecordSnapshot,
  remote: RecordSnapshot,
): MergeResult {
  const conflicts: MergeField[] = []
  const autoMerged: RecordSnapshot = { ...base }

  // created_* 与 type 属于不可变字段：永远跟随 base（§10、§12）
  autoMerged.type = base.type
  autoMerged.createdAtUtc = base.createdAtUtc
  autoMerged.createdTimezone = base.createdTimezone
  autoMerged.createdLocalDate = base.createdLocalDate

  // parentId 同理：进展「属于哪件大事」是写下的那一刻就定死的，之后不会变。
  // 既然两端都不该改它，就不把它放进 MergeField —— 放进去了反而要在冲突
  // 弹窗里多一个用户根本无从判断的选项（「这条进展该挂在哪件大事下？」）。
  // 跟随 base 在任何情况下都不会丢数据。
  autoMerged.parentId = base.parentId

  // ---- content ----
  {
    const localChanged = local.content !== base.content
    const remoteChanged = remote.content !== base.content
    if (localChanged && remoteChanged) {
      if (local.content === remote.content) autoMerged.content = local.content
      else {
        conflicts.push('content')
        autoMerged.content = base.content
      }
    } else if (remoteChanged) autoMerged.content = remote.content
    else autoMerged.content = local.content
  }

  // ---- progress（大事进度） ----
  //
  // 两端都动了进度才算冲突。注意这里**不做「取较大值」** ——
  // 那看起来聪明，实际会把「本机刚把进度退回 0 重新做」直接抹掉。
  // 语义不明的合并宁可交给用户裁决。
  {
    const localChanged = local.progress !== base.progress
    const remoteChanged = remote.progress !== base.progress
    if (localChanged && remoteChanged) {
      if (local.progress === remote.progress) autoMerged.progress = local.progress
      else {
        conflicts.push('progress')
        autoMerged.progress = base.progress
      }
    } else if (remoteChanged) autoMerged.progress = remote.progress
    else autoMerged.progress = local.progress
  }

  // ---- deadlineLocalDate（大事截止日） ----
  {
    const localChanged = local.deadlineLocalDate !== base.deadlineLocalDate
    const remoteChanged = remote.deadlineLocalDate !== base.deadlineLocalDate
    if (localChanged && remoteChanged) {
      if (local.deadlineLocalDate === remote.deadlineLocalDate) {
        autoMerged.deadlineLocalDate = local.deadlineLocalDate
      } else {
        conflicts.push('deadlineLocalDate')
        autoMerged.deadlineLocalDate = base.deadlineLocalDate
      }
    } else if (remoteChanged) autoMerged.deadlineLocalDate = remote.deadlineLocalDate
    else autoMerged.deadlineLocalDate = local.deadlineLocalDate
  }

  // ---- completedAtUtc ----
  {
    const localChanged = !eq(local.completedAtUtc, base.completedAtUtc)
    const remoteChanged = !eq(remote.completedAtUtc, base.completedAtUtc)
    if (localChanged && remoteChanged) {
      if (eq(local.completedAtUtc, remote.completedAtUtc)) {
        autoMerged.completedAtUtc = local.completedAtUtc
        autoMerged.completedTimezone = local.completedTimezone
      } else {
        conflicts.push('completedAtUtc')
        autoMerged.completedAtUtc = base.completedAtUtc
        autoMerged.completedTimezone = base.completedTimezone
      }
    } else if (remoteChanged) {
      autoMerged.completedAtUtc = remote.completedAtUtc
      autoMerged.completedTimezone = remote.completedTimezone
    } else {
      autoMerged.completedAtUtc = local.completedAtUtc
      autoMerged.completedTimezone = local.completedTimezone
    }
  }

  // ---- deletedAtUtc（删除是破坏性操作，一律保守处理，§52） ----
  {
    const localDeleted = !eq(local.deletedAtUtc, base.deletedAtUtc)
    const remoteDeleted = !eq(remote.deletedAtUtc, base.deletedAtUtc)

    if (localDeleted && remoteDeleted) {
      // 两边都删了，意图一致，取较早的那个时间
      const earlier =
        new Date(local.deletedAtUtc as string).getTime() <=
        new Date(remote.deletedAtUtc as string).getTime()
          ? local.deletedAtUtc
          : remote.deletedAtUtc
      autoMerged.deletedAtUtc = earlier
    } else if (localDeleted) {
      const remoteTouched = !snapshotEquals(remote, base)
      if (remoteTouched) {
        conflicts.push('deletedAtUtc')
        autoMerged.deletedAtUtc = base.deletedAtUtc
      } else {
        autoMerged.deletedAtUtc = local.deletedAtUtc
      }
    } else if (remoteDeleted) {
      const localTouched = !snapshotEquals(local, base)
      if (localTouched) {
        conflicts.push('deletedAtUtc')
        autoMerged.deletedAtUtc = base.deletedAtUtc
      } else {
        autoMerged.deletedAtUtc = remote.deletedAtUtc
      }
    } else {
      autoMerged.deletedAtUtc = local.deletedAtUtc
    }
  }

  const updated = pickUpdated(base, local, remote)
  autoMerged.updatedAtUtc = updated.updatedAtUtc
  autoMerged.updatedTimezone = updated.updatedTimezone

  const merged: RecordSnapshot = { ...autoMerged }
  for (const field of conflicts) {
    if (field === 'content') merged.content = local.content
    if (field === 'progress') merged.progress = local.progress
    if (field === 'deadlineLocalDate') merged.deadlineLocalDate = local.deadlineLocalDate
    if (field === 'completedAtUtc') {
      merged.completedAtUtc = local.completedAtUtc
      merged.completedTimezone = local.completedTimezone
    }
    if (field === 'deletedAtUtc') merged.deletedAtUtc = local.deletedAtUtc
  }

  return { autoMerged, merged, conflicts }
}

/** 冲突裁决：无冲突字段沿用自动合并结果，冲突字段取被选中的一侧 */
export function applyConflictChoice(
  result: MergeResult,
  chosen: RecordSnapshot,
): RecordSnapshot {
  const final: RecordSnapshot = { ...result.autoMerged }
  for (const field of result.conflicts) {
    if (field === 'content') final.content = chosen.content
    if (field === 'progress') final.progress = chosen.progress
    if (field === 'deadlineLocalDate') final.deadlineLocalDate = chosen.deadlineLocalDate
    if (field === 'completedAtUtc') {
      final.completedAtUtc = chosen.completedAtUtc
      final.completedTimezone = chosen.completedTimezone
    }
    if (field === 'deletedAtUtc') final.deletedAtUtc = chosen.deletedAtUtc
  }
  return final
}

function conflictKind(base: RecordSnapshot, local: RecordSnapshot, remote: RecordSnapshot): ConflictKind {
  const localDeleted = local.deletedAtUtc !== base.deletedAtUtc
  const remoteDeleted = remote.deletedAtUtc !== base.deletedAtUtc
  if (localDeleted !== remoteDeleted) return 'delete-edit'
  return 'field'
}

/** 计算 from → to 的字段级补丁 */
export function diffSnapshot(from: RecordSnapshot, to: RecordSnapshot): MutationPayload {
  const patch: MutationPayload = {}
  if (from.content !== to.content) patch.content = to.content
  if (from.progress !== to.progress) patch.progress = to.progress
  if (from.deadlineLocalDate !== to.deadlineLocalDate) patch.deadlineLocalDate = to.deadlineLocalDate
  if (from.completedAtUtc !== to.completedAtUtc) {
    patch.completedAtUtc = to.completedAtUtc
    patch.completedTimezone = to.completedTimezone
  }
  if (from.deletedAtUtc !== to.deletedAtUtc) patch.deletedAtUtc = to.deletedAtUtc
  if (from.updatedAtUtc !== to.updatedAtUtc) {
    patch.updatedAtUtc = to.updatedAtUtc
    patch.updatedTimezone = to.updatedTimezone
  }
  return patch
}

export function operationForDiff(from: RecordSnapshot, to: RecordSnapshot): MutationOperation {
  if (from.deletedAtUtc !== to.deletedAtUtc) {
    return to.deletedAtUtc ? 'delete' : 'restore'
  }
  if (from.completedAtUtc !== to.completedAtUtc) {
    return to.completedAtUtc ? 'complete' : 'uncomplete'
  }
  return 'update'
}

// ---------------------------------------------------------------
// 冲突的持久化
// ---------------------------------------------------------------

export async function createConflict(params: {
  userId: string
  local: LocalRecord
  cloud: CloudRecord
  base: RecordSnapshot
  merge: MergeResult
}): Promise<void> {
  const { userId, local, cloud, base, merge } = params
  const localSnapshot = snapshotOf(local)
  const remoteSnapshot = snapshotOfCloud(cloud)

  const entry: ConflictEntry = {
    recordId: local.id,
    userId,
    kind: conflictKind(base, localSnapshot, remoteSnapshot),
    fields: merge.conflicts,
    base,
    local: localSnapshot,
    remote: remoteSnapshot,
    remoteVersion: cloud.version,
    createdAt: nowIso(),
  }

  await db.transaction('rw', db.records, db.conflicts, async () => {
    await db.conflicts.put(entry)
    await db.records.where('id').equals(local.id).modify((record) => {
      record.syncState = 'conflict'
    })
  })
}

/** 服务器在用户裁决期间又变了：更新 Remote 一侧，Base / Local 保持不动 */
export async function refreshConflictRemote(recordId: string, cloud: CloudRecord): Promise<void> {
  const entry = await db.conflicts.get(recordId)
  if (!entry) return
  if (cloud.version <= entry.remoteVersion) return
  await db.conflicts.put({
    ...entry,
    remote: snapshotOfCloud(cloud),
    remoteVersion: cloud.version,
  })
}

export async function getConflict(recordId: string): Promise<ConflictEntry | undefined> {
  return db.conflicts.get(recordId)
}

export async function listConflicts(userId: string): Promise<ConflictEntry[]> {
  const list = await db.conflicts.where('userId').equals(userId).toArray()
  return list.toSorted((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
}

export async function countConflicts(userId: string): Promise<number> {
  return db.conflicts.where('userId').equals(userId).count()
}

export type ConflictChoice = 'local' | 'remote' | 'edited'

/**
 * 用户完成裁决。
 *
 * 裁决后不再复用旧的待发送 Mutation，而是按「服务器版本 → 最终状态」的差量重建一个，
 * 保证非冲突字段的自动合并结果不会丢。
 */
export async function resolveConflict(
  recordId: string,
  choice: ConflictChoice,
  editedContent?: string,
): Promise<void> {
  const entry = await db.conflicts.get(recordId)
  if (!entry) return

  const merge = threeWayMerge(entry.base, entry.local, entry.remote)
  const chosen = choice === 'remote' ? entry.remote : entry.local
  const final = applyConflictChoice(merge, chosen)
  if (editedContent !== undefined) final.content = editedContent.trim()

  if (choice === 'remote') {
    await db.transaction('rw', db.records, db.outbox, db.conflicts, async () => {
      await dropPendingForRecord(recordId)
      await db.conflicts.delete(recordId)
      await db.records.where('id').equals(recordId).modify((record) => {
        record.type = final.type
        record.content = final.content
        record.progress = final.progress
        record.deadlineLocalDate = final.deadlineLocalDate
        record.createdAtUtc = final.createdAtUtc
        record.createdTimezone = final.createdTimezone
        record.createdLocalDate = final.createdLocalDate
        record.updatedAtUtc = final.updatedAtUtc
        record.updatedTimezone = final.updatedTimezone
        record.completedAtUtc = final.completedAtUtc
        record.completedTimezone = final.completedTimezone
        record.deletedAtUtc = final.deletedAtUtc
        record.serverVersion = entry.remoteVersion
        record.syncState = 'synced'
      })
    })
    return
  }

  const patch = diffSnapshot(entry.remote, final)
  const operation = operationForDiff(entry.remote, final)

  await db.transaction('rw', db.records, db.outbox, db.conflicts, async () => {
    await dropPendingForRecord(recordId)
    await db.conflicts.delete(recordId)
    await replaceWithSnapshot(recordId, final, 'pending', entry.remoteVersion)

    if (Object.keys(patch).length > 0) {
      const mutation: Mutation = {
        mutationId: uuidv4(),
        userId: entry.userId,
        recordId,
        operation,
        baseServerVersion: entry.remoteVersion,
        baseSnapshot: entry.remote,
        payload: patch,
        createdAt: nowIso(),
        retryCount: 0,
        state: 'pending',
        attempted: false,
      }
      await enqueueMutation(mutation)
    } else {
      await db.records.where('id').equals(recordId).modify((record) => {
        record.syncState = 'synced'
      })
    }
  })
}

/** 冲突期间用户直接编辑了内容：更新本机版本，仍然等用户裁决 */
export async function updateConflictLocal(recordId: string, content: string): Promise<void> {
  const entry = await db.conflicts.get(recordId)
  if (!entry) return
  await db.conflicts.put({
    ...entry,
    local: { ...entry.local, content: content.trim() },
  })
}
