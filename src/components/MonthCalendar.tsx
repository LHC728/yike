import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  daysInMonth,
  formatMonthTitle,
  monthGrid,
  type MonthInfo,
} from '../utils/time'

interface MonthCalendarProps {
  info: MonthInfo
  selectedDate: string | null
  /** 有记录的日期 */
  markedDates: Set<string>
  /** 与归档列表共用父组件的午夜更新，不能在子组件另外取一次今天。 */
  today: string
  onSelect: (date: string) => void
  onShiftMonth: (delta: number) => void
  onToday: () => void
}

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

/**
 * 月历（方案 §23）。
 *
 * 极简：有记录的日子只显示一个 4px 圆点。
 * 不做热力图、不做统计、不做数量大数字。
 *
 * 三种状态互相区分得很清楚：
 *   今天   = 数字用赭石色
 *   选中   = 26px 赭石实心圆 + 白字
 *   有记录 = 下方一个赭石圆点
 */
export function MonthCalendar({
  info,
  selectedDate,
  markedDates,
  today,
  onSelect,
  onShiftMonth,
  onToday,
}: MonthCalendarProps) {
  const cells = monthGrid(info)

  return (
    <div className="card-raised rounded-[16px] px-2 py-3" data-testid="month-calendar">
      <div className="mb-2 flex items-center justify-between px-2">
        <button
          type="button"
          aria-label="上个月"
          onClick={() => onShiftMonth(-1)}
          className="tap tap-active flex h-9 w-9 items-center justify-center rounded-[8px] text-ink-soft"
        >
          <ChevronLeft size={18} strokeWidth={1.8} />
        </button>

        <button
          type="button"
          onClick={onToday}
          className="tap tap-active rounded-[8px] px-3 py-1 text-[13px] font-medium text-ink"
        >
          {formatMonthTitle(info)}
        </button>

        <button
          type="button"
          aria-label="下个月"
          onClick={() => onShiftMonth(1)}
          className="tap tap-active flex h-9 w-9 items-center justify-center rounded-[8px] text-ink-soft"
        >
          <ChevronRight size={18} strokeWidth={1.8} />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-y-0.5">
        {WEEKDAYS.map((label) => (
          <div key={label} className="pb-1 text-center text-[11px] text-ink-soft">
            {label}
          </div>
        ))}

        {cells.map((date, index) => {
          // 空位格子没有身份可言 —— 位置就是它的身份，这里用 index 是刻意的。
          // oxlint-disable-next-line react/no-array-index-key
          if (!date) return <div key={`empty-${index}`} className="h-10" />

          const day = Number(date.split('-')[2])
          const marked = markedDates.has(date)
          const selected = date === selectedDate
          const isToday = date === today

          return (
            <button
              key={date}
              type="button"
              onClick={() => onSelect(date)}
              aria-current={isToday ? 'date' : undefined}
              data-date={date}
              data-testid={`calendar-day-${date}`}
              className="tap tap-active relative mx-auto flex h-11 w-11 items-center justify-center"
            >
              <span
                className={`flex h-[26px] w-[26px] items-center justify-center rounded-full text-[13px] ${
                  selected
                    ? 'bg-idea font-medium text-on-idea'
                    : isToday
                      ? 'font-medium text-idea'
                      : 'text-ink-soft'
                }`}
              >
                {day}
              </span>
              <span
                className={`absolute bottom-[1px] h-[4px] w-[4px] rounded-full ${
                  marked ? (selected ? 'bg-idea' : 'bg-idea/60') : 'bg-transparent'
                }`}
                aria-hidden
              />
            </button>
          )
        })}
      </div>

      <div className="sr-only">当月共 {daysInMonth(info.year, info.month)} 天</div>
    </div>
  )
}
