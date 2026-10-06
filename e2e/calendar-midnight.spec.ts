import { expect, test, type Page } from '@playwright/test'
import { installDatabaseDriver, inspectDatabase, seedRecords, type AuditRecord } from './auditDatabase.js'

function datedIdea(date: string, content: string): AuditRecord {
  return {
    id: `midnight-${date}`, userId: 'local-device', type: 'idea', content, progress: null, deadlineLocalDate: null, parentId: null,
    createdAtUtc: `${date}T00:00:00.000Z`, createdTimezone: 'Asia/Shanghai', createdLocalDate: date,
    updatedAtUtc: `${date}T00:00:00.000Z`, updatedTimezone: 'Asia/Shanghai', completedAtUtc: null, completedTimezone: null,
    deletedAtUtc: null, serverVersion: 1, syncState: 'synced',
  }
}

async function openYearEnd(page: Page): Promise<void> {
  // 虚拟时钟只验证日期与事件逻辑，不用于真机软键盘或 viewport 行为结论。
  await page.clock.install({ time: new Date('2026-12-31T15:59:50.000Z') })
  await page.goto('/')
  await expect(page.getByTestId('quick-capture')).toBeVisible()
  await installDatabaseDriver(page)
  await seedRecords(page, [
    datedIdea('2026-12-30', '历史日期的归档'), datedIdea('2026-12-31', '旧年最后一天的归档'),
    datedIdea('2027-01-01', '新年第一天的归档'), datedIdea('2027-01-02', '新年第二天的归档'),
  ])
  await page.getByTestId('main-nav').getByText('日历', { exact: true }).click()
  await expect(page.getByTestId('month-calendar').getByRole('button', { name: '2026年12月', exact: true })).toBeVisible()
  await expect(page.getByTestId('calendar-day-list')).toContainText('旧年最后一天的归档')
}

test('R17：默认今天跨午夜跨年后，月份、选中日、今日标记与归档列表一起更新', async ({ page }) => {
  await openYearEnd(page)
  const before = await inspectDatabase(page)
  await page.clock.fastForward(12_000)
  await expect(page.getByTestId('month-calendar').getByRole('button', { name: '2027年1月', exact: true })).toBeVisible({ timeout: 1000 })
  await expect(page.getByTestId('calendar-day-list')).toContainText('1月1日')
  await expect(page.getByTestId('calendar-day-list')).toContainText('新年第一天的归档')
  await expect(page.getByTestId('calendar-day-list')).not.toContainText('旧年最后一天的归档')
  const today = page.getByTestId('calendar-day-2027-01-01')
  await expect(today).toHaveAttribute('aria-current', 'date')
  await expect(today.locator('span').first()).toHaveClass(/\bbg-idea\b/)
  expect(await inspectDatabase(page)).toEqual(before)
})

test('R17：12月30日的手动选择跨年仍保留12月，回到今天后重新跟随下一午夜', async ({ page }) => {
  await openYearEnd(page)
  await page.getByTestId('calendar-day-2026-12-30').click()
  const oldToday = page.getByTestId('calendar-day-2026-12-31')
  await expect(oldToday.locator('span').first()).toHaveClass(/\btext-idea\b/)
  const before = await inspectDatabase(page)
  await page.clock.fastForward(12_000)
  await expect(page.getByTestId('month-calendar').getByRole('button', { name: '2026年12月', exact: true })).toBeVisible()
  await expect(page.getByTestId('calendar-day-list')).toContainText('历史日期的归档')
  await expect(page.getByTestId('calendar-day-list')).toContainText('12月30日')
  await expect(oldToday.locator('span').first()).not.toHaveClass(/\btext-idea\b/, { timeout: 1000 })
  await expect(oldToday).not.toHaveAttribute('aria-current', 'date')
  await expect(page.getByTestId('calendar-day-2026-12-30').locator('span').first()).toHaveClass(/\bbg-idea\b/)
  await page.getByTestId('month-calendar').getByRole('button', { name: '2026年12月', exact: true }).click()
  await expect(page.getByTestId('month-calendar').getByRole('button', { name: '2027年1月', exact: true })).toBeVisible()
  await expect(page.getByTestId('calendar-day-list')).toContainText('新年第一天的归档')
  await page.clock.fastForward(24 * 60 * 60 * 1000)
  await expect(page.getByTestId('calendar-day-list')).toContainText('新年第二天的归档')
  await expect(page.getByTestId('calendar-day-2027-01-02')).toHaveAttribute('aria-current', 'date')
  await expect(page.getByTestId('calendar-day-2027-01-01')).not.toHaveAttribute('aria-current', 'date')
  expect(await inspectDatabase(page)).toEqual(before)
})

test('R17：手动浏览的月份跨午夜不被跳走，默认日列表仍更新今天', async ({ page }) => {
  await openYearEnd(page)
  await page.getByRole('button', { name: '上个月', exact: true }).click()
  await expect(page.getByTestId('month-calendar').getByRole('button', { name: '2026年11月', exact: true })).toBeVisible()
  const before = await inspectDatabase(page)
  await page.clock.fastForward(12_000)
  await expect(page.getByTestId('month-calendar').getByRole('button', { name: '2026年11月', exact: true })).toBeVisible()
  await expect(page.getByTestId('calendar-day-list')).toContainText('新年第一天的归档')
  await expect(page.getByTestId('month-calendar').locator('[aria-current="date"]')).toHaveCount(0)
  expect(await inspectDatabase(page)).toEqual(before)
})

test('R17：离开后重新打开日历，明确选择的历史日与所属月份一致', async ({ page }) => {
  await openYearEnd(page)
  await page.getByTestId('calendar-day-2026-12-30').click()
  const before = await inspectDatabase(page)
  await page.getByTestId('main-nav').getByText('首页', { exact: true }).click()
  await page.clock.fastForward(12_000)
  await page.getByTestId('main-nav').getByText('日历', { exact: true }).click()
  await expect(page.getByTestId('calendar-day-list')).toContainText('历史日期的归档')
  await expect(page.getByTestId('month-calendar').getByRole('button', { name: '2026年12月', exact: true })).toBeVisible()
  await expect(page.getByTestId('calendar-day-2026-12-30').locator('span').first()).toHaveClass(/\bbg-idea\b/)
  expect(await inspectDatabase(page)).toEqual(before)
})

test('R17：前台补偿事件使用同一个 today，刷新默认日列表与月历今日标记', async ({ page }) => {
  await openYearEnd(page)
  const before = await inspectDatabase(page)
  await page.clock.setSystemTime(new Date('2027-01-02T00:00:00.000Z'))
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByTestId('calendar-day-list')).toContainText('新年第二天的归档')
  await expect(page.getByTestId('month-calendar').getByRole('button', { name: '2027年1月', exact: true })).toBeVisible()
  await expect(page.getByTestId('calendar-day-2027-01-02')).toHaveAttribute('aria-current', 'date')
  await expect(page.getByTestId('calendar-day-2027-01-02').locator('span').first()).toHaveClass(/\bbg-idea\b/)
  expect(await inspectDatabase(page)).toEqual(before)
})
