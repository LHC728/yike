import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { recordActions, useLogsWithDeleted } from '../hooks/useRecords'
import { useTodayLocalDate } from '../hooks/useToday'
import { progressOf, type LocalRecord } from '../domain/record'
import { deviceTimeZone, formatRelativeStamp } from '../utils/time'
import { toaster, TOAST_NOTICE_MS } from '../app/toastStore'
import { captureWriteOwner, isWriteOwnerCurrent, recordTarget } from '../app/writeOwner'
import { didWrite } from '../domain/write'
import { useStaleContentEditor } from '../hooks/useStaleContentEditor'
import { StaleEditNotice } from './StaleEditNotice'

/**
 * 大事详情里的「进展记录」。
 *
 * 回答的是进度条回答不了的问题：**具体做到哪一步了**。
 * 进度条说「60%」，这里说「60% · 限位搞定了，卡在电机异响」——
 * 过两周回头看，只有后者能让你想起当时的状态。
 *
 * 三条已定的设计：
 *   1. 最新在最上 —— 打开详情第一眼要看到「现在到哪了」
 *   2. 能改能删 —— 删错了有常驻撤销（和打勾、删除同一条规矩）
 *   3. 每条顺手记下当时的进度 —— 显示成「50% · 限位搞定了」
 *
 * 进展是 Record(type = 'log')，**不会出现在首页时间线 / 日历 / 搜索**里，
 * 只在这个面板里看得到。
 */
