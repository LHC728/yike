#!/usr/bin/env node
/**
 * 一刻 —— 配色对比度校验（WCAG 2.1）。
 *
 * 为什么要有这个脚本：
 *   设计规范里写着硬规则「任何承载信息的文字对比度不低于 4.5:1」，
 *   但**规则靠人记，人记不住十六进制**。`#8b9199` 到底是多少比多少，
 *   光看色号是看不出来的 —— 上一版就出过 `ink-faint` 只有 2.2:1
 *   却用在时间戳上的事。
 *   所以这里把那条规则变成机器能守的约束：颜色改了，数字自己会说话。
 *
 * 它读的是 `src/index.css` 里的真实令牌（浅色 `@theme` + 深色覆盖块），
 * 不是另抄一份 —— 抄一份就会漂移。
 *
 * 用法：
 *   node scripts/check-contrast.mjs          # 校验，不达标退出码 1
 *   node scripts/check-contrast.mjs --list   # 只打印全部实测值，不判失败
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CSS_PATH = 'src/index.css'
const LIST_ONLY = process.argv.includes('--list')

// ---------------------------------------------------------------
// WCAG 相对亮度与对比度
// ---------------------------------------------------------------

function channel(value) {
  const v = value / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

function luminance(hex) {
  const raw = hex.replace('#', '')
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw
  const r = Number.parseInt(full.slice(0, 2), 16)
  const g = Number.parseInt(full.slice(2, 4), 16)
  const b = Number.parseInt(full.slice(4, 6), 16)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(foreground, background) {
  const a = luminance(foreground)
  const b = luminance(background)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

// ---------------------------------------------------------------
// 从 CSS 里抠令牌
// ---------------------------------------------------------------

/**
 * 用大括号配对取出某个选择器的块内容。
 *
 * 选择器**必须出现在行首**（允许缩进）—— 这个约束是必需的：
 * 文件开头的说明注释里就提到了 `html.dark`，如果只做朴素的
 * `indexOf('html.dark')`，会从注释里那一句开始找，然后匹配到下一个 `{`，
 * 也就是 `@theme` 块 —— 结果是「深色配色」读出来跟浅色一模一样，
 * 校验全绿，而深色主题根本没被检查到。这个坑实测踩过一次。
 */
