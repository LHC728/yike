import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppDatabase } from '../db/db'
import { createRecord, softDelete } from '../db/recordRepository'
import { snapshotOf, type CloudRecord } from '../domain/record'
import { reconcileOne } from '../sync/ReconcileService'
import { refreshConflictRemote } from '../sync/ConflictService'
import { resolveOwnedConflict } from '../sync/ownedConflict'
import { cleanupDevices, openDevice } from './fakeCloudServer'

const OWNER = { userId: 'owned-conflict-owner', sessionRevision: 1 }
const CURRENT = (): boolean => true
let database: AppDatabase

beforeEach(async () => {
  database = await openDevice(`owned-conflict-${Math.random().toString(36).slice(2)}`)
})

afterEach(async () => { await cleanupDevices() })

async function fixture(): Promise<CloudRecord> {
  const record = await createRecord({
    userId: OWNER.userId, type: 'idea', content: '冲突基线正文', nowUtc: '2026-10-06T00:00:00.000Z', timezone: 'Asia/Shanghai',
  })
  await database.outbox.clear()
  await database.records.update(record.id, { serverVersion: 1, syncState: 'synced' })
  await softDelete(record.id, '2026-10-06T01:00:00.000Z')
  const remote: CloudRecord = {
    ...snapshotOf(record), id: record.id, userId: OWNER.userId, content: '另一设备的编辑正文',
    updatedAtUtc: '2026-10-06T02:00:00.000Z', version: 2, serverUpdatedAt: '2026-10-06T02:00:01.000Z',
  }
  await reconcileOne(remote)
  return remote
}

describe('UI 裁决绑定呈现的冲突版本', () => {
  it('远端刷新后拒绝旧选择，记录、三份快照与既有 outbox 都保留', async () => {
    const remote = await fixture()
    const original = await database.records.get(remote.id)
    const outbox = await database.outbox.toArray()
    await refreshConflictRemote(remote.id, { ...remote, content: '远端第三版', version: 3 })
    const entry = await database.conflicts.get(remote.id)
    const result = await resolveOwnedConflict({ ...OWNER, recordId: remote.id }, 'remote', undefined, CURRENT, 2)
    expect(result).toEqual({ status: 'unavailable', reason: 'conflict-updated' })
    expect(await database.records.get(remote.id)).toEqual(original)
    expect(await database.conflicts.get(remote.id)).toEqual(entry)
    expect(await database.outbox.toArray()).toEqual(outbox)
    expect(outbox).toHaveLength(1)
  })

  it('裁决排队期间前一事务刷新为删除，旧恢复选择不能隐式接受新删除', async () => {
    const remote = await fixture()
    const original = await database.records.get(remote.id)
    const outbox = await database.outbox.toArray()
    let release = (): void => undefined
    let started = (): void => undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const begun = new Promise<void>((resolve) => { started = resolve })
    const earlier = database.transaction('rw', database.records, database.outbox, database.conflicts, async () => {
      started()
      await Dexie.waitFor(blocked)
      await refreshConflictRemote(remote.id, { ...remote, deletedAtUtc: '2026-10-06T03:00:00.000Z', version: 3 })
    })
    await begun
    const decision = Dexie.ignoreTransaction(() => resolveOwnedConflict({ ...OWNER, recordId: remote.id }, 'remote', undefined, CURRENT, 2))
    release()
    await earlier
    expect(await decision).toEqual({ status: 'unavailable', reason: 'conflict-updated' })
    expect(await database.records.get(remote.id)).toEqual(original)
    expect(await database.outbox.toArray()).toEqual(outbox)
    expect((await database.conflicts.get(remote.id))?.remoteVersion).toBe(3)
  })

  it('当前版本明确选择恢复另一设备编辑，仍按原链路保留内容与创建时间', async () => {
    const remote = await fixture()
    const before = await database.records.get(remote.id)
    const result = await resolveOwnedConflict({ ...OWNER, recordId: remote.id }, 'remote', undefined, CURRENT, 2)
    expect(result).toMatchObject({ status: 'saved', record: { content: remote.content, deletedAtUtc: null, createdAtUtc: before?.createdAtUtc } })
    expect(await database.conflicts.count()).toBe(0)
    expect(await database.outbox.count()).toBe(0)
  })

  it('手动草稿的旧版本保存也被拒绝，不清已有同步任务', async () => {
    const remote = await fixture()
    const outbox = await database.outbox.toArray()
    const original = await database.records.get(remote.id)
    await refreshConflictRemote(remote.id, { ...remote, content: '提示期间的新正文', version: 3 })
    expect(await resolveOwnedConflict({ ...OWNER, recordId: remote.id }, 'edited', '不能覆盖新正文的手动草稿', CURRENT, 2))
      .toEqual({ status: 'unavailable', reason: 'conflict-updated' })
    expect(await database.records.get(remote.id)).toEqual(original)
    expect(await database.outbox.toArray()).toEqual(outbox)
    expect(await database.conflicts.count()).toBe(1)
  })
})
