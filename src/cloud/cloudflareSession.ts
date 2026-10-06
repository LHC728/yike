import { invalidateCloudSession } from './sessionScope'

/**
 * Cloudflare 会话的本地存储 —— 相当于 Supabase 那边的「会话」。
 *
 * 单独一个键，与 Supabase 的 storageKey 互不影响。
 *
 * 为什么连 userId 一起存：
 *   本项目的核心承诺是「离线正常」。如果每次启动都去问服务器「我是谁」，
 *   那断网时就拿不到 userId，同步引擎会直接停摆 —— 离线可用就成了空话。
 *   所以 userId 随会话一起缓存在本机，启动时立刻可用，
 *   再在后台向服务器确认令牌是否还有效。
 *
 * 关于安全：令牌存在 localStorage，任何能在你浏览器里跑脚本的东西都读得到。
 * 这是所有网页应用的共同限制（浏览器不给网页安全区），
 * 所以对策放在服务端：库里只存 SHA-256、令牌可随时吊销、只授权同步接口。
 */

/** ⚠️ 存储键，不是显示名 */
const SESSION_KEY = 'inspiration-todo/cf-session'

export interface CloudflareSession {
  token: string
  /** 令牌对应的账号 id，由服务器下发后缓存 */
  userId: string
  email: string | null
}

export function readCloudflareSession(): CloudflareSession | null {
  try {
    const raw = globalThis.localStorage?.getItem(SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, unknown>

    const token = typeof parsed.token === 'string' ? parsed.token.trim() : ''
    const userId = typeof parsed.userId === 'string' ? parsed.userId.trim() : ''
    if (token === '' || userId === '') return null

    const email = typeof parsed.email === 'string' && parsed.email !== '' ? parsed.email : null
    return { token, userId, email }
  } catch {
    return null
  }
}

export function saveCloudflareSession(session: CloudflareSession | null): void {
  const previous = readCloudflareSession()
  if (previous?.token !== session?.token || previous?.userId !== session?.userId) {
    invalidateCloudSession()
  }
  try {
    if (session === null) {
      globalThis.localStorage?.removeItem(SESSION_KEY)
      return
    }
    const token = session.token.trim()
    const userId = session.userId.trim()
    if (token === '' || userId === '') {
      globalThis.localStorage?.removeItem(SESSION_KEY)
      return
    }
    globalThis.localStorage?.setItem(
      SESSION_KEY,
      JSON.stringify({ token, userId, email: session.email }),
    )
  } catch {
    // 忽略存储异常，不影响本地使用
  }
}
