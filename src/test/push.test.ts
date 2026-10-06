import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppDatabase } from '../db/db'
import * as outboxRepository from '../db/outboxRepository'
import { createRecord, completeTodo, updateContent } from '../db/recordRepository'
import type { LocalRecord, RecordType } from '../domain/record'
import { snapshotOf, snapshotOfCloud } from '../domain/record'
import { mutationToParams } from '../cloud/CloudAdapter'
import { pushPending, resetStaleSending } from '../sync/PushService'
import { reconcileMany } from '../sync/ReconcileService'
import { cleanupDevices, FakeCloudServer, openDevice, reopenDevice } from './fakeCloudServer'

const ACCOUNT = 'push-account'
const TZ = 'Asia/Shanghai'
const CREATED_AT = '2026-10-06T01:00:00.000Z'

let database: AppDatabase
let server: FakeCloudServer

beforeEach(async () => {
  database = await openDevice(`push-${Math.random().toString(36).slice(2)}`)
  server = new FakeCloudServer()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanupDevices()
})

async function syncedRecord(type: RecordType = 'idea'): Promise<LocalRecord> {
  const record = await createRecord({ userId: ACCOUNT, type, content: '原文', nowUtc: CREATED_AT, timezone: TZ })
  await pushPending(server, ACCOUNT)
  const synced = await database.records.get(record.id)
  if (!synced) throw new Error('缺少本机基线')
  return synced
}

