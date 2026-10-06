import { expect, test } from '@playwright/test'

/** 全部云请求由 route 接管；验证身份过渡不会卸载正在输入的真实界面。 */
test('令牌登录失败后保留地址和令牌，并显示可重试的错误', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('inspiration-todo/cloud-config', JSON.stringify({ provider: 'cloudflare', url: 'https://auth-e2e.invalid' }))
  })
  await page.route('https://auth-e2e.invalid/**', async (route) => {
    await route.fulfill({ status: route.request().method() === 'OPTIONS' ? 204 : 401, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' }, contentType: 'application/json', body: route.request().method() === 'OPTIONS' ? '' : JSON.stringify({ error: 'invalid_token' }) })
  })
  await page.goto('/')
  await page.getByLabel('同步服务地址').fill('https://auth-e2e.invalid')
  await page.getByLabel('访问令牌').fill('draft-token-retain')
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect(page.getByTestId('login-error')).toContainText('这个令牌不被接受')
  await expect(page.getByLabel('同步服务地址')).toHaveValue('https://auth-e2e.invalid')
  await expect(page.getByLabel('访问令牌')).toHaveValue('draft-token-retain')
  await expect(page.getByRole('button', { name: '连接', exact: true })).toBeEnabled()
})

test('设置页验证失败后仍在云端连接表单，保留输入和本机草稿', async ({ page }) => {
  await page.route('https://auth-e2e.invalid/**', async (route) => {
    await route.fulfill({ status: route.request().method() === 'OPTIONS' ? 204 : 401, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' }, contentType: 'application/json', body: route.request().method() === 'OPTIONS' ? '' : JSON.stringify({ error: 'invalid_token' }) })
  })
  await page.goto('/')
  await page.getByTestId('quick-capture-input').fill('失败登录不能隐藏本机草稿')
  await page.getByTestId('quick-capture-idea').click()
  await expect(page.getByTestId('timeline')).toContainText('失败登录不能隐藏本机草稿')
  await page.getByTestId('open-settings').click()
  await page.getByRole('button', { name: '云端连接' }).click()
  await page.getByTestId('settings-provider-cloudflare').click()
  await page.getByLabel('云端地址').fill('https://auth-e2e.invalid')
  await page.getByLabel('访问令牌').fill('settings-token-retain')
  await page.getByRole('button', { name: '保存连接', exact: true }).click()
  await expect(page.getByTestId('settings-cloud-error')).toContainText('这个令牌不被接受')
  await expect(page.getByLabel('云端地址')).toHaveValue('https://auth-e2e.invalid')
  await expect(page.getByLabel('访问令牌')).toHaveValue('settings-token-retain')
  await expect(page.getByRole('button', { name: '保存连接', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('timeline')).toContainText('失败登录不能隐藏本机草稿')
})


test('连接成功后恢复写入与同步，新增记录确实送到同一账号', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('inspiration-todo/cloud-config', JSON.stringify({ provider: 'cloudflare', url: 'https://auth-e2e.invalid' }))
  })
  const rows: Record<string, unknown>[] = []
  const contents: string[] = []
  await page.route('https://auth-e2e.invalid/**', async (route) => {
    const request = route.request()
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' }
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers })
      return
    }
    let payload: unknown = { records: rows }
    if (request.url().endsWith('/api/me')) payload = { userId: 'e2e-A', email: null }
    if (request.url().endsWith('/api/sync/mutate')) {
      expect(request.headers()['authorization']).toBe('Bearer valid-token-A')
      const mutation = request.postDataJSON() as { recordId: string; payload: Record<string, unknown> }
      contents.push(String(mutation.payload['content']))
      const record = { ...mutation.payload, id: mutation.recordId, userId: 'e2e-A', version: 1, serverUpdatedAt: new Date().toISOString() }
      rows.push(record)
      payload = { status: 'applied', version: 1, record }
    }
    await route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(payload) })
  })
  await page.goto('/')
  await page.getByLabel('访问令牌').fill('valid-token-A')
  await page.getByRole('button', { name: '连接', exact: true }).click()
  await expect(page.getByTestId('quick-capture')).toBeVisible()
  await page.getByTestId('quick-capture-input').fill('连接成功后可写入并同步')
  await page.getByTestId('quick-capture-idea').click()
  await expect(page.getByTestId('timeline')).toContainText('连接成功后可写入并同步')
  await expect.poll(() => contents).toContain('连接成功后可写入并同步')
})
