import { expect, test, type Page } from '@playwright/test'
import { beginWriteBlock, installDatabaseDriver, inspectDatabase, patchRecord, releaseWriteBlock, seedRecords, stageBlockedConflictInsert, type AuditRecord, type AuditSnapshot } from './auditDatabase.js'

async function makeLog(page: Page, content = '必须能找回的进展'): Promise<{ project: AuditRecord; log: AuditRecord }> {
  await page.goto('/')
  await expect(page.getByTestId('quick-capture')).toBeVisible()
  await installDatabaseDriver(page)
  await page.getByTestId('project-add').click()
  await page.getByTestId('project-create-input').fill('有恢复路径的大事')
  await page.getByTestId('project-create-save').click()
  await page.getByTestId('project-row').filter({ hasText: '有恢复路径的大事' }).click()
  await page.getByTestId('project-preset-50').click()
  await expect(page.getByTestId('project-percent')).toHaveText('50%')
  await page.getByTestId('project-log-input').fill(content)
  await page.getByTestId('project-log-save').click()
  await expect(page.getByTestId('project-log-input')).toHaveValue('')
  const snapshot = await inspectDatabase(page)
  const project = snapshot.records.find((row) => row.type === 'project')
  const log = snapshot.records.find((row) => row.type === 'log')
  if (!project || !log) throw new Error('未创建恢复测试数据')
  await patchRecord(page, log.id, { serverVersion: 1, syncState: 'synced' }, true)
  return { project, log: { ...log, serverVersion: 1, syncState: 'synced' } }
}

async function closeDetail(page: Page): Promise<void> {
  const close = page.getByTestId('detail-close')
  if (await close.count()) await close.click()
  else await page.keyboard.press('Escape')
}

function retainedFields(record: AuditRecord | undefined) {
  if (!record) throw new Error('测试进展已丢失')
  const { updatedAtUtc: _updatedAtUtc, updatedTimezone: _updatedTimezone, deletedAtUtc: _deletedAtUtc, syncState: _syncState, ...retained } = record
  return retained
}

function snapshotOf(record: AuditRecord): AuditSnapshot {
  const { id: _id, userId: _userId, serverVersion: _serverVersion, syncState: _syncState, ...snapshot } = record
  return snapshot
}