function blockOf(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(?:^|\\n)[ \\t]*${escaped}[ \\t]*\\{`)
  const matched = pattern.exec(css)
  if (!matched) return null
  const open = css.indexOf('{', matched.index)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  return null
}

/** 块里所有 `--color-x: #hex;` */
function tokensIn(block) {
  const tokens = new Map()
  if (block === null) return tokens
  const pattern = /(--color-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g
  for (const match of block.matchAll(pattern)) {
    tokens.set(match[1].replace('--color-', ''), match[2].toLowerCase())
  }
  return tokens
}

const css = readFileSync(resolve(process.cwd(), CSS_PATH), 'utf8')

const lightTokens = tokensIn(blockOf(css, '@theme'))
const darkOverride = tokensIn(blockOf(css, 'html.dark'))

if (lightTokens.size === 0) {
  process.stderr.write(`✗ 没能从 ${CSS_PATH} 的 @theme 里读到任何颜色令牌。\n`)
  process.exit(2)
}

/** 深色 = 浅色打底 + 深色覆盖。没被覆盖的令牌沿用浅色值。 */
function resolveDark() {
  const merged = new Map(lightTokens)
  for (const [name, value] of darkOverride) merged.set(name, value)
  return merged
}

// ---------------------------------------------------------------
// 要校验的组合
//
// 左边是「文字/前景色」，右边是它可能落在的底色。
// 阈值：承载信息 4.5:1（WCAG AA 正文），纯装饰 3:1（非文本对比度）。
// ---------------------------------------------------------------

const TEXT_PAIRS = {
  ink: ['canvas', 'surface', 'sunken'],
  'ink-soft': ['canvas', 'surface', 'sunken'],
  idea: ['canvas', 'surface', 'idea-soft'],
  // 蓝色也用于文字选区，输入区的凹陷底色不能漏掉。
  todo: ['canvas', 'surface', 'sunken', 'todo-soft'],
  project: ['canvas', 'surface', 'project-soft'],
  danger: ['canvas', 'surface'],
  // 实心按钮 / 打勾里的文字与勾：它们是**内容**，不是装饰。
  // 白色是这里原先隐式的值 —— 现在它必须显式定义，因为深色底上白色会翻车。
  'on-idea': ['idea'],
  'on-todo': ['todo'],
  'on-project': ['project'],
  'on-danger': ['danger'],
}

/** 只用于装饰（分隔线旁的小圆点、关闭图标），不承载语义 */
const DECORATIVE_PAIRS = {
  'ink-faint': ['canvas', 'surface'],
}

const TEXT_MIN = 4.5
const DECORATIVE_MIN = 3

// ---------------------------------------------------------------
// 跑
// ---------------------------------------------------------------

const problems = []

function evaluate(themeName, tokens, pairs, min) {
  const rows = []
  for (const [foreground, backgrounds] of Object.entries(pairs)) {
    const fg = tokens.get(foreground)
    if (fg === undefined) {
      problems.push(`${themeName}：缺少令牌 --color-${foreground}`)
      rows.push({ pair: `${foreground} on ?`, value: null, ok: false, note: '令牌不存在' })
      continue
    }
    for (const background of backgrounds) {
      const bg = tokens.get(background)
      if (bg === undefined) {
        problems.push(`${themeName}：缺少令牌 --color-${background}`)
        rows.push({ pair: `${foreground} on ${background}`, value: null, ok: false, note: '令牌不存在' })
        continue
      }
      const value = contrast(fg, bg)
      rows.push({ pair: `${foreground} on ${background}`, value, ok: value >= min, min })
    }
  }
  return rows
}

function printTheme(themeName, tokens) {
  process.stdout.write(`\n── ${themeName} ${'─'.repeat(Math.max(0, 52 - themeName.length))}\n`)
  const rows = [
    ...evaluate(themeName, tokens, TEXT_PAIRS, TEXT_MIN),
    ...evaluate(themeName, tokens, DECORATIVE_PAIRS, DECORATIVE_MIN),
  ]
  for (const row of rows) {
    const shown = row.value === null ? '  —  ' : `${row.value.toFixed(2)}:1`
    const limit = row.min === undefined ? '' : ` (≥ ${row.min})`
    const mark = row.ok ? '✓' : '✗'
    process.stdout.write(`  ${mark} ${row.pair.padEnd(24)} ${shown.padStart(8)}${limit}\n`)
  }
  return rows.every((row) => row.ok)
}

process.stdout.write('\n一刻 · 配色对比度校验（WCAG 2.1）\n')

const lightOk = printTheme('浅色', lightTokens)
const darkTokens = resolveDark()
const darkOk = printTheme('深色', darkTokens)

if (darkOverride.size === 0) {
  process.stdout.write('\n  ⚠ 没找到 html.dark 覆盖块 —— 深色主题等于没实现。\n')
  problems.push('缺少深色令牌覆盖块 html.dark')
} else if (darkTokens.get('canvas') === lightTokens.get('canvas')) {
  // 覆盖块存在、但底色没变 —— 多半是块没被正确解析到（例如选择器匹配歪了）。
  // 这种情况下两种主题的实测值会完全一样，光看数字是看不出来的。
  process.stdout.write('\n  ⚠ html.dark 里没有改底色 —— 深色主题实际上没生效。\n')
  problems.push('html.dark 未改变 --color-canvas，深色主题没有真正生效')
}

process.stdout.write('\n' + '─'.repeat(64) + '\n')

if (LIST_ONLY) {
  process.stdout.write('  （--list：只列出实测值，不判失败）\n\n')
  process.exit(0)
}

if (problems.length === 0 && lightOk && darkOk) {
  process.stdout.write('  两种主题全部达标。\n\n')
  process.exit(0)
}

process.stdout.write(`  未达标 ${problems.length} 项：\n`)
for (const item of problems) process.stdout.write(`    · ${item}\n`)
process.stdout.write('\n')
process.exit(1)
