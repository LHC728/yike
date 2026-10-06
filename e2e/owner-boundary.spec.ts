import { expect, test, type Page } from '@playwright/test'
import { beginWriteBlock, installDatabaseDriver, inspectDatabase, releaseWriteBlock, seedRecords, type AuditRecord } from './auditDatabase.js'

const CLOUD_URL = 'https://audit-sync.invalid'

function idea(id: string, userId: string, content: string): AuditRecord {
  return {
    id, userId, type: 'idea', content, progress: null, deadlineLocalDate: null, parentId: null,
    createdAtUtc: '2026-10-06T00:00:00.000Z', createdTimezone: 'Asia/Shanghai', createdLocalDate: '2026-10-06',
    updatedAtUtc: '2026-10-06T00:00:00.000Z', updatedTimezone: 'Asia/Shanghai',
    completedAtUtc: null, completedTimezone: null, deletedAtUtc: null,
    serverVersion: 1, syncState: 'synced',
  }
}

/** 所有云端请求都在测试中截获，不接触真实 Worker/令牌。 */
async function openCloudA(page: Page): Promise<void> {
  await page.route(`${CLOUD_URL}/**`, async (route) => {
    const request = route.request()
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    }
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers })
      return
    }
    const token = request.headers().authorization ?? ''
    expect(['Bearer token-A', 'Bearer token-B']).toContain(token)
    const userId = token.endsWith('token-B') ? 'audit-B' : 'audit-A'
    const pathname = new URL(request.url()).pathname
    const body = pathname === '/api/me' ? { userId, email: null }
      : pathname === '/api/sync/pull-page' ? { records: [], nextCursor: null }
        : pathname === '/api/sync/record' ? { record: null }
          : { status: 'applied', version: 2, record: null }
    await route.fulfill({ status: 200, headers, json: body })
  })
  await page.addInitScript(({ url }) => {
    if (sessionStorage.getItem('audit-session-started') === '1') return
    localStorage.setItem('inspiration-todo/cloud-config', JSON.stringify({ provider: 'cloudflare', url }))
    localStorage.setItem('inspiration-todo/cf-session', JSON.stringify({ token: 'token-A', userId: 'audit-A', email: null }))
    sessionStorage.setItem('audit-session-started', '1')
  }, { url: CLOUD_URL })
  await page.goto('/')
  await expect(page.getByTestId('quick-capture')).toBeVisible()
  await installDatabaseDriver(page)
  await seedRecords(page, [idea('audit-record-A', 'audit-A', 'A 的私密内容'), idea('audit-record-B', 'audit-B', 'B 的记录')])
}

async function signOut(page: Page): Promise<void> {
  await page.getByTestId('open-settings').click()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '访问令牌', exact: true })).toBeVisible()
}

async function startSignInB(page: Page): Promise<void> {
  await page.getByRole('textbox', { name: '同步服务地址', exact: true }).fill(CLOUD_URL)
  await page.getByRole('textbox', { name: '访问令牌', exact: true }).fill('token-B')
  await page.getByRole('button', { name: '连接', exact: true }).click()
}

test('R04：同页 A 退出后登录 B，旧详情与编辑草稿不跨账号', async ({ page }) => {
  // 只有桌面详情允许边保留详情边操作设置；另一个用例使用原生手机视口。
  await page.setViewportSize({ width: 1280, height: 900 })
  await openCloudA(page)
  await page.getByTestId('timeline').getByTestId('record-row').filter({ hasText: 'A 的私密内容' }).locator('button').click()
  await page.getByTestId('detail-edit').click()
  await page.getByTestId('detail-editor').fill('A 的尚未保存草稿')
  await signOut(page)
  await startSignInB(page)
  await expect(page.getByTestId('quick-capture')).toBeVisible()
  await expect(page.getByTestId('timeline')).toContainText('B 的记录')
  await expect(page.getByText('A 的私密内容', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('detail-editor')).toHaveCount(0)
  const after = await inspectDatabase(page)
  expect(after.records.find((row) => row.id === 'audit-record-A')?.content).toBe('A 的私密内容')
  expect(after.outbox.filter((row) => row.userId === 'audit-A')).toHaveLength(0)
})

test('R04：排队的旧账号保存不会在切换身份后落库', async ({ page }) => {
  await openCloudA(page)
  await beginWriteBlock(page)
  try {
    await page.getByTestId('quick-capture-input').fill('A 切换前排队的内容')
    await page.getByTestId('quick-capture-idea').click()
    await expect(page.getByTestId('quick-capture-idea')).toBeDisabled()
    await signOut(page)
    await startSignInB(page)
  } finally {
    await releaseWriteBlock(page)
  }
  await expect(page.getByTestId('quick-capture')).toBeVisible()
  await expect(page.getByTestId('timeline')).toContainText('B 的记录')
  const after = await inspectDatabase(page)
  expect(after.records.some((row) => row.content === 'A 切换前排队的内容')).toBe(false)
  expect(after.outbox.filter((row) => row.userId === 'audit-A')).toHaveLength(0)
})

test('R04：账号切换清理旧撤销与未保存的快捷输入，保留 A 的已完成状态', async ({ page }) => {
  await openCloudA(page)
  await seedRecords(page, [{ ...idea('audit-todo-A', 'audit-A', 'A 的私密待办'), type: 'todo' }])
  await page.getByTestId('main-nav').getByText('待办', { exact: true }).click()
  await page.getByRole('checkbox', { name: '完成：A 的私密待办', exact: true }).click()
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeVisible()
  await page.getByTestId('main-nav').getByText('首页', { exact: true }).click()
  await page.getByTestId('quick-capture-input').fill('A 的尚未保存快捷输入')
  await signOut(page)
  await startSignInB(page)
  await expect(page.getByTestId('timeline')).toContainText('B 的记录')
  await expect(page.getByTestId('quick-capture-input')).toHaveValue('')
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toHaveCount(0)
  const after = await inspectDatabase(page)
  expect(after.records.find((row) => row.id === 'audit-todo-A')?.completedAtUtc).not.toBeNull()
  expect(after.records.some((row) => row.content === 'A 的尚未保存快捷输入')).toBe(false)
})
