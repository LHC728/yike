#!/usr/bin/env node
/**
 * 一刻 —— 「界面 → 真实后端」的端到端检查。
 *
 * 为什么还需要这个脚本（check-sync.mjs 已经验过接口了）：
 *   check-sync.mjs 是**照着后端代码**写的请求，它证明不了
 *   「应用真正发出去的请求」和「后端接受的请求」是同一套。
 *   两边各写各的、字段名差一个字母，接口测试照样全绿，用户却同步不了。
 *   所以这里用真浏览器走真界面：配置 → 记录 → 同步 → 去线上查这条在不在。
 *
 * 它是这条链路上唯一的一环 —— 少测了它，就只能等用户在手机上发现「同步没反应」。
 *
 * 用法（地址与令牌同样从参数或环境变量读，脚本不含密钥）：
 *
 *   node scripts/check-app-sync.mjs \
 *     --app=http://127.0.0.1:4173 \
 *     --url=https://yike-sync.xxx.workers.dev --token=yyy
 *
 * 前置：目标地址上跑着一份应用（`npm run preview` 或 `npm run dev`）。
 *
 * 它会在浏览器里记一条**测试记录**，同步上去，确认落库后就地软删除 ——
 * 所以界面上不会给你留一条多余的东西。
 *
 * 退出码：全部通过 0，有任何一项失败 1。
 */

import { chromium } from '@playwright/test'

const flags = new Map()
for (const arg of process.argv.slice(2)) {
  const index = arg.indexOf('=')
  flags.set(index === -1 ? arg : arg.slice(0, index), index === -1 ? true : arg.slice(index + 1))
}

const APP = String(flags.get('--app') ?? process.env.YIKE_APP_URL ?? 'http://127.0.0.1:4173').replace(
  /\/+$/,
  '',
)
const BASE = String(flags.get('--url') ?? process.env.YIKE_SYNC_URL ?? '').replace(/\/+$/, '')
const TOKEN = String(flags.get('--token') ?? process.env.YIKE_SYNC_TOKEN ?? '')
const LOGIN_STORAGE_KEYS = ['inspiration-todo/cloud-config', 'inspiration-todo/cf-session']

if (BASE === '' || TOKEN === '') {
  process.stderr.write(
    [
      '缺少后端地址或令牌。用法：',
      '',
      '  node scripts/check-app-sync.mjs --app=http://127.0.0.1:4173 \\',
      '    --url=https://yike-sync.xxx.workers.dev --token=yyy',
      '',
    ].join('\n'),
  )
  process.exit(2)
}

let passed = 0
const failures = []

function redact(value) {
  return String(value).replaceAll(TOKEN, '[已隐藏令牌]')
}

function check(name, ok, detail) {
  if (ok) {
    passed += 1
    process.stdout.write(`  ✓ ${name}\n`)
  } else {
    failures.push(name)
    process.stdout.write(`  ✗ ${name}\n`)
    if (detail !== undefined) process.stdout.write(`      ${redact(detail)}\n`)
  }
}

