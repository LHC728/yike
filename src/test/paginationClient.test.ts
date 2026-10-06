// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectKeysetRows, collectRecordPages } from '../cloud/pagination'

afterEach(() => { vi.restoreAllMocks() })

describe('完整分页收集', () => {
  it('两页全部成功才返回完整数组，并把上一页尾 id 作为下页游标', async () => {
    const fetchPage = vi.fn<(afterId: string | null) => Promise<unknown>>()
      .mockResolvedValueOnce({ records: [{ id: 'a' }, { id: 'b' }], nextCursor: 'b' })
      .mockResolvedValueOnce({ records: [{ id: 'c' }], nextCursor: null })
    expect(await collectRecordPages(fetchPage, (row) => row.id)).toEqual(['a', 'b', 'c'])
    expect(fetchPage.mock.calls).toEqual([[null], ['b']])
  })

  it('第二页断网必须抛错，不返回第一页', async () => {
    const fetchPage = vi.fn<(afterId: string | null) => Promise<unknown>>()
      .mockResolvedValueOnce({ records: [{ id: 'a' }], nextCursor: 'a' })
      .mockRejectedValueOnce(new Error('network_unavailable'))
    await expect(collectRecordPages(fetchPage, (row) => row.id)).rejects.toThrow('network_unavailable')
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it.each([
    null, [], {}, { records: [] }, { records: null, nextCursor: null },
    { records: [], nextCursor: '' }, { records: [], nextCursor: 'a' },
    { records: [{ id: 'a' }], nextCursor: 7 }, { records: [{ id: 'a' }], nextCursor: 'b' },
    { records: [{ id: 'a' }, { id: 'a' }], nextCursor: null },
    { records: [{ id: 'b' }, { id: 'a' }], nextCursor: null },
    { records: [{ id: '' }], nextCursor: null }, { records: [null], nextCursor: null },
  ])('错误或旧版非分页响应 %j 必须失败，不能伪装完成', async (response) => {
    await expect(collectRecordPages(async () => response, (row) => row.id)).rejects.toThrow('invalid_pull_page')
  })

  it.each(['a', '0'])('下页重复或倒退到 %s 必须失败，不能死循环', async (id) => {
    const fetchPage = vi.fn<(afterId: string | null) => Promise<unknown>>()
      .mockResolvedValueOnce({ records: [{ id: 'a' }], nextCursor: 'a' })
      .mockResolvedValueOnce({ records: [{ id }], nextCursor: id })
    await expect(collectRecordPages(fetchPage, (row) => row.id)).rejects.toThrow('invalid_pull_page_order')
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('历史非 ASCII id 按 SQLite UTF-8 顺序验证，不依赖语言环境', async () => {
    // UTF-16 会把补充平面字符放在私用区前面；SQLite UTF-8 的顺序恰好相反。
    const ids = ['旧-id', '\ue000', '\u{10000}']
    const rows = await collectRecordPages(async () => ({ records: ids.map((id) => ({ id })), nextCursor: null }), (row) => row.id)
    expect(rows).toEqual(ids)
  })
})

describe('Supabase keyset 空页终止', () => {
  it('服务端每页上限小于请求数量时，仍继续读到空页', async () => {
    const fetchRows = vi.fn<(afterId: string | null) => Promise<unknown>>()
      .mockResolvedValueOnce([{ id: 'a' }])
      .mockResolvedValueOnce([{ id: 'b' }])
      .mockResolvedValueOnce([])
    expect(await collectKeysetRows(fetchRows, (row) => row.id)).toEqual(['a', 'b'])
    expect(fetchRows.mock.calls).toEqual([[null], ['a'], ['b']])
  })

  it('后续页错误或 null 必须抛错，不能返回已读部分', async () => {
    const fetchRows = vi.fn<(afterId: string | null) => Promise<unknown>>()
      .mockResolvedValueOnce([{ id: 'a' }])
      .mockResolvedValueOnce(null)
    await expect(collectKeysetRows(fetchRows, (row) => row.id)).rejects.toThrow('invalid_pull_page_records')
  })
})
