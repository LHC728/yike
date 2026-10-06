import { expect, test, type Page } from '@playwright/test'
import {
  beginWriteBlock, installDatabaseDriver, inspectDatabase, patchConflict, patchRecord,
  releaseWriteBlock, seedConflict, stageBlockedConflictUpdate,
  type AuditConflict, type AuditRecord, type AuditSnapshot,
} from './auditDatabase.js'

function snapshotOf(record: AuditRecord): AuditSnapshot {
  return {
    type: record.type, content: record.content, progress: record.progress,
    deadlineLocalDate: record.deadlineLocalDate, parentId: record.parentId,
    createdAtUtc: record.createdAtUtc, createdTimezone: record.createdTimezone, createdLocalDate: record.createdLocalDate,
    updatedAtUtc: record.updatedAtUtc, updatedTimezone: record.updatedTimezone,
    completedAtUtc: record.completedAtUtc, completedTimezone: record.completedTimezone, deletedAtUtc: record.deletedAtUtc,
  }
}

async function prepareConflict(page: Page, localDeleted: boolean): Promise<{ record: AuditRecord; entry: AuditConflict }> {
  await page.goto('/')
  await expect(page.getByTestId('quick-capture')).toBeVisible()
  await installDatabaseDriver(page)
  await page.getByTestId('quick-capture-input').fill('冲突基线正文')
  await page.getByTestId('quick-capture-idea').click()
  await expect(page.getByTestId('quick-capture-input')).toHaveValue('')
  const original = (await inspectDatabase(page)).records.find((row) => row.content === '冲突基线正文')
  if (!original) throw new Error('测试记录未创建')
  await patchRecord(page, original.id, { serverVersion: 1, syncState: 'synced' }, true)
  const base = snapshotOf(original)
  const local = {
    ...base, content: localDeleted ? base.content : '本机编辑后的正文',
    deletedAtUtc: localDeleted ? '2026-10-06T01:00:00.000Z' : null, updatedAtUtc: '2026-10-06T01:00:00.000Z',
  }
  const remote = {
    ...base, content: localDeleted ? '另一设备编辑后的正文' : base.content,
    deletedAtUtc: localDeleted ? null : '2026-10-06T02:00:00.000Z', updatedAtUtc: '2026-10-06T02:00:00.000Z',
  }
  const record: AuditRecord = { ...original, ...local, syncState: 'conflict', serverVersion: 1 }
  const entry: AuditConflict = {
    recordId: record.id, userId: record.userId, kind: 'delete-edit', fields: ['deletedAtUtc'],
    base, local, remote, remoteVersion: 2, createdAt: '2026-10-06T03:00:00.000Z',
  }
  await seedConflict(page, record, entry)
  await expect(page.getByRole('dialog')).toBeVisible()
  return { record, entry }
}

for (const localDeleted of [false, true]) {
  for (const keepEdit of [true, false]) {
    test(`R11：${localDeleted ? '本机删除、另一设备编辑' : '本机编辑、另一设备删除'}，选择${keepEdit ? '恢复编辑' : '保留删除'}符合按钮含义`, async ({ page }) => {
      const { record, entry } = await prepareConflict(page, localDeleted)
      const button = page.getByTestId(keepEdit ? 'conflict-keep-edit' : 'conflict-keep-delete')
      const label = await button.innerText()
      await button.click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      const after = await inspectDatabase(page)
      const saved = after.records.find((row) => row.id === record.id)
      if (!saved) throw new Error('裁决不得物理删除记录')
      expect(saved.deletedAtUtc === null).toBe(keepEdit)
      expect(saved.content).toBe(localDeleted ? entry.remote.content : entry.local.content)
      expect(saved.createdAtUtc).toBe(record.createdAtUtc)
      expect(after.conflicts).toHaveLength(0)
      if (keepEdit) expect(label).toBe(localDeleted ? '恢复并保留另一设备内容' : '恢复并保留本机内容')
      else expect(label).toBe('保留删除')
    })
  }
}

