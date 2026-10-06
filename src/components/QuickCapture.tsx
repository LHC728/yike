import { useEffect, useRef, useState } from 'react'
import { recordActions } from '../hooks/useRecords'
import { captureWriteOwner, isWriteOwnerCurrent } from '../app/writeOwner'
import { didWrite } from '../domain/write'

interface QuickCaptureProps {
  userId: string
}

/**
 * 快车道只做两种记录，**刻意不含大事**。
 *
 * 大事要多填一个截止日，塞进来会让最常用的路径（记灵感 / 记待办）
 * 多一个选择。大事有自己的入口 —— 首页那个「目前在做的大事」模块。
 * 类型写窄成 `'idea' | 'todo'` 就是为了让这条边界在类型层面也成立。
 */
type QuickCaptureType = 'idea' | 'todo'

/**
 * QuickCapture（方案 §8）。
 *
 * 用户动作只有三步：打开 → 输入 → 点「灵感」或「待办」。
 * 不输入标题、不选日期、不选分类、不选文件夹、不设优先级、不设截止时间、不再点保存。
 *
 * 这是整个 APP 唯一的写入入口，因此可见性是第一要求：
 * - 卡片有明确边界与阴影，是页面上视觉权重最高的元素；
 * - 占位文字用可读的 ink-soft，不是装饰性的浅灰；
 * - 按钮文案写明「记为灵感 / 记为待办」，直接说明点击后果；
 * - 按钮**形状恒定**，只用颜色表达「还没输入 / 可以点了」，
 *   绝不用整体透明表达禁用态 —— 那会让按钮直接消失在白卡片里。
 */
export function QuickCapture({ userId }: QuickCaptureProps) {
  const owner = captureWriteOwner(userId)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const canSubmit = value.trim().length > 0 && !busy

  // 自动增高，避免在手机键盘弹出时输入区被遮挡
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
    // value 在这里只作为「输入变了，重新量一次高度」的触发器，effect 体内刻意不读它。
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [value])

  // 桌面端自动聚焦：光标在输入框里闪，是最直接的「在这里打字」提示。
  // 手机端不自动聚焦，避免一进来就弹出键盘挡住屏幕。
  useEffect(() => {
    if (!window.matchMedia('(pointer: fine)').matches) return
    textareaRef.current?.focus()
  }, [])

  async function submit(type: QuickCaptureType) {
    const content = value.trim()
    if (!content || busy) return
    setBusy(true)
    try {
      const result = await recordActions.quickCapture(owner, content, type)
      if (didWrite(result) && isWriteOwnerCurrent(owner)) setValue('')
    } finally {
      setBusy(false)
      // 保持焦点，方便连续记录
      textareaRef.current?.focus()
    }
  }

  const buttonBase =
    'tap tap-active flex h-11 flex-1 items-center justify-center gap-1.5 rounded-[10px] border text-[15px] font-medium disabled:cursor-not-allowed'

  return (
    <div className="card-raised rounded-[16px] px-3.5 py-3" data-testid="quick-capture">
      <textarea
        ref={textareaRef}
        value={value}
        rows={1}
        onChange={(event) => setValue(event.target.value)}
        placeholder="想到什么，先写下来"
        aria-label="记录内容"
        data-testid="quick-capture-input"
        // 16px 是刻意保留的：iOS Safari 在字号小于 16px 时会自动放大页面
        className="min-h-[26px] w-full resize-none bg-transparent text-[16px] leading-[1.5] text-ink outline-none placeholder:text-ink-soft"
      />

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void submit('idea')}
          data-testid="quick-capture-idea"
          className={`${buttonBase} border-idea/40 bg-idea-soft text-idea disabled:border-line disabled:bg-sunken disabled:text-ink-soft`}
        >
          <span className="block h-[8px] w-[8px] shrink-0 rounded-full bg-current" aria-hidden />
          记为灵感
        </button>

        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void submit('todo')}
          data-testid="quick-capture-todo"
          className={`${buttonBase} border-todo/40 bg-todo-soft text-todo disabled:border-line disabled:bg-sunken disabled:text-ink-soft`}
        >
          <span
            className="block h-[10px] w-[10px] shrink-0 rounded-[3px] border-[1.5px] border-current"
            aria-hidden
          />
          记为待办
        </button>
      </div>
    </div>
  )
}
