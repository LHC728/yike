import type { LocalRecord, RecordType } from '../domain/record'

/**
 * 导出全部记录为 JSON。
 *
 * 这是**用户自己手里的备份**，不是同步格式 —— 所以：
 * - 导出**全部**（含已删除的墓碑），不做过滤。用户要的是「一份完整底稿」，
 *   而不是「界面上现在能看到的那些」；软删的记录也在库里，漏掉就不是完整备份了。
 * - 带上 `schemaVersion`，将来字段变了能靠它判断这份文件是哪一代的。
 * - 只导出业务字段，**不带 syncState / serverVersion** —— 那些是「这台设备
 *   和服务器之间的事情」，换台机器导入没有意义，留着反而会误导。
 *
 * 时间戳都原样保留 UTC 字符串（ISO 8601），不做时区换算：
 * 换台设备当地时间不同，导出时换一次就等于把原始时刻弄脏了。
 */

/** 导出文件的格式版本。加字段不用改它，只有「老版本读不了新文件」时才 +1。 */
export const EXPORT_SCHEMA_VERSION = 1

export interface ExportFile {
  schemaVersion: number
  exportedAtUtc: string
  /** 这次导出共多少条（含已删除） */
  count: number
  /** 按类型分组的条数，方便一眼看出内容构成 */
  breakdown: Record<RecordType, number>
  records: ExportRecord[]
}

/** 单条记录的导出形态：去掉本机同步状态 */
export interface ExportRecord {
  id: string
  type: RecordType
  content: string
  progress: number | null
  deadlineLocalDate: string | null
  parentId: string | null
  createdAtUtc: string
  createdTimezone: string
  createdLocalDate: string
  updatedAtUtc: string
  updatedTimezone: string
  completedAtUtc: string | null
  completedTimezone: string | null
  deletedAtUtc: string | null
}

const ALL_TYPES: ReadonlySet<RecordType> = new Set(['idea', 'todo', 'project', 'log'])

function toExportRecord(record: LocalRecord): ExportRecord {
  return {
    id: record.id,
    type: record.type,
    content: record.content,
    progress: record.progress,
    deadlineLocalDate: record.deadlineLocalDate,
    parentId: record.parentId,
    createdAtUtc: record.createdAtUtc,
    createdTimezone: record.createdTimezone,
    createdLocalDate: record.createdLocalDate,
    updatedAtUtc: record.updatedAtUtc,
    updatedTimezone: record.updatedTimezone,
    completedAtUtc: record.completedAtUtc,
    completedTimezone: record.completedTimezone,
    deletedAtUtc: record.deletedAtUtc,
  }
}

export function buildExportFile(records: readonly LocalRecord[], nowUtc: string): ExportFile {
  const breakdown: Record<RecordType, number> = { idea: 0, todo: 0, project: 0, log: 0 }
  for (const record of records) {
    // 类型来自数据库，理论上一定是这四种；真遇到脏数据也别让它把整次导出搞崩
    if (ALL_TYPES.has(record.type)) breakdown[record.type] += 1
  }

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAtUtc: nowUtc,
    count: records.length,
    breakdown,
    records: records.map(toExportRecord),
  }
}

/** 导出文件的文件名：`一刻-2026-10-04.json`（用本地日期，用户一眼能对上） */
export function exportFileName(localDate: string): string {
  return `一刻-${localDate}.json`
}

/** 导出失败时抛这个，调用方好区分「能不能导出」与「导出炸了」 */
export class ExportUnsupportedError extends Error {
  constructor() {
    super('当前环境不支持导出文件')
    this.name = 'ExportUnsupportedError'
  }
}

/**
 * 触发浏览器下载。
 *
 * `URL.revokeObjectURL` 必须延迟调用：立刻 revoke 会让部分浏览器
 * （尤其是移动端 Safari）来不及把 blob 读完，表现为「点了没反应」。
 *
 * ⚠️ **不要用 `'download' in document.createElement('a')` 判断支持性** ——
 * 所有现代浏览器都有这个属性，包括**不支持下载的 iOS Safari**。
 * 这个属性判断恒为真，等于没判。要判就判用户是不是触摸设备（见下）。
 */
export function downloadJson(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * 这台设备点「下载链接」会不会真的把文件存下来。
 *
 * iOS / iPadOS 的 Safari 与所有 iOS 浏览器（内核必须是 WebKit）**不支持
 * `<a download>`** —— 点了会当普通链接打开，要么弹出一个空白页，要么什么都不发生。
 * 而 `'download' in a` 那种属性检测**在 iOS 上也是 true**，检测不出来，
 * 只能按「是不是触摸设备」来判断。
 *
 * 台式机触摸屏（Windows 的触屏本）会被误判成手机 —— 代价只是多出一个
 * 「复制 JSON」按钮，点错了也没损失，比「点下载没反应」好得多。
 */
export function canDownloadFile(): boolean {
  if (typeof window === 'undefined') return false
  return !window.matchMedia('(pointer: coarse)').matches
}

/** 复制到剪贴板。返回是否成功 —— 失败时调用方要给出「手动长按复制」的退路。 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // 优先用 Clipboard API；它在 https 与 localhost 下可用，
  // 但在某些内嵌浏览器里会直接抛错，所以失败了要继续试老办法。
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 落到下面的兜底
    }
  }

  // 兜底：老式的「临时 textarea + document.execCommand('copy')」。
  // execCommand 已被标记废弃，但它是唯一在不支持 Clipboard API 的环境里
  // 还能用的办法，移动端尤其需要。所以这里就地关掉那条 deprecated 的告警。
  try {
    const area = document.createElement('textarea')
    area.value = text
    // 必须留在视口里（只是移出屏幕外也会导致 iOS 选不中），
    // 用透明 + 不可见来藏，而不是挪到 -9999px。
    area.style.position = 'fixed'
    area.style.top = '0'
    area.style.left = '0'
    area.style.opacity = '0'
    area.setAttribute('readonly', '')
    document.body.appendChild(area)
    area.select()
    area.setSelectionRange(0, text.length)
    // oxlint-disable-next-line @typescript-eslint/no-deprecated
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}
