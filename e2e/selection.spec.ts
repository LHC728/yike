import { expect, test, type Locator } from '@playwright/test'

// 按浏览器实际解析的颜色量可读性，不能只断言 CSS 换成了某个令牌。
function luminance(color: string): number {
  const channels = color.match(/[\d.]+/g)?.map(Number)
  if (!channels || channels.length < 3 || (channels[3] !== undefined && channels[3] !== 1)) {
    throw new Error(`选区颜色必须不透明：${color}`)
  }
  const linear = channels.slice(0, 3).map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0)
}

function contrast(first: string, second: string): number {
  const a = luminance(first)
  const b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

async function checkHighlight(locator: Locator): Promise<void> {
  const palette = await locator.evaluate((element) => {
    const highlight = getComputedStyle(element, '::selection')
    const probe = document.createElement('span')
    document.body.append(probe)
    const backgrounds = ['canvas', 'surface', 'sunken'].map((name) => {
      probe.style.color = `var(--color-${name})`
      return getComputedStyle(probe).color
    })
    probe.remove()
    return { foreground: highlight.color, background: highlight.backgroundColor, backgrounds }
  })
  expect(contrast(palette.foreground, palette.background), '选区内文字要清楚').toBeGreaterThanOrEqual(4.5)
  for (const background of palette.backgrounds) {
    expect(contrast(palette.background, background), '选区要明显区别于页面、卡片和输入区').toBeGreaterThanOrEqual(3)
  }
}

async function selectPrefix(locator: Locator, content: string): Promise<void> {
  await locator.focus()
  await locator.press('Control+Home')
  for (let index = 0; index < 6; index += 1) await locator.press('Shift+ArrowRight')
  const selection = await locator.evaluate((element) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) throw new Error('不是文字输入控件')
    return { focused: document.activeElement === element, start: element.selectionStart, end: element.selectionEnd, value: element.value }
  })
  expect(selection).toEqual({ focused: true, start: 0, end: 6, value: content })
  await checkHighlight(locator)
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}：正文和输入框的部分选区清晰，内容不变`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/')
    const input = page.getByTestId('quick-capture-input')
    await expect(input).toBeVisible()
    if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/)
    else await expect(page.locator('html')).not.toHaveClass(/dark/)

    const content = '文字选区测试，剩余内容保持原样'
    await input.fill(content)
    await selectPrefix(input, content)
    const inputShot = testInfo.outputPath('input-selection.png')
    await input.screenshot({ path: inputShot })
    await testInfo.attach('输入框部分选区', { path: inputShot, contentType: 'image/png' })
    await page.getByTestId('quick-capture-idea').click()
    await expect(input).toHaveValue('')
    await page.getByTestId('timeline').getByText(content, { exact: true }).click()

    const detail = page.getByTestId('detail-content')
    await expect(detail).toHaveText(content)
    await detail.evaluate((element) => {
      const node = element.firstChild
      if (!node || node.nodeType !== Node.TEXT_NODE) throw new Error('正文没有文字节点')
      const range = document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, 6)
      const selection = window.getSelection()
      if (!selection) throw new Error('浏览器没有选区')
      selection.removeAllRanges()
      selection.addRange(range)
    })
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(content.slice(0, 6))
    await checkHighlight(detail)
    const detailShot = testInfo.outputPath('detail-selection.png')
    await detail.screenshot({ path: detailShot })
    await testInfo.attach('正文部分选区', { path: detailShot, contentType: 'image/png' })
    await expect(detail).toHaveText(content)

    await page.getByTestId('detail-edit').click()
    const editor = page.getByTestId('detail-editor')
    await expect(editor).toHaveValue(content)
    await selectPrefix(editor, content)
    const editorShot = testInfo.outputPath('editor-selection.png')
    await editor.screenshot({ path: editorShot })
    await testInfo.attach('编辑器部分选区', { path: editorShot, contentType: 'image/png' })
    await page.getByTestId('detail-save').click()
    await expect(detail).toHaveText(content)

    const close = page.getByTestId('detail-close')
    if (await close.count()) await close.click()
    else await page.keyboard.press('Escape')
    await page.getByTestId('open-search').click()
    const search = page.getByTestId('search-input')
    await search.fill('文字选区测试')
    await selectPrefix(search, '文字选区测试')
    const searchShot = testInfo.outputPath('search-selection.png')
    await search.screenshot({ path: searchShot })
    await testInfo.attach('搜索框部分选区', { path: searchShot, contentType: 'image/png' })
    await expect(page.getByRole('dialog').getByText(content, { exact: true })).toBeVisible()
  })
}