export function ProjectLogs({ userId, project }: { userId: string; project: LocalRecord }) {
  const target = recordTarget(captureWriteOwner(userId), project.id)
  const allLogs = useLogsWithDeleted(userId, project.id)
  const [editingIds, setEditingIds] = useState<Set<string>>(() => new Set())
  const logs = allLogs.filter((log) => log.deletedAtUtc === null || editingIds.has(log.id))
  // 软删时正在编辑的原行必须继续挂载；取消后再移到恢复区，不能复制一份行抢走草稿。
  const deletedLogs = allLogs.filter((log) => log.deletedAtUtc !== null && !editingIds.has(log.id))
  const [showDeleted, setShowDeleted] = useState(false)
  const activeCount = allLogs.filter((log) => log.deletedAtUtc === null).length
  const onEditingChange = (id: string, editing: boolean): void => {
    setEditingIds((previous) => {
      const next = new Set(previous)
      if (editing) next.add(id)
      else next.delete(id)
      return next
    })
  }
  const today = useTodayLocalDate(deviceTimeZone())

  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  // 新进展记的是**当前**进度快照。项目进度恒有值（新建时就是 0），
  // 所以这里不需要判空。
  const currentPercent = progressOf(project)
  const canSubmit = draft.trim().length > 0 && !busy

  async function submit(): Promise<void> {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      const result = await recordActions.createLog(target, text, currentPercent)
      if (didWrite(result) && isWriteOwnerCurrent(target)) setDraft('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 rounded-[12px] border border-line px-3 py-3" data-testid="project-logs">
      <div className="flex items-baseline gap-2">
        <span className="text-[12.5px] text-ink-soft">进展记录</span>
        <span className="text-[12px] tabular-nums text-ink-soft" data-testid="project-logs-count">
          {activeCount} 条
        </span>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <input
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
          placeholder="写到哪一步了？"
          aria-label="进展内容"
          data-testid="project-log-input"
          // 16px 是刻意保留的：iOS Safari 在字号小于 16px 时会自动放大页面
          className="h-10 min-w-0 flex-1 rounded-[10px] border border-line bg-canvas px-2.5 text-[16px] text-ink outline-none placeholder:text-ink-soft focus:border-project/50"
        />
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void submit()}
          data-testid="project-log-save"
          className="tap tap-active h-10 shrink-0 rounded-[10px] bg-project px-4 text-[14px] font-medium text-on-project disabled:bg-sunken disabled:text-ink-soft"
        >
          记下来
        </button>
      </div>

      <p className="mt-1.5 text-[11.5px] leading-4 text-ink-soft">
        会顺手记下当前进度 {currentPercent}%
      </p>

      {logs.length === 0 ? (
        <p className="py-4 text-center text-[12px] leading-5 text-ink-soft" data-testid="project-logs-empty">
          还没有进展。
          <br />
          写下「做到哪一步了」，回头看就知道当时卡在哪。
        </p>
      ) : (
        <ul className="mt-3">
          {logs.map((log) => (
            <li key={log.id}>
              <LogRow userId={userId} log={log} today={today} onEditingChange={onEditingChange} />
            </li>
          ))}
        </ul>
      )}

      {deletedLogs.length > 0 ? (
        <section className="mt-2 border-t border-line" data-testid="deleted-logs-tray">
          <button
            type="button"
            onClick={() => setShowDeleted((previous) => !previous)}
            aria-expanded={showDeleted}
            data-testid="deleted-logs-toggle"
            className="tap tap-active flex min-h-[44px] w-full items-center gap-2 text-left"
          >
            <ChevronRight size={14} strokeWidth={2} aria-hidden
              className={`shrink-0 text-ink-soft transition-transform duration-150 ${showDeleted ? 'rotate-90' : ''}`} />
            <span className="text-[12px] font-medium text-ink-soft">已删除进展</span>
            <span className="text-[12px] tabular-nums text-ink-soft">{deletedLogs.length} 条</span>
          </button>
          {showDeleted ? (
            <ul className="pb-1">
              {deletedLogs.map((log) => (
                <li key={log.id}>
                  <DeletedLogRow userId={userId} log={log} today={today} />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

/** Toast 只是快捷入口；持久化的软删行让用户晚些发现误删、刷新后仍能找回同一条。 */
function DeletedLogRow({ userId, log, today }: { userId: string; log: LocalRecord; today: string }) {
  const target = recordTarget(captureWriteOwner(userId), log.id)
  const [restoring, setRestoring] = useState(false)

  async function restore(): Promise<void> {
    if (restoring) return
    setRestoring(true)
    try {
      const result = await recordActions.restore(target)
      if (didWrite(result) && isWriteOwnerCurrent(target)) {
        toaster.show({ message: '已恢复这条进展', duration: TOAST_NOTICE_MS })
      }
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="flex items-start gap-2 rounded-[10px] px-2 py-2" data-record-id={log.id} data-testid="deleted-log-row">
      <div className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          {log.progress === null ? null : (
            <span className="shrink-0 text-[12px] tabular-nums text-project">{log.progress}%</span>
          )}
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[15px] leading-[1.5] text-ink-soft">
            {log.content || '（空）'}
          </span>
        </span>
        <span className="mt-0.5 block text-[12px] leading-4 text-ink-soft" data-testid="deleted-log-stamp">
          {formatRelativeStamp(log.createdAtUtc, today, log.createdTimezone)}
        </span>
      </div>
      <button
        type="button"
        disabled={restoring}
        onClick={() => void restore()}
        aria-label={`恢复进展：${log.content}`}
        data-testid="deleted-log-restore"
        className="tap tap-active min-h-[44px] min-w-[64px] shrink-0 rounded-[8px] border border-line px-2.5 text-[13px] font-medium text-project disabled:opacity-50"
      >
        恢复
      </button>
    </div>
  )
}

/**
 * 一条进展。点一下就地变成编辑框（和详情正文同一套交互），
 * 编辑框里有删除 —— 删除按钮只在编辑态出现，避免在手机上
 * 让一行里挤两个可点区域、误触到删。
 */
function LogRow({ userId, log, today, onEditingChange }: { userId: string; log: LocalRecord; today: string; onEditingChange: (id: string, editing: boolean) => void }) {
  const target = recordTarget(captureWriteOwner(userId), log.id)
  const editor = useStaleContentEditor(log, userId, (editing) => onEditingChange(log.id, editing))
  const { editing, draft, saving, setDraft } = editor

  // 进度是「写下这条时的快照」，可能没有（老数据 / 未记录）
  const percent = log.progress
  const stamp = formatRelativeStamp(log.createdAtUtc, today, log.createdTimezone)

  async function remove(): Promise<void> {
    const result = await recordActions.remove(target)
    if (!didWrite(result) || !isWriteOwnerCurrent(target)) return
    editor.cancel()
    toaster.show({
      message: '已删除这条进展',
      actionLabel: '撤销',
      onAction: () => {
        void recordActions.restore(target)
      },
    })
  }

  if (editing) {
    return (
      <div className="rounded-[10px] bg-sunken px-2.5 py-2" data-testid="project-log-editor">
        <textarea
          value={draft}
          disabled={saving}
          autoFocus
          rows={2}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="进展内容"
          data-testid="project-log-editor-input"
          className="w-full resize-none rounded-[8px] border border-line bg-canvas px-2.5 py-2 text-[15px] leading-[1.5] text-ink outline-none focus:border-project/50"
        />
        {editor.stale ? (
          <StaleEditNotice currentContent={editor.stale.content} busy={saving} testId="project-log-stale"
            onReload={editor.reload} onKeepDraft={editor.keepDraft} />
        ) : null}
        {editor.message ? <p className="mt-3 text-[13px] text-ink-soft">{editor.message}</p> : null}
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={() => void editor.save()}
            data-testid="project-log-editor-save"
            className="tap tap-active h-9 rounded-[9px] bg-project px-3.5 text-[13px] font-medium text-on-project disabled:opacity-50"
          >
            保存
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={editor.cancel}
            data-testid="project-log-editor-cancel"
            className="tap tap-active h-9 rounded-[9px] px-3 text-[13px] text-ink-soft"
          >
            取消
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void remove()}
            data-testid="project-log-delete"
            className="tap tap-active ml-auto h-9 rounded-[9px] px-3 text-[13px] text-danger"
          >
            删除
          </button>
        </div>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={editor.begin}
      data-testid="project-log-row"
      className="tap tap-active block w-full rounded-[10px] px-2 py-2 text-left"
    >
      <span className="flex items-baseline gap-2">
        {percent === null ? null : (
          <span className="shrink-0 text-[11.5px] tabular-nums text-project">{percent}%</span>
        )}
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[14px] leading-[1.5] text-ink">
          {log.content || <span className="text-ink-soft">（空）</span>}
        </span>
      </span>
      <span className="mt-0.5 block text-[11.5px] leading-4 text-ink-soft" data-testid="project-log-stamp">
        {stamp}
      </span>
    </button>
  )
}
