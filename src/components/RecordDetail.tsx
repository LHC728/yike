import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { X } from 'lucide-react'
import { db } from '../db/db'
import { recordActions, useRecord } from '../hooks/useRecords'
import { formatChineseDateTime } from '../utils/time'
import { forwardWheelToMain } from '../utils/wheel'
import { toaster } from '../app/toastStore'
import { Modal } from './Modal'
import { ConfirmDialog } from './ConfirmDialog'
import { ProjectEditor } from './ProjectEditor'
import { ProjectLogs } from './ProjectLogs'
import { captureWriteOwner, isWriteOwnerCurrent, recordTarget } from '../app/writeOwner'
import { didWrite } from '../domain/write'
import { useStaleContentEditor } from '../hooks/useStaleContentEditor'
import { StaleEditNotice } from './StaleEditNotice'
import { useIsMounted } from '../hooks/useIsMounted'

interface RecordDetailProps {
  userId: string
  recordId: string | null
  onClose: () => void
}

/**
 * 记录详情（方案 §18、§22、§25）。
 * 只显示：内容、状态、创建时间、（有则）最后编辑、完成时间。
 * 操作只有：编辑、删除、（已完成则）恢复为待办。
 *
 * 手机端是底部抽屉，桌面端是右侧面板 —— 两种外壳共用同一个 Body，
 * 保证行为完全一致，只有外壳不同。
 */
