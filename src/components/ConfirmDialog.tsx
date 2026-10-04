import { useState } from 'react'
import { Modal } from './Modal'

interface ConfirmDialogProps {
  open: boolean
  title: string
  /** 说明文字。写清「点了会发生什么」，别只写「确定吗」。 */
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  /** 危险操作用红色实心按钮（删除这类不可逆的动作） */
  tone?: 'danger' | 'normal'
  onConfirm: () => void | Promise<void>
  onCancel: () => void
}

/**
 * 通用确认弹窗（用户拍板：删除前必须先问一句）。
 *
 * 跟 Toast 撤销是**二选一**的策略，不是叠加：
 * 先确认再撤销等于同一个动作拦两次，用户会烦。
 * 删除走「删前确认」，打勾走「删后撤销」—— 前者不可逆、后者一键就回来。
 *
 * 确认按钮在等 `onConfirm` 期间自锁，避免连点两次重复删除。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确定',
  cancelLabel = '取消',
  tone = 'normal',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false)

  if (!open) return null

  async function handleConfirm() {
    if (busy) return
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={busy ? () => {} : onCancel} widthClass="md:max-w-sm">
      <h3 className="text-[15px] font-medium text-ink">{title}</h3>
      {description ? (
        <p className="mt-2 text-[13.5px] leading-[1.6] text-ink-soft">{description}</p>
      ) : null}

      <div className="mt-5 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleConfirm()}
          data-testid="confirm-accept"
          className={`tap tap-active h-10 flex-1 rounded-xl px-4 text-[14.5px] font-medium disabled:opacity-50 ${
            tone === 'danger' ? 'bg-danger text-on-danger' : 'bg-idea text-on-idea'
          }`}
        >
          {busy ? '处理中…' : confirmLabel}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          data-testid="confirm-cancel"
          className="tap tap-active h-10 rounded-xl border border-line px-4 text-[14.5px] text-ink-soft disabled:opacity-50"
        >
          {cancelLabel}
        </button>
      </div>
    </Modal>
  )
}
