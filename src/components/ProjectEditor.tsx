import { useRef, useState } from 'react'
import { recordActions } from '../hooks/useRecords'
import { useTodayLocalDate } from '../hooks/useToday'
import {
  progressOf,
  snapshotOf,
  type RecordSnapshot,
  PROGRESS_MAX,
  PROGRESS_MIN,
  PROGRESS_STEP,
  type LocalRecord,
} from '../domain/record'
import { deviceTimeZone } from '../utils/time'
import { ProgressTrack, ProjectDeadline } from './ProjectProgress'
import { captureWriteOwner, isWriteOwnerCurrent, recordTarget } from '../app/writeOwner'
import type { RecordWriteTarget } from '../domain/write'
import { toaster } from '../app/toastStore'

/** 快捷档位。拖动滑块调不准的两个极端，用按钮一步到位。 */
const PRESETS = [0, 25, 50, 75] as const

const CHIP = 'tap tap-active h-9 flex-1 rounded-[9px] border text-[12.5px] tabular-nums'

/**
 * 大事的编辑区（详情面板里）。
 *
 * 只有大事才有这一段 —— 灵感和待办没有「做到哪了」这回事。
 *
 * ⚠️ 落库时机是这里最关键的一处设计：
 *   拖一次滑块会触发**几十个** change 事件。跟着 change 写库的话，
 *   一次拖动就是几十个 mutation 打进 outbox、几十次 IndexedDB 事务，
 *   而首页那个大事模块是靠 liveQuery 驱动的，会跟着重渲染几十次。
 *   所以规则是「拖动只改界面，动作结束才落库一次」——
 *   结束的信号是松手（pointerup）、松开按键（keyup）。
 */
const ADJUST_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])

interface DragSession {
  target: RecordWriteTarget
  baseline: RecordSnapshot
  value: number
  dirty: boolean
}

