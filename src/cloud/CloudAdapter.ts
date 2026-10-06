/**
 * CloudAdapter —— 业务代码与云服务之间的唯一边界（方案 §27、§28、Phase 8）。
 *
 * 依赖方向：UI → Repository/Domain → IndexedDB → SyncEngine → CloudAdapter → Supabase
 * React 页面绝不直接调用 Supabase。
 */
import type { SessionScope } from './sessionScope'
import type { CloudRecord } from '../domain/record'
import type { Mutation, MutationOperation } from '../domain/mutation'

export interface ApplyMutationParams {
  mutationId: string
  recordId: string
  operation: MutationOperation
  /** create 时为 null */
  expectedVersion: number | null
  payload: Record<string, unknown>
}

export type ApplyMutationStatus =
  | 'applied'
  | 'already_applied'
  | 'version_conflict'
  | 'record_not_found'

export interface ApplyMutationResult {
  status: ApplyMutationStatus
  version: number | null
  record: CloudRecord | null
}

export interface CloudAdapter {
  readonly kind: string
  /** 每轮冻结连接、身份和令牌，SDK 单例的后续登录不能影响本轮请求。 */
  bindSession?(userId: string, scope: SessionScope): Promise<CloudAdapter>
  /** 是否已配置且可用 */
  isConfigured(): boolean
  /** 拉取该用户全部 Record（含软删除 Tombstone，§46） */
  pullAll(userId: string): Promise<CloudRecord[]>
  /** 拉取单条（Realtime 命中后使用） */
  pullOne(userId: string, recordId: string): Promise<CloudRecord | null>
  /** 原子应用一次 Mutation（服务端负责 version 检查与幂等，§40、§41） */
  applyMutation(userId: string, params: ApplyMutationParams): Promise<ApplyMutationResult>
  /** 订阅该用户 Record 变化，返回取消订阅函数。Realtime 只是加速器（§55） */
  subscribe(userId: string, onChange: (recordId: string) => void): () => void
}

export function mutationToParams(mutation: Mutation): ApplyMutationParams {
  return {
    mutationId: mutation.mutationId,
    recordId: mutation.recordId,
    operation: mutation.operation,
    expectedVersion: mutation.baseServerVersion,
    payload: mutation.payload as Record<string, unknown>,
  }
}
