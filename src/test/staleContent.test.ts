import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppDatabase } from '../db/db'
import { createRecord, updateContent } from '../db/recordRepository'
import { updateOwnedContent } from '../db/uiRecordRepository'
import { snapshotOf, type LocalRecord } from '../domain/record'
import { cleanupDevices, openDevice } from './fakeCloudServer'

const OWNER = { userId: 'stale-content-owner', sessionRevision: 1 }
const CURRENT = (): boolean => true
let database: AppDatabase

beforeEach(async () => {
  database = await openDevice(`stale-content-${Math.random().toString(36).slice(2)}`)
})

afterEach(async () => { await cleanupDevices() })

async function fixture(): Promise<LocalRecord> {
  const record = await createRecord({ userId: OWNER.userId, type: 'project', content: '编辑开始正文', progress: 0 })
  await database.outbox.clear()
  await database.records.update(record.id, { serverVersion: 1, syncState: 'synced' })
  const saved = await database.records.get(record.id)
  if (!saved) throw new Error('测试基线不存在')
  return saved
}

describe('正文编辑开始快照与原子 CAS', () => {
  it('已经拉取的新正文不能被旧草稿覆盖，拒绝时不产生 outbox', async () => {
    const original = await fixture()
    await database.records.update(original.id, { content: '远端第二版', serverVersion: 2 })
    const result = await updateOwnedContent({ ...OWNER, recordId: original.id }, '旧草稿', CURRENT, snapshotOf(original))
    expect(result).toMatchObject({ status: 'stale', current: { content: '远端第二版', serverVersion: 2 } })
    expect((await database.records.get(original.id))?.content).toBe('远端第二版')
    expect(await database.outbox.count()).toBe(0)
  })

  it('同一个 serverVersion 的本机新正文也受保护，不能只比较服务器版本', async () => {
    const original = await fixture()
    await updateContent(original.id, '另一处本机新正文')
    const before = await database.outbox.toArray()
    const result = await updateOwnedContent({ ...OWNER, recordId: original.id }, '旧草稿', CURRENT, snapshotOf(original))
    expect(result).toMatchObject({ status: 'stale', current: { content: '另一处本机新正文', serverVersion: 1 } })
    expect(await database.outbox.toArray()).toEqual(before)
  })

  it('明确确认仍比较显示给用户的快照，提示后第三版到达需要再次确认', async () => {
    const original = await fixture()
    await database.records.update(original.id, { content: '第二版', serverVersion: 2 })
    const second = await database.records.get(original.id)
    if (!second) throw new Error('第二版不存在')
    await database.records.update(original.id, { content: '第三版', serverVersion: 3 })
    const target = { ...OWNER, recordId: original.id }
    const stale = await updateOwnedContent(target, '明确确认的草稿', CURRENT, snapshotOf(second))
    expect(stale).toMatchObject({ status: 'stale', current: { content: '第三版' } })
    expect(await database.outbox.count()).toBe(0)
    const third = await database.records.get(original.id)
    if (!third) throw new Error('第三版不存在')
    const result = await updateOwnedContent(target, '明确确认的草稿', CURRENT, snapshotOf(third))
    expect(result).toMatchObject({ status: 'saved', record: { content: '明确确认的草稿' } })
    const [mutation] = await database.outbox.toArray()
    expect(mutation?.baseServerVersion).toBe(3)
    expect(mutation?.baseSnapshot.content).toBe('第三版')
    expect(result.status === 'saved' && result.record.createdAtUtc).toBe(original.createdAtUtc)
  })

  it('只有进度或截止日更新时可保存正文，保存保留最新非冲突字段', async () => {
    const original = await fixture()
    await database.records.update(original.id, { progress: 75, deadlineLocalDate: '2026-10-20', serverVersion: 2 })
    const result = await updateOwnedContent({ ...OWNER, recordId: original.id }, '独立正文编辑', CURRENT, snapshotOf(original))
    expect(result).toMatchObject({ status: 'saved', record: { content: '独立正文编辑', progress: 75, deadlineLocalDate: '2026-10-20' } })
    const [mutation] = await database.outbox.toArray()
    expect(mutation?.baseServerVersion).toBe(2)
    expect(mutation?.payload).not.toHaveProperty('progress')
    expect(mutation?.payload).not.toHaveProperty('deadlineLocalDate')
  })

  it('远端软删后即使确认旧草稿也不恢复记录', async () => {
    const original = await fixture()
    const deletedAtUtc = '2026-10-06T02:00:00.000Z'
    await database.records.update(original.id, { deletedAtUtc, serverVersion: 2 })
    expect(await updateOwnedContent({ ...OWNER, recordId: original.id }, '保留但不可隐式恢复的草稿', CURRENT, snapshotOf(original)))
      .toEqual({ status: 'unavailable', reason: 'deleted' })
    expect((await database.records.get(original.id))?.deletedAtUtc).toBe(deletedAtUtc)
    expect(await database.outbox.count()).toBe(0)
  })
})