test('R11：打开冲突后远端恢复，旧 kind 不再把实际存活版本称为已删除', async ({ page }) => {
  const { record, entry } = await prepareConflict(page, false)
  await patchConflict(page, record.id, {
    remote: { ...entry.remote, content: '另一设备恢复后的新正文', deletedAtUtc: null }, remoteVersion: 3,
  })
  await expect(page.getByTestId('conflict-keep-edit')).toHaveCount(0)
  await expect(page.getByTestId('conflict-keep-delete')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toContainText('另一设备恢复后的新正文')
  await expect(page.getByRole('dialog').getByText('已删除这条记录', { exact: true })).toHaveCount(0)
  await page.getByTestId('conflict-keep-remote').click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const saved = (await inspectDatabase(page)).records.find((row) => row.id === record.id)
  expect(saved?.deletedAtUtc).toBeNull()
  expect(saved?.content).toBe('另一设备恢复后的新正文')
})

test('R11：冲突刷新后两边都删除，两个版本都如实标记删除', async ({ page }) => {
  const { record, entry } = await prepareConflict(page, true)
  await patchConflict(page, record.id, {
    remote: { ...entry.remote, deletedAtUtc: '2026-10-06T04:00:00.000Z' }, remoteVersion: 3,
  })
  await expect(page.getByTestId('conflict-keep-edit')).toHaveCount(0)
  await expect(page.getByRole('dialog').getByText('已删除这条记录', { exact: true })).toHaveCount(2)
  await page.getByTestId('conflict-keep-local').click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await inspectDatabase(page)).records.find((row) => row.id === record.id)?.deletedAtUtc).not.toBeNull()
})

test('R11：排队期间远端变化，旧恢复按钮不能变成删除裁决', async ({ page }) => {
  const { record, entry } = await prepareConflict(page, true)
  const before = await inspectDatabase(page)
  await beginWriteBlock(page)
  try {
    await page.getByTestId('conflict-keep-edit').click()
    await expect(page.getByTestId('conflict-keep-edit')).toBeDisabled()
    await stageBlockedConflictUpdate(page, record.id, {
      remote: { ...entry.remote, content: '排队期间变成删除的新版本', deletedAtUtc: '2026-10-06T04:00:00.000Z' }, remoteVersion: 3,
    })
  } finally {
    await releaseWriteBlock(page)
  }
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText('排队期间变成删除的新版本')
  const after = await inspectDatabase(page)
  expect(after.records).toEqual(before.records)
  expect(after.outbox).toEqual(before.outbox)
  expect(after.conflicts[0]?.remoteVersion).toBe(3)
})

test('R11：拒绝排队期间过期的手动裁决，编辑草稿留在弹窗内', async ({ page }) => {
  const { record, entry } = await prepareConflict(page, false)
  const liveRemote = { ...entry.remote, content: '另一设备第三版正文', deletedAtUtc: null }
  await patchConflict(page, record.id, { kind: 'field', fields: ['content'], remote: liveRemote, remoteVersion: 3 })
  await page.getByRole('button', { name: '手动编辑', exact: true }).click()
  const input = page.getByRole('textbox', { name: '手动编辑后保存', exact: true })
  await input.fill('仍可复制保留的手动草稿')
  const before = await inspectDatabase(page)
  await beginWriteBlock(page)
  try {
    await page.getByTestId('conflict-save-manual').click()
    await expect(page.getByTestId('conflict-save-manual')).toBeDisabled()
    await stageBlockedConflictUpdate(page, record.id, { remote: { ...liveRemote, content: '排队期间的第四版正文' }, remoteVersion: 4 })
  } finally {
    await releaseWriteBlock(page)
  }
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(input).toHaveValue('仍可复制保留的手动草稿')
  await expect(page.getByRole('dialog')).toContainText('排队期间的第四版正文')
  const after = await inspectDatabase(page)
  expect(after.records).toEqual(before.records)
  expect(after.outbox).toEqual(before.outbox)
  expect(after.conflicts[0]?.remoteVersion).toBe(4)
})
