/**
 * Push（方案 §34、§39 - §43、§57、§58）。
 *
 * - 同一条 Record 的 Mutation 严格串行；不同 Record 可以并行（§57）
 * - 每个 Mutation 带 mutationId，服务端保证幂等，重试不会重复执行（§41）
 * - 遇到 version_conflict 立即停下，交给 Reconcile 做三方比较，绝不静默覆盖
 */
import { noSessionCheck } from '../cloud/sessionScope'
import { mutationToParams, type CloudAdapter } from '../cloud/CloudAdapter'
import { db } from '../db/db'
import {
  claimMutation,
  listAllPending,
  markFailed,
  markPending,
  removeMutation,
} from '../db/outboxRepository'
import { setServerVersion } from '../db/recordRepository'
import { createPayloadOf, type Mutation } from '../domain/mutation'
import { snapshotOf } from '../domain/record'
import { uuidv4 } from '../utils/id'
import { nowIso } from '../utils/time'
import { reconcileOne } from './ReconcileService'

export interface PushStats {
  pushed: number
  conflicts: number
  failed: number
}

/** 上次运行中途被打断留下的 sending 状态，回到 pending 重新发送（幂等保证安全） */
export async function resetStaleSending(userId: string, checkCurrent: () => void = noSessionCheck): Promise<void> {
  await db.transaction('rw', db.outbox, async () => {
    checkCurrent()
    await db.outbox.where('[userId+state]').equals([userId, 'sending']).modify({ state: 'pending', attempted: true })
    checkCurrent()
  })
}

export async function pushPending(adapter: CloudAdapter, userId: string, checkCurrent: () => void = noSessionCheck): Promise<PushStats> {
  const stats: PushStats = { pushed: 0, conflicts: 0, failed: 0 }
  if (!adapter.isConfigured()) return stats

  checkCurrent()
  const mutations = await listAllPending(userId)
  checkCurrent()
  if (mutations.length === 0) return stats

  const grouped = new Map<string, Mutation[]>()
  for (const mutation of mutations) {
    const list = grouped.get(mutation.recordId)
    if (list) list.push(mutation)
    else grouped.set(mutation.recordId, [mutation])
  }

  const settled = await Promise.allSettled(
    Array.from(grouped.entries()).map(([recordId, list]) =>
      pushRecord(adapter, userId, recordId, list, stats, checkCurrent),
    ),
  )

  // 只要有一条记录推送失败，就让上层知道（触发退避重试），
  // 但其余记录该成功的仍然已经成功。
  const rejected = settled.find((item) => item.status === 'rejected')
  if (rejected && rejected.status === 'rejected') {
    throw rejected.reason instanceof Error ? rejected.reason : new Error('push_failed')
  }

  return stats
}

async function pushRecord(
  adapter: CloudAdapter,
  userId: string,
  recordId: string,
  mutations: Mutation[],
  stats: PushStats,
  checkCurrent: () => void,
): Promise<void> {
  for (const candidate of mutations) {
    checkCurrent()
    const mutation = await db.transaction('rw', db.records, db.outbox, db.conflicts, async () => {
      checkCurrent()
      const claimed = await claimMutation(candidate.mutationId, userId)
      checkCurrent()
      return claimed
    })
    checkCurrent()
    if (!mutation) continue

    let result
    try {
      result = await adapter.applyMutation(userId, mutationToParams(mutation))
    } catch (error) {
      checkCurrent()
      await db.transaction('rw', db.records, db.outbox, async () => {
        checkCurrent()
        await markFailed(mutation.mutationId, mutation.retryCount + 1)
        await db.records.where('id').equals(recordId).modify((row) => { row.syncState = 'error' })
        checkCurrent()
      })
      stats.failed += 1
      throw error
    }

    checkCurrent()
    const keepSending = await db.transaction('rw', db.records, db.outbox, db.conflicts, async () => {
      checkCurrent()
      let next = false
      if (result.status === 'applied' || result.status === 'already_applied') {
        await removeMutation(mutation.mutationId)
        if (result.record) await reconcileOne(result.record, undefined, checkCurrent)
        else if (result.version !== null) await setServerVersion(recordId, result.version)
        stats.pushed += 1
        next = true
      } else if (result.status === 'version_conflict') {
        await markPending(mutation.mutationId)
        stats.conflicts += 1
      } else {
        await promoteToCreate(recordId)
      }
      // 已应用但会话随后失效也必须回滚本地出队，回到 A 后用原 mutationId 幂等确认。
      checkCurrent()
      return next
    })
    if (!keepSending) return
  }
}

/** 把某条记录的全部待发送 Mutation 替换成一个完整的 create */
export async function promoteToCreate(recordId: string): Promise<boolean> {
  let ok = false
  await db.transaction('rw', db.records, db.outbox, async () => {
    const record = await db.records.get(recordId)
    if (!record) return

    await db.outbox.where('recordId').equals(recordId).delete()
    await db.records.where('id').equals(recordId).modify((row) => {
      row.serverVersion = null
      row.syncState = 'pending'
    })

    const mutation: Mutation = {
      mutationId: uuidv4(),
      userId: record.userId,
      recordId: record.id,
      operation: 'create',
      baseServerVersion: null,
      baseSnapshot: { ...snapshotOf(record), content: '' },
      payload: createPayloadOf(record),
      createdAt: nowIso(),
      retryCount: 0,
      state: 'pending',
      attempted: false,
    }
    await db.outbox.put(mutation)
    ok = true
  })
  return ok
}
