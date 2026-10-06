import { expect, test, type Locator, type Page } from '@playwright/test'
import {
  beginWriteBlock, failNextRecordWrite, installDatabaseDriver, inspectDatabase, patchRecord,
  releaseWriteBlock, seedConflict, type AuditConflict, type AuditRecord, type AuditSnapshot,
} from './auditDatabase.js'

type FormKind = 'quick' | 'project' | 'log'

async function openApp(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('quick-capture')).toBeVisible()
  await installDatabaseDriver(page)
}

async function openProject(page: Page): Promise<void> {
  await page.getByTestId('project-add').click()
  await page.getByTestId('project-create-input').fill('异步输入测试的大事')
  await page.getByTestId('project-create-save').click()
  await page.getByTestId('project-row').filter({ hasText: '异步输入测试的大事' }).click()
  await expect(page.getByTestId('project-log-input')).toBeVisible()
}

async function prepareForm(page: Page, kind: FormKind): Promise<{ input: Locator; save: Locator; deadline: Locator | null }> {
  await openApp(page)
  if (kind === 'project') await page.getByTestId('project-add').click()
  if (kind === 'log') await openProject(page)
  const ids = kind === 'quick' ? ['quick-capture-input', 'quick-capture-idea']
    : kind === 'project' ? ['project-create-input', 'project-create-save'] : ['project-log-input', 'project-log-save']
  const inputId = ids[0]
  const saveId = ids[1]
  if (!inputId || !saveId) throw new Error('缺少测试表单定位')
  return { input: page.getByTestId(inputId), save: page.getByTestId(saveId), deadline: kind === 'project' ? page.getByTestId('project-create-deadline') : null }
}

for (const kind of ['quick', 'project', 'log'] as const) {
  for (const failure of [false, true]) {
    test(`R15：${kind} 本机写入等待时保护输入，${failure ? '失败保留并可重试' : '成功只提交当次草稿'}`, async ({ page }) => {
      const { input, save, deadline } = await prepareForm(page, kind)
      const content = `${kind} 当次提交的原草稿`
      await input.fill(content)
      if (deadline) await deadline.fill('2026-11-30')
      await beginWriteBlock(page)
      let couldEdit = false
      try {
        if (failure) await failNextRecordWrite(page)
        await save.click()
        await expect(save).toBeDisabled()
        couldEdit = await input.isEditable()
        // 旧实现允许继续输入；先实证这份新草稿在旧回调清空/卸载时丢失。
        if (couldEdit && !failure) await input.fill('等待期间写入的第二份草稿')
        if (!couldEdit && deadline) await expect(deadline).toBeDisabled()
      } finally { await releaseWriteBlock(page) }
      if (couldEdit && !failure) {
        const saved = kind === 'quick' ? page.getByTestId('timeline') : kind === 'project' ? page.getByTestId('project-module') : page.getByTestId('project-log-row')
        await expect(saved).toContainText(content)
        await expect(input).toHaveValue('等待期间写入的第二份草稿', { timeout: 1000 })
      }
      expect(couldEdit).toBe(false)
      if (failure) {
        await expect(input).toBeEditable()
        await expect(input).toHaveValue(content)
        if (deadline) await expect(deadline).toHaveValue('2026-11-30')
        const rejected = await inspectDatabase(page)
        expect(rejected.records.some((row) => row.content === content)).toBe(false)
        expect(rejected.outbox.some((row) => row.payload.content === content)).toBe(false)
        await save.click()
      }
      if (kind === 'project') await expect(page.getByTestId('project-create')).toHaveCount(0)
      else await expect(input).toHaveValue('')
      const after = await inspectDatabase(page)
      const submitted = after.records.filter((row) => row.content === content)
      expect(submitted).toHaveLength(1)
      const record = submitted[0]
      expect(record?.type).toBe(kind === 'quick' ? 'idea' : kind)
      if (kind === 'project') expect(record?.deadlineLocalDate).toBe('2026-11-30')
      if (kind === 'log') expect(record?.parentId).not.toBeNull()
      expect(after.outbox.filter((row) => row.recordId === record?.id)).toHaveLength(1)
      if (kind === 'project') await page.getByTestId('project-add').click()
      await expect(input).toBeEditable()
      await input.fill('保存之后可以继续记下一条')
      await expect(input).toHaveValue('保存之后可以继续记下一条')
    })
  }
}

