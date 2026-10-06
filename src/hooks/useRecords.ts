/**
 * 记录查询与操作（方案 §28、§29）。
 *
 * 所有查询都直接读 IndexedDB —— UI 永远不等待网络。
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import type { CreateRecordInput } from '../db/recordRepository'
import {
  completeOwnedTodo, createOwnedRecord, deleteOwnedRecord, restoreOwnedRecord,
  uncompleteOwnedTodo, updateOwnedContent, updateOwnedDeadline, updateOwnedProgress,
} from '../db/uiRecordRepository'
import { captureWriteOwner, isWriteOwnerCurrent } from '../app/writeOwner'
import { toaster } from '../app/toastStore'
import { didWrite, type RecordWriteResult, type RecordWriteTarget, type WriteOwner } from '../domain/write'
import { resolveOwnedConflict } from '../sync/ownedConflict'
import { countPending } from '../db/outboxRepository'
import type { LocalRecord, RecordType } from '../domain/record'
import {
  byCompletedAtDesc,
  byCreatedAtDesc,
  byDeadlineAsc,
  isDoneTodo,
  isIdea,
  isLogOf,
  isOnTimeline,
  isOpenProject,
  isOpenTodo,
  matchesQuery,
  PROGRESS_MAX,
} from '../domain/record'
import { syncEngine } from '../sync/SyncEngine'
import { countConflicts, type ConflictChoice } from '../sync/ConflictService'

const EMPTY: LocalRecord[] = []

function sortDesc(records: LocalRecord[]): LocalRecord[] {
  return records.toSorted(byCreatedAtDesc)
}

/** 该用户全部记录（含软删除，同步层需要） */
export function useAllRecords(userId: string | null): LocalRecord[] {
  const records = useLiveQuery(
    async () => (userId ? db.records.where('userId').equals(userId).toArray() : EMPTY),
    [userId],
    EMPTY,
  )
  return userId ? (records ?? EMPTY).filter((record) => record.userId === userId) : EMPTY
}

/** 首页时间线：idea + todo，创建时间倒序，已完成仍保留（§78） */
export function useTimeline(userId: string | null): LocalRecord[] {
  const records = useAllRecords(userId)
  return sortDesc(records.filter(isOnTimeline))
}

/** 灵感页（§17） */
export function useIdeas(userId: string | null): LocalRecord[] {
  const records = useAllRecords(userId)
  return sortDesc(records.filter(isIdea))
}

/** 待办页：只显示未完成（§19、§79） */
export function useOpenTodos(userId: string | null): LocalRecord[] {
  const records = useAllRecords(userId)
  return sortDesc(records.filter(isOpenTodo))
}

/**
 * 待办页底部的「已完成」区：全部已完成的待办，按**完成时间**倒序。
 *
 * 它不是归档，是一块「后悔药」—— 手滑打勾之后能就地撤销。
 * 归档仍然归首页时间线和日历管，所以这里不做分组、不做时间窗。
 */
export function useDoneTodos(userId: string | null): LocalRecord[] {
  const records = useAllRecords(userId)
  return records.filter(isDoneTodo).toSorted(byCompletedAtDesc)
}

/**
 * 首页「目前在做的大事」。
 *
 * 排序是**截止日升序**（最紧急的在最上），不是创建时间 ——
 * 这块地方存在的意义就是「打开就知道先干哪个」。
 * 没设截止日的排最后。
 *
 * 推到 100% 的不在这里，但也不会消失：它仍在首页时间线里。
 */
export function useOpenProjects(userId: string | null): LocalRecord[] {
  const records = useAllRecords(userId)
  return records.filter(isOpenProject).toSorted(byDeadlineAsc)
}

/**
 * 某件大事下的进展记录，**最新在最上面**。
 *
 * 倒序是刻意的：打开详情时第一眼要看到的是「现在到哪了」，
 * 而不是「最开始写了什么」。
 *
 * 父级被删掉时进展不跟着消失（各自的 deletedAtUtc 独立），
 * 所以这里只按 isLogOf 过滤，不关心父级还在不在 ——
 * 撤销「删除大事」之后写过的进展要原样回来。
 */
export function useLogs(userId: string | null, projectId: string | null): LocalRecord[] {
  const records = useAllRecords(userId)
  if (!projectId) return EMPTY
  return records.filter((record) => isLogOf(record, projectId)).toSorted(byCreatedAtDesc)
}

/**
 * 每件大事下有多少条进展：`Map<大事 id, 条数>`。
 *
 * 一次遍历算出全部，而不是每行调一次 hook —— 首页模块里可能有十几件大事，
 * 那样就是十几个 liveQuery 订阅，每写一条记录全部重算一遍。
 */
export function useLogCounts(userId: string | null): Map<string, number> {
  const records = useAllRecords(userId)
  const counts = new Map<string, number>()
  for (const record of records) {
    if (record.deletedAtUtc !== null || record.type !== 'log') continue
    if (record.parentId === null) continue
    counts.set(record.parentId, (counts.get(record.parentId) ?? 0) + 1)
  }
  return counts
}

/**
 * 日历归档：按 created_local_date（§23、§24、§80）。
 *
 * 走 isOnTimeline 而不是自己写 `deletedAtUtc === null` ——
 * 那样会把进展也列进来，日历上就会冒出「9月30日 · 限位搞定了」这种
 * 没有上下文的碎片。过滤规则只留一处，加新类型时才不会漏。
 */
