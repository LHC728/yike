import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppDatabase } from '../db/db'
import { createRecord, softDelete, updateContent } from '../db/recordRepository'
import {
  completeOwnedTodo, createOwnedRecord, deleteOwnedRecord, restoreOwnedRecord, runOwnedRecordWrite,
  uncompleteOwnedTodo, updateOwnedContent, updateOwnedDeadline, updateOwnedProgress,
} from '../db/uiRecordRepository'
import { snapshotOf, type LocalRecord, type RecordType } from '../domain/record'
import { didWrite, type RecordWriteTarget } from '../domain/write'
import { resolveOwnedConflict } from '../sync/ownedConflict'
import { cleanupDevices, openDevice } from './fakeCloudServer'

let database: AppDatabase
const OWNER = { userId: 'ui-owner-A', sessionRevision: 1 }
const CURRENT = (): boolean => true

beforeEach(async () => {
  database = await openDevice(`ui-owner-${Math.random().toString(36).slice(2)}`)
})

afterEach(async () => { await cleanupDevices() })

async function fixture(type: RecordType = 'idea', userId = OWNER.userId): Promise<LocalRecord> {
  const record = await createRecord({
    userId, type, content: '不能跨账号修改的原文', nowUtc: '2026-10-06T00:00:00.000Z', timezone: 'Asia/Shanghai',
  })
  await database.outbox.clear()
  await database.records.update(record.id, { serverVersion: 1, syncState: 'synced' })
  const saved = await database.records.get(record.id)
  if (!saved) throw new Error('测试基线不存在')
  return saved
}

