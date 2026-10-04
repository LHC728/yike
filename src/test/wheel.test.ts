/**
 * 滚轮转发单元测试。
 *
 * 钉住的是那个真实踩过的坑：鼠标停在侧栏 / 右侧面板上时，滚轮的事件目标是
 * 那个元素，而真正能滚的 `<main>` 是它的**兄弟**（不在祖先链上），
 * 浏览器往上找可滚祖先找不到，滚轮就「滚了个寂寞」。
 */
import { describe, expect, it } from 'vitest'
import { forwardWheelToMain } from '../utils/wheel'

/** 造一个假的可滚容器，记录 scrollTop 被改成了多少 */
function fakeScroller(initialTop = 0, clientHeight = 600) {
  return { scrollTop: initialTop, clientHeight }
}

describe('把滚轮转交给 main', () => {
  it('像素模式（deltaMode=0）：原样加上 deltaY', () => {
    const scroller = fakeScroller(100)
    forwardWheelToMain({ deltaY: 120, deltaMode: 0 }, scroller)
    expect(scroller.scrollTop).toBe(220)
  })

  it('行模式（deltaMode=1）：换算成像素，不能只加一丁点', () => {
    const scroller = fakeScroller(0)
    forwardWheelToMain({ deltaY: 3, deltaMode: 1 }, scroller)
    // 3 行 × 40px = 120px。如果直接用 3 会小到几乎看不见
    expect(scroller.scrollTop).toBe(120)
  })

  it('页模式（deltaMode=2）：按容器可见高度换算', () => {
    const scroller = fakeScroller(0, 600)
    forwardWheelToMain({ deltaY: 2, deltaMode: 2 }, scroller)
    expect(scroller.scrollTop).toBe(1200)
  })

  it('向上滚是负值，能滚回去', () => {
    const scroller = fakeScroller(500)
    forwardWheelToMain({ deltaY: -200, deltaMode: 0 }, scroller)
    expect(scroller.scrollTop).toBe(300)
  })

  it('找不到滚动容器时安静返回，不抛异常', () => {
    expect(() => forwardWheelToMain({ deltaY: 100, deltaMode: 0 }, null)).not.toThrow()
  })
})