export function useRecordsOnDate(userId: string | null, localDate: string | null): LocalRecord[] {
  const records = useAllRecords(userId)
  if (!localDate) return EMPTY
  return sortDesc(records.filter((r) => isOnTimeline(r) && r.createdLocalDate === localDate))
}

/** 有记录的日期集合，用于月历小圆点（同样排除进展） */
export function useRecordDates(userId: string | null): Set<string> {
  const records = useAllRecords(userId)
  const dates = new Set<string>()
  for (const record of records) {
    if (isOnTimeline(record)) dates.add(record.createdLocalDate)
  }
  return dates
}

export function useRecord(userId: string | null, recordId: string | null): LocalRecord | undefined {
  const record = useLiveQuery(async () => {
    if (!userId || !recordId) return undefined
    const found = await db.records.get(recordId)
    return found?.userId === userId ? found : undefined
  }, [userId, recordId])
  // liveQuery 的上次结果可能仍在；不能等下一次异步查询才隐藏别人的内容。
  return record?.userId === userId && record.id === recordId ? record : undefined
}

export function useSearchResults(userId: string | null, query: string): LocalRecord[] {
  const records = useAllRecords(userId)
  if (!query.trim()) return EMPTY
  return sortDesc(records.filter((r) => matchesQuery(r, query)))
}

export function usePendingCount(userId: string | null): number {
  const count = useLiveQuery(
    async () => (userId ? countPending(userId) : 0),
    [userId],
    0,
  )
  return count ?? 0
}

export function useConflictCount(userId: string | null): number {
  const count = useLiveQuery(
    async () => (userId ? countConflicts(userId) : 0),
    [userId],
    0,
  )
  return count ?? 0
}

export function useConflicts(userId: string | null) {
  const conflicts = useLiveQuery(
    async () => (userId ? db.conflicts.where('userId').equals(userId).toArray() : []),
    [userId],
    [],
  )
  return (conflicts ?? []).filter((conflict) => conflict.userId === userId)
}

// ---------------------------------------------------------------
// 操作：UI 只通过这里写数据
// ---------------------------------------------------------------

async function safeWrite(owner: WriteOwner, write: () => Promise<RecordWriteResult>): Promise<RecordWriteResult> {
  if (!isWriteOwnerCurrent(owner)) return { status: 'unavailable', reason: 'session' }
  try {
    const result = await write()
    if (didWrite(result) && isWriteOwnerCurrent(owner)) syncEngine.notifyLocalChange()
    if (result.status === 'unavailable' && result.reason !== 'session' && isWriteOwnerCurrent(owner)) {
      toaster.show({ message: '这次操作没有保存。请保留输入内容，检查记录状态后重试。' })
    }
    return result
  } catch {
    if (isWriteOwnerCurrent(owner)) toaster.show({ message: '没能保存到本机，请保留输入内容后重试。' })
    return { status: 'unavailable', reason: 'failed' }
  }
}

export { captureWriteOwner }

export const recordActions = {
  create(owner: WriteOwner, input: Omit<CreateRecordInput, 'userId'>): Promise<RecordWriteResult> {
    return safeWrite(owner, () => createOwnedRecord(owner, input, () => isWriteOwnerCurrent(owner)))
  },
  quickCapture(owner: WriteOwner, content: string, type: RecordType): Promise<RecordWriteResult> {
    return recordActions.create(owner, { type, content })
  },
  updateContent(target: RecordWriteTarget, content: string): Promise<RecordWriteResult> {
    return safeWrite(target, () => updateOwnedContent(target, content, () => isWriteOwnerCurrent(target)))
  },
  setProgress(target: RecordWriteTarget, progress: number): Promise<RecordWriteResult> {
    return safeWrite(target, () => updateOwnedProgress(target, progress, () => isWriteOwnerCurrent(target)))
  },
  finishProject(target: RecordWriteTarget): Promise<RecordWriteResult> {
    return recordActions.setProgress(target, PROGRESS_MAX)
  },
  setDeadline(target: RecordWriteTarget, date: string | null): Promise<RecordWriteResult> {
    return safeWrite(target, () => updateOwnedDeadline(target, date, () => isWriteOwnerCurrent(target)))
  },
  createLog(target: RecordWriteTarget, content: string, progress: number | null): Promise<RecordWriteResult> {
    return recordActions.create(target, { type: 'log', content, parentId: target.recordId, progress })
  },
  complete(target: RecordWriteTarget): Promise<RecordWriteResult> {
    return safeWrite(target, () => completeOwnedTodo(target, () => isWriteOwnerCurrent(target)))
  },
  uncomplete(target: RecordWriteTarget): Promise<RecordWriteResult> {
    return safeWrite(target, () => uncompleteOwnedTodo(target, () => isWriteOwnerCurrent(target)))
  },
  remove(target: RecordWriteTarget): Promise<RecordWriteResult> {
    return safeWrite(target, () => deleteOwnedRecord(target, () => isWriteOwnerCurrent(target)))
  },
  restore(target: RecordWriteTarget): Promise<RecordWriteResult> {
    return safeWrite(target, () => restoreOwnedRecord(target, () => isWriteOwnerCurrent(target)))
  },
  resolveConflict(target: RecordWriteTarget, choice: ConflictChoice, editedContent?: string): Promise<RecordWriteResult> {
    return safeWrite(target, () => resolveOwnedConflict(target, choice, editedContent, () => isWriteOwnerCurrent(target)))
  },
}
