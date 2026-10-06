/**
 * 同步与冲突测试 —— 方案 §77 Test 3 / 4 / 5 / 6 / 7 / 8 / 9 / 10 / 14。
 *
 * 说明：本仓库的 Repository 通过模块级单例数据库工作，
 * 因此「两台设备」通过切换独立 IndexedDB 顺序模拟，与真实的
 * 「A 写 → 服务器 → B 读」在数据流上完全一致。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db, setActiveDatabase, type AppDatabase } from '../db/db'
import {
  completeTodo,
  createRecord,
  applyCloudRecord,
  updateContent,
} from '../db/recordRepository'
import { listAllPending } from '../db/outboxRepository'
import { syncEngine } from '../sync/SyncEngine'
import { pushPending } from '../sync/PushService'
import { resolveConflict, listConflicts } from '../sync/ConflictService'
import { cleanupDevices, FakeCloudServer, openDevice } from './fakeCloudServer'

const ACCOUNT = 'account-1'
const TZ = 'Asia/Shanghai'

let server: FakeCloudServer
const deviceCache = new Map<string, AppDatabase>()

async function device(name: string): Promise<AppDatabase> {
  const cached = deviceCache.get(name)
  if (cached) {
    setActiveDatabase(cached)
    return cached
  }
  const created = await openDevice(name)
  deviceCache.set(name, created)
  return created
}

/** 切换到某台设备并把同步引擎指向同一个账号 */
async function switchTo(name: string, userId: string = ACCOUNT): Promise<AppDatabase> {
  const database = await device(name)
  // 先让上一台设备的在途同步收敛，再切换
  await syncEngine.waitIdle()
  syncEngine.stop()
  syncEngine.configure({ adapter: server, userId, mode: 'cloud' })
  return database
}

/** 完整同步并等待彻底收敛（含 Realtime 触发的后台同步） */
async function sync(): Promise<void> {
  await syncEngine.sync('manual')
  await syncEngine.waitIdle()
}

beforeEach(() => {
  server = new FakeCloudServer()
  deviceCache.clear()
})

afterEach(async () => {
  await syncEngine.waitIdle()
  syncEngine.stop()
  await cleanupDevices()
  deviceCache.clear()
})

describe('Test 3：离线补同步', () => {
  it('断网创建三条，联网后自动上传，另一台设备能看到', async () => {
    server.offline = true
    await switchTo('A')

    await createRecord({ userId: ACCOUNT, type: 'idea', content: 'A', nowUtc: '2026-09-29T16:00:00.000Z', timezone: TZ })
    await createRecord({ userId: ACCOUNT, type: 'todo', content: 'B', nowUtc: '2026-09-29T16:10:00.000Z', timezone: TZ })
    await createRecord({ userId: ACCOUNT, type: 'idea', content: 'C', nowUtc: '2026-09-29T16:20:00.000Z', timezone: TZ })

    // 断网时同步失败，但本地一切正常
    await sync()
    expect(server.rows.size).toBe(0)
    expect(await db.records.count()).toBe(3)

    // 恢复网络
    server.offline = false
    await sync()
    expect(server.rows.size).toBe(3)

    // 另一台设备登录后自动出现
    await switchTo('B')
    await sync()
    const onB = await db.records.toArray()
    expect(onB).toHaveLength(3)
    expect(onB.map((r) => r.content).toSorted()).toEqual(['A', 'B', 'C'])
    expect(await listAllPending(ACCOUNT)).toHaveLength(0)
  })
})

describe('Test 4：多次重试不重复', () => {
  it('服务器已成功但响应丢失，客户端重试不会重复执行', async () => {
    await switchTo('A')
    // 此例单独验证写入幂等，避免 Realtime 的完整对账提前安全出队。
    syncEngine.stop()

    server.dropNextResponse = true
    await createRecord({ userId: ACCOUNT, type: 'idea', content: '研究 ROS2', nowUtc: '2026-09-29T16:00:00.000Z', timezone: TZ })

    // 第一次：服务器写成功，但客户端收不到响应
    await expect(pushPending(server, ACCOUNT)).rejects.toThrow('response_lost')
    expect(server.rows.size).toBe(1)

    const [recordId] = Array.from(server.rows.keys())
    if (recordId === undefined) throw new Error('第一次同步后应该有且只有一条记录')
    const versionAfterFirst = server.rows.get(recordId)?.version

    // 直接重试写入，明确验证幂等；完整对账也可能发现内容已一致而安全出队。
    await pushPending(server, ACCOUNT)
    await sync()

    expect(server.rows.size).toBe(1)
    // version 只增加了一次
    expect(server.rows.get(recordId)?.version).toBe(versionAfterFirst)
    // 服务端确实收到了重复请求，但只有一次真正生效
    expect(server.received.length).toBeGreaterThan(1)
    expect(new Set(server.received).size).toBe(1)
    expect(await listAllPending(ACCOUNT)).toHaveLength(0)
  })
})

