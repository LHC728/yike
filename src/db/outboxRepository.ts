/**
 * Outbox 仓库（方案 §34、§57、§58）。
 *
 * 所有 Mutation 的入队、压缩、重基（rebase）、出队都集中在这里。
 * 注意：入队必须与 Record 写入处在同一个 transaction —— 见 recordRepository。
 */
import { db } from './db'
import type { Mutation } from '../domain/mutation'
import { canCompress, compressMutations } from '../domain/mutation'
import type { RecordSnapshot } from '../domain/record'

function queueOrderOf(mutation: Mutation): number {
  const value = mutation.queueOrder
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 0
}

function compareQueueOrder(a: Mutation, b: Mutation): number {
  // 老版本没有序号；升级后追加的修改必须排在这些尚未确认的旧包之后。
  const order = queueOrderOf(a) - queueOrderOf(b)
  if (order !== 0) return order
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.mutationId.localeCompare(b.mutationId)
}

/** 某条记录所有尚未完成的 Mutation，按入队顺序 */
export async function listPendingForRecord(recordId: string): Promise<Mutation[]> {
  const list = await db.outbox.where('[recordId+state]').equals([recordId, 'pending']).toArray()
  const sending = await db.outbox.where('[recordId+state]').equals([recordId, 'sending']).toArray()
  // failed 只是等待重试，并不是用户放弃了草稿；对账必须保留它的基线。
  const failed = await db.outbox.where('[recordId+state]').equals([recordId, 'failed']).toArray()
  return [...list, ...sending, ...failed].toSorted(compareQueueOrder)
}

/** 某条记录是否有正在发送的 Mutation（此时不参与 Reconcile，等下一轮） */
export async function hasSendingForRecord(recordId: string): Promise<boolean> {
  const count = await db.outbox.where('[recordId+state]').equals([recordId, 'sending']).count()
  return count > 0
}

export async function listAllPending(userId: string): Promise<Mutation[]> {
  const list = await db.outbox.where('[userId+state]').equals([userId, 'pending']).toArray()
  const failed = await db.outbox.where('[userId+state]').equals([userId, 'failed']).toArray()
  return [...list, ...failed].toSorted(compareQueueOrder)
}

export async function countPending(userId: string): Promise<number> {
  const pending = await db.outbox.where('[userId+state]').equals([userId, 'pending']).count()
  const failed = await db.outbox.where('[userId+state]').equals([userId, 'failed']).count()
  const sending = await db.outbox.where('[userId+state]').equals([userId, 'sending']).count()
  return pending + failed + sending
}

/**
 * 入队。若已存在同一记录、尚未发送的 Mutation，则压缩成一个（§58）。
 * 必须在外层 transaction 中调用。
 */
export async function enqueueMutation(mutation: Mutation): Promise<void> {
  const queued = await listPendingForRecord(mutation.recordId)
  const existing = queued.find((item) => canCompress(item, mutation))

  if (existing) {
    const compressed = compressMutations(existing, mutation)
    await db.outbox.put(compressed)
    return
  }

  const queueOrder = queued.reduce((max, item) => Math.max(max, queueOrderOf(item)), 0) + 1
  await db.outbox.put({ ...mutation, queueOrder })
}

/** 扫描得到的只是候选 ID；领取与冻结必须一起提交，防止旧副本吞掉刚保存的 payload。 */
export async function claimMutation(mutationId: string, userId: string): Promise<Mutation | null> {
  return db.transaction('rw', db.records, db.outbox, db.conflicts, async () => {
    const mutation = await db.outbox.get(mutationId)
    if (!mutation || mutation.userId !== userId || mutation.state === 'sending') return null
    const record = await db.records.get(mutation.recordId)
    if (!record || record.userId !== userId) return null
    if (await db.conflicts.get(mutation.recordId)) return null
    if (await hasSendingForRecord(mutation.recordId)) return null
    const [oldest] = await listPendingForRecord(mutation.recordId)
    if (oldest?.mutationId !== mutationId) return null

    const claimed: Mutation = { ...mutation, state: 'sending', attempted: true }
    await db.outbox.put(claimed)
    return claimed
  })
}

export async function markPending(mutationId: string): Promise<void> {
  await db.outbox.where('mutationId').equals(mutationId).modify({ state: 'pending', attempted: true })
}

export async function markFailed(mutationId: string, retryCount: number): Promise<void> {
  await db.outbox
    .where('mutationId')
    .equals(mutationId)
    .modify({ state: 'failed', retryCount, attempted: true })
}

/** 幂等成功：出队 */
export async function removeMutation(mutationId: string): Promise<void> {
  await db.outbox.delete(mutationId)
}

/**
 * 重基（§47 情况 B / §48）：
 * 服务器没有冲突变化时，把待发送 Mutation 的 base 提升到服务器最新版本。
 * payload 保持我们自己的改动不变。
 */
export async function rebasePendingForRecord(
  recordId: string,
  baseSnapshot: RecordSnapshot,
  baseServerVersion: number,
): Promise<void> {
  await db.outbox.where('recordId').equals(recordId).modify((mutation) => {
    if (mutation.state === 'pending' || mutation.state === 'failed') {
      // failed 已经过发送尝试；恢复队列状态不能把这个事实变回「未发送」。
      if (mutation.state === 'failed') mutation.attempted = true
      mutation.baseSnapshot = baseSnapshot
      mutation.baseServerVersion = baseServerVersion
      mutation.retryCount = 0
      mutation.state = 'pending'
    }
  })
}

/** 放弃本机的待发送改动（冲突中选择“保留另一设备”时） */
export async function dropPendingForRecord(recordId: string): Promise<void> {
  await db.outbox.where('recordId').equals(recordId).delete()
}

export async function clearOutboxForUser(userId: string): Promise<void> {
  await db.outbox.where('userId').equals(userId).delete()
}
