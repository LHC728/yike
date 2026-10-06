interface StaleEditNoticeProps {
  currentContent: string
  busy: boolean
  testId: string
  onReload: () => void
  onKeepDraft: () => void
}

/** 保留输入框里的草稿，展示这次确认实际要覆盖的版本。 */
export function StaleEditNotice({ currentContent, busy, testId, onReload, onKeepDraft }: StaleEditNoticeProps) {
  return (
    <div className="mt-3 rounded-[12px] border border-line bg-canvas px-3 py-3" data-testid={testId}>
      <p className="text-[13px] leading-5 text-ink-soft">这条记录已经更新。你的草稿仍在输入框里。</p>
      <p className="mt-2 text-[12px] text-ink-soft">当前已保存的内容</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-[15px] leading-[1.5] text-ink" data-testid={`${testId}-current`}>
        {currentContent || '（空）'}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={onReload} data-testid={`${testId}-reload`}
          className="tap tap-active min-h-11 rounded-[10px] border border-line px-3 text-[13px] text-ink-soft disabled:opacity-50">
          载入最新内容
        </button>
        <button type="button" disabled={busy} onClick={onKeepDraft} data-testid={`${testId}-keep`}
          className="tap tap-active min-h-11 rounded-[10px] bg-idea px-3 text-[13px] font-medium text-on-idea disabled:opacity-50">
          确认采用我的草稿
        </button>
      </div>
    </div>
  )
}