test('R15：在途大事收起再展开后，旧 onDone 不能卸载新的文本与截止日草稿', async ({ page }) => {
  const { input, save, deadline } = await prepareForm(page, 'project')
  await input.fill('第一份在途大事')
  if (!deadline) throw new Error('缺少大事截止日')
  await deadline.fill('2026-11-30')
  await beginWriteBlock(page)
  try {
    await save.click()
    await expect(save).toBeDisabled()
    await page.getByTestId('project-add').click()
    await expect(page.getByTestId('project-create')).toHaveCount(0)
    await page.getByTestId('project-add').click()
    await input.fill('第二个新表单的草稿')
    await deadline.fill('2026-12-31')
  } finally { await releaseWriteBlock(page) }
  await expect(page.getByTestId('project-row').filter({ hasText: '第一份在途大事' })).toBeVisible()
  await expect(input).toHaveValue('第二个新表单的草稿', { timeout: 1000 })
  await expect(deadline).toHaveValue('2026-12-31')
  expect((await inspectDatabase(page)).records.some((row) => row.content === '第二个新表单的草稿')).toBe(false)
  await save.click()
  await expect(page.getByTestId('project-create')).toHaveCount(0)
  const rows = (await inspectDatabase(page)).records
  expect(rows.find((row) => row.content === '第一份在途大事')?.deadlineLocalDate).toBe('2026-11-30')
  expect(rows.find((row) => row.content === '第二个新表单的草稿')?.deadlineLocalDate).toBe('2026-12-31')
})

function snapshotOf(record: AuditRecord): AuditSnapshot {
  const { id: _id, userId: _userId, serverVersion: _serverVersion, syncState: _syncState, ...snapshot } = record
  return snapshot
}

async function prepareManual(page: Page): Promise<{ record: AuditRecord; conflict: AuditConflict; input: Locator }> {
  await openApp(page)
  await page.getByTestId('quick-capture-input').fill('手动裁决基线')
  await page.getByTestId('quick-capture-idea').click()
  await expect(page.getByTestId('quick-capture-input')).toHaveValue('')
  const original = (await inspectDatabase(page)).records.find((row) => row.content === '手动裁决基线')
  if (!original) throw new Error('缺少手动裁决测试记录')
  await patchRecord(page, original.id, { serverVersion: 1, syncState: 'synced' }, true)
  const base = snapshotOf(original)
  const local = { ...base, content: '本机裁决版本', updatedAtUtc: '2026-10-06T01:00:00.000Z' }
  const remote = { ...base, content: '远端裁决版本', updatedAtUtc: '2026-10-06T02:00:00.000Z' }
  const record: AuditRecord = { ...original, ...local, serverVersion: 1, syncState: 'conflict' }
  const conflict: AuditConflict = { recordId: record.id, userId: record.userId, kind: 'field', fields: ['content'], base, local, remote, remoteVersion: 2, createdAt: '2026-10-06T03:00:00.000Z' }
  await seedConflict(page, record, conflict)
  await page.getByRole('button', { name: '手动编辑', exact: true }).click()
  return { record, conflict, input: page.getByRole('textbox', { name: '手动编辑后保存', exact: true }) }
}

for (const failure of [false, true]) {
  test(`R15：手动裁决等待本机写入时保护草稿，${failure ? '失败仍可修改重试' : '成功只保存提交内容'}`, async ({ page }) => {
    const { record, input } = await prepareManual(page)
    const submitted = '手动输入的提交草稿'
    await input.fill(submitted)
    const before = await inspectDatabase(page)
    await beginWriteBlock(page)
    let couldEdit = false
    try {
      if (failure) await failNextRecordWrite(page)
      await page.getByTestId('conflict-save-manual').click()
      await expect(page.getByTestId('conflict-save-manual')).toBeDisabled()
      couldEdit = await input.isEditable()
      if (couldEdit && !failure) await input.fill('裁决等待时写的新草稿')
    } finally { await releaseWriteBlock(page) }
    if (couldEdit && !failure) {
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(input).toHaveValue('裁决等待时写的新草稿', { timeout: 1000 })
    }
    expect(couldEdit).toBe(false)
    if (failure) {
      await expect(input).toBeEditable()
      await expect(input).toHaveValue(submitted)
      expect(await inspectDatabase(page)).toEqual(before)
      await input.fill('失败后主动修改再提交')
      await page.getByTestId('conflict-save-manual').click()
    }
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const after = await inspectDatabase(page)
    expect(after.records.find((row) => row.id === record.id)?.content).toBe(failure ? '失败后主动修改再提交' : submitted)
    expect(after.records.find((row) => row.id === record.id)?.createdAtUtc).toBe(record.createdAtUtc)
    expect(after.conflicts).toHaveLength(0)
    expect(after.outbox.filter((row) => row.recordId === record.id)).toHaveLength(1)
  })
}

