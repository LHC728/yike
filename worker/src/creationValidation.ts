type CreationField = 'createdAtUtc' | 'createdTimezone' | 'createdLocalDate'

export class CreationValidationError extends Error {
  readonly field: CreationField

  constructor(field: CreationField) {
    super(`invalid_creation_field:${field}`)
    this.name = 'CreationValidationError'
    this.field = field
  }
}

export interface CreationFields {
  createdAtUtc: string
  createdTimezone: string
  createdLocalDate: string
}

export function isValidCreationDate(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false
  const leap = year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0)
  const max = month === 2 ? leap ? 29 : 28 : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  return max !== undefined && day <= max
}

/** 不让 Date.parse 的宽松纠正把 2 月 30 日变成另一条创建事实。 */
export function isValidCreationUtc(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,6})?(?:Z|\+00:00)$/.exec(value)
  if (!match || !isValidCreationDate(match[1])) return false
  return Number(match[2]) <= 23 && Number(match[3]) <= 59 && Number(match[4]) <= 59
}

export function isValidCreationTimezone(value: unknown): value is string {
  if (typeof value !== 'string') return false
  // UTC/GMT 与 IANA 别名都保留；EST/UTC+8 等模糊缩写和 POSIX/right 扩展不属于本协议。
  if (!/^(?:UTC|GMT|[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/i.test(value) || /^(?:posix|right)\//i.test(value)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0)
    return true
  } catch {
    return false
  }
}

/** null 与缺字段沿用旧 coalesce 协议；非法提供值不能被服务器此刻偷偷替换。 */
function providedField(
  payload: Record<string, unknown>,
  field: CreationField,
  fallback: string,
  validate: (value: unknown) => value is string,
): string {
  if (!Object.prototype.hasOwnProperty.call(payload, field) || payload[field] === null) return fallback
  const value = payload[field]
  if (!validate(value)) throw new CreationValidationError(field)
  return value
}

export function validatedCreationFields(payload: Record<string, unknown>, now: string): CreationFields {
  return {
    createdAtUtc: providedField(payload, 'createdAtUtc', now, isValidCreationUtc),
    createdTimezone: providedField(payload, 'createdTimezone', 'UTC', isValidCreationTimezone),
    createdLocalDate: providedField(payload, 'createdLocalDate', now.slice(0, 10), isValidCreationDate),
  }
}
