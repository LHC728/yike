import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppDatabase } from '../db/db'
import { createRecord, updateProjectProgress } from '../db/recordRepository'
import { updateOwnedProgress } from '../db/uiRecordRepository'
import { snapshotOf, type LocalRecord } from '../domain/record'
import { cleanupDevices, openDevice } from './fakeCloudServer'

const OWNER = { userId: 'progress-cas-owner', sessionRevision: 1 }
const CURRENT = (): boolean => true
let database: AppDatabase

beforeEach(async () => {
  database = await openDevice(`progress-cas-${Math.random().toString(36).slice(2)}`)
})

afterEach(async () => { await cleanupDevices() })

async function fixture(progress = 0): Promise<LocalRecord> {
  const record = await createRecord({ userId: OWNER.userId, type: 'project', content: '原大事正文', progress })
  await database.outbox.clear()
  await database.records.update(record.id, { serverVersion: 1, syncState: 'synced' })
  const saved = await database.records.get(record.id)
  if (!saved) throw new Error('测试基线不存在')
  return saved
}

describe('进度操作开始快照与原子 CAS', () => {
  it('拖动期间拉取的新进度不得被旧动作覆盖，不生成 outbox', async () => {
    const original = await fixture()
    await database.records.update(original.id, { progress: 75, serverVersion: 2 })
    const result = await updateOwnedProgress({ ...OWNER, recordId: original.id }, 25, CURRENT, snapshotOf(original))
    expect(result).toMatchObject({ status: 'stale', current: { progress: 75 } })
    expect((await database.records.get(original.id))?.progress).toBe(75)
    expect(await database.outbox.count()).toBe(0)
  })

  it('服务器版本未变的另一处本机进度更新也受保护', async () => {
    const original = await fixture()
    await updateProjectProgress(original.id, 50)
    const before = await database.outbox.toArray()
    expect(await updateOwnedProgress({ ...OWNER, recordId: original.id }, 25, CURRENT, snapshotOf(original)))
      .toMatchObject({ status: 'stale', current: { progress: 50, serverVersion: 1 } })
    expect(await database.outbox.toArray()).toEqual(before)
  })

  it('正文或截止日独立更新不会错误阻挡进度，保存保留最新非冲突字段', async () => {
    const original = await fixture()
    await database.records.update(original.id, { content: '新的独立正文', deadlineLocalDate: '2026-10-20', serverVersion: 2 })
    const result = await updateOwnedProgress({ ...OWNER, recordId: original.id }, 25, CURRENT, snapshotOf(original))
    expect(result).toMatchObject({ status: 'saved', record: { progress: 25, content: '新的独立正文', deadlineLocalDate: '2026-10-20' } })
    const [mutation] = await database.outbox.toArray()
    expect(mutation?.baseServerVersion).toBe(2)
    expect(mutation?.payload).not.toHaveProperty('content')
    expect(mutation?.payload).not.toHaveProperty('deadlineLocalDate')
  })

  it('同值保存不产生同步任务，不改变记录时间', async () => {
    const original = await fixture(75)
    expect(await updateOwnedProgress({ ...OWNER, recordId: original.id }, 75, CURRENT, snapshotOf(original)))
      .toEqual({ status: 'unchanged', record: original })
    expect(await database.records.get(original.id)).toEqual(original)
    expect(await database.outbox.count()).toBe(0)
  })

  it('用户明确退回 0 时照常保存，不能擅自取较大值', async () => {
    const original = await fixture(75)
    expect(await updateOwnedProgress({ ...OWNER, recordId: original.id }, 0, CURRENT, snapshotOf(original)))
      .toMatchObject({ status: 'saved', record: { progress: 0, createdAtUtc: original.createdAtUtc } })
    const [mutation] = await database.outbox.toArray()
    expect(mutation?.payload.progress).toBe(0)
  })

  it('操作期间软删后不能由进度保存隐式恢复', async () => {
    const original = await fixture()
    const deletedAtUtc = '2026-10-06T02:00:00.000Z'
    await database.records.update(original.id, { deletedAtUtc, serverVersion: 2 })
    expect(await updateOwnedProgress({ ...OWNER, recordId: original.id }, 50, CURRENT, snapshotOf(original)))
      .toEqual({ status: 'unavailable', reason: 'deleted' })
    expect((await database.records.get(original.id))?.deletedAtUtc).toBe(deletedAtUtc)
    expect(await database.outbox.count()).toBe(0)
  })
})