test('R15：保留一侧的裁决排队时，不能再进入手动编辑产生会被旧回调清掉的新草稿', async ({ page }) => {
  const { input } = await prepareManual(page)
  // 先回到未打开手动编辑的初始界面，避免只验证 textarea 而漏掉编辑入口。
  await page.reload()
  await expect(page.getByRole('dialog')).toBeVisible()
  await installDatabaseDriver(page)
  await beginWriteBlock(page)
  let couldStartManual = false
  try {
    await page.getByTestId('conflict-keep-local').click()
    await expect(page.getByTestId('conflict-keep-local')).toBeDisabled()
    const manual = page.getByRole('button', { name: '手动编辑', exact: true })
    couldStartManual = await manual.isEnabled()
    if (couldStartManual) {
      await manual.click()
      await input.fill('旧裁决等待时新开的手动草稿')
    }
  } finally { await releaseWriteBlock(page) }
  if (couldStartManual) {
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(input).toHaveValue('旧裁决等待时新开的手动草稿', { timeout: 1000 })
  }
  expect(couldStartManual).toBe(false)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

for (const logEditor of [false, true]) {
  test(`R15：${logEditor ? '进展' : '普通详情'}正文已有等待禁用守护，成功与失败都保留正确内容`, async ({ page }) => {
    await openApp(page)
    if (logEditor) {
      await openProject(page)
      await page.getByTestId('project-log-input').fill('正文编辑基线')
      await page.getByTestId('project-log-save').click()
      await expect(page.getByTestId('project-log-input')).toHaveValue('')
      await page.getByTestId('project-log-row').click()
    } else {
      await page.getByTestId('quick-capture-input').fill('正文编辑基线')
      await page.getByTestId('quick-capture-idea').click()
      await expect(page.getByTestId('quick-capture-input')).toHaveValue('')
      await page.getByTestId('timeline').getByTestId('record-row').filter({ hasText: '正文编辑基线' }).locator('button').click()
      await page.getByTestId('detail-edit').click()
    }
    const input = page.getByTestId(logEditor ? 'project-log-editor-input' : 'detail-editor')
    const save = page.getByTestId(logEditor ? 'project-log-editor-save' : 'detail-save')
    await input.fill('保存失败也留着的正文草稿')
    const before = await inspectDatabase(page)
    await beginWriteBlock(page)
    try {
      await failNextRecordWrite(page)
      await save.click()
      await expect(input).toBeDisabled()
    } finally { await releaseWriteBlock(page) }
    await expect(input).toBeEditable()
    await expect(input).toHaveValue('保存失败也留着的正文草稿')
    expect(await inspectDatabase(page)).toEqual(before)
    await save.click()
    await expect(page.getByTestId(logEditor ? 'project-log-row' : 'detail-content')).toContainText('保存失败也留着的正文草稿')
  })
}

test('R15：手机抽屉退出在途删除后，旧详情回调不能关闭后来打开的另一条记录', async ({ page }) => {
  // 嵌套 Modal 的 Escape 行为只在手机抽屉外壳存在；桌面项目也显式检查这个真实响应式分支。
  await page.setViewportSize({ width: 800, height: 900 })
  await openApp(page)
  for (const content of ['即将删除的原详情', '随后打开并继续编辑的详情']) {
    await page.getByTestId('quick-capture-input').fill(content)
    await page.getByTestId('quick-capture-idea').click()
    await expect(page.getByTestId('quick-capture-input')).toHaveValue('')
  }
  await page.getByTestId('timeline').getByTestId('record-row').filter({ hasText: '即将删除的原详情' }).locator('button').click()
  await page.getByTestId('detail-delete').click()
  await beginWriteBlock(page)
  try {
    await page.getByTestId('confirm-accept').click()
    await expect(page.getByTestId('confirm-accept')).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('confirm-accept')).toHaveCount(0)
    await page.getByTestId('timeline').getByTestId('record-row').filter({ hasText: '随后打开并继续编辑的详情' }).locator('button').click()
  } finally { await releaseWriteBlock(page) }
  await expect(page.getByTestId('detail-content')).toHaveText('随后打开并继续编辑的详情', { timeout: 1000 })
  await page.getByTestId('detail-edit').click()
  await page.getByTestId('detail-editor').fill('新详情的草稿不受旧删除关闭')
  await expect(page.getByTestId('detail-editor')).toHaveValue('新详情的草稿不受旧删除关闭')
  const after = await inspectDatabase(page)
  expect(after.records.find((row) => row.content === '即将删除的原详情')?.deletedAtUtc).not.toBeNull()
  expect(after.records.find((row) => row.content === '随后打开并继续编辑的详情')?.deletedAtUtc).toBeNull()
})