describe('UI 账号归属与事务边界', () => {
  it('所有修改入口在同一事务中拒绝其他账号的记录，原文与 outbox 均不变', async () => {
    const original = await fixture('todo')
    const wrong: RecordWriteTarget = { ...OWNER, userId: 'ui-owner-B', recordId: original.id }
    const writes = [
      () => updateOwnedContent(wrong, 'B 的错误正文', CURRENT, snapshotOf(original)),
      () => updateOwnedProgress(wrong, 50, CURRENT, snapshotOf(original)),
      () => updateOwnedDeadline(wrong, '2026-12-01', CURRENT),
      () => completeOwnedTodo(wrong, CURRENT),
      () => uncompleteOwnedTodo(wrong, CURRENT),
      () => deleteOwnedRecord(wrong, CURRENT),
      () => restoreOwnedRecord(wrong, CURRENT),
      () => resolveOwnedConflict(wrong, 'local', undefined, CURRENT),
    ]
    for (const write of writes) {
      expect(await write()).toEqual({ status: 'unavailable', reason: 'owner' })
      expect(await database.records.get(original.id)).toEqual(original)
      expect(await database.outbox.count()).toBe(0)
    }
  })

  it('旧会话在事务开始前失效时，新建不会产生记录或同步任务', async () => {
    expect(await createOwnedRecord(OWNER, { type: 'idea', content: '旧草稿' }, () => false))
      .toEqual({ status: 'unavailable', reason: 'session' })
    expect(await database.records.count()).toBe(0)
    expect(await database.outbox.count()).toBe(0)
  })

  it('写入完成后、事务提交前换身份，记录与 outbox 必须一起回滚', async () => {
    const original = await fixture()
    let current = true
    const result = await runOwnedRecordWrite({ ...OWNER, recordId: original.id }, () => current, {}, async () => {
      const updated = await updateContent(original.id, '事务中写入但不能提交的草稿')
      current = false
      return updated
    })
    expect(result).toEqual({ status: 'unavailable', reason: 'session' })
    expect(await database.records.get(original.id)).toEqual(original)
    expect(await database.outbox.count()).toBe(0)
  })

  it('新建的事务尾也复查会话，不会遗留迁移后不可见的本机记录', async () => {
    let checks = 0
    const result = await createOwnedRecord(OWNER, { type: 'idea', content: '迁移空窗中的旧输入' }, () => ++checks === 1)
    expect(result).toEqual({ status: 'unavailable', reason: 'session' })
    expect(await database.records.count()).toBe(0)
    expect(await database.outbox.count()).toBe(0)
  })

  it('进展父级必须存在、属于当前账号、仍有效且确实是大事', async () => {
    const foreign = await fixture('project', 'ui-owner-B')
    const idea = await fixture()
    const deleted = await fixture('project')
    await softDelete(deleted.id)
    await database.outbox.clear()
    for (const parentId of ['不存在的父级', foreign.id, idea.id, deleted.id]) {
      expect(await createOwnedRecord(OWNER, { type: 'log', content: '不应写入', parentId, progress: 25 }, CURRENT))
        .toEqual({ status: 'unavailable', reason: 'parent' })
    }
    expect(await database.records.where('type').equals('log').count()).toBe(0)
    expect(await database.outbox.count()).toBe(0)
  })

  it('同账号的有效进展复用单 Record 与原子 outbox，创建字段保持原样', async () => {
    const parent = await fixture('project')
    const result = await createOwnedRecord(OWNER, {
      type: 'log', content: '合法进展', parentId: parent.id, progress: 25,
      nowUtc: '2026-10-06T01:00:00.000Z', timezone: 'Asia/Shanghai',
    }, CURRENT)
    expect(didWrite(result)).toBe(true)
    if (!didWrite(result)) throw new Error('合法写入未保存')
    expect(result.record).toMatchObject({ userId: OWNER.userId, parentId: parent.id, progress: 25, type: 'log' })
    const [mutation] = await database.outbox.toArray()
    expect(mutation?.recordId).toBe(result.record.id)
    expect(mutation?.payload).toMatchObject(snapshotOf(result.record))
    expect(await database.records.get(parent.id)).toEqual(parent)
  })

  it('软删或存在同步冲突的记录不会被普通编辑隐式恢复或改写', async () => {
    const deleted = await fixture()
    await softDelete(deleted.id)
    const conflicted = await fixture()
    const snapshot = snapshotOf(conflicted)
    await database.conflicts.put({
      recordId: conflicted.id, userId: OWNER.userId, kind: 'field', fields: ['content'],
      base: snapshot, local: snapshot, remote: { ...snapshot, content: '云端正文' },
      remoteVersion: 2, createdAt: '2026-10-06T02:00:00.000Z',
    })
    await database.outbox.clear()
    expect(await updateOwnedContent({ ...OWNER, recordId: deleted.id }, '不得恢复', CURRENT, snapshotOf(deleted)))
      .toEqual({ status: 'unavailable', reason: 'deleted' })
    expect(await updateOwnedContent({ ...OWNER, recordId: conflicted.id }, '不得覆盖冲突', CURRENT, snapshotOf(conflicted)))
      .toEqual({ status: 'unavailable', reason: 'conflict' })
    expect((await database.records.get(deleted.id))?.deletedAtUtc).not.toBeNull()
    expect(await database.records.get(conflicted.id)).toEqual(conflicted)
    expect(await database.outbox.count()).toBe(0)
  })

  it('冲突裁决同时核对冲突归属；缺失或别人的冲突不能报告成功', async () => {
    const original = await fixture()
    const target = { ...OWNER, recordId: original.id }
    expect(await resolveOwnedConflict(target, 'remote', undefined, CURRENT))
      .toEqual({ status: 'unavailable', reason: 'missing' })
    const snapshot = snapshotOf(original)
    await database.conflicts.put({
      recordId: original.id, userId: 'ui-owner-B', kind: 'field', fields: ['content'],
      base: snapshot, local: snapshot, remote: { ...snapshot, content: 'B 的错误冲突内容' },
      remoteVersion: 2, createdAt: '2026-10-06T02:00:00.000Z',
    })
    expect(await resolveOwnedConflict(target, 'remote', undefined, CURRENT))
      .toEqual({ status: 'unavailable', reason: 'owner' })
    expect(await database.records.get(original.id)).toEqual(original)
    expect((await database.conflicts.get(original.id))?.userId).toBe('ui-owner-B')
    expect(await database.outbox.count()).toBe(0)
  })
})
