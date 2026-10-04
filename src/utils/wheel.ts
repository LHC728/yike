/**
 * 「鼠标停在某个不滚动（或已滚到底）的区域上时，把滚轮转交给真正能滚的容器」。
 *
 * 为什么需要这个东西：滚轮的事件目标是**鼠标底下那个元素**。如果那个元素
 * 没东西可滚，浏览器会顺着**祖先链**往上找可滚的祖先 —— 但本项目的布局里，
 * 真正能滚的 `<main>` 是左右两侧栏的**兄弟节点，不在祖先链上**，于是滚轮
 * 就这样「滚了个寂寞」。
 *
 * 真实反馈过的两个入口：
 * - 桌面左侧导航（内容永远装得下，永远滚不动）
 * - 桌面右侧详情面板（内容短的时候滚不动；内容长时滚到底之后同样会卡住）
 *
 * 调用方把它挂到侧栏 / 面板的 `onWheel` 上即可。
 */
/**
 * 只需要「能读 scrollTop、能拿 clientHeight」这两件事。
 * 刻意不写 `HTMLElement` —— 一来函数用不到别的成员，二来测试里能用普通对象。
 */
export interface ScrollBox {
  scrollTop: number
  clientHeight: number
}

export function forwardWheelToMain(
  event: { deltaY: number; deltaMode: number },
  scroller: ScrollBox | null = document.querySelector('main'),
): void {
  if (!scroller) return

  // deltaMode：0=像素、1=行、2=页。行/页必须换算，否则滚动量小到看不见。
  const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? scroller.clientHeight : 1
  scroller.scrollTop += event.deltaY * unit
}
