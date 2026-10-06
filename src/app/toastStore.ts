/**
 * Toast 状态（方案 §21、§60、§69）。
 * 只用于「已完成 / 已删除 + 撤销」这类纠错提示，用户应该几乎注意不到它。
 *
 * 默认 8 秒：撤销入口只有几秒的话，用户「意识到点错了」的时候它已经没了，
 * 等于没有。宁可让它多停一会儿，也不要让人错过。
 */
import { useSyncExternalStore } from 'react'

/** 带撤销按钮的提示默认停留时长 */
export const TOAST_UNDO_MS = 8000
/** 纯确认类提示（不需要用户操作）的停留时长 */
export const TOAST_NOTICE_MS = 2500

/**
 * 一条已入队的 Toast。
 *
 * actionLabel / onAction 写成「必填但可为 undefined」而不是 `?` 可选，
 * 是 exactOptionalPropertyTypes 下的刻意选择：这个对象由 store 自己构造，
 * 字段始终存在，用 `?` 反而会让人以为「有时没有这个 key」。
 */
export interface ToastItem {
  id: string
  message: string
  actionLabel: string | undefined
  onAction: (() => void) | undefined
  duration: number
}

export interface ToastInput {
  message: string
  actionLabel?: string
  onAction?: () => void
  duration?: number
}

class ToastStore {
  private listeners = new Set<() => void>()
  private items: ToastItem[] = []
  private seq = 0

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): ToastItem[] => this.items

  show(input: ToastInput): string {
    this.seq += 1
    const id = `toast-${this.seq}`
    this.items = [
      ...this.items,
      {
        id,
        message: input.message,
        actionLabel: input.actionLabel,
        onAction: input.onAction,
        duration: input.duration ?? TOAST_UNDO_MS,
      },
    ]
    for (const listener of this.listeners) listener()
    return id
  }

  clear(): void {
    if (this.items.length === 0) return
    this.items = []
    for (const listener of this.listeners) listener()
  }

  dismiss(id: string): void {
    const next = this.items.filter((item) => item.id !== id)
    if (next.length === this.items.length) return
    this.items = next
    for (const listener of this.listeners) listener()
  }
}

export const toaster = new ToastStore()

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(toaster.subscribe, toaster.getSnapshot, toaster.getSnapshot)
}