describe('Test 5：Realtime', () => {
  it('A 创建记录后，B 不刷新也能通过 Realtime 自动看到', async () => {
    await switchTo('A')
    const record = await createRecord({
      userId: ACCOUNT,
      type: 'idea',
      content: '手机创建的内容',
      nowUtc: '2026-09-29T16:00:00.000Z',
      timezone: TZ,
    })
    await sync()

    // B 上线并订阅 Realtime（此时本地还没有这条记录）
    await switchTo('B')
    expect(await db.records.count()).toBe(0)

    // 模拟服务端推送 Realtime 事件
    server.emit(ACCOUNT, record.id)
    await syncEngine.waitIdle()

    const onB = await db.records.get(record.id)
    expect(onB?.content).toBe('手机创建的内容')
  })
})

describe('Test 6：漏掉 Realtime 也能补回来', () => {
  it('B 断网期间 A 创建，B 恢复后即使没收到事件，Pull 也能补回', async () => {
    await switchTo('A')
    await createRecord({ userId: ACCOUNT, type: 'idea', content: '离线期间创建', nowUtc: '2026-09-29T16:00:00.000Z', timezone: TZ })
    await sync()

    await switchTo('B')
    expect(await db.records.count()).toBe(0)

    // 完全不触发 Realtime，直接做一次完整同步
    await sync()
    expect(await db.records.count()).toBe(1)
    expect((await db.records.toArray())[0]?.content).toBe('离线期间创建')
  })
})

describe('Test 7：同时修改同一字段', () => {
  it('发送失败的本地编辑遇到远端编辑仍保留三方冲突', async () => {
    await switchTo('A')
    const record = await createRecord({ userId: ACCOUNT, type: 'idea', content: '原文', timezone: TZ })
    await sync()
    await updateContent(record.id, '本机草稿')
    await db.outbox.where('recordId').equals(record.id).modify({ state: 'failed', retryCount: 1 })

    const remote = server.rows.get(record.id)
    if (!remote) throw new Error('缺少服务器基线')
    server.rows.set(record.id, { ...remote, content: '另一设备编辑', version: remote.version + 1 })
    await sync()

    const [conflict] = await listConflicts(ACCOUNT)
    expect(conflict?.base.content).toBe('原文')
    expect(conflict?.local.content).toBe('本机草稿')
    expect(conflict?.remote.content).toBe('另一设备编辑')
    expect((await db.records.get(record.id))?.content).toBe('本机草稿')
    expect(server.rows.get(record.id)?.content).toBe('另一设备编辑')
    expect(await listAllPending(ACCOUNT)).toHaveLength(1)
  })

  it('推送回执不能覆盖仍在 failed 队列里的草稿', async () => {
    await switchTo('A')
    const record = await createRecord({ userId: ACCOUNT, type: 'idea', content: '原文', timezone: TZ })
    await sync()
    await updateContent(record.id, '待重试草稿')
    await db.outbox.where('recordId').equals(record.id).modify({ state: 'failed' })
    const remote = server.rows.get(record.id)
    if (!remote) throw new Error('缺少服务器基线')
    await applyCloudRecord({ ...remote, content: '新远端', version: remote.version + 1 })
    expect((await db.records.get(record.id))?.content).toBe('待重试草稿')
    expect(await listAllPending(ACCOUNT)).toHaveLength(1)
  })

  it('两边都改 content 且不同 → 必须进入冲突，不能静默覆盖', async () => {
    await switchTo('A')
    const record = await createRecord({ userId: ACCOUNT, type: 'idea', content: 'AAA', nowUtc: '2026-09-29T16:00:00.000Z', timezone: TZ })
    await sync()

    // A 本机改成 BBB（暂不同步）
    await updateContent(record.id, 'BBB', '2026-09-29T17:00:00.000Z', TZ)

    // B 拿到这条记录后改成 CCC 并同步
    await switchTo('B')
    await sync()
    await updateContent(record.id, 'CCC', '2026-09-29T18:00:00.000Z', TZ)
    await sync()

    // A 上线
    await switchTo('A')
    await sync()

    const conflicts = await listConflicts(ACCOUNT)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.kind).toBe('field')
    expect(conflicts[0]?.fields).toContain('content')

    // 三个版本都还在
    expect(conflicts[0]?.base.content).toBe('AAA')
    expect(conflicts[0]?.local.content).toBe('BBB')
    expect(conflicts[0]?.remote.content).toBe('CCC')

    // 本机内容没有被静默覆盖
    const local = await db.records.get(record.id)
    expect(local?.content).toBe('BBB')
    expect(local?.syncState).toBe('conflict')

    // 服务器上仍然是 B 的版本，A 没有偷偷覆盖
    expect(server.rows.get(record.id)!.content).toBe('CCC')
  })
})