describe('推送队列领取与压缩边界', () => {
  it('冻结旧包后，连续的新编辑仍可压缩到各自未发送的新 ID', async () => {
    const record = await syncedRecord()
    await updateContent(record.id, '已尝试正文')
    server.failNext = true
    await expect(pushPending(server, ACCOUNT)).rejects.toThrow('server_error')
    const [sent] = await database.outbox.toArray()
    if (!sent) throw new Error('缺少已尝试 mutation')
    await outboxRepository.markPending(sent.mutationId)
    await updateContent(record.id, '新草稿一')
    await updateContent(record.id, '新草稿二')
    const queued = await database.outbox.toArray()
    expect(queued).toHaveLength(2)
    expect(queued.find((item) => item.mutationId === sent.mutationId)?.payload.content).toBe('已尝试正文')
    expect(queued.find((item) => item.mutationId !== sent.mutationId)?.payload.content).toBe('新草稿二')
    await pushPending(server, ACCOUNT)
    expect(server.rows.get(record.id)?.content).toBe('新草稿二')
    expect(await database.outbox.count()).toBe(0)
  })

  it('扫描队列后保存的新正文，必须以领取时的最新 payload 发送', async () => {
    const record = await syncedRecord()
    await updateContent(record.id, '扫描前的草稿', '2026-10-06T02:00:00.000Z', TZ)
    const listAllPending = outboxRepository.listAllPending
    vi.spyOn(outboxRepository, 'listAllPending').mockImplementationOnce(async (userId) => {
      const candidates = await listAllPending(userId)
      // 把正常保存安排在扫描之后、发送之前，不伪造数据库内部事务。
      await updateContent(record.id, '刚保存的最终草稿', '2026-10-06T02:01:00.000Z', TZ)
      return candidates
    })

    await pushPending(server, ACCOUNT)

    expect(server.rows.get(record.id)?.content).toBe('刚保存的最终草稿')
    expect((await database.records.get(record.id))?.content).toBe('刚保存的最终草稿')
    expect(await database.outbox.count()).toBe(0)
  })

  it('扫描后 mutation 已不属于当前账号时，不能发送旧副本或删除它', async () => {
    const record = await syncedRecord()
    await updateContent(record.id, '另一个账号保留的草稿', '2026-10-06T02:00:00.000Z', TZ)
    const listAllPending = outboxRepository.listAllPending
    vi.spyOn(outboxRepository, 'listAllPending').mockImplementationOnce(async (userId) => {
      const candidates = await listAllPending(userId)
      await database.outbox.where('recordId').equals(record.id).modify({ userId: 'other-account' })
      return candidates
    })

    const receivedBefore = server.received.length
    await pushPending(server, ACCOUNT)

    expect(server.received).toHaveLength(receivedBefore)
    expect(server.rows.get(record.id)?.content).toBe('原文')
    expect(await database.outbox.count()).toBe(1)
  })

  it('同记录已有 sending 时，后续 mutation 等待，不能越过正在发送的修改', async () => {
    const record = await syncedRecord()
    await updateContent(record.id, '正在发送的草稿', '2026-10-06T02:00:00.000Z', TZ)
    await database.outbox.where('recordId').equals(record.id).modify({ state: 'sending' })
    await updateContent(record.id, '排队中的新草稿', '2026-10-06T02:01:00.000Z', TZ)

    const receivedBefore = server.received.length
    await pushPending(server, ACCOUNT)

    expect(server.received).toHaveLength(receivedBefore)
    expect((await database.records.get(record.id))?.content).toBe('排队中的新草稿')
    expect(await database.outbox.count()).toBe(2)
  })

  it('服务器已处理但响应前被杀，重启后的完成动作使用新 ID 并最终同步', async () => {
    const record = await syncedRecord('todo')
    await updateContent(record.id, '已发出的正文', '2026-10-06T02:00:00.000Z', TZ)
    const [sent] = await database.outbox.toArray()
    if (!sent) throw new Error('缺少已发送 mutation')
    await database.outbox.where('mutationId').equals(sent.mutationId).modify((mutation) => {
      mutation.state = 'sending'
      // 模拟已经持久保存的发送标记，兼容尚未新增字段的旧实现来验证回归。
      const raw = mutation as unknown as Record<string, unknown>
      raw['attempted'] = true
    })
    await server.applyMutation(ACCOUNT, mutationToParams(sent))

    // 没执行本机回执确认，直接重开同一个库，模拟真实进程中断。
    await reopenDevice(database)
    await resetStaleSending(ACCOUNT)
    await completeTodo(record.id, '2026-10-06T02:01:00.000Z', TZ)
    const queued = await database.outbox.toArray()
    expect(queued).toHaveLength(2)
    expect(queued.find((mutation) => mutation.payload.completedAtUtc !== undefined)?.mutationId).not.toBe(sent.mutationId)

    await reconcileMany(await server.pullAll(ACCOUNT))
    await pushPending(server, ACCOUNT)
    await reconcileMany(await server.pullAll(ACCOUNT))

    expect(server.rows.get(record.id)?.completedAtUtc).toBe('2026-10-06T02:01:00.000Z')
    expect((await database.records.get(record.id))?.completedAtUtc).toBe('2026-10-06T02:01:00.000Z')
    expect(await database.outbox.count()).toBe(0)
  })

  it('旧库没有 attempted 字段时保守冻结，不能复用已经应用的 ID', async () => {
    const record = await syncedRecord('todo')
    await updateContent(record.id, '旧版本已发出的正文', '2026-10-06T02:00:00.000Z', TZ)
    const [sent] = await database.outbox.toArray()
    if (!sent) throw new Error('缺少旧 mutation')
    await server.applyMutation(ACCOUNT, mutationToParams(sent))
    await database.outbox.where('mutationId').equals(sent.mutationId).modify((mutation) => {
      const raw = mutation as unknown as Record<string, unknown>
      delete raw['attempted']
      delete raw['queueOrder']
      mutation.state = 'pending'
    })

    await reopenDevice(database)
    await completeTodo(record.id, '2026-10-06T02:01:00.000Z', TZ)
    expect(await database.outbox.count()).toBe(2)
    await reconcileMany(await server.pullAll(ACCOUNT))
    await pushPending(server, ACCOUNT)

    expect(server.rows.get(record.id)?.completedAtUtc).toBe('2026-10-06T02:01:00.000Z')
    expect(await database.outbox.count()).toBe(0)
  })

  it('失败旧包与新编辑落在同一毫秒时，仍按入队顺序发送并一次收敛', async () => {
    const record = await syncedRecord()
    const changedAt = '2026-10-06T02:00:00.000Z'
    await updateContent(record.id, '失败的旧草稿', changedAt, TZ)
    const [older] = await database.outbox.toArray()
    if (!older) throw new Error('缺少旧 mutation')
    server.failNext = true
    await expect(pushPending(server, ACCOUNT)).rejects.toThrow('server_error')
    await updateContent(record.id, '同毫秒保存的新草稿', changedAt, TZ)

    const receivedBefore = server.received.length
    await pushPending(server, ACCOUNT)

    const sentIds = server.received.slice(receivedBefore)
    expect(sentIds).toHaveLength(2)
    expect(sentIds[0]).toBe(older.mutationId)
    expect(sentIds[1]).not.toBe(older.mutationId)
    expect(server.rows.get(record.id)?.content).toBe('同毫秒保存的新草稿')
    expect((await database.records.get(record.id))?.content).toBe('同毫秒保存的新草稿')
    expect(await database.outbox.count()).toBe(0)
  })

  it('重试旧正文后安全重基下一条完成动作，单次推送不留下版本冲突', async () => {
    const record = await syncedRecord('todo')
    await updateContent(record.id, '等待重试的正文', '2026-10-06T02:00:00.000Z', TZ)
    server.failNext = true
    await expect(pushPending(server, ACCOUNT)).rejects.toThrow('server_error')
    await completeTodo(record.id, '2026-10-06T02:01:00.000Z', TZ)

    const stats = await pushPending(server, ACCOUNT)

    expect(stats).toEqual({ pushed: 2, conflicts: 0, failed: 0 })
    expect(server.rows.get(record.id)?.content).toBe('等待重试的正文')
    expect(server.rows.get(record.id)?.completedAtUtc).toBe('2026-10-06T02:01:00.000Z')
    expect(await database.outbox.count()).toBe(0)
  })

  it('两次并发推送同一记录时，不能重复领取或越过在途修改', async () => {
    const record = await syncedRecord()
    await updateContent(record.id, '并发发送的正文', '2026-10-06T02:00:00.000Z', TZ)
    const applyMutation = server.applyMutation.bind(server)
    let announce: (() => void) | undefined
    let release: (() => void) | undefined
    const sending = new Promise<void>((resolve) => { announce = resolve })
    const blocked = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(server, 'applyMutation').mockImplementationOnce(async (userId, params) => {
      announce?.()
      await blocked
      return applyMutation(userId, params)
    })

    const receivedBefore = server.received.length
    const first = pushPending(server, ACCOUNT)
    await sending
    await updateContent(record.id, '在途时追加的正文', '2026-10-06T02:01:00.000Z', TZ)
    await pushPending(server, ACCOUNT)
    expect(server.received).toHaveLength(receivedBefore)
    expect(await database.outbox.count()).toBe(2)
    release?.()
    await first
    await pushPending(server, ACCOUNT)

    expect(server.received).toHaveLength(receivedBefore + 2)
    expect(new Set(server.received).size).toBe(server.received.length)
    expect(server.rows.get(record.id)?.content).toBe('在途时追加的正文')
    expect(await database.outbox.count()).toBe(0)
  })

  it('领取必须核对真实队头，不能信任已经过时的候选顺序', async () => {
    const record = await syncedRecord()
    await updateContent(record.id, '需要先重试的正文', '2026-10-06T02:00:00.000Z', TZ)
    const [older] = await database.outbox.toArray()
    if (!older) throw new Error('缺少旧 mutation')
    server.failNext = true
    await expect(pushPending(server, ACCOUNT)).rejects.toThrow('server_error')
    await updateContent(record.id, '必须后发送的正文', '2026-10-06T02:01:00.000Z', TZ)
    const listAllPending = outboxRepository.listAllPending
    vi.spyOn(outboxRepository, 'listAllPending').mockImplementationOnce(async (userId) =>
      (await listAllPending(userId)).toReversed(),
    )

    const receivedBefore = server.received.length
    await pushPending(server, ACCOUNT)

    expect(server.received.slice(receivedBefore)).toEqual([older.mutationId])
    expect(await database.outbox.count()).toBe(1)
    await pushPending(server, ACCOUNT)
    expect(server.rows.get(record.id)?.content).toBe('必须后发送的正文')
    expect(await database.outbox.count()).toBe(0)
  })

  it('设备时间回拨后，新修改仍排在已尝试旧包之后，用户时间原样保存', async () => {
    const record = await syncedRecord()
    await updateContent(record.id, '校时前的正文', '2026-10-06T02:00:00.000Z', TZ)
    const [older] = await database.outbox.toArray()
    if (!older) throw new Error('缺少旧 mutation')
    server.failNext = true
    await expect(pushPending(server, ACCOUNT)).rejects.toThrow('server_error')
    const correctedTime = '2026-10-06T01:30:00.000Z'
    await updateContent(record.id, '校时后的新正文', correctedTime, TZ)

    const receivedBefore = server.received.length
    await pushPending(server, ACCOUNT)

    expect(server.received[receivedBefore]).toBe(older.mutationId)
    expect(server.rows.get(record.id)?.content).toBe('校时后的新正文')
    expect(server.rows.get(record.id)?.updatedAtUtc).toBe(correctedTime)
    expect((await database.records.get(record.id))?.createdAtUtc).toBe(CREATED_AT)
    expect(await database.outbox.count()).toBe(0)
  })
})

