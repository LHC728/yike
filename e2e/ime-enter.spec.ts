import { expect, test, type Page } from '@playwright/test'
import { installDatabaseDriver, inspectDatabase } from './auditDatabase.js'

async function openApp(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('quick-capture')).toBeVisible()
  await installDatabaseDriver(page)
}

for (const log of [false, true]) {
  for (const legacy229 of [false, true]) {
    test(`R16：${log ? '进展' : '新建大事'}不把${legacy229 ? '229 候选确认' : '组合态 Enter'}当保存，普通 Enter 仍提交一次`, async ({ page }) => {
      await openApp(page)
      await page.getByTestId('project-add').click()
      if (log) {
        await page.getByTestId('project-create-input').fill('输入法测试的父大事')
        await page.getByTestId('project-create-save').click()
        await page.getByTestId('project-row').filter({ hasText: '输入法测试的父大事' }).click()
        await page.getByTestId('project-preset-50').click()
        await expect(page.getByTestId('project-percent')).toHaveText('50%')
      } else {
        await page.getByTestId('project-create-deadline').fill('2026-11-30')
      }
      const input = page.getByTestId(log ? 'project-log-input' : 'project-create-input')
      const content = `中文候选词确认后${log ? '写进展' : '创建大事'}`
      await input.fill(content)
      const before = await inspectDatabase(page)
      // 这里只验证真实浏览器的事件分支与真实 DB；不是对安卓真机输入法的模拟结论。
      await input.dispatchEvent('compositionstart', { data: '中文' })
      await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: !legacy229, keyCode: legacy229 ? 229 : 13 })
      expect(await inspectDatabase(page)).toEqual(before)
      await expect(input).toHaveValue(content)
      await input.dispatchEvent('compositionend', { data: content })
      await input.press('Enter')
      if (log) await expect(input).toHaveValue('')
      else await expect(page.getByTestId('project-create')).toHaveCount(0)
      const after = await inspectDatabase(page)
      const created = after.records.filter((row) => row.content === content)
      expect(created).toHaveLength(1)
      const record = created[0]
      expect(record?.type).toBe(log ? 'log' : 'project')
      if (log) {
        expect(record?.parentId).toBe(before.records.find((row) => row.type === 'project')?.id)
        expect(record?.progress).toBe(50)
      } else {
        expect(record?.deadlineLocalDate).toBe('2026-11-30')
        expect(record?.parentId).toBeNull()
      }
      expect(after.outbox.filter((row) => row.recordId === record?.id)).toHaveLength(1)
    })
  }
}

test('R16：首页快捷输入的普通 Enter 仍换行，不提前创建灵感或待办', async ({ page }) => {
  await openApp(page)
  const input = page.getByTestId('quick-capture-input')
  await input.fill('第一行中文')
  await input.press('Enter')
  await input.pressSequentially('第二行中文')
  await expect(input).toHaveValue('第一行中文\n第二行中文')
  expect((await inspectDatabase(page)).records).toHaveLength(0)
  expect((await inspectDatabase(page)).outbox).toHaveLength(0)
  await page.getByTestId('quick-capture-todo').click()
  await expect(input).toHaveValue('')
  const after = await inspectDatabase(page)
  expect(after.records).toHaveLength(1)
  expect(after.records[0]?.type).toBe('todo')
  expect(after.records[0]?.content).toBe('第一行中文\n第二行中文')
  expect(after.outbox).toHaveLength(1)
})
