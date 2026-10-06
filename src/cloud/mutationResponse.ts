import type { CloudRecord } from '../domain/record'
import type { ApplyMutationResult } from './CloudAdapter'
import { InvalidCloudRecordResponseError, validateCloudRecordResponse, type RecordFormat } from './recordResponse'

function invalidResponse(): never {
  throw new Error('cloud_invalid_mutation_response')
}

function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalidResponse()
  return value as Record<string, unknown>
}

function positiveVersion(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return invalidResponse()
  const version = Number(value)
  return Number.isSafeInteger(version) && version > 0 ? version : invalidResponse()
}

/** HTTP 200 不是写入证明；缺少身份、版本或记录的回执不能让唯一草稿出队。 */
export function decodeMutationResponse(
  value: unknown,
  toCloud: (row: Record<string, unknown>) => CloudRecord,
  userId: string,
  recordId: string,
  format: RecordFormat,
): ApplyMutationResult {
  const raw = objectOf(value)
  const status = raw.status
  if (status !== 'applied' && status !== 'already_applied' && status !== 'version_conflict' && status !== 'record_not_found') return invalidResponse()
  if (status === 'record_not_found') {
    if (raw.version !== null || raw.record !== null) return invalidResponse()
    return { status, version: null, record: null }
  }

  const version = positiveVersion(raw.version)
  const row = objectOf(raw.record)
  const recordVersion = positiveVersion(row.version)
  // 幂等回执可以给出较早的已应用版本，而 Record 已被后续合法修改推进。
  if (recordVersion < version || (status === 'version_conflict' && recordVersion !== version)) return invalidResponse()
  try {
    validateCloudRecordResponse(row, format)
  } catch (error) {
    if (error instanceof InvalidCloudRecordResponseError) return invalidResponse()
    throw error
  }
  const record = toCloud(row)
  if (record.id !== recordId || record.userId !== userId) return invalidResponse()
  return { status, version, record }
}
