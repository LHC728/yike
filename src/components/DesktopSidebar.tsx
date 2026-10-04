import { NavLink } from 'react-router-dom'
import { NAV_ITEMS } from '../app/navItems'
import { useIdeas, useOpenTodos } from '../hooks/useRecords'

interface DesktopSidebarProps {
  userId: string
}

/**
 * 桌面左侧导航。
 *
 * 「灵感」与「待办」带数量角标 —— 桌面有空间，顺手回答「我有多少东西」，
 * 不用点进去才知道。首页与日历不带（一个回答时间、一个回答某一天）。
 */
export function DesktopSidebar({ userId }: DesktopSidebarProps) {
  const ideas = useIdeas(userId)
  const todos = useOpenTodos(userId)

  const counts: Record<string, number> = {
    '/ideas': ideas.length,
    '/todos': todos.length,
  }

  return (
    <nav
      // ⚠️ 这里曾经写成 `sticky top-0 h-screen`，结果是**鼠标滚轮划过侧栏时滚不动**：
      // 一条钉住的满屏高柱子会吃掉指针经过时的滚轮事件。
      // 现在改由外层 AppShell 出滚动条（`h-screen overflow-hidden`，只有 main 自己滚），
      // 侧栏只负责「撑满高度、不参与滚动」。
      className="hidden h-full w-[200px] shrink-0 overflow-y-auto border-r border-line bg-sunken md:block"
      aria-label="主导航"
      data-testid="main-nav"
    >
      <div className="safe-top flex flex-col px-3 py-5">
        <div className="mb-5 px-2 text-[15px] font-medium tracking-[0.08em] text-ink">一刻</div>

        <ul className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const count = counts[item.to]
            return (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    `tap tap-active flex items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-[13px] ${
                      isActive
                        ? 'card-raised font-medium text-ink'
                        : 'text-ink-soft hover:bg-canvas'
                    }`
                  }
                >
                  <Icon size={17} strokeWidth={1.7} />
                  <span className="flex-1">{item.label}</span>
                  {typeof count === 'number' && count > 0 ? (
                    <span className="text-[11px] tabular-nums text-ink-soft">{count}</span>
                  ) : null}
                </NavLink>
              </li>
            )
          })}
        </ul>
      </div>
    </nav>
  )
}
