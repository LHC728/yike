import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { CompletedTodoRow } from '../components/CompletedTodoRow'
import { DateGroup } from '../components/DateGroup'
import { RecordRow } from '../components/RecordRow'
import { toaster, TOAST_NOTICE_MS } from '../app/toastStore'
import { recordActions, useDoneTodos, useOpenTodos } from '../hooks/useRecords'
import { groupByLocalDate, type LocalRecord } from '../domain/record'
import { uiActions } from '../app/uiStore'
import { deviceTimeZone, nowIso } from '../utils/time'
import { captureWriteOwner, isWriteOwnerCurrent, recordTarget } from '../app/writeOwner'
import { didWrite } from '../domain/write'

interface PageProps {
  userId: string
}

/** 完成动画时长（方案 §19：300～600ms） */
const EXIT_MS = 420

/**
 * 待办页（方案 §19、§79）：主要回答「现在还有什么没有做」。
 *
 * 视觉上换成行动清单的语言：左侧大勾选框、行间细分隔线、不画时间轴。
 * 打勾后立即 completed_at = now，播放轻微完成动画，然后从这里消失。
 *
 * 列表底部另有一块默认折叠的「已完成」区 —— 它不是归档（归档归首页时间线管），
 * 而是一块后悔药：打勾这个动作太轻了，手滑一下那条就从列表里没了，
 * 而弹窗提示只有几秒。有了这块，任何时候都能把误打勾的待办退回去。
 */
export function TodosPage({ userId }: PageProps) {
  const owner = captureWriteOwner(userId)
  const timezone = deviceTimeZone()
  const todos = useOpenTodos(userId)
  const done = useDoneTodos(userId)

  const [exiting, setExiting] = useState<LocalRecord[]>([])
  const [showDone, setShowDone] = useState(false)
  const timers = useRef(new Map<string, number>())

  useEffect(() => {
    const map = timers.current
    return () => {
      for (const timer of map.values()) window.clearTimeout(timer)
      map.clear()
    }
  }, [])

  const handleToggle = useCallback(
    (recordId: string) => {
      const record = todos.find((item) => item.id === recordId)
      if (!record) return
      const target = recordTarget(owner, recordId)

      // 立即写库：completed_at = now
      const snapshot: LocalRecord = { ...record, completedAtUtc: nowIso() }
      setExiting((prev) => (prev.some((item) => item.id === recordId) ? prev : [...prev, snapshot]))

      const timer = window.setTimeout(() => {
        setExiting((prev) => prev.filter((item) => item.id !== recordId))
        timers.current.delete(recordId)
      }, EXIT_MS)
      timers.current.set(recordId, timer)

      void recordActions.complete(target).then((result) => {
        if (!isWriteOwnerCurrent(target)) return
        if (!didWrite(result)) {
          const pending = timers.current.get(recordId)
          if (pending) window.clearTimeout(pending)
          timers.current.delete(recordId)
          setExiting((prev) => prev.filter((item) => item.id !== recordId))
          return
        }
        toaster.show({
          message: '已完成',
          actionLabel: '撤销',
          onAction: () => {
            const pending = timers.current.get(recordId)
            if (pending) {
              window.clearTimeout(pending)
              timers.current.delete(recordId)
            }
            setExiting((prev) => prev.filter((item) => item.id !== recordId))
            void recordActions.uncomplete(target)
          },
        })
      })
    },
    [todos, owner],
  )

  /** 从「已完成」区撤销：退回未完成，回到上面的待办列表 */
  const handleUndo = useCallback((recordId: string) => {
    const target = recordTarget(owner, recordId)
    void recordActions.uncomplete(target).then((result) => {
      if (!didWrite(result) || !isWriteOwnerCurrent(target)) return
      toaster.show({ message: '已恢复为待办', duration: TOAST_NOTICE_MS })
    })
  }, [owner])

  const merged = useMemo(() => {
    const exitingIds = new Set(exiting.map((item) => item.id))
    const live = todos.filter((item) => !exitingIds.has(item.id))
    return [...live, ...exiting]
  }, [todos, exiting])

  const groups = useMemo(() => groupByLocalDate(merged), [merged])
  const exitingIds = useMemo(() => new Set(exiting.map((item) => item.id)), [exiting])

  return (
    <div className="mx-auto w-full max-w-[640px] px-4 pb-10">
      <header className="pt-6">
        <h1 className="text-[20px] font-medium leading-[1.2] text-ink">待办</h1>
        <p className="mt-1 text-[12px] text-ink-soft">
          {todos.length === 0 ? '都做完了' : `还有 ${todos.length} 件没做`}
        </p>
      </header>

      <div className="mt-2" data-testid="todos-list">
        {groups.length === 0 ? (
          <p className="py-14 text-center text-[13px] leading-6 text-ink-soft">
            现在没有待办。
            <br />
            想到要做什么，去首页记一条。
          </p>
        ) : (
          groups.map((group) => (
            <DateGroup
              key={group.date}
              date={group.date}
              timezone={timezone}
              count={group.items.length}
            >
              {group.items.map((record) => (
                <RecordRow
                  key={record.id}
                  record={record}
                  showCheckbox
                  onToggle={handleToggle}
                  onOpen={uiActions.openRecord}
                  exiting={exitingIds.has(record.id)}
                />
              ))}
            </DateGroup>
          ))
        )}
      </div>

      {done.length > 0 ? (
        <section className="mt-1" data-testid="completed-tray">
          <button
            type="button"
            onClick={() => setShowDone((prev) => !prev)}
            aria-expanded={showDone}
            data-testid="completed-tray-toggle"
            className="tap tap-active flex min-h-[44px] w-full items-center gap-2 text-left"
          >
            <ChevronRight
              size={14}
              strokeWidth={2}
              aria-hidden
              className={`shrink-0 text-ink-soft transition-transform duration-150 ${
                showDone ? 'rotate-90' : ''
              }`}
            />
            <span className="text-[12px] font-medium text-ink-soft">已完成</span>
            <span className="text-[12px] tabular-nums text-ink-soft">{done.length} 条</span>
            <span className="h-px flex-1 bg-line" aria-hidden />
          </button>

          {showDone ? (
            <div className="animate-fade-in pb-2">
              {done.map((record) => (
                <CompletedTodoRow
                  key={record.id}
                  record={record}
                  onOpen={uiActions.openRecord}
                  onUndo={handleUndo}
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
