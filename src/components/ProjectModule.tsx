import { useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { recordActions, useLogCounts, useOpenProjects } from '../hooks/useRecords'
import { progressOf, type LocalRecord } from '../domain/record'
import { uiActions } from '../app/uiStore'
import { RecordNode } from './RecordNode'
import { ProgressTrack, ProjectDeadline } from './ProjectProgress'
import { captureWriteOwner, isWriteOwnerCurrent } from '../app/writeOwner'
import { didWrite } from '../domain/write'
import { useIsMounted } from '../hooks/useIsMounted'

interface ProjectModuleProps {
  userId: string
  /**
   * 「今天」由首页统一传入。
   * 不在组件内部各自取当前时间 —— 同一个页面里出现两个不同的
   * 「今天」会算出两个互相矛盾的倒计时，而且极难复现。
   */
  today: string
}

/** 节点宽度（13px）+ 行间距（10px），第二行靠它对齐到内容 */
const INDENT = 'w-[23px]'

/**
 * 首页的「目前在做的大事」模块（独立一栏，插在输入框和时间线之间）。
 *
 * 它回答的问题和时间线完全不同：
 *   时间线 = 「我什么时候记下了什么」（向后看，按日期归档）
 *   这个模块 = 「我现在该先干哪个」（向前看，按紧迫度排序）
 *
 * 所以排序用的是**截止日升序**而不是创建时间 —— 这是它存在的全部意义。
 *
 * 推到 100% 的大事会从这里消失，但**不会丢**：它仍然在下面的时间线里。
 * 想再看到它，点开详情或者去时间线翻。
 */
export function ProjectModule({ userId, today }: ProjectModuleProps) {
  const projects = useOpenProjects(userId)
  const logCounts = useLogCounts(userId)
  const [creating, setCreating] = useState(false)

  return (
    <section className="card-raised mt-3 rounded-[16px] px-3.5 py-3" data-testid="project-module">
      <div className="flex items-center gap-2">
        <h2 className="text-[12.5px] font-medium text-ink">目前在做的大事</h2>
        <span className="text-[11.5px] tabular-nums text-ink-soft">{projects.length} 件</span>
        <span className="h-px flex-1 bg-line" aria-hidden />
        <button
          type="button"
          onClick={() => setCreating((prev) => !prev)}
          aria-label={creating ? '收起新建大事' : '新建大事'}
          aria-expanded={creating}
          data-testid="project-add"
          className="tap tap-active -mr-1.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] text-ink-soft"
        >
          <Plus
            size={16}
            strokeWidth={1.8}
            aria-hidden
            className={`transition-transform duration-150 ${creating ? 'rotate-45' : ''}`}
          />
        </button>
      </div>

      {creating ? <ProjectCreateForm userId={userId} onDone={() => setCreating(false)} /> : null}

      {projects.length === 0 ? (
        creating ? null : (
          <p className="py-5 text-center text-[12.5px] leading-5 text-ink-soft">
            还没有大事。
            <br />
            点右上角的 ＋ 记一件。
          </p>
        )
      ) : (
        <ul className="mt-0.5">
          {projects.map((project) => (
            <li key={project.id}>
              <ProjectRow
                project={project}
                today={today}
                logCount={logCounts.get(project.id) ?? 0}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** 模块里的一件大事：内容 + 进度条 + 倒计时 + 进展条数。点开进详情编辑。 */
function ProjectRow({
  project,
  today,
  logCount,
}: {
  project: LocalRecord
  today: string
  /** 这件大事下有多少条进展（0 时不显示那一行） */
  logCount: number
}) {
  const percent = progressOf(project)

  return (
    <button
      type="button"
      onClick={() => uiActions.openRecord(project.id)}
      data-testid="project-row"
      className="tap tap-active block w-full rounded-[8px] py-2 text-left"
    >
      <span className="flex items-center gap-2.5">
        <RecordNode type="project" />
        <span className="min-w-0 flex-1 truncate text-[15px] leading-[1.45] text-ink">
          {project.content || <span className="text-ink-soft">（空）</span>}
        </span>
      </span>

      <span className="mt-1.5 flex items-center gap-2.5">
        <span className={`${INDENT} shrink-0`} aria-hidden />
        <ProgressTrack
          value={percent}
          className="flex-1"
          label={`${project.content || '大事'} 的进度`}
        />
        <span className="w-[34px] shrink-0 text-right text-[11.5px] tabular-nums text-ink-soft">
          {percent}%
        </span>
      </span>

      {project.deadlineLocalDate === null ? null : (
        <span className="mt-1 flex items-center gap-2.5">
          <span className={`${INDENT} shrink-0`} aria-hidden />
          <span className="text-[11.5px] leading-4">
            <ProjectDeadline deadlineLocalDate={project.deadlineLocalDate} today={today} />
          </span>
        </span>
      )}

      {/* 有进展才显示。0 条时留一行「0 条进展」只会占地方 ——
          它没带来任何信息，而这一屏要尽量塞下更多大事。 */}
      {logCount === 0 ? null : (
        <span className="mt-1 flex items-center gap-2.5">
          <span className={`${INDENT} shrink-0`} aria-hidden />
          <span className="text-[11.5px] leading-4 text-ink-soft" data-testid="project-log-count">
            {logCount} 条进展
          </span>
        </span>
      )}
    </button>
  )
}

/**
 * 新建大事。就地展开，不跳页面。
 *
 * 和首页那个输入框（记为灵感 / 记为待办）刻意分开：那两个是
 * 「三步、零选择」的快车道，而大事天生要多填一个截止日。
 * 把日期选择塞进快车道会拖慢最常用的路径。
 *
 * 截止日**可以留空** —— 先记下来，之后在详情里补也行。
 */
function ProjectCreateForm({ userId, onDone }: { userId: string; onDone: () => void }) {
  const owner = captureWriteOwner(userId)
  const isMounted = useIsMounted()
  const [content, setContent] = useState('')
  const [deadline, setDeadline] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 桌面端自动聚焦（光标在闪就是「在这里打字」的提示）；
  // 手机端不自动聚焦，避免一展开就弹键盘挡住半屏。
  useEffect(() => {
    if (!window.matchMedia('(pointer: fine)').matches) return
    inputRef.current?.focus()
  }, [])

  const canSubmit = content.trim().length > 0 && !busy

  async function submit(): Promise<void> {
    const text = content.trim()
    if (!text || busy) return
    setBusy(true)
    try {
      const result = await recordActions.create(owner, {
        type: 'project',
        content: text,
        // 空字符串表示「没设截止日」，不能存成 ''（那会是个非法日期）
        deadlineLocalDate: deadline === '' ? null : deadline,
      })
      if (didWrite(result) && isWriteOwnerCurrent(owner) && isMounted()) onDone()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2.5 rounded-[12px] bg-sunken px-3 py-2.5" data-testid="project-create">
      <input
        ref={inputRef}
        value={content}
        disabled={busy}
        onChange={(event) => setContent(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void submit()
        }}
        placeholder="在做的大事是什么"
        aria-label="大事内容"
        data-testid="project-create-input"
        // 16px 是刻意保留的：iOS Safari 在字号小于 16px 时会自动放大页面
        className="w-full bg-transparent text-[16px] leading-[1.5] text-ink outline-none placeholder:text-ink-soft"
      />

      <div className="mt-2.5 flex items-center gap-2">
        <input
          type="date"
          value={deadline}
          disabled={busy}
          onChange={(event) => setDeadline(event.target.value)}
          aria-label="截止日，可以留空"
          data-testid="project-create-deadline"
          className="h-10 min-w-0 flex-1 rounded-[10px] border border-line bg-surface px-2.5 text-[14px] text-ink outline-none focus:border-project/50"
        />
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void submit()}
          data-testid="project-create-save"
          className="tap tap-active h-10 shrink-0 rounded-[10px] bg-project px-4 text-[14px] font-medium text-on-project disabled:bg-sunken disabled:text-ink-soft"
        >
          记下来
        </button>
      </div>
    </div>
  )
}
