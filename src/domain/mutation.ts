/**
 * Mutation —— 本地变化的同步单元（方案 §34、§35）。
 *
 * 每次本地变化同时写 Record + Mutation，且必须落在同一个 IndexedDB transaction 里，
 * 避免「Record 改好了，但同步任务没保存下来」。
 */
import type { RecordSnapshot, RecordType } from './record'

export type MutationOperation =
  | 'create'
  | 'update'
  | 'complete'
  | 'uncomplete'
  | 'delete'
  | 'restore'

export type MutationState = 'pending' | 'sending' | 'failed'

/** 只包含“变化了的字段”的补丁 */
export interface MutationPayload {
  type?: RecordType
  content?: string
  /** 大事进度 0–100；`null` 表示显式清空 */
  progress?: number | null
  /** 大事截止日 `YYYY-MM-DD`；`null` 表示显式清空 */
  deadlineLocalDate?: string | null
  /** 进展所属大事的 id；只有 create 会带（服务端把它当不可变字段） */
  parentId?: string | null
  createdAtUtc?: string
  createdTimezone?: string
  createdLocalDate?: string
  updatedAtUtc?: string
  updatedTimezone?: string
  completedAtUtc?: string | null
  completedTimezone?: string | null
  deletedAtUtc?: string | null
}

/** 创建与灾后补传共用完整快照，避免新增字段只进普通创建、恢复时悄悄遗漏。 */
export function createPayloadOf(record: RecordSnapshot): MutationPayload {
  return {
    type: record.type,
    content: record.content,
    progress: record.progress,
    deadlineLocalDate: record.deadlineLocalDate,
    parentId: record.parentId,
    createdAtUtc: record.createdAtUtc,
    createdTimezone: record.createdTimezone,
    createdLocalDate: record.createdLocalDate,
    updatedAtUtc: record.updatedAtUtc,
    updatedTimezone: record.updatedTimezone,
    completedAtUtc: record.completedAtUtc,
    completedTimezone: record.completedTimezone,
    deletedAtUtc: record.deletedAtUtc,
  }
}

export interface Mutation {
  mutationId: string
  userId: string
  recordId: string
  operation: MutationOperation
  /** 提交时期望的服务器版本；create 为 null */
  baseServerVersion: number | null
  /** 修改前的基线快照，冲突处理的关键（§36） */
  baseSnapshot: RecordSnapshot
  payload: MutationPayload
  createdAt: string
  retryCount: number
  state: MutationState
  /** 旧库缺少此标记时无法证明从未发送，按已尝试处理，禁止复用 ID 压缩新变化。 */
  attempted?: boolean
  /** 同一记录的入队序号；与用户时间分离，防止同毫秒或设备校时把新修改排到旧包前面。 */
  queueOrder?: number
}

/** 合并两个补丁，后者优先 */
export function mergePayload(a: MutationPayload, b: MutationPayload): MutationPayload {
  return { ...a, ...b }
}

/** 补丁是否为空 */
export function isEmptyPayload(payload: MutationPayload): boolean {
  return Object.keys(payload).length === 0
}

/**
 * 压缩规则（§58）：
 * 同一条记录、尚未发送的连续修改，压缩成一个最终 Mutation。
 * baseServerVersion / baseSnapshot 必须保留最初那一份。
 */
const OPERATION_PRIORITY: Record<MutationOperation, number> = {
  create: 6, // create 一旦存在就保持，服务端走 INSERT 路径
  delete: 5,
  restore: 4,
  complete: 3,
  uncomplete: 3,
  update: 1,
}

export function pickOperation(a: MutationOperation, b: MutationOperation): MutationOperation {
  return OPERATION_PRIORITY[a] >= OPERATION_PRIORITY[b] ? a : b
}

export function canCompress(existing: Mutation, incoming: Mutation): boolean {
  return (
    existing.recordId === incoming.recordId &&
    existing.userId === incoming.userId &&
    existing.state === 'pending' &&
    existing.attempted === false &&
    incoming.attempted === false
  )
}

export function compressMutations(existing: Mutation, incoming: Mutation): Mutation {
  const operation = pickOperation(existing.operation, incoming.operation)
  const payload = mergePayload(existing.payload, incoming.payload)

  // create 路径需要完整字段，补齐不可变字段。
  // baseSnapshot 的 created* 在类型上就是必填 string，所以「取不到时保留原值」
  // 等价于原来的 `base || payload`，但写成 if 之后类型上是完备的。
  if (operation === 'create') {
    const { createdAtUtc, createdTimezone, createdLocalDate } = existing.baseSnapshot
    payload.type = incoming.payload.type ?? existing.payload.type ?? existing.baseSnapshot.type
    if (createdAtUtc) payload.createdAtUtc = createdAtUtc
    if (createdTimezone) payload.createdTimezone = createdTimezone
    if (createdLocalDate) payload.createdLocalDate = createdLocalDate
  }

  return {
    ...existing,
    operation,
    payload,
    // baseServerVersion / baseSnapshot 保持最初那一份（§58）
    retryCount: 0,
    state: 'pending',
  }
}
