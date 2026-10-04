/**
 * 导出功能单元测试。
 *
 * 重点钉三件事：
 * 1. **导出必须是全量**（含软删墓碑）—— 少一条就不是完整备份了。
 * 2. **不带本机同步状态**（syncState / serverVersion）—— 那是设备与服务器的私事。
 * 3. 时间戳原样保留，不做时区换算（换台设备看不会漂）。
 */
import { describe, expect, it } from 'vitest'
import type { LocalRecord } from '../domain/record'
import { buildExportFile, EXPORT_SCHEMA_VERSION, exportFileName } from '../utils/exportRecords'

function makeRecord(overrides: Partial<LocalRecord> = {}): LocalRecord {
  return {
    id: 'r-1',
    userId: 'u-1',
    type: 'idea',
    content: '一条灵感',
    progress: null,
    deadlineLocalDate: null,
    parentId: null,
    createdAtUtc: '2026-10-04T01:00:00.000Z',
    createdTimezone: 'Asia/Shanghai',
    createdLocalDate: '2026-10-04',
    updatedAtUtc: '2026-10-04T01:00:00.000Z',
    updatedTimezone: 'Asia/Shanghai',
    completedAtUtc: null,
    completedTimezone: null,
    deletedAtUtc: null,
    serverVersion: 3,
    syncState: 'synced',
    ...overrides,
  }
}

describe('导出全部记录', () => {
  it('包含每一条记录，包括已软删除的', () => {
    const records = [
      makeRecord({ id: 'a' }),
      makeRecord({ id: 'b', type: 'todo', completedAtUtc: '2026-10-04T02:00:00.000Z' }),
      makeRecord({ id: 'c', deletedAtUtc: '2026-10-04T03:00:00.000Z' }),
    ]

    const file = buildExportFile(records, '2026-10-04T05:00:00.000Z')

    expect(file.count).toBe(3)
    expect(file.records.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    // 墓碑也在：删掉的记录同样是一份完整备份的组成部分
    expect(file.records[2]?.deletedAtUtc).toBe('2026-10-04T03:00:00.000Z')
  })

  it('不导出本机同步状态（那是设备与服务器之间的事）', () => {
    const file = buildExportFile([makeRecord()], '2026-10-04T05:00:00.000Z')
    const exported: Record<string, unknown> = { ...file.records[0] }

    expect(exported).not.toHaveProperty('syncState')
    expect(exported).not.toHaveProperty('serverVersion')
    expect(exported).not.toHaveProperty('userId')
  })

  it('时间戳原样保留，不做时区换算', () => {
    const file = buildExportFile(
      [makeRecord({ createdAtUtc: '2026-10-03T19:18:50.000Z' })],
      '2026-10-04T05:00:00.000Z',
    )

    expect(file.records[0]?.createdAtUtc).toBe('2026-10-03T19:18:50.000Z')
    expect(file.records[0]?.createdTimezone).toBe('Asia/Shanghai')
  })

  it('按类型统计条数', () => {
    const file = buildExportFile(
      [
        makeRecord({ id: '1', type: 'idea' }),
        makeRecord({ id: '2', type: 'idea' }),
        makeRecord({ id: '3', type: 'todo' }),
        makeRecord({ id: '4', type: 'project' }),
        makeRecord({ id: '5', type: 'log', parentId: '4' }),
        makeRecord({ id: '6', type: 'log', parentId: '4' }),
        makeRecord({ id: '7', type: 'log', parentId: '4' }),
      ],
      '2026-10-04T05:00:00.000Z',
    )

    expect(file.breakdown).toEqual({ idea: 2, todo: 1, project: 1, log: 3 })
  })

  it('带上格式版本与导出时刻', () => {
    const file = buildExportFile([], '2026-10-04T05:00:00.000Z')

    expect(file.schemaVersion).toBe(EXPORT_SCHEMA_VERSION)
    expect(file.exportedAtUtc).toBe('2026-10-04T05:00:00.000Z')
    expect(file.count).toBe(0)
    expect(file.records).toEqual([])
  })

  it('空库也能正常导出（不是报错）', () => {
    const file = buildExportFile([], '2026-10-04T05:00:00.000Z')
    expect(file.breakdown).toEqual({ idea: 0, todo: 0, project: 0, log: 0 })
  })

  it('导出的对象里保留大事独有的 progress 与截止日', () => {
    const file = buildExportFile(
      [
        makeRecord({
          type: 'project',
          content: '做完这个项目',
          progress: 60,
          deadlineLocalDate: '2026-10-20',
        }),
      ],
      '2026-10-04T05:00:00.000Z',
    )

    expect(file.records[0]?.progress).toBe(60)
    expect(file.records[0]?.deadlineLocalDate).toBe('2026-10-20')
  })

  it('进展的 parentId 原样保留', () => {
    const file = buildExportFile(
      [makeRecord({ type: 'log', parentId: 'project-9', progress: 40 })],
      '2026-10-04T05:00:00.000Z',
    )

    expect(file.records[0]?.parentId).toBe('project-9')
    // 「没记」和「记了 0%」是两回事，null 必须原样留着
    expect(file.records[0]?.progress).toBe(40)
  })

  it('文件名带本地日期', () => {
    expect(exportFileName('2026-10-04')).toBe('一刻-2026-10-04.json')
  })
})
