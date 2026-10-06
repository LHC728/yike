/**
 * Cloudflare 实现（自建 Worker + D1）。
 *
 * 与 SupabaseAdapter 语义完全等价，差异只有两点：
 *   1. 传输：走自建 Worker 的 REST 接口，而不是 supabase-js
 *   2. 实时：Worker 没有 Realtime 通道，subscribe 返回空取消函数
 *      —— 这不影响正确性。Realtime 在本项目里只是「加速器」（§55），
 *      正确性由 Pull → Reconcile → Push → Pull 的同步循环保证。
 */
import type { CloudRecord, RecordType } from '../domain/record'
import { clampDeadlineLocalDate, clampParentId, clampProgress, clampRecordType } from '../domain/record'
import type { ApplyMutationParams, ApplyMutationResult, CloudAdapter } from './CloudAdapter'
import { SessionChangedError, type SessionScope } from './sessionScope'
import { cfRequest, getCloudflareClient, type CloudflareClient } from './cloudflareClient'

type Row = Record<string, unknown>

function asString(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback
  return String(value)
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

/** 网络来的东西一律当作不可信，逐个字段归一后再进领域层 */
function toCloud(row: Row): CloudRecord {
  const type: RecordType = clampRecordType(row.type)
  const version = Number(row.version)
  return {
    id: asString(row.id),
    userId: asString(row.userId),
    type,
    content: asString(row.content),
    progress: clampProgress(row.progress),
    deadlineLocalDate: clampDeadlineLocalDate(row.deadlineLocalDate),
    parentId: clampParentId(row.parentId),
    createdAtUtc: asString(row.createdAtUtc),
    createdTimezone: asString(row.createdTimezone, 'UTC'),
    createdLocalDate: asString(row.createdLocalDate),
    updatedAtUtc: asString(row.updatedAtUtc),
    updatedTimezone: asString(row.updatedTimezone, 'UTC'),
    completedAtUtc: asNullableString(row.completedAtUtc),
    completedTimezone: asNullableString(row.completedTimezone),
    deletedAtUtc: asNullableString(row.deletedAtUtc),
    version: Number.isFinite(version) ? version : 1,
    serverUpdatedAt: asString(row.serverUpdatedAt),
  }
}

export class CloudflareAdapter implements CloudAdapter {
  readonly kind = 'cloudflare'
  private fixed: { client: CloudflareClient; owner: string; scope: SessionScope } | null

  constructor(fixed: { client: CloudflareClient; owner: string; scope: SessionScope } | null = null) {
    this.fixed = fixed
  }

  async bindSession(userId: string, scope: SessionScope): Promise<CloudAdapter> {
    scope.checkCurrent()
    const client = getCloudflareClient()
    if (!client) throw new Error('cloud_not_configured')
    if (client.userId !== userId) throw new SessionChangedError()
    const frozen = { ...client }
    const boundScope: SessionScope = {
      signal: scope.signal,
      checkCurrent: () => {
        scope.checkCurrent()
        const current = getCloudflareClient()
        // 另一个标签页直接改变存储时，本页尚未收到 React 清理，也不能接受旧响应。
        if (current?.url !== frozen.url || current.token !== frozen.token || current.userId !== userId) {
          throw new SessionChangedError()
        }
      },
    }
    return new CloudflareAdapter({ client: frozen, owner: userId, scope: boundScope })
  }

  private requestOptions(userId: string): { client: CloudflareClient; signal?: AbortSignal } {
    if (this.fixed) {
      this.fixed.scope.checkCurrent()
      if (this.fixed.owner !== userId) throw new SessionChangedError()
      return { client: this.fixed.client, signal: this.fixed.scope.signal }
    }
    const client = getCloudflareClient()
    if (!client) throw new Error('cloud_not_configured')
    if (client.userId !== userId) throw new SessionChangedError()
    return { client }
  }

  private checkResponse(): void {
    this.fixed?.scope.checkCurrent()
  }

  isConfigured(): boolean {
    return this.fixed !== null || getCloudflareClient() !== null
  }

  /** 服务端仍从令牌识别身份；客户端账号校验只负责防止混用会话。 */
  async pullAll(userId: string): Promise<CloudRecord[]> {
    const data = await cfRequest<{ records?: Row[] }>('/api/sync/pull', { method: 'POST', ...this.requestOptions(userId) })
    this.checkResponse()
    const rows = data.records ?? []
    return rows.map(toCloud)
  }

  async pullOne(userId: string, recordId: string): Promise<CloudRecord | null> {
    const data = await cfRequest<{ record?: Row | null }>(
      `/api/sync/record?id=${encodeURIComponent(recordId)}`,
      this.requestOptions(userId),
    )
    this.checkResponse()
    return data.record ? toCloud(data.record) : null
  }

  async applyMutation(userId: string, params: ApplyMutationParams): Promise<ApplyMutationResult> {
    const data = await cfRequest<{
      status?: string
      version?: number | string | null
      record?: Row | null
    }>('/api/sync/mutate', {
      ...this.requestOptions(userId),
      method: 'POST',
      body: {
        mutationId: params.mutationId,
        recordId: params.recordId,
        operation: params.operation,
        expectedVersion: params.expectedVersion,
        payload: params.payload,
      },
    })

    this.checkResponse()
    const status =
      data.status === 'already_applied' ||
      data.status === 'version_conflict' ||
      data.status === 'record_not_found'
        ? data.status
        : 'applied'

    return {
      status,
      version:
        data.version === null || data.version === undefined ? null : Number(data.version),
      record: data.record ? toCloud(data.record) : null,
    }
  }

  /**
   * Worker 没有推送通道。同步循环会兜住一致性，这里返回空取消函数即可。
   *
   * 参数按 CloudAdapter 的契约保留（不能省）：省掉之后调用方按接口传参
   * 就会报「Expected 0 arguments」—— 那是个只在类型层面存在的假故障。
   */
  subscribe(_userId: string, _onChange: (recordId: string) => void): () => void {
    return () => undefined
  }
}

export const cloudflareAdapter = new CloudflareAdapter()