describe('Test 8：修改不同字段', () => {
  it('一边改正文、一边完成 Todo → 自动安全合并，不弹冲突', async () => {
    await switchTo('A')
    const todo = await createRecord({ userId: ACCOUNT, type: 'todo', content: '学习 STM32', nowUtc: '2026-09-29T16:00:00.000Z', timezone: TZ })
    await sync()

    // A 完成它
    await completeTodo(todo.id, '2026-09-29T17:00:00.000Z', TZ)

    // B 改正文并同步
    await switchTo('B')
    await sync()
    await updateContent(todo.id, '学习 STM32 定时器', '2026-09-29T18:00:00.000Z', TZ)
    await sync()

    // A 上线
    await switchTo('A')
    await sync()

    expect(await listConflicts(ACCOUNT)).toHaveLength(0)

    const local = await db.records.get(todo.id)
    expect(local?.content).toBe('学习 STM32 定时器')
    expect(local?.completedAtUtc).not.toBeNull()
    expect(local?.syncState).toBe('synced')

    const remote = server.rows.get(todo.id)!
    expect(remote.content).toBe('学习 STM32 定时器')
    expect(remote.completedAtUtc).not.toBeNull()
  })
})

describe('Test 9：删除防复活', () => {
  it('手机删除后，长期离线的电脑重新上线不会让记录复活', async () => {
    await switchTo('A')
    const record = await createRecord({ userId: ACCOUNT, type: 'idea', content: '待删除', nowUtc: '2026-09-29T16:00:00.000Z', timezone: TZ })
    await sync()

    // B 先同步一次，拿到这条记录
    await switchTo('B')
    await sync()
    expect(await db.records.count()).toBe(1)

    // A 删除
    await switchTo('A')
    const { softDelete } = await import('../db/recordRepository')
    await softDelete(record.id, '2026-09-29T20:00:00.000Z')
    await sync()
    expect(server.rows.get(record.id)!.deletedAtUtc).not.toBeNull()

    // B 重新上线
    await switchTo('B')
    await sync()

    const onB = await db.records.get(record.id)
    expect(onB?.deletedAtUtc).not.toBeNull()
    expect(onB?.syncState).toBe('synced')
    expect(await listAllPending(ACCOUNT)).toHaveLength(0)

    // 服务器上仍然是删除状态
    expect(server.rows.get(record.id)!.deletedAtUtc).not.toBeNull()
  })
})

describe('Test 10：删除与编辑冲突', () => {
  it('电脑离线编辑、手机删除 → 必须提示冲突，本机内容不能丢', async () => {
    await switchTo('A')
    const record = await createRecord({ userId: ACCOUNT, type: 'idea', content: '原始内容', nowUtc: '2026-09-29T16:00:00.000Z', timezone: TZ })
    await sync()

    // B 离线编辑
    await switchTo('B')
    await sync()
    await updateContent(record.id, '离线编辑后的内容', '2026-09-29T17:00:00.000Z', TZ)

    // A 删除
    await switchTo('A')
    const { softDelete } = await import('../db/recordRepository')
    await softDelete(record.id, '2026-09-29T18:00:00.000Z')
    await sync()

    // B 上线
    await switchTo('B')
    await sync()

    const conflicts = await listConflicts(ACCOUNT)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.kind).toBe('delete-edit')
    expect(conflicts[0]?.local.content).toBe('离线编辑后的内容')

    // 本机内容仍然在，服务器上也还没有复活
    expect((await db.records.get(record.id))?.content).toBe('离线编辑后的内容')
    expect(server.rows.get(record.id)!.deletedAtUtc).not.toBeNull()

    // 选择「恢复并保留本机内容」
    await resolveConflict(record.id, 'local')
    await sync()

    expect(await listConflicts(ACCOUNT)).toHaveLength(0)
    const remote = server.rows.get(record.id)!
    expect(remote.deletedAtUtc).toBeNull()
    expect(remote.content).toBe('离线编辑后的内容')
  })

  it('选择「保留删除」时，服务器的删除状态保持不变', async () => {
    await switchTo('A')
    const record = await createRecord({ userId: ACCOUNT, type: 'idea', content: '原始内容', nowUtc: '2026-09-29T16:00:00.000Z', timezone: TZ })
    await sync()

    await switchTo('B')
    await sync()
    await updateContent(record.id, '离线编辑', '2026-09-29T17:00:00.000Z', TZ)

    await switchTo('A')
    const { softDelete } = await import('../db/recordRepository')
    await softDelete(record.id, '2026-09-29T18:00:00.000Z')
    await sync()

    await switchTo('B')
    await sync()
    await resolveConflict(record.id, 'remote')
    await sync()

    expect(server.rows.get(record.id)!.deletedAtUtc).not.toBeNull()
    expect((await db.records.get(record.id))?.deletedAtUtc).not.toBeNull()
  })
})

