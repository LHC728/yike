/**
 * Cloudflare Worker 的 HTTP 客户端。
 * AuthService 与 CloudflareAdapter 共用同一份配置。
 *
 * 每次绑定同步会话时读取最新凭据；一次同步内使用固定副本，避免混用新账号。
 */
import { readCloudConfig } from './cloudConfig'
import { readCloudflareSession } from './cloudflareSession'

export interface CloudflareClient {
  /** 去掉结尾斜杠的 Worker 地址 */
  url: string
  token: string
  /** 登录验证前尚不知道账号，绑定同步会话时必须存在。 */
  userId?: string
}

export function getCloudflareClient(): CloudflareClient | null {
  const config = readCloudConfig()
  if (!config || config.provider !== 'cloudflare') return null
  const session = readCloudflareSession()
  if (session === null) return null
  const url = config.url.replace(/\/+$/, '')
  if (url === '') return null
  return { url, token: session.token, userId: session.userId }
}

export class CloudRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'CloudRequestError'
    this.status = status
  }
}

/**
 * 发起一次带令牌的请求。
 *
 * 非 2xx 一律抛错 —— 绝不把失败伪装成成功。
 * 同步引擎据此保留 outbox 里的 mutation 稍后重试，
 * 这是「数据不丢」的关键：宁可重试，也不能当已应用。
 *
 * client 可显式传入：登录时要用「还没落盘的凭据」先验证一次，
 * 验证通过再写入存储 —— 避免先落盘再回滚，留个坏令牌在本地反复重试。
 */
export async function cfRequest<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; client?: CloudflareClient; signal?: AbortSignal } = {},
): Promise<T> {
  const client = options.client ?? getCloudflareClient()
  if (!client) throw new Error('cloud_not_configured')

  const method = options.method ?? 'GET'
  const response = await fetch(`${client.url}${path}`, {
    method,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${client.token}`,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })

  if (!response.ok) {
    let detail = ''
    try {
      detail = JSON.stringify(await response.json())
    } catch {
      // 响应体不是 JSON（例如网关错误页），忽略即可，状态码已经够用
    }
    throw new CloudRequestError(response.status, `cloud_request_failed ${response.status} ${detail}`)
  }

  return (await response.json()) as T
}
