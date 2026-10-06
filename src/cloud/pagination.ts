/**
 * 全量拉取只有两种结果：所有页的完整数组，或抛错。不能把半份结果交给对账。
 * 两套后端共用顺序检查；id 不可变，软删仍留在队列里，不会随更新时间跳页。
 */
type PullRow = Record<string, unknown>

function compareIds(a: string, b: string): number {
  // SQLite BINARY 按 UTF-8 比较；旧 ID 不强制 UUID，不能用依赖语言环境的 localeCompare。
  const encoder = new TextEncoder()
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

function readRow(value: unknown): PullRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid_pull_page_record')
  const row = value as PullRow
  if (typeof row.id !== 'string' || row.id.length === 0) throw new Error('invalid_pull_page_id')
  return row
}

export async function collectRecordPages<T>(
  fetchPage: (afterId: string | null) => Promise<unknown>,
  normalize: (row: PullRow) => T,
): Promise<T[]> {
  const records: T[] = []
  let afterId: string | null = null
  while (true) {
    const value = await fetchPage(afterId)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid_pull_page_response')
    const page = value as PullRow
    if (!Array.isArray(page.records)) throw new Error('invalid_pull_page_records')
    const nextCursor = page.nextCursor
    if (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor.length === 0)) throw new Error('invalid_pull_page_cursor')

    let previous: string = afterId ?? ''
    for (const item of page.records) {
      const row = readRow(item)
      const id = row.id as string
      if (compareIds(id, previous) <= 0) throw new Error('invalid_pull_page_order')
      previous = id
      records.push(normalize(row))
    }
    if (nextCursor === null) return records
    if (page.records.length === 0 || nextCursor !== previous) throw new Error('invalid_pull_page_cursor')
    afterId = nextCursor
  }
}

/** Supabase 不提供 nextCursor；即使返回不足请求数量，也继续读到空页，兼容服务端响应上限。 */
export async function collectKeysetRows<T>(
  fetchRows: (afterId: string | null) => Promise<unknown>,
  normalize: (row: PullRow) => T,
): Promise<T[]> {
  return collectRecordPages(async (afterId) => {
    const rows = await fetchRows(afterId)
    if (!Array.isArray(rows)) throw new Error('invalid_pull_page_records')
    const last = rows.length === 0 ? null : readRow(rows.at(-1))
    return { records: rows, nextCursor: last === null ? null : last.id }
  }, normalize)
}
