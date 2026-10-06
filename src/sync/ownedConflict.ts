import { db } from '../db/db'
import { runOwnedRecordWrite } from '../db/uiRecordRepository'
import type { RecordWriteResult, RecordWriteTarget } from '../domain/write'
import { resolveConflict, type ConflictChoice } from './ConflictService'

/** 版本核对与裁决共享事务，不能把排队前的“恢复”重新解释成后来刷新版本的“删除”。 */
export function resolveOwnedConflict(
  target: RecordWriteTarget,
  choice: ConflictChoice,
  editedContent: string | undefined,
  current: () => boolean,
  expectedRemoteVersion: number,
): Promise<RecordWriteResult> {
  return runOwnedRecordWrite(target, current, {
    allowDeleted: true, allowConflict: true, requireConflict: true, expectedConflictVersion: expectedRemoteVersion,
  }, async () => {
    await resolveConflict(target.recordId, choice, editedContent)
    return db.records.get(target.recordId)
  })
}
