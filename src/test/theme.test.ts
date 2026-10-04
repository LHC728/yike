import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  THEME_OPTIONS,
  THEME_STORAGE_KEY,
  readStoredMode,
  resolveTheme,
  themeActions,
  themeStore,
  type ThemeMode,
} from '../app/themeStore'
import { DESKTOP_QUERY } from '../hooks/useMediaQuery'

/**
 * 主题这块逻辑很少，但有三处**错了不会报错、只会表现得很怪**的地方，
 * 所以值得钉住：
 *   1. 「跟随系统」与「显式指定」的优先级 —— 反了的话，用户在系统深色下
 *      选「浅色」会没反应，而且他不会想到是优先级的问题。
 *   2. localStorage 抛异常 —— 隐私模式下会抛，主题读不出来**绝不能**把应用带崩。
 *   3. `index.html` 里的防闪脚本与主题模块的存储键必须一致 ——
 *      不一致的话，UI 里切的主题下次打开会丢，且没有任何报错。
 */

function stubSystemDark(prefersDark: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => {
    const list = {
      matches: query.includes('prefers-color-scheme: dark') ? prefersDark : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }
    return list as unknown as MediaQueryList
  })
}

function isDarkApplied(): boolean {
  return document.documentElement.classList.contains('dark')
}

beforeEach(() => {
  // `themeStore` 是单例、跨用例存活（这正是它在真实应用里的样子），
  // 所以只清 DOM 上的类会让「store 记着的模式」和「DOM 实际的样子」错位，
  // 后面的用例就会因为 `setMode` 的提前返回而看到上一轮的残留。
  // 顺序有讲究：先借 setMode 把两者拉回同一个确定状态，**再**清存储，
  // 这样「没存过」那条用例读到的仍然是空。
  document.documentElement.classList.remove('dark')
  themeActions.setMode('light')
  localStorage.clear()
  themeStore.start()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('resolveTheme：显式选择永远优先于系统', () => {
  it('跟随系统时听系统的', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })

  it('用户选了浅色，系统是深色也不跟着变', () => {
    expect(resolveTheme('light', true)).toBe('light')
  })

  it('用户选了深色，系统是浅色也不跟着变', () => {
    expect(resolveTheme('dark', false)).toBe('dark')
  })
})

describe('readStoredMode：坏值一律退回「跟随系统」', () => {
  it('没存过 → system', () => {
    expect(readStoredMode()).toBe('system')
  })

  it('存过就原样读出来', () => {
    for (const mode of ['system', 'light', 'dark'] as const) {
      localStorage.setItem(THEME_STORAGE_KEY, mode)
      expect(readStoredMode()).toBe(mode)
    }
  })

  it('存了脏值 → 退回 system，而不是崩掉', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'blue')
    expect(readStoredMode()).toBe('system')
  })

  it('localStorage 直接抛错（隐私模式）→ 退回 system', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('access denied')
    })
    expect(readStoredMode()).toBe('system')
  })
})

describe('setMode：写进存储、也落到 <html> 上', () => {
  it('选深色 → html.dark 出现，且记住了', () => {
    themeActions.setMode('dark')
    expect(isDarkApplied()).toBe(true)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
  })

  it('选浅色 → html.dark 消失，且记住了', () => {
    themeActions.setMode('dark')
    themeActions.setMode('light')
    expect(isDarkApplied()).toBe(false)
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
  })

  it('选「跟随系统」时按系统当前状态落', () => {
    stubSystemDark(true)
    // 先离开 system —— `setMode` 对「选的还是当前这个值」会提前返回，
    // 连选两次 system 只有第一次会真的套用，那样测的就不是这里想测的东西了。
    themeActions.setMode('light')
    themeActions.setMode('system')
    expect(isDarkApplied()).toBe(true)

    stubSystemDark(false)
    themeActions.setMode('light')
    themeActions.setMode('system')
    expect(isDarkApplied()).toBe(false)
  })

  it('重复选当前已生效的值：界面保持正确（提前返回是刻意的，避免无谓重排）', () => {
    themeActions.setMode('dark')
    themeActions.setMode('dark')
    expect(isDarkApplied()).toBe(true)
  })

  it('存储写不进去也不影响本次会话的显示', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    themeActions.setMode('dark')
    expect(isDarkApplied()).toBe(true)
  })

  it('三个选项的取值与界面按钮一一对应', () => {
    const values: ThemeMode[] = THEME_OPTIONS.map((item) => item.value)
    expect(values).toEqual(['system', 'light', 'dark'])
  })
})

describe('index.html 的防闪脚本与主题模块不许漂移', () => {
  // 这段脚本没法 import 模块（必须内联、必须在首屏之前跑），
  // 所以存储键与取值只能各写一份 —— 那就用这条用例保证两份一样。
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8')

  it('用的是同一个存储键', () => {
    expect(html).toContain(`'${THEME_STORAGE_KEY}'`)
  })

  it('认得同样的三个取值', () => {
    expect(html).toContain("saved === 'light'")
    expect(html).toContain("saved === 'dark'")
    expect(html).toContain("mode === 'system'")
  })

  it('在 <head> 里、且在标题之后立刻执行（否则会闪一帧浅色）', () => {
    const headEnd = html.indexOf('</head>')
    const scriptAt = html.indexOf('prefers-color-scheme: dark')
    expect(scriptAt).toBeGreaterThan(-1)
    expect(scriptAt).toBeLessThan(headEnd)
  })
})