test('R14：Toast 到期和刷新后仍能从默认折叠区恢复原 ID 与完整进展字段', async ({ page }) => {
  const { log } = await makeLog(page)
  await page.clock.install()
  await page.getByTestId('project-log-row').click()
  await page.getByTestId('project-log-delete').click()
  await expect(page.getByTestId('project-log-row')).toHaveCount(0)
  await expect(page.getByTestId('project-logs-count')).toHaveText('0 条')
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeVisible()
  await page.clock.fastForward(8500)
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toHaveCount(0)
  const toggle = page.getByTestId('deleted-logs-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('deleted-log-row')).toHaveCount(0)

  await page.reload()
  await expect(page.getByTestId('quick-capture')).toBeVisible()
  await installDatabaseDriver(page)
  await page.getByTestId('project-row').filter({ hasText: '有恢复路径的大事' }).click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  const deleted = page.getByTestId('deleted-log-row')
  await expect(deleted).toContainText(log.content)
  await expect(deleted).toContainText('50%')
  await expect(deleted.getByTestId('deleted-log-stamp')).not.toBeEmpty()
  await deleted.getByTestId('deleted-log-restore').click()
  await expect(page.getByTestId('project-log-row')).toContainText(log.content)
  await expect(page.getByTestId('project-logs-count')).toHaveText('1 条')
  await expect(page.getByTestId('deleted-logs-tray')).toHaveCount(0)
  const after = await inspectDatabase(page)
  const restored = after.records.find((row) => row.id === log.id)
  expect(retainedFields(restored)).toEqual(retainedFields(log))
  expect(restored?.deletedAtUtc).toBeNull()
  expect(restored?.syncState).toBe('pending')
  const pending = after.outbox.filter((row) => row.recordId === log.id)
  expect(pending).toHaveLength(1)
  expect(pending[0]?.payload.deletedAtUtc).toBeNull()
  expect(after.records.filter((row) => row.type === 'log')).toHaveLength(1)
})

test('R14：恢复区只显示当前账号与父大事的已删进展，恢复仍不进入三个全局列表', async ({ page }) => {
  const { project, log } = await makeLog(page, '只在详情恢复的独特进展')
  const deleted = { ...log, progress: null, deletedAtUtc: '2026-10-06T03:00:00.000Z' }
  await seedRecords(page, [
    deleted,
    { ...deleted, id: 'other-parent-log', parentId: 'other-project', content: '另一大事的已删进展' },
    { ...deleted, id: 'foreign-owner-log', userId: 'foreign-owner', content: '别人账号的已删进展' },
    { ...deleted, id: 'deleted-idea', type: 'idea', parentId: null, content: '普通已删记录' },
  ])
  await page.getByTestId('deleted-logs-toggle').click()
  await expect(page.getByTestId('deleted-log-row')).toHaveCount(1)
  await expect(page.getByTestId('deleted-logs-tray')).not.toContainText('另一大事')
  await expect(page.getByTestId('deleted-logs-tray')).not.toContainText('别人账号')
  await page.getByTestId('deleted-log-restore').click()
  await expect(page.getByTestId('project-log-row')).toContainText(log.content)
  const after = await inspectDatabase(page)
  expect(retainedFields(after.records.find((row) => row.id === log.id))).toEqual(retainedFields(deleted))
  expect(after.records.find((row) => row.id === 'other-parent-log')?.deletedAtUtc).toBe(deleted.deletedAtUtc)
  expect(after.records.find((row) => row.id === 'foreign-owner-log')?.deletedAtUtc).toBe(deleted.deletedAtUtc)
  expect(after.outbox.filter((row) => row.recordId !== project.id && row.recordId !== log.id)).toHaveLength(0)
  await closeDetail(page)
  await expect(page.getByTestId('timeline')).not.toContainText(log.content)
  await page.getByTestId('main-nav').getByText('日历', { exact: true }).click()
  await page.getByTestId(`calendar-day-${log.createdLocalDate}`).click()
  await expect(page.getByTestId('calendar-day-list')).not.toContainText(log.content)
  await page.getByTestId('open-search').click()
  await page.getByTestId('search-input').fill(log.content)
  await expect(page.getByRole('dialog')).not.toContainText(log.content)
  await expect(page.getByRole('dialog').getByText('没有找到匹配的记录')).toBeVisible()
})

test('R14：远端软删时保留编辑草稿，取消后才转入折叠恢复区', async ({ page }) => {
  const { log } = await makeLog(page)
  await page.getByTestId('project-log-row').click()
  await page.getByTestId('project-log-editor-input').fill('应保留到取消的草稿')
  const tombstone = '2026-10-06T04:00:00.000Z'
  await patchRecord(page, log.id, { deletedAtUtc: tombstone, serverVersion: 2, syncState: 'synced' })
  await expect(page.getByTestId('project-log-editor-input')).toHaveValue('应保留到取消的草稿')
  await expect(page.getByTestId('project-logs-count')).toHaveText('0 条')
  await expect(page.getByTestId('deleted-log-row')).toHaveCount(0)
  await page.getByTestId('project-log-editor-save').click()
  await expect(page.getByTestId('project-log-editor-input')).toHaveValue('应保留到取消的草稿')
  expect((await inspectDatabase(page)).outbox.filter((row) => row.recordId === log.id)).toHaveLength(0)
  await page.getByTestId('project-log-editor-cancel').click()
  await expect(page.getByTestId('project-log-editor')).toHaveCount(0)
  await expect(page.getByTestId('project-log-row')).toHaveCount(0)
  await page.getByTestId('deleted-logs-toggle').click()
  await expect(page.getByTestId('deleted-log-row')).toHaveCount(1)
  await page.getByTestId('deleted-log-restore').click()
  await expect(page.getByTestId('project-log-row')).toContainText(log.content)
  expect((await inspectDatabase(page)).records.find((row) => row.id === log.id)?.content).toBe(log.content)
})

test('R14：排队期间到达冲突会拒绝恢复，已删行和原有持久化数据保留', async ({ page }) => {
  const { log } = await makeLog(page)
  const deleted = { ...log, deletedAtUtc: '2026-10-06T05:00:00.000Z' }
  await seedRecords(page, [deleted])
  const conflict = {
    recordId: log.id, userId: log.userId, kind: 'delete-edit' as const, fields: ['deletedAtUtc'],
    base: snapshotOf(log), local: snapshotOf(deleted), remote: { ...snapshotOf(log), content: '另一设备修改过的内容' },
    remoteVersion: 2, createdAt: '2026-10-06T05:00:00.000Z',
  }
  await page.getByTestId('deleted-logs-toggle').click()
  const before = await inspectDatabase(page)
  await beginWriteBlock(page)
  try {
    await stageBlockedConflictInsert(page, conflict)
    await page.getByTestId('deleted-log-restore').click()
    await expect(page.getByTestId('deleted-log-restore')).toBeDisabled()
  } finally { await releaseWriteBlock(page) }
  await expect(page.getByTestId('deleted-log-restore')).toBeEnabled()
  await expect(page.getByTestId('deleted-log-row')).toContainText(log.content)
  await expect(page.getByTestId('project-log-row')).toHaveCount(0)
  const after = await inspectDatabase(page)
  expect(after.records).toEqual(before.records)
  expect(after.outbox).toEqual(before.outbox)
  expect(after.conflicts).toEqual([conflict])
})

test('R14：排队恢复遇同页账号切换不落库，也不泄露旧账号进展', async ({ page }) => {
  const cloudUrl = 'https://audit-log-restore.invalid'
  await page.route(`${cloudUrl}/**`, async (route) => {
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-allow-methods': 'GET, POST, OPTIONS' }
    if (route.request().method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return }
    const userId = route.request().headers().authorization?.endsWith('token-B') ? 'restore-B' : 'restore-A'
    const pathname = new URL(route.request().url()).pathname
    const body = pathname === '/api/me' ? { userId, email: null }
      : pathname === '/api/sync/pull-page' ? { records: [], nextCursor: null } : { records: [] }
    await route.fulfill({ status: 200, headers, json: body })
  })
  await page.addInitScript(({ url }) => {
    localStorage.setItem('inspiration-todo/cloud-config', JSON.stringify({ provider: 'cloudflare', url }))
    localStorage.setItem('inspiration-todo/cf-session', JSON.stringify({ token: 'token-A', userId: 'restore-A', email: null }))
  }, { url: cloudUrl })
  await page.goto('/')
  await expect(page.getByTestId('quick-capture')).toBeVisible()
  await installDatabaseDriver(page)
  const project: AuditRecord = {
    id: 'restore-project-A', userId: 'restore-A', type: 'project', content: 'A 的恢复测试大事', progress: 50, deadlineLocalDate: null, parentId: null,
    createdAtUtc: '2026-10-06T00:00:00.000Z', createdTimezone: 'Asia/Shanghai', createdLocalDate: '2026-10-06',
    updatedAtUtc: '2026-10-06T00:00:00.000Z', updatedTimezone: 'Asia/Shanghai', completedAtUtc: null, completedTimezone: null,
    deletedAtUtc: null, serverVersion: 1, syncState: 'synced',
  }
  const log: AuditRecord = { ...project, id: 'restore-log-A', type: 'log', parentId: project.id, content: 'A 的私密已删进展', deletedAtUtc: '2026-10-06T06:00:00.000Z' }
  await seedRecords(page, [project, log])
  await page.getByTestId('project-row').filter({ hasText: project.content }).click()
  await page.getByTestId('deleted-logs-toggle').click()
  await beginWriteBlock(page)
  try {
    await page.getByTestId('deleted-log-restore').click()
    await expect(page.getByTestId('deleted-log-restore')).toBeDisabled()
    await closeDetail(page)
    await page.getByTestId('open-settings').click()
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '访问令牌', exact: true })).toBeVisible()
    await page.getByRole('textbox', { name: '同步服务地址', exact: true }).fill(cloudUrl)
    await page.getByRole('textbox', { name: '访问令牌', exact: true }).fill('token-B')
    await page.getByRole('button', { name: '连接', exact: true }).click()
  } finally { await releaseWriteBlock(page) }
  await expect(page.getByTestId('quick-capture')).toBeVisible()
  await expect(page.getByTestId('project-row')).toHaveCount(0)
  await expect(page.getByText(log.content, { exact: true })).toHaveCount(0)
  const after = await inspectDatabase(page)
  expect(after.records.find((row) => row.id === log.id)).toEqual(log)
  expect(after.outbox.filter((row) => row.userId === 'restore-A')).toHaveLength(0)
})