describe('云端缺记录时完整恢复', () => {
  it.each(['project', 'log'] as const)('恢复 %s 不丢进度、截止日或所属大事', async (type) => {
    const parent = type === 'log'
      ? await createRecord({ userId: ACCOUNT, type: 'project', content: '所属大事', progress: 65, timezone: TZ })
      : null
    const record = await createRecord({
      userId: ACCOUNT, type, content: '原始记录', progress: type === 'project' ? 65 : 40,
      deadlineLocalDate: type === 'project' ? '2026-10-31' : null,
      parentId: parent?.id ?? null, nowUtc: CREATED_AT, timezone: TZ,
    })
    await pushPending(server, ACCOUNT)
    server.rows.delete(record.id)
    await updateContent(record.id, '需要恢复的最新正文')
    await pushPending(server, ACCOUNT)
    const [recovery] = await database.outbox.where('recordId').equals(record.id).toArray()
    expect(recovery?.operation).toBe('create')
    expect(recovery?.payload.progress).toBe(record.progress)
    expect(recovery?.payload.deadlineLocalDate).toBe(record.deadlineLocalDate)
    expect(recovery?.payload.parentId).toBe(record.parentId)
    await pushPending(server, ACCOUNT)
    const remote = server.rows.get(record.id)
    const local = await database.records.get(record.id)
    if (!remote || !local) throw new Error('恢复记录缺失')
    expect(snapshotOfCloud(remote)).toEqual(snapshotOf(local))
    expect(remote.createdAtUtc).toBe(CREATED_AT)
    expect(remote.content).toBe('需要恢复的最新正文')
    expect(await database.outbox.count()).toBe(0)
  })
})
