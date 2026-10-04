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

/**
 * 触发浏览器下载。
 *
 * `URL.revokeObjectURL` 必须延迟调用：立刻revoke 会让部分浏览器
 * （尤其是移动端 Safari）来不及把 blob 读完，表现为「点了没反应」。
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