function section(title) {
  process.stdout.write(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}\n`)
}

async function api(path, options = {}) {
  const headers = { authorization: `Bearer ${TOKEN}` }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const init = { method: options.method ?? 'GET', headers }
  if (options.body !== undefined) init.body = JSON.stringify(options.body)
  const response = await fetch(`${BASE}${path}`, init)
  return { status: response.status, body: await response.json().catch(() => null) }
}

async function readLocalCreation(targetPage, identity) {
  return targetPage.evaluate(
    (lookup) =>
      new Promise((resolve, reject) => {
        const opened = indexedDB.open('inspiration-todo')
        opened.addEventListener('error', () => reject(new Error('无法读取本机数据库')))
        opened.addEventListener('success', () => {
          const db = opened.result
          const transaction = db.transaction('records', 'readonly')
          transaction.addEventListener('complete', () => db.close())
          transaction.addEventListener('abort', () => {
            db.close()
            reject(new Error('读取本机记录事务中断'))
          })
          const records = transaction.objectStore('records')
          const request = lookup.id ? records.get(lookup.id) : records.getAll()
          request.addEventListener('error', () => reject(new Error('无法读取本机记录')))
          request.addEventListener('success', () => {
            const record = lookup.id
              ? request.result
              : request.result.find((item) => item.content === lookup.content)
            resolve(record ? {
              id: record.id,
              createdAtUtc: record.createdAtUtc,
              createdLocalDate: record.createdLocalDate,
              createdTimezone: record.createdTimezone,
            } : null)
          })
        })
      }),
    identity,
  )
}

const run = Math.random().toString(16).slice(2, 8)
const CONTENT = `一刻自测 ${run}`

process.stdout.write(`\n一刻 · 界面到后端的端到端检查\n  应用：${APP}\n  后端：${BASE}\n`)

const browser = await chromium.launch()
// 每次跑都用全新的浏览器档案：不带上一次的 IndexedDB 与配置，
// 结果才可复现，也不会把测试数据留在你的真实浏览器里。
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await context.newPage()
let restoredContext = null

const consoleErrors = []
function collectConsoleError(message) {
  if (message.type() === 'error') consoleErrors.push(message.text())
}
page.on('console', collectConsoleError)

let recordId = null

try {
  // ---------------------------------------------------------------
  section('0. 应用能打开（本机模式）')

  await page.goto(APP, { waitUntil: 'load' })
  await page.getByTestId('quick-capture').waitFor({ state: 'visible', timeout: 15000 })
  check('首页可打开，写入入口可见', true)

  // ---------------------------------------------------------------
  section('1. 先在「未连接云端」时记一条')

  // 这一步是有意的：它同时验证「本机已有记录会在首次登录时归入账号」。
  await page.getByTestId('quick-capture-input').fill(CONTENT)
  await page.getByTestId('quick-capture-idea').click()
  await page.waitForFunction(
    () => document.querySelector('[data-testid="quick-capture-input"]')?.value === '',
  )
  await page.getByTestId('record-row').filter({ hasText: CONTENT }).waitFor({ timeout: 10000 })
  check('记录已存到本机', true)
  const localCreation = await readLocalCreation(page, { content: CONTENT })
  if (!localCreation || !Object.values(localCreation).every((value) => typeof value === 'string' && value !== '')) {
    throw new Error('首次本机记录缺少 ID 或创建时间，不能用服务端结果代替基准')
  }
  check('首次本机记录的 ID 与创建三字段已读取', true)

  // ---------------------------------------------------------------
  section('2. 在界面里配置 Cloudflare 并保存')

  await page.getByLabel('设置').click()
  await page.getByTestId('settings-open-cloud').click()
  await page.getByTestId('settings-provider-cloudflare').click()
  await page.getByLabel('云端地址').fill(BASE)
  await page.getByLabel('访问令牌').fill(TOKEN)

  // 登录配置必须真正保存并完成当前界面的重载；超时不能吞掉后继续算成功。
  await Promise.all([
    page.waitForEvent('load', { timeout: 20000 }),
    page.getByRole('button', { name: '保存连接' }).click(),
  ])
  await page.getByTestId('quick-capture').waitFor({ state: 'visible', timeout: 20000 })

  await page.getByLabel('设置').click()
  const providerText = (await page.getByTestId('settings-provider').textContent()) ?? ''
  check('界面认到了 Cloudflare 后端', providerText.includes('Cloudflare'), providerText)

  // ---------------------------------------------------------------
  section('3. 同步上去')

  await page.getByRole('button', { name: '立即同步' }).click()

  let pendingText = ''
  for (let attempt = 0; attempt < 40; attempt += 1) {
    pendingText = (await page.getByTestId('settings-pending').textContent()) ?? ''
    if (pendingText.trim().startsWith('0')) break
    await page.waitForTimeout(500)
  }
  check('待同步归零（说明推送没有卡住）', pendingText.trim().startsWith('0'), pendingText)

  const phase = (await page.getByTestId('settings-sync-phase').textContent()) ?? ''
  check('同步状态不是「暂时无法同步」', !phase.includes('无法同步'), phase)

  // ---------------------------------------------------------------
  section('4. 去线上后端查这条在不在')

  const pulled = await api('/api/sync/pull', { method: 'POST', body: {} })
  const found = (pulled.body?.records ?? []).find((item) => item.id === localCreation.id)
  check('本机同 ID 的记录真的落到了线上数据库', pulled.status === 200 && Boolean(found), {
    count: pulled.body?.records?.length ?? 0,
    lookingFor: CONTENT,
  })

  if (found) {
    recordId = found.id
    check('类型是「灵感」', found.type === 'idea', found.type)
    check('云端创建时刻与首次本机值相等', found.createdAtUtc === localCreation.createdAtUtc)
    check('云端创建日期与首次本机值相等', found.createdLocalDate === localCreation.createdLocalDate)
    check('云端创建时区与首次本机值相等', found.createdTimezone === localCreation.createdTimezone)
    check('版本从 1 开始', found.version === 1, found.version)
  }

  // ---------------------------------------------------------------
  section('5. 反向验证：全新浏览器环境从云端拉回同一条')

  // 只复制连接与登录 localStorage，不能复制 IndexedDB；旧页的 blocked/error
  // 从来不代表删除成功，全新的匿名 context 才能排除本机旧记录造成的假阳性。
  const loginStorage = await page.evaluate(
    (keys) => keys.map((name) => ({ name, value: localStorage.getItem(name) })),
    LOGIN_STORAGE_KEYS,
  )
  if (loginStorage.some((item) => !item.value)) throw new Error('登录配置未完整落盘，无法验证新设备拉取')
  restoredContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    storageState: { cookies: [], origins: [{ origin: new URL(APP).origin, localStorage: loginStorage }] },
  })
  const restoredPage = await restoredContext.newPage()
  restoredPage.on('console', collectConsoleError)
  // 首次只加载同源空白页，在应用脚本运行前核验空库；此一次性路由不接管后端请求。
  await restoredPage.route(new URL(APP).href, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>同步验收空环境</title>' }), { times: 1 })
  await restoredPage.goto(APP, { waitUntil: 'load' })
  check('第二个匿名环境在应用启动前没有 IndexedDB', await restoredPage.evaluate(async () => (await indexedDB.databases()).length === 0))
  await restoredPage.goto(APP, { waitUntil: 'load' })
  await restoredPage.getByTestId('quick-capture').waitFor({ state: 'visible', timeout: 20000 })

  let restored = false
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const count = await restoredPage.getByTestId('record-row').filter({ hasText: CONTENT }).count()
    if (count > 0) {
      restored = true
      break
    }
    await restoredPage.waitForTimeout(500)
  }
  check('全新环境的界面能显示云端拉回的记录', restored)
  const restoredCreation = await readLocalCreation(restoredPage, { id: localCreation.id })
  check('拉回本机的记录 ID 与首次写入相等', restoredCreation?.id === localCreation.id)
  check('拉回本机的创建时刻与首次值相等', restoredCreation?.createdAtUtc === localCreation.createdAtUtc)
  check('拉回本机的创建日期与首次值相等', restoredCreation?.createdLocalDate === localCreation.createdLocalDate)
  check('拉回本机的创建时区与首次值相等', restoredCreation?.createdTimezone === localCreation.createdTimezone)

  const appErrors = consoleErrors.filter((text) => !text.includes('favicon'))
  check('全程没有控制台报错', appErrors.length === 0, appErrors.slice(0, 3))
} catch (error) {
  const message = redact(error instanceof Error ? error.message : String(error))
  failures.push(`脚本执行中断：${message}`)
  process.stdout.write(`\n  ✗ 脚本中断：${message}\n`)
} finally {
  // ---------------------------------------------------------------
  section('6. 清理本次测试记录')

  try {
    if (recordId === null) {
      const pulled = await api('/api/sync/pull', { method: 'POST', body: {} })
      recordId = (pulled.body?.records ?? []).find((item) => item.content === CONTENT)?.id ?? null
    }

    if (recordId === null) {
      process.stdout.write('  没有留下测试记录，无需清理。\n')
    } else {
      const read = await api(`/api/sync/record?id=${encodeURIComponent(recordId)}`)
      const version = read.body?.record?.version
      if (typeof version === 'number') {
        const now = new Date().toISOString()
        const result = await api('/api/sync/mutate', {
          method: 'POST',
          body: {
            mutationId: `app-smoke-del-${run}`,
            recordId,
            operation: 'delete',
            expectedVersion: version,
            payload: { deletedAtUtc: now, updatedAtUtc: now },
          },
        })
        check('测试记录已软删除（界面不会再看到它）', result.body?.status === 'applied', result.body)
      } else {
        check('能够读取本次测试记录版本并清理', false)
      }
    }
  } catch (error) {
    check('本次测试记录的清理请求成功', false, error instanceof Error ? error.message : error)
  } finally {
    try {
      await restoredContext?.close()
    } finally {
      try {
        await context.close()
      } finally {
        await browser.close()
      }
    }
  }
}

process.stdout.write('\n' + '─'.repeat(64) + '\n')
if (failures.length === 0) {
  process.stdout.write(`  全部通过（${passed} 项）—— 界面到后端真的通了，不是推断的。\n\n`)
  process.exit(0)
}
process.stdout.write(`  ${passed} 项通过，${failures.length} 项失败：\n`)
for (const name of failures) process.stdout.write(`    · ${name}\n`)
process.stdout.write('\n')
process.exit(1)
