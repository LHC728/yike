import type { LocalRecord, RecordSnapshot } from './record'

/** 捕获点击/编辑开始时的身份；旧回调不能在新会话中重新解释归属。 */
export interface WriteOwner {
  userId: string
  sessionRevision: number
}

export interface RecordWriteTarget extends WriteOwner {
  recordId: string
}

export type EditBaseline = RecordSnapshot

export type WriteFailure = 'session' | 'missing' | 'owner' | 'deleted' | 'conflict' | 'conflict-updated' | 'type' | 'parent' | 'failed'

export type RecordWriteResult =
  | { status: 'saved' | 'unchanged'; record: LocalRecord }
  | { status: 'stale'; current: LocalRecord }
  | { status: 'unavailable'; reason: WriteFailure }

export function didWrite(result: RecordWriteResult): result is Extract<RecordWriteResult, { status: 'saved' | 'unchanged' }> {
  return result.status === 'saved' || result.status === 'unchanged'
}
