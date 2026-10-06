import { db } from './db'
import {
  completeTodo, createRecord, restoreRecord, softDelete, uncompleteTodo,
  updateContent, updateDeadline, updateProjectProgress,
  type CreateRecordInput,
} from './recordRepository'
import { clampProgress, snapshotEquals, snapshotOf, type LocalRecord, type RecordType } from '../domain/record'
import type { RecordWriteResult, RecordWriteTarget, WriteOwner } from '../domain/write'

type ScopeCheck = () => boolean

class UiSessionExpired extends Error {}

function checkScope(current: ScopeCheck): void {
  if (!current()) throw new UiSessionExpired('ui_session_expired')
}

interface OwnedChangeOptions {
  allowDeleted?: boolean
  allowConflict?: boolean
  requireConflict?: boolean
  type?: RecordType
}

/**
 * 外层事务保留原 RecordRepository 的写入链路和原子 outbox。
 * 事务尾的身份复查必须抛异常，单纯 return 会把已写入的旧身份数据提交。
 */
export async function runOwnedRecordWrite(
  target: RecordWriteTarget,
  current: ScopeCheck,
  options: OwnedChangeOptions,
  write: (record: LocalRecord) => Promise<LocalRecord | null | undefined>,
): Promise<RecordWriteResult> {
  try {
    return await db.transaction('rw', db.records, db.outbox, db.conflicts, async (): Promise<RecordWriteResult> => {
      checkScope(current)
      const record = await db.records.get(target.recordId)
      checkScope(current)
      if (!record) return { status: 'unavailable', reason: 'missing' }
      if (record.userId !== target.userId) return { status: 'unavailable', reason: 'owner' }
      if (!options.allowDeleted && record.deletedAtUtc !== null) return { status: 'unavailable', reason: 'deleted' }
      if (options.type !== undefined && record.type !== options.type) return { status: 'unavailable', reason: 'type' }
      const conflict = await db.conflicts.get(record.id)
      checkScope(current)
      if (conflict && conflict.userId !== target.userId) return { status: 'unavailable', reason: 'owner' }
      if (options.requireConflict && !conflict) return { status: 'unavailable', reason: 'missing' }
      if (!options.allowConflict && conflict) return { status: 'unavailable', reason: 'conflict' }
      const before = snapshotOf(record)
      const updated = await write(record)
      checkScope(current)
      const final = updated ?? record
      return { status: snapshotEquals(before, snapshotOf(final)) ? 'unchanged' : 'saved', record: final }
    })
  } catch (error) {
    if (error instanceof UiSessionExpired) return { status: 'unavailable', reason: 'session' }
    throw error
  }
}

export async function createOwnedRecord(
  owner: WriteOwner,
  input: Omit<CreateRecordInput, 'userId'>,
  current: ScopeCheck,
): Promise<RecordWriteResult> {
  try {
    return await db.transaction('rw', db.records, db.outbox, db.conflicts, async (): Promise<RecordWriteResult> => {
      checkScope(current)
      if (input.type === 'log') {
        const parent = input.parentId ? await db.records.get(input.parentId) : undefined
        checkScope(current)
        if (!parent || parent.userId !== owner.userId || parent.type !== 'project' || parent.deletedAtUtc !== null) {
          return { status: 'unavailable', reason: 'parent' }
        }
      }
      const record = await createRecord({ ...input, userId: owner.userId })
      checkScope(current)
      return { status: 'saved', record }
    })
  } catch (error) {
    if (error instanceof UiSessionExpired) return { status: 'unavailable', reason: 'session' }
    throw error
  }
}

export function updateOwnedContent(target: RecordWriteTarget, content: string, current: ScopeCheck): Promise<RecordWriteResult> {
  return runOwnedRecordWrite(target, current, {}, () => updateContent(target.recordId, content))
}

export function updateOwnedProgress(target: RecordWriteTarget, progress: number, current: ScopeCheck): Promise<RecordWriteResult> {
  if (clampProgress(progress) === null) return Promise.resolve({ status: 'unavailable', reason: 'type' })
  return runOwnedRecordWrite(target, current, { type: 'project' }, () => updateProjectProgress(target.recordId, progress))
}

export function updateOwnedDeadline(target: RecordWriteTarget, date: string | null, current: ScopeCheck): Promise<RecordWriteResult> {
  return runOwnedRecordWrite(target, current, { type: 'project' }, () => updateDeadline(target.recordId, date))
}

export function completeOwnedTodo(target: RecordWriteTarget, current: ScopeCheck): Promise<RecordWriteResult> {
  return runOwnedRecordWrite(target, current, { type: 'todo' }, () => completeTodo(target.recordId))
}

export function uncompleteOwnedTodo(target: RecordWriteTarget, current: ScopeCheck): Promise<RecordWriteResult> {
  return runOwnedRecordWrite(target, current, { type: 'todo' }, () => uncompleteTodo(target.recordId))
}

export function deleteOwnedRecord(target: RecordWriteTarget, current: ScopeCheck): Promise<RecordWriteResult> {
  return runOwnedRecordWrite(target, current, { allowDeleted: true }, () => softDelete(target.recordId))
}

export function restoreOwnedRecord(target: RecordWriteTarget, current: ScopeCheck): Promise<RecordWriteResult> {
  return runOwnedRecordWrite(target, current, { allowDeleted: true }, () => restoreRecord(target.recordId))
}