describe('桌面断点：CSS 的 md: 与 JS 的 DESKTOP_QUERY 不许漂移', () => {
  // 同一件事的两半，各写一份所以必须钉住：
  //   CSS 那边管 `md:`（弹层限宽 / 遮罩居中 / Toast 位置 / 底部导航隐藏），
  //   JS 这边管侧栏与右侧详情面板渲不渲染。
  // 两边一旦不一致，就会出现「底部导航还在、中间内容却被它挡住」这种
  // 半吊子形态 —— 不报错，只是某一段宽度区间里的界面没法用。
  const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

  function cssBreakpointPx(): string | null {
    // 只认 px：写 rem 会随浏览器字号漂移，跟 JS 那边的 px 对不上
    return /--breakpoint-md:\s*(\d+)px/.exec(css)?.[1] ?? null
  }

  it('CSS 里确实覆盖了 Tailwind 默认的 768px', () => {
    const px = cssBreakpointPx()
    expect(px).not.toBeNull()
    // 768px 进三列的话，中间内容区只剩 248px（侧栏 200 + 详情 320 = 520 是死的）
    expect(Number(px)).toBeGreaterThan(768)
  })

  it('JS 的断点与 CSS 的 --breakpoint-md 同值', () => {
    const px = cssBreakpointPx()
    expect(DESKTOP_QUERY).toBe(`(min-width: ${px}px)`)
  })
})

describe('触摸滚动红线：不许有整页级别的触摸拦截', () => {
  /**
   * 真机上真实踩过：手机上装的 PWA **整个页面完全划不动，所有页面都一样**。
   * 用浏览器打开同一个地址是能划的，只有「独立窗口模式」不行。
   *
   * 当时唯一对**触摸形态整页生效**的样式是
   * `@media (pointer: coarse) { body { overscroll-behavior-y: none } }` ——
   * 本意只是「别弹下拉刷新圈」，但它是没有被广泛测试过的浏览器特性，
   * 一旦浏览器判定得偏一点，代价不是「少了个刷新圈」，而是整页触摸滚动全没。
   * 已经删掉了。
   *
   * 这条测试防的是有人觉得「下拉刷新很烦」又把它加回来。
   * ⚠️ 要加也只许加在**具体的滚动容器**上（比如弹层里那个 div），
   * 不许作用在 html / body / #root 这种整页级别。
   */
  const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

  /** 去掉注释，避免注释里提到这些词就误判 */
  function cssWithoutComments(): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, '')
  }

  it('没有 html / body / #root 级别的 overscroll-behavior 拦截', () => {
    const code = cssWithoutComments()
    // 逐条声明看它落在哪个选择器里
    const offenders: string[] = []
    for (const match of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const [, selector = '', block = ''] = match
      if (!/overscroll-behavior/.test(block)) continue
      if (/\b(body|html|#root)\b/.test(selector)) {
        offenders.push(`${selector.trim()} { ${block.trim().replace(/\s+/g, ' ')} }`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('没有任何 touch-action / user-select: none 之类的全局触摸禁用', () => {
    const code = cssWithoutComments()
    const offenders: string[] = []
    for (const match of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const [, selector = '', block = ''] = match
      const isGlobal = /^\s*(html|body|#root|\*)\s*(,|$)/.test(selector)
      if (!isGlobal) continue
      if (/touch-action\s*:\s*none|pointer-events\s*:\s*none/.test(block)) {
        offenders.push(`${selector.trim()} { ${block.trim().replace(/\s+/g, ' ')} }`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('overflow-x: hidden 是允许的（横轴，管不到竖着划）', () => {
    // 反过来确认：这条测试不是「什么都不许写」，横轴溢出该拦还得拦
    const code = cssWithoutComments()
    expect(code).toMatch(/overflow-x:\s*hidden/)
  })
})

describe('手机文字膨胀：不许让它干扰单指滑动', () => {
  /**
   * **真机验证过的 bug**（安卓，用户确认「改完就好了」）：
   * 手机上装的 PWA **单指完全划不动，要先两根手指缩放一下才能划**。
   *
   * 根因是 `-webkit-text-size-adjust`（手机的文字膨胀开关）开着 ——
   * 开启膨胀会干扰**单指手势的识别**。所以必须是 `none`，
   * 不能是 `100%`（Tailwind preflight 的默认值）。
   *
   * ⚠️ **这个 bug 在测试环境里永远复现不了**，别再试图写 E2E 去测它：
   * MDN 的初始值是「`auto` for smartphone browsers supporting inflation,
   * `none` in other cases (and then not modifiable)」——
   * 安卓手机支持膨胀所以默认 `auto`（可改，于是会出 bug），
   * 而 Chromium 桌面 / Playwright 不膨胀、初始就是 `none` 且不可修改。
   * 所以这条只能靠**静态断言**钉住，正确性由真机负责。
   *
   * ⚠️ 这条只能靠 `!important` 压住 preflight 的 `html, :host { … 100% }`，
   * 是本项目唯一允许的 important。断言里特意检查了这个 important ——
   * 把 important 去掉之后，构建产物里就是 preflight 的 100% 生效，又回到老 bug。
   */
  const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

  it('显式设成 none，且用 !important 压住 preflight', () => {
    // 只看 html 那条规则，不看注释
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).toMatch(/-webkit-text-size-adjust:\s*none\s*!important/)
    expect(code).toMatch(/(?<!-webkit-)text-size-adjust:\s*none\s*!important/)
  })

  it('没有把 text-size-adjust 再设回 100%', () => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/text-size-adjust:\s*100%/)
  })
})
