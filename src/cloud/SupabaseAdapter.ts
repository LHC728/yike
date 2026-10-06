/**
 * Supabase 实现（方案 §27、§32、§40、§41、§54）。
 *
 * - 全部读取都带 user_id 过滤，并且服务端 RLS 再兜一层（§64）
 * - 写入一律走 apply_record_mutation RPC：数据库端原子完成
 *   「检查 version → 应用 mutation → version + 1 → 记录 applied_mutations」
 */
import type { CloudRecord, RecordType } from '../domain/record'
import { clampDeadlineLocalDate, clampParentId, clampProgress, clampRecordType } from '../domain/record'
import type {
  ApplyMutationParams,
  ApplyMutationResult,
  CloudAdapter,
} from './CloudAdapter'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readCloudConfig } from './cloudConfig'
import { SessionChangedError, type SessionScope } from './sessionScope'
import { createSessionSupabaseClient, getSupabaseClient } from './supabaseClient'
import { decodeMutationResponse } from './mutationResponse'
import { decodeCloudRecordList, decodeCloudRecordResponse } from './recordResponse'

const COLUMNS = [
  'id',
  'user_id',
  'type',
  'content',
  'progress',
  'deadline_local_date',
  'parent_id',
  'created_at_utc',
  'created_timezone',
  'created_local_date',
  'updated_at_utc',
  'updated_timezone',
  'completed_at_utc',
  'completed_timezone',
  'deleted_at_utc',
  'version',
  'server_updated_at',
].join(',')

type Row = Record<string, unknown>

function asString(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback
  return String(value)
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  return String(value)
}

function toCloud(row: Row): CloudRecord {
  const type: RecordType = clampRecordType(row.type)
  return {
    id: asString(row.id),
    userId: asString(row.user_id),
    type,
    content: asString(row.content),
    progress: clampProgress(row.progress),
    deadlineLocalDate: clampDeadlineLocalDate(row.deadline_local_date),
    parentId: clampParentId(row.parent_id),
    createdAtUtc: asString(row.created_at_utc),
    createdTimezone: asString(row.created_timezone, 'UTC'),
    createdLocalDate: asString(row.created_local_date),
    updatedAtUtc: asString(row.updated_at_utc),
    updatedTimezone: asString(row.updated_timezone, 'UTC'),
    completedAtUtc: asNullableString(row.completed_at_utc),
    completedTimezone: asNullableString(row.completed_timezone),
    deletedAtUtc: asNullableString(row.deleted_at_utc),
    version: Number(row.version ?? 1),
    serverUpdatedAt: asString(row.server_updated_at),
  }
}

const PAGE_SIZE = 500

export class SupabaseAdapter implements CloudAdapter {
  readonly kind = 'supabase'
  private fixed: { client: SupabaseClient; owner: string; scope: SessionScope } | null

  constructor(fixed: { client: SupabaseClient; owner: string; scope: SessionScope } | null = null) {
    this.fixed = fixed
  }

  async bindSession(userId: string, scope: SessionScope): Promise<CloudAdapter> {
    scope.checkCurrent()
    const config = readCloudConfig()
    const client = getSupabaseClient()
    if (!client || config?.provider !== 'supabase') throw new Error('cloud_not_configured')
    const { data, error } = await client.auth.getSession()
    scope.checkCurrent()
    const session = data.session
    if (error) throw new Error(error.message)
    if (!session || session.user.id !== userId) throw new SessionChangedError()
    const current = readCloudConfig()
    if (current?.provider !== 'supabase' || current.url !== config.url || current.anonKey !== config.anonKey) {
      throw new SessionChangedError()
    }
    const frozen = createSessionSupabaseClient(config, session.access_token, scope)
    return new SupabaseAdapter({ client: frozen, owner: userId, scope })
  }

  isConfigured(): boolean {
    return this.fixed !== null || getSupabaseClient() !== null
  }

  private async client(userId: string): Promise<SupabaseClient> {
    if (this.fixed) {
      this.fixed.scope.checkCurrent()
      if (this.fixed.owner !== userId) throw new SessionChangedError()
      return this.fixed.client
    }
    const controller = new AbortController()
    const bound = await this.bindSession(userId, { checkCurrent: () => undefined, signal: controller.signal })
    if (!(bound instanceof SupabaseAdapter) || !bound.fixed) throw new Error('cloud_not_configured')
    return bound.fixed.client
  }

  private checkResponse(): void {
    this.fixed?.scope.checkCurrent()
  }

  async pullAll(userId: string): Promise<CloudRecord[]> {
    const client = await this.client(userId)
    const result: CloudRecord[] = []

    for (let from = 0; from < 200000; from += PAGE_SIZE) {
      const { data, error } = await client
        .from('records')
        .select(COLUMNS)
        .eq('user_id', userId)
        .order('server_updated_at', { ascending: true })
        .range(from, from + PAGE_SIZE - 1)

      this.checkResponse()
      if (error) throw new Error(error.message)
      const rows = decodeCloudRecordList(data, 'snake', toCloud, userId)
      result.push(...rows)
      if (rows.length < PAGE_SIZE) break
    }

    return result
  }

  async pullOne(userId: string, recordId: string): Promise<CloudRecord | null> {
    const client = await this.client(userId)
    const { data, error } = await client
      .from('records')
      .select(COLUMNS)
      .eq('user_id', userId)
      .eq('id', recordId)
      .maybeSingle()
    this.checkResponse()
    if (error) throw new Error(error.message)
    if (data === null) return null
    return decodeCloudRecordResponse(data, 'snake', toCloud, userId, recordId)
  }

  async applyMutation(userId: string, params: ApplyMutationParams): Promise<ApplyMutationResult> {
    const client = await this.client(userId)
    const { data, error } = await client.rpc('apply_record_mutation', {
      p_mutation_id: params.mutationId,
      p_record_id: params.recordId,
      p_operation: params.operation,
      p_expected_version: params.expectedVersion,
      p_payload: params.payload,
    })

    this.checkResponse()
    if (error) throw new Error(error.message)

    return decodeMutationResponse(data, toCloud, userId, params.recordId, 'snake')
  }

  subscribe(userId: string, onChange: (recordId: string) => void): () => void {
    const client = getSupabaseClient()
    if (!client) return () => undefined

    const channel = client
      .channel(`records:${userId}`)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'postgres_changes' as any,
        {
          event: '*',
          schema: 'public',
          table: 'records',
          filter: `user_id=eq.${userId}`,
        },
        (event: { new?: Row; old?: Row }) => {
          const row = event.new && Object.keys(event.new).length > 0 ? event.new : event.old
          const id = row?.id
          if (id) onChange(String(id))
        },
      )
      .subscribe()

    return () => {
      void client.removeChannel(channel)
    }
  }
}

/** 未配置云端时使用的空实现：一切同步操作静默跳过，本地照常可用 */
export class NullAdapter implements CloudAdapter {
  readonly kind = 'null'

  isConfigured(): boolean {
    return false
  }

  async pullAll(): Promise<CloudRecord[]> {
    return []
  }

  async pullOne(): Promise<CloudRecord | null> {
    return null
  }

  async applyMutation(): Promise<ApplyMutationResult> {
    return { status: 'record_not_found', version: null, record: null }
  }

  subscribe(): () => void {
    return () => undefined
  }
}

export const supabaseAdapter = new SupabaseAdapter()
export const nullAdapter = new NullAdapter()

// 适配器的分发已经移到 cloudProvider.ts ——
// 这里再留一份会变成两个入口，迟早有人改了一处忘了另一处。
