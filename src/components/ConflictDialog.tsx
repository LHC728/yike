import { useState } from 'react'
import { recordActions, useConflicts } from '../hooks/useRecords'
import { formatChineseDateTime } from '../utils/time'
import type { RecordSnapshot } from '../domain/record'
import type { ConflictEntry } from '../db/db'
import { Modal } from './Modal'
import { captureWriteOwner, isWriteOwnerCurrent, recordTarget } from '../app/writeOwner'
import { didWrite } from '../domain/write'

interface ConflictDialogProps {
  userId: string | null
}

/**
 * 大事的进度 / 截止日摘要。
 *
 * 冲突弹窗原本只展示正文，而大事的冲突往往**恰恰不在正文上** ——
 * 两台设备各自拖了进度条、改了截止日，正文一个字没动。
 * 不把这两个值摆出来，用户看到的会是两段一模一样的内容，
 * 完全不知道该选哪个。
 */
function projectExtra(snapshot: RecordSnapshot): string | undefined {
  if (snapshot.type !== 'project') return undefined
  const parts: string[] = []
  if (snapshot.progress !== null) parts.push(`进度 ${snapshot.progress}%`)
  if (snapshot.deadlineLocalDate !== null) parts.push(`截止 ${snapshot.deadlineLocalDate}`)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/**
 * 冲突 UI（方案 §50、§52）。
 *
 * 只有真正冲突时才弹，不做 Git diff 界面。
 * 用户完成选择以前，Base / Local / Remote 三个版本一个都不丢（§51）。
 */
export function ConflictDialog({ userId }: ConflictDialogProps) {
  const conflicts = useConflicts(userId)
  const owner = userId ? captureWriteOwner(userId) : null
  const [manual, setManual] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const conflict = conflicts?.[0] as ConflictEntry | undefined
  if (!conflict) return null

  // Remote 会在弹窗打开期间刷新，持久化的 kind 未必还是当前两份快照的删除方向。
  const localDeleted = conflict.local.deletedAtUtc !== null
  const remoteDeleted = conflict.remote.deletedAtUtc !== null
  const isDeleteEdit = localDeleted !== remoteDeleted
  const editChoice = localDeleted ? 'remote' : 'local'
  const deleteChoice = localDeleted ? 'local' : 'remote'
  // 只在冲突真的落在进度 / 截止日上时才多显示一行，避免平时多出噪音
  const touchesProject =
    conflict.fields.includes('progress') || conflict.fields.includes('deadlineLocalDate') ||
    conflict.local.progress !== conflict.remote.progress || conflict.local.deadlineLocalDate !== conflict.remote.deadlineLocalDate

  async function decide(choice: 'local' | 'remote' | 'edited') {
    if (!conflict || !owner || busy) return
    const target = recordTarget(owner, conflict.recordId)
    setBusy(true)
    try {
      const result = await recordActions.resolveConflict(
        target,
        choice,
        conflict.remoteVersion,
        choice === 'edited' ? draft : undefined,
      )
      if (!didWrite(result) || !isWriteOwnerCurrent(target)) return
      setManual(false)
      setDraft('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => {
        // 不允许直接关掉：必须先裁决，否则三个版本会一直挂着
      }}
      title="需要你确认"
      widthClass="md:max-w-xl"
    >
      <p className="text-[14.5px] leading-6 text-ink-soft">
        {isDeleteEdit
          ? (localDeleted
            ? '你在本机删除了这条记录，但另一台设备修改过它。'
            : '这条记录已在另一台设备删除，但你在本机修改过它。')
          : (localDeleted
            ? '两边都已删除这条记录。请选择要保留的版本。'
            : '另一台设备也修改了这条记录。请选择要保留的内容。')}
      </p>

      <div className="mt-4 space-y-3">
        <ConflictVersion
          label={localDeleted ? '本机已删除的版本' : (isDeleteEdit ? '本机修改的内容' : '本机版本')}
          deleted={localDeleted}
          content={conflict.local.content}
          time={formatChineseDateTime(conflict.local.updatedAtUtc, conflict.local.updatedTimezone)}
          tone="local"
          extra={touchesProject ? projectExtra(conflict.local) : undefined}
        />

        <ConflictVersion
          label={remoteDeleted ? '另一设备已删除的版本' : (isDeleteEdit ? '另一设备修改的内容' : '另一设备版本')}
          deleted={remoteDeleted}
          content={conflict.remote.content}
          time={formatChineseDateTime(conflict.remote.updatedAtUtc, conflict.remote.updatedTimezone)}
          tone="remote"
          extra={touchesProject ? projectExtra(conflict.remote) : undefined}
        />
      </div>

      {manual ? (
        <div className="mt-4">
          <label className="text-[12.5px] text-ink-soft" htmlFor="conflict-manual">
            手动编辑后保存
          </label>
          <textarea
            id="conflict-manual"
            value={draft}
            rows={3}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            className="mt-1.5 w-full resize-none rounded-xl border border-line bg-canvas px-3 py-2.5 text-[15px] leading-[1.55] text-ink outline-none focus:border-idea/40"
          />
        </div>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        {isDeleteEdit ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide(editChoice)}
              data-testid="conflict-keep-edit"
              className="tap tap-active h-10 rounded-xl bg-idea px-4 text-[14.5px] font-medium text-on-idea disabled:opacity-50"
            >
              {localDeleted ? '恢复并保留另一设备内容' : '恢复并保留本机内容'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide(deleteChoice)}
              data-testid="conflict-keep-delete"
              className="tap tap-active h-10 rounded-xl border border-line px-4 text-[14.5px] text-ink-soft disabled:opacity-50"
            >
              保留删除
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide('local')}
              data-testid="conflict-keep-local"
              className="tap tap-active h-10 rounded-xl bg-idea px-4 text-[14.5px] font-medium text-on-idea disabled:opacity-50"
            >
              保留本机
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide('remote')}
              data-testid="conflict-keep-remote"
              className="tap tap-active h-10 rounded-xl border border-line px-4 text-[14.5px] text-ink-soft disabled:opacity-50"
            >
              保留另一设备
            </button>
            {manual ? (
              <button
                type="button"
                disabled={busy || draft.trim().length === 0}
                onClick={() => void decide('edited')}
                data-testid="conflict-save-manual"
                className="tap tap-active h-10 rounded-xl border border-line px-4 text-[14.5px] text-ink-soft disabled:opacity-50"
              >
                保存手动内容
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setDraft(conflict.local.content)
                  setManual(true)
                }}
                className="tap tap-active h-10 rounded-xl px-3 text-[14.5px] text-ink-soft"
              >
                手动编辑
              </button>
            )}
          </>
        )}
      </div>

      <p className="mt-4 text-[12.5px] leading-5 text-ink-soft">
        两个版本都仍然保存在本机，在你做出选择之前不会丢失。
        {conflicts && conflicts.length > 1 ? ` 还有 ${conflicts.length - 1} 条待处理。` : ''}
      </p>
    </Modal>
  )
}

function ConflictVersion({
  label,
  deleted,
  content,
  time,
  tone,
  extra,
}: {
  label: string
  deleted: boolean
  content: string
  time: string
  tone: 'local' | 'remote'
  /** 大事的进度 / 截止日摘要，只有真的冲突在这两个字段上时才传 */
  extra?: string | undefined
}) {
  return (
    <div
      className={`rounded-xl border px-3.5 py-3 ${
        tone === 'local' ? 'border-idea/25 bg-idea-soft' : 'border-line bg-canvas'
      }`}
    >
      <div className="text-[12px] text-ink-soft">{label}</div>
      {deleted ? <div className="mt-1 text-[12px] text-ink-soft">已删除这条记录</div> : null}
      <div className="mt-1 whitespace-pre-wrap break-words text-[14.5px] leading-[1.55] text-ink">
        {content || '（空）'}
      </div>
      {extra ? <div className="mt-1.5 text-[13px] text-ink">{extra}</div> : null}
      <div className="mt-1.5 text-[11.5px] text-ink-soft">{time}</div>
    </div>
  )
}
