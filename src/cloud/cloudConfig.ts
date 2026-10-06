import { invalidateCloudSession } from './sessionScope'

/**
 * 云端连接配置。
 *
 * 优先读构建期环境变量（VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY），
 * 也可以在「设置」里粘贴，保存在本机 localStorage，避免必须重新构建。
 *
 * 支持两种后端，语义完全等价，客户端同步引擎不感知差别：
 *   - supabase   ：托管 PostgreSQL + 邮箱验证码登录
 *   - cloudflare ：自建 Worker + D1 + 访问令牌登录
 */

/**
 * ⚠️ 存储键，不是显示名 —— 改了会丢掉用户已填好的云端配置。
 * 产品名请改 index.html / manifest。
 */
const STORAGE_KEY = 'inspiration-todo/cloud-config'

export type CloudProviderKind = 'supabase' | 'cloudflare'

export interface SupabaseCloudConfig {
  provider: 'supabase'
  url: string
  anonKey: string
}

export interface CloudflareCloudConfig {
  provider: 'cloudflare'
  /** Worker 地址，例如 https://yike-sync.xxx.workers.dev */
  url: string
}

/**
 * 访问令牌不放这里，而是单独存（见 cloudflareSession.ts）。
 *
 * 理由与 Supabase 保持对称：那边也是「连接信息」与「会话」分开存。
 * 合在一起的话，「退出登录」清掉令牌会让配置变成不完整 → 被判为未配置
 * → 直接掉回本机模式，那不是用户期望的行为。
 */
export type CloudConfig = SupabaseCloudConfig | CloudflareCloudConfig

export const CLOUD_PROVIDER_LABEL: Record<CloudProviderKind, string> = {
  supabase: 'Supabase',
  cloudflare: 'Cloudflare（自建）',
}

function normalize(value: string | undefined | null): string {
  return (value ?? '').trim()
}

function fromEnv(): CloudConfig | null {
  const url = normalize(import.meta.env?.VITE_SUPABASE_URL)
  const anonKey = normalize(import.meta.env?.VITE_SUPABASE_ANON_KEY)
  if (url && anonKey) return { provider: 'supabase', url, anonKey }
  return null
}

/**
 * 解析存下来的配置。
 *
 * 关键：**旧的配置里没有 provider 字段**（那时只有 Supabase）。
 * 所以要把它当成 supabase 读，而不是判为无效 ——
 * 否则老用户升级后会发现「云端配置莫名其妙丢了」。
 */
function parseStored(raw: string): CloudConfig | null {
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const provider = parsed.provider === 'cloudflare' ? 'cloudflare' : 'supabase'
  const url = normalize(typeof parsed.url === 'string' ? parsed.url : '')

  if (provider === 'cloudflare') {
    return url === '' ? null : { provider: 'cloudflare', url }
  }

  const anonKey = normalize(typeof parsed.anonKey === 'string' ? parsed.anonKey : '')
  if (url && anonKey) return { provider: 'supabase', url, anonKey }
  return null
}

function fromStorage(): CloudConfig | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return null
    return parseStored(raw)
  } catch {
    return null
  }
}

export function readCloudConfig(): CloudConfig | null {
  return fromStorage() ?? fromEnv()
}

export function readStoredCloudConfig(): CloudConfig | null {
  return fromStorage()
}

export function readEnvCloudConfig(): CloudConfig | null {
  return fromEnv()
}

export function saveCloudConfig(config: CloudConfig | null): void {
  if (JSON.stringify(config) !== JSON.stringify(readCloudConfig())) invalidateCloudSession()
  try {
    if (config === null) {
      globalThis.localStorage?.removeItem(STORAGE_KEY)
      return
    }
    const normalized: CloudConfig =
      config.provider === 'cloudflare'
        ? { provider: 'cloudflare', url: config.url.trim() }
        : { provider: 'supabase', url: config.url.trim(), anonKey: config.anonKey.trim() }

    const complete =
      normalized.provider === 'cloudflare'
        ? normalized.url !== ''
        : normalized.url !== '' && normalized.anonKey !== ''

    if (!complete) {
      globalThis.localStorage?.removeItem(STORAGE_KEY)
      return
    }
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch {
    // 忽略存储异常，不影响本地使用
  }
}

export function isCloudConfigured(): boolean {
  return readCloudConfig() !== null
}

export function cloudProviderOf(config: CloudConfig | null): CloudProviderKind | null {
  return config?.provider ?? null
}
