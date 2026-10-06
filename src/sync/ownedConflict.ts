import { db } from '../db/db'
import { runOwnedRecordWrite } from '../db/uiRecordRepository'
import type { RecordWriteResult, RecordWriteTarget } from '../domain/write'
import { resolveConflict, type ConflictChoice } from './ConflictService'

/** 冲突裁决仍走原链路，归属和当前会话验证与裁决共享事务。 */
export function resolveOwnedConflict(
  target: RecordWriteTarget,
  choice: ConflictChoice,
  editedContent: string | undefined,
  current: () => boolean,
): Promise<RecordWriteResult> {
  return runOwnedRecordWrite(target, current, { allowDeleted: true, allowConflict: true, requireConflict: true }, async () => {
    await resolveConflict(target.recordId, choice, editedContent)
    return db.records.get(target.recordId)
  })
}