function RecordDetailBody({ userId, recordId, onClose }: { userId: string; recordId: string; onClose: () => void }) {
  const isMounted = useIsMounted()
  const record = useRecord(userId, recordId)
  const target = recordTarget(captureWriteOwner(userId), recordId)
  const conflict = useLiveQuery(async () => {
    const entry = await db.conflicts.get(recordId)
    return entry?.userId === userId ? entry : undefined
  }, [userId, recordId])

  const editor = useStaleContentEditor(record, userId)
  const { editing, draft, saving, setDraft } = editor
  // 删除前先问一句（用户拍板）。删除是 V1 里唯一「一键丢数据」的动作：
  // 打勾能再点回来、编辑能改回去，只有删除是不可逆的（软删但界面上找不回来）。
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  // 切换记录时由调用方通过 key 重新挂载，编辑状态自然复位
  const edited = useMemo(() => {
    if (!record) return false
    return record.updatedAtUtc !== record.createdAtUtc
  }, [record])

  if (!record) {
    return <p className="py-8 text-center text-[13px] text-ink-soft">这条记录已不存在。</p>
  }

  async function handleDelete() {
    if (!record) return
    const result = await recordActions.remove(target)
    if (!didWrite(result) || !isWriteOwnerCurrent(target)) return
    if (isMounted()) onClose()
    // 删除**不再弹撤销**（用户拍板）：删前已经确认过一次了，
    // 删完再拦一次等于同一个动作问两遍。撤销那条留给「打勾」——
    // 那个是一键就能回来的动作，值得给后悔药。
    toaster.show({ message: '已删除' })
  }

  async function handleToggleComplete() {
    if (!record) return
    if (record.completedAtUtc) {
      await recordActions.uncomplete(target)
      return
    }
    const result = await recordActions.complete(target)
    if (!didWrite(result) || !isWriteOwnerCurrent(target)) return
    if (isMounted()) onClose()
    toaster.show({
      message: '已完成',
      actionLabel: '撤销',
      onAction: () => {
        void recordActions.uncomplete(target)
      },
    })
  }

  return (
    <div>
      {editing ? (
        <textarea
          value={draft}
          disabled={saving}
          autoFocus
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          className="w-full resize-none rounded-[12px] border border-line bg-canvas px-3 py-2.5 text-[16px] leading-[1.55] text-ink outline-none focus:border-idea/50"
          data-testid="detail-editor"
        />
      ) : (
        <p
          className="whitespace-pre-wrap break-words text-[17px] leading-[1.6] text-ink"
          data-testid="detail-content"
        >
          {record.content || <span className="text-ink-soft">（空）</span>}
        </p>
      )}

      {editing && editor.stale ? (
        <StaleEditNotice currentContent={editor.stale.content} busy={saving} testId="detail-stale"
          onReload={editor.reload} onKeepDraft={editor.keepDraft} />
      ) : null}
      {editing && editor.message ? <p className="mt-3 text-[13px] text-ink-soft">{editor.message}</p> : null}

      {record.type === 'todo' ? (
        <p className="mt-3 text-[12px] text-ink-soft">
          {record.completedAtUtc ? '已完成' : '未完成'}
        </p>
      ) : null}

      {record.type === 'project' ? (
        <>
          <ProjectEditor userId={userId} record={record} />
          <ProjectLogs userId={userId} project={record} />
        </>
      ) : null}

      <dl className="mt-5 space-y-2 text-[13px] leading-5">
        <div className="flex gap-3">
          <dt className="w-[60px] shrink-0 text-ink-soft">创建于</dt>
          <dd className="text-ink-soft" data-testid="detail-created">
            {formatChineseDateTime(record.createdAtUtc, record.createdTimezone)}
          </dd>
        </div>

        {edited ? (
          <div className="flex gap-3">
            <dt className="w-[60px] shrink-0 text-ink-soft">最后编辑</dt>
            <dd className="text-ink-soft">
              {formatChineseDateTime(record.updatedAtUtc, record.updatedTimezone)}
            </dd>
          </div>
        ) : null}

        {record.completedAtUtc ? (
          <div className="flex gap-3">
            <dt className="w-[60px] shrink-0 text-ink-soft">完成于</dt>
            <dd className="text-ink-soft" data-testid="detail-completed">
              {formatChineseDateTime(record.completedAtUtc, record.completedTimezone)}
            </dd>
          </div>
        ) : null}
      </dl>

      {conflict ? (
        <p className="mt-5 rounded-[12px] bg-idea-soft px-3 py-2 text-[13px] text-idea">
          这条记录存在未裁决的冲突，请先处理冲突提示。
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <button
              type="button"
              disabled={saving}
              onClick={() => void editor.save()}
              data-testid="detail-save"
              className="tap tap-active h-10 rounded-[10px] bg-idea px-4 text-[14px] font-medium text-on-idea disabled:opacity-50"
            >
              保存
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={editor.cancel}
              className="tap tap-active h-10 rounded-[10px] px-3 text-[14px] text-ink-soft"
            >
              取消
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={editor.begin}
              data-testid="detail-edit"
              className="tap tap-active h-10 rounded-[10px] border border-line px-4 text-[14px] text-ink-soft"
            >
              编辑
            </button>

            {record.type === 'todo' && record.completedAtUtc ? (
              <button
                type="button"
                onClick={() => void handleToggleComplete()}
                data-testid="detail-uncomplete"
                className="tap tap-active h-10 rounded-[10px] border border-line px-4 text-[14px] text-ink-soft"
              >
                恢复为待办
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              data-testid="detail-delete"
              className="tap tap-active h-10 rounded-[10px] px-3 text-[14px] text-danger"
            >
              删除
            </button>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        title="删除这条记录？"
        description={
          record.type === 'project'
            ? // 说清「进展不会被连坐删掉」：它们是独立记录，
              // 删了大事之后进展仍在本地（撤销删除还能原样回来），
              // 只是界面上没地方看它们了。
              '它会从所有设备上消失。它的进展记录不会被一起删除，但界面里暂时看不到它们。'
            : '它会从所有设备上消失。'
        }
        confirmLabel="删除"
        tone="danger"
        onConfirm={handleDelete}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  )
}

/** 手机端：底部抽屉 */
export function RecordDetail({ userId, recordId, onClose }: RecordDetailProps) {
  if (!recordId) return <Modal open={false} onClose={onClose} />
  return (
    <Modal open onClose={onClose} widthClass="md:max-w-md">
      <RecordDetailBody userId={userId} recordId={recordId} onClose={onClose} />
    </Modal>
  )
}

/** 桌面端：右侧面板，点开记录不丢失列表上下文 */
export function RecordDetailPanel({ userId, recordId, onClose }: RecordDetailProps) {
  /**
   * 面板自己能滚时优先滚面板（符合「滚轮滚鼠标底下那个东西」的直觉），
   * **只有滚到底或内容装得下**的时候，才把剩下的滚动量交给 main。
   * 不做这个的话，鼠标停在右侧空白处就完全滚不动页面 —— 真实反馈过。
   */
  function handleWheel(event: React.WheelEvent<HTMLElement>) {
    // 真正的滚动容器是里面那个 div，不是 aside 本身
    const el = event.currentTarget.querySelector<HTMLElement>('[data-detail-scroll]')
    if (el) {
      const canScroll = el.scrollHeight > el.clientHeight
      if (canScroll) {
        const atTop = el.scrollTop <= 0 && event.deltaY < 0
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1 && event.deltaY > 0
        // 还在中间，交给自己滚
        if (!atTop && !atBottom) return
      }
    }
    forwardWheelToMain(event)
  }

  return (
    <aside
      className="flex h-full w-[320px] shrink-0 flex-col border-l border-line bg-surface"
      aria-label="记录详情"
      onWheel={handleWheel}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
        <span className="text-[12px] text-ink-soft">详情</span>
        {recordId ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭详情"
            data-testid="detail-close"
            className="tap tap-active -mr-2 flex h-9 w-9 items-center justify-center rounded-[8px] text-ink-faint"
          >
            <X size={16} strokeWidth={1.8} />
          </button>
        ) : null}
      </div>

      {recordId ? (
        <div data-detail-scroll className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <RecordDetailBody userId={userId} recordId={recordId} onClose={onClose} />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6">
          <p className="text-center text-[12px] leading-5 text-ink-soft">
            点一条记录
            <br />
            详情显示在这里
          </p>
        </div>
      )}
    </aside>
  )
}