describe('Test 14：账号隔离', () => {
  it('B 账号读不到 A 账号的任何记录', async () => {
    await switchTo('A', 'account-A')
    await createRecord({ userId: 'account-A', type: 'idea', content: 'A 的私密记录', nowUtc: '2026-09-29T16:00:00.000Z', timezone: TZ })
    await sync()
    expect(server.rows.size).toBe(1)

    await switchTo('B', 'account-B')
    await sync()

    expect(await db.records.count()).toBe(0)
  })

  it('B 账号无法通过伪造 recordId 写入 A 账号的记录', async () => {
    await switchTo('A', 'account-A')
    const record = await createRecord({ userId: 'account-A', type: 'idea', content: 'A 的记录', nowUtc: '2026-09-29T16:00:00.000Z', timezone: TZ })
    await sync()

    await switchTo('B', 'account-B')
    const result = await server.applyMutation('account-B', {
      mutationId: 'forged-mutation',
      recordId: record.id,
      operation: 'update',
      expectedVersion: 1,
      payload: { content: '被篡改' },
    })

    expect(result.status).toBe('record_not_found')
    expect(server.rows.get(record.id)!.content).toBe('A 的记录')
  })
})

describe('离线连续修改压缩（§58）', () => {
  it('同一记录离线改 5 次只发一个 Update，base 仍是最初离线前那一份', async () => {
    await switchTo('A')
    const idea = await createRecord({ userId: ACCOUNT, type: 'idea', content: '第一版', nowUtc: '2026-09-29T16:00:00.000Z', timezone: TZ })
    await sync()
    expect(server.rows.get(idea.id)!.version).toBe(1)

    server.offline = true
    for (let i = 0; i < 5; i += 1) {
      await updateContent(idea.id, `第 ${i + 2} 版`, `2026-09-29T17:0${i}:00.000Z`, TZ)
    }

    const pending = await listAllPending(ACCOUNT)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.operation).toBe('update')
    expect(pending[0]?.payload.content).toBe('第 6 版')
    // baseServerVersion / baseSnapshot 保留最初那一份
    expect(pending[0]?.baseServerVersion).toBe(1)
    expect(pending[0]?.baseSnapshot.content).toBe('第一版')

    server.offline = false
    await sync()
    expect(server.rows.get(idea.id)!.content).toBe('第 6 版')
    expect(server.rows.get(idea.id)!.version).toBe(2)
  })
})

describe('冲突裁决：保留本机', () => {
  it('保留本机后，服务器最终与本机一致，且非冲突字段的自动合并结果保留', async () => {
    await switchTo('A')
    const todo = await createRecord({ userId: ACCOUNT, type: 'todo', content: 'AAA', nowUtc: '2026-09-29T16:00:00.000Z', timezone: TZ })
    await sync()

    await updateContent(todo.id, 'BBB', '2026-09-29T17:00:00.000Z', TZ)
    await completeTodo(todo.id, '2026-09-29T17:01:00.000Z', TZ)

    await switchTo('B')
    await sync()
    await updateContent(todo.id, 'CCC', '2026-09-29T18:00:00.000Z', TZ)
    await sync()

    await switchTo('A')
    await sync()
    expect(await listConflicts(ACCOUNT)).toHaveLength(1)

    await resolveConflict(todo.id, 'local')
    await sync()

    const remote = server.rows.get(todo.id)!
    expect(remote.content).toBe('BBB')
    // 本机的「已完成」是非冲突字段，必须被保留下来
    expect(remote.completedAtUtc).not.toBeNull()
    expect(await listConflicts(ACCOUNT)).toHaveLength(0)
  })
})
