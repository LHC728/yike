import type { CloudRecord } from '../domain/record'
import { isValidTimeZone, parseLocalDate } from '../utils/time'

export type RecordFormat = 'camel' | 'snake'

export class InvalidCloudRecordResponseError extends Error {
  constructor() {
    super('cloud_invalid_record_response')
    this.name = 'InvalidCloudRecordResponseError'
  }
}

function invalidResponse(): never {
  throw new InvalidCloudRecordResponseError()
}

function fieldOf(row: Record<string, unknown>, format: RecordFormat, field: keyof CloudRecord, optional = false): unknown {
  const key = format === 'camel' ? field : field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
  if (!Object.prototype.hasOwnProperty.call(row, key)) return optional ? null : invalidResponse()
  return row[key]
}

function validLocalDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const date = parseLocalDate(value)
  return date !== null && date.year > 0
}

function validUtc(value: unknown): value is string {
  if (typeof value !== 'string') return false
  // PostgreSQL 的 JSON 回执使用 +00:00 和微秒；保留原文，不用 Date 截掉精度。
  const match = /^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,6})?(?:Z|\+00:00)$/.exec(value)
  return match !== null && validLocalDate(match[1]) && Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4]) < 60
}

function validTimezone(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && isValidTimeZone(value)
}

/** 先确认原始字段存在，才能归一；否则缺正文会被伪装成空正文、缺父级会变成孤儿。 */
export function validateCloudRecordResponse(value: unknown, format: RecordFormat): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalidResponse()
  const row = value as Record<string, unknown>
  const field = (name: keyof CloudRecord, optional = false) => fieldOf(row, format, name, optional)
  const id = field('id')
  const userId = field('userId')
  if (typeof id !== 'string' || id.trim() === '' || typeof userId !== 'string' || userId.trim() === '') return invalidResponse()
  const version = field('version')
  if ((typeof version !== 'number' && (typeof version !== 'string' || version.trim() === '')) || !Number.isSafeInteger(Number(version)) || Number(version) <= 0) return invalidResponse()
  const type = field('type')
  if (type !== 'idea' && type !== 'todo' && type !== 'project' && type !== 'log') return invalidResponse()
  if (typeof field('content') !== 'string') return invalidResponse()
  if (!validUtc(field('createdAtUtc')) || !validUtc(field('updatedAtUtc')) || !validUtc(field('serverUpdatedAt'))) return invalidResponse()
  if (!validLocalDate(field('createdLocalDate')) || !validTimezone(field('createdTimezone'))) return invalidResponse()
  // 旧数据库允许 updated_timezone 为 NULL，既有适配器会把它归一成 UTC。
  const updatedTimezone = field('updatedTimezone')
  if (updatedTimezone !== null && !validTimezone(updatedTimezone)) return invalidResponse()
  const completedTimezone = field('completedTimezone')
  if (completedTimezone !== null && !validTimezone(completedTimezone)) return invalidResponse()
  for (const name of ['completedAtUtc', 'deletedAtUtc'] as const) {
    const timestamp = field(name)
    if (timestamp !== null && !validUtc(timestamp)) return invalidResponse()
  }

  // 仅旧 idea/todo 协议允许省略新三列；大事/进展必须由具备完整三列的后端返回。
  const legacy = type === 'idea' || type === 'todo'
  const progress = field('progress', legacy)
  const deadline = field('deadlineLocalDate', legacy)
  const parentId = field('parentId', legacy)
  if (progress !== null && (typeof progress !== 'number' || !Number.isInteger(progress) || progress < 0 || progress > 100)) return invalidResponse()
  if (deadline !== null && !validLocalDate(deadline)) return invalidResponse()
  // 显式 null/空串仍沿用 parentId 的历史归一规则；缺键与非法类型才是未知事实。
  if (parentId !== null && typeof parentId !== 'string') return invalidResponse()
  if ((legacy && progress !== null) || (type !== 'project' && deadline !== null) || (type !== 'log' && parentId !== null)) return invalidResponse()
  return row
}

/** 结构合法仍不等于属于当前账号；身份核对必须在数据离开网络边界前完成。 */
export function decodeCloudRecordResponse(
  value: unknown,
  format: RecordFormat,
  toCloud: (row: Record<string, unknown>) => CloudRecord,
  userId: string,
  recordId?: string,
): CloudRecord {
  const record = toCloud(validateCloudRecordResponse(value, format))
  if (record.userId !== userId || (recordId !== undefined && record.id !== recordId)) return invalidResponse()
  return record
}

/** 任何一行失败都使整次拉取失败，不能让部分结果进入对账。 */
export function decodeCloudRecordList(
  value: unknown,
  format: RecordFormat,
  toCloud: (row: Record<string, unknown>) => CloudRecord,
  userId: string,
): CloudRecord[] {
  if (!Array.isArray(value)) return invalidResponse()
  return value.map((row: unknown) => decodeCloudRecordResponse(row, format, toCloud, userId))
}
