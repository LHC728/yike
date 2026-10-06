/**
 * Reconcile（方案 §45、§47 - §53）。
 *
 * 这是同步正确性的核心：把服务器状态与本机状态对齐，决定
 *   A. 本机没有未同步修改 → 直接采用服务器
 *   B. 本机有修改、服务器没动 → 保留本机，准备 Push
 *   C. 两边都动了 → 三方比较（能自动合并就合并，真冲突才打扰用户）
 */
import { noSessionCheck } from '../cloud/sessionScope'
import { db } from '../db/db'
import {
  dropPendingForRecord,
  hasSendingForRecord,
  listPendingForRecord,
  rebasePendingForRecord,
} from '../db/outboxRepository'
import { applyCloudRecord, replaceWithSnapshot } from '../db/recordRepository'
import type { CloudRecord } from '../domain/record'
import { snapshotEquals, snapshotOf, snapshotOfCloud } from '../domain/record'
import {
  createConflict,
  refreshConflictRemote,
  threeWayMerge,
} from './ConflictService'

export interface ReconcileStats {
  adopted: number
  keptLocal: number
  autoMerged: number
  conflicts: number
}

/** 对账单条服务器记录 */
export async function reconcileOne(
  cloud: CloudRecord,
  stats?: ReconcileStats,
  checkCurrent: () => void = noSessionCheck,
): Promise<void> {
  await db.transaction('rw', db.records, db.outbox, db.conflicts, async () => {
    checkCurrent()
    await reconcileCurrent(cloud, stats)
    // 中间的 IDB await 可能跨过退出登录；抛出后整笔对账回滚。
    checkCurrent()
  })
}

async function reconcileCurrent(cloud: CloudRecord, stats?: ReconcileStats): Promise<void> {
  const local = await db.records.get(cloud.id)

  // 本机完全没有这条记录（含服务器上的 Tombstone）→ 直接落地，防止复活
  if (!local) {
    await applyCloudRecord(cloud)
    if (stats) stats.adopted += 1
    return
  }

  // 有 Mutation 正在发送：本轮跳过，等 Push 结束后再判断
  if (await hasSendingForRecord(cloud.id)) return

  // 已经处于冲突态：只刷新 Remote 一侧，绝不覆盖 Base / Local
  const conflict = await db.conflicts.get(cloud.id)
  if (conflict) {
    await refreshConflictRemote(cloud.id, cloud)
    return
  }

  const pendings = await listPendingForRecord(cloud.id)
  const [oldest] = pendings

  // 情况 A：本机没有未同步修改
  if (oldest === undefined) {
    if (local.serverVersion !== cloud.version) {
      await applyCloudRecord(cloud)
      if (stats) stats.adopted += 1
    }
    return
  }

  const base = oldest.baseSnapshot
  const localSnapshot = snapshotOf(local)
  const remoteSnapshot = snapshotOfCloud(cloud)

  // 本机改动最终又回到了原样 → 放弃待发送 Mutation，采用服务器
  if (snapshotEquals(localSnapshot, base)) {
    await dropPendingForRecord(cloud.id)
    await applyCloudRecord(cloud)
    if (stats) stats.adopted += 1
    return
  }

  // 情况 B：服务器版本仍等于我们的基线 → 服务器没发生其他变化，直接准备 Push
  if (oldest.baseServerVersion !== null && cloud.version === oldest.baseServerVersion) {
    return
  }

  // 情况 C：三方比较
  const merge = threeWayMerge(base, localSnapshot, remoteSnapshot)

  if (merge.conflicts.length === 0) {
    await db.transaction('rw', db.records, db.outbox, async () => {
      await replaceWithSnapshot(cloud.id, merge.merged, 'pending', cloud.version)
      await rebasePendingForRecord(cloud.id, remoteSnapshot, cloud.version)
    })
    if (stats) stats.autoMerged += 1
    return
  }

  // 真冲突：Base / Local / Remote 三份全部保留
  await createConflict({
    userId: cloud.userId,
    local,
    cloud,
    base,
    merge,
  })
  if (stats) stats.conflicts += 1
}

export async function reconcileMany(clouds: CloudRecord[], checkCurrent: () => void = noSessionCheck): Promise<ReconcileStats> {
  const stats: ReconcileStats = { adopted: 0, keptLocal: 0, autoMerged: 0, conflicts: 0 }
  for (const cloud of clouds) {
    checkCurrent()
    await reconcileOne(cloud, stats, checkCurrent)
  }
  return stats
}