export function ProjectEditor({ userId, record }: { userId: string; record: LocalRecord }) {
  const target = recordTarget(captureWriteOwner(userId), record.id)
  const session = useRef<DragSession | null>(null)
  const [saving, setSaving] = useState(false)
  const committed = progressOf(record)
  const [dragging, setDragging] = useState(false)
  const [dragValue, setDragValue] = useState(committed)
  const today = useTodayLocalDate(deviceTimeZone())

  // 拖动中显示手上的值，其余时候显示落库值。
  //
  // 这样「另一台设备同步过来了新进度」会自动生效 —— 不需要任何 effect
  // 去同步 state，也就不会先渲染一帧旧值、再补一帧新值（滑块会闪）。
  // 顺带还避开了两个 lint 规则：渲染期间不许读 ref、effect 里不许 setState。
  const value = dragging ? dragValue : committed

  function begin(): void {
    if (saving || session.current || !isWriteOwnerCurrent(target)) return
    session.current = { target, baseline: snapshotOf(record), value: committed, dirty: false }
  }

  async function saveProgress(next: number, baseline: RecordSnapshot, owner: RecordWriteTarget): Promise<void> {
    if (saving) return
    setSaving(true)
    try {
      const result = await recordActions.setProgress(owner, next, baseline)
      if (result.status === 'stale' && isWriteOwnerCurrent(owner)) {
        toaster.show({ message: '进度已更新为 ' + progressOf(result.current) + '%，这次调整没有覆盖它。请重新调整。' })
      }
    } finally {
      setSaving(false)
    }
  }

  function finish(): void {
    const active = session.current
    session.current = null
    setDragging(false)
    if (!active?.dirty) return
    void saveProgress(active.value, active.baseline, active.target)
  }

  function cancel(): void {
    session.current = null
    setDragging(false)
  }

  function applyPreset(next: number): void {
    cancel()
    if (next === committed) return
    void saveProgress(next, snapshotOf(record), target)
  }

  const tone = (active: boolean): string =>
    active ? 'border-project/40 bg-project-soft text-project' : 'border-line text-ink-soft'

  return (
    <div className="mt-4 rounded-[12px] border border-line px-3 py-3" data-testid="project-editor">
      <div className="flex items-baseline gap-2">
        <span className="text-[12.5px] text-ink-soft">进度</span>
        <span
          className="text-[17px] font-medium tabular-nums text-project"
          data-testid="project-percent"
        >
          {value}%
        </span>
        {value >= PROGRESS_MAX ? <span className="text-[12px] text-ink-soft">已完成</span> : null}
      </div>

      {/* 滑块叠在只读进度条上：填充色统一由 ProgressTrack 提供，
          滑块自己的轨道是透明的（见 index.css 的 progress-slider）。 */}
      <div className="relative mt-1 h-11">
        <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2">
          <ProgressTrack value={value} instant={dragging} />
        </div>
        <input
          type="range"
          min={PROGRESS_MIN}
          max={PROGRESS_MAX}
          step={PROGRESS_STEP}
          value={value}
          disabled={saving}
          onPointerDown={begin}
          onKeyDown={(event) => { if (ADJUST_KEYS.has(event.key)) begin() }}
          onChange={(event) => {
            begin()
            const active = session.current
            if (!active) return
            active.value = Number(event.target.value)
            // 来回调整后回到开始值也没有新修改，不能用曾触发 change 当作保存依据。
            active.dirty = active.value !== (active.baseline.progress ?? PROGRESS_MIN)
            setDragging(true)
            setDragValue(active.value)
          }}
          onPointerUp={finish}
          onPointerCancel={cancel}
          onKeyUp={(event) => { if (ADJUST_KEYS.has(event.key)) finish() }}
          onBlur={finish}
          aria-label="大事进度"
          data-testid="project-slider"
          className="progress-slider absolute inset-0 h-11 w-full"
        />
      </div>

      <div className="mt-1.5 flex gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            disabled={saving}
            onClick={() => applyPreset(preset)}
            data-testid={`project-preset-${preset}`}
            className={`${CHIP} ${tone(value === preset)}`}
          >
            {preset}%
          </button>
        ))}
        <button
          type="button"
          disabled={saving}
          onClick={() => applyPreset(PROGRESS_MAX)}
          data-testid="project-finish"
          className={`${CHIP} ${tone(value >= PROGRESS_MAX)}`}
        >
          完成
        </button>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <span className="w-[52px] shrink-0 text-[12.5px] text-ink-soft">截止日</span>
        <input
          type="date"
          value={record.deadlineLocalDate ?? ''}
          onChange={(event) => {
            const next = event.target.value
            // 日期框被清空时 value 是 ''，那表示「没有截止日」而不是空字符串
            void recordActions.setDeadline(target, next === '' ? null : next)
          }}
          aria-label="大事截止日"
          data-testid="project-deadline-input"
          className="h-10 min-w-0 flex-1 rounded-[10px] border border-line bg-canvas px-2.5 text-[14px] text-ink outline-none focus:border-project/50"
        />
        {record.deadlineLocalDate === null ? null : (
          <button
            type="button"
            onClick={() => void recordActions.setDeadline(target, null)}
            data-testid="project-deadline-clear"
            className="tap tap-active h-10 shrink-0 rounded-[10px] px-2 text-[12.5px] text-ink-soft"
          >
            清除
          </button>
        )}
      </div>

      {record.deadlineLocalDate === null ? (
        <p className="mt-1.5 pl-[64px] text-[12px] leading-4 text-ink-soft">
          还没设截止日。设一个就能看到倒计时。
        </p>
      ) : (
        <p className="mt-1.5 pl-[64px] text-[12px] leading-4">
          <ProjectDeadline
            deadlineLocalDate={record.deadlineLocalDate}
            today={today}
            withDate={false}
          />
        </p>
      )}
    </div>
  )
}
