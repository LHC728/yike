/**
 * 一刻 — Cloudflare Worker 入口（HTTP 层）。
 *
 * 只做三件事：CORS、鉴权、路由。所有业务逻辑都在 core.ts。
 *
 * 接口契约（与客户端 CloudAdapter 一一对应）：
 *   GET  /api/health                  健康检查，不需要令牌
 *   POST /api/sync/pull               拉取全部 Record（含软删除 Tombstone）
 *   POST /api/sync/pull-page          按不可变 id 分页拉取
 *   GET  /api/sync/record?id=<uuid>   拉取单条
 *   POST /api/sync/mutate             原子应用一次 Mutation
 *
 * 鉴权：Authorization: Bearer <访问令牌>。
 * 令牌只存 SHA-256，库里没有明文。
 */
import {
  applyMutation,
  pullAll,
  pullPage,
  parsePullPageInput,
  readRecord,
  readUser,
  resolveUser,
  type ApplyMutationInput,
  type Env,
  type MutationOperation,
} from './core'

const OPERATIONS = new Set<string>([
  'create',
  'update',
  'complete',
  'uncomplete',
  'delete',
  'restore',
])

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

/**
 * 本项目用 Bearer 令牌鉴权，不带 Cookie，
 * 所以跨域不涉及 CSRF —— 别人的页面拿不到令牌。
 * 默认放开，但可以用 ALLOWED_ORIGINS 收紧。
 */
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? ''
  const allowList = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')

  const allowed =
    allowList.length === 0 ? '*' : allowList.includes(origin) ? origin : (allowList[0] ?? '')

  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...cors },
  })
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * 取出 Bearer 令牌。
 *
 * 认证方案名（Bearer）按 RFC 7235 是**大小写不敏感**的，
 * 而 `startsWith('Bearer ')` 是敏感的 —— 那样 `bearer xxx` 会被
 * 当成「没带令牌」，用户只会看到一句没头没脑的 401。
 * 这里统一按不敏感处理。
 */
function readBearerToken(request: Request): string {
  const header = request.headers.get('Authorization') ?? ''
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() ?? ''
}

/** 严格校验请求体 —— 宁可返回 400，也不要把脏数据写进库 */
function parseMutationInput(body: unknown): ApplyMutationInput | null {
  if (typeof body !== 'object' || body === null) return null
  const raw = body as Record<string, unknown>

  const mutationId = asString(raw.mutationId)
  const recordId = asString(raw.recordId)
  const operation = asString(raw.operation)

  if (!mutationId || !recordId || !operation) return null
  if (!OPERATIONS.has(operation)) return null

  const versionRaw = raw.expectedVersion
  let expectedVersion: number | null = null
  if (versionRaw !== null && versionRaw !== undefined) {
    if (typeof versionRaw !== 'number' || !Number.isFinite(versionRaw)) return null
    expectedVersion = versionRaw
  }

  const payload = raw.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null

  return {
    mutationId,
    recordId,
    operation: operation as MutationOperation,
    expectedVersion,
    payload: payload as Record<string, unknown>,
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env)
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    if (url.pathname === '/api/health') {
      return json({ ok: true, service: 'yike-sync', version: 1 }, 200, cors)
    }

    // 鉴权也放在 try 里：数据库连不上时也要返回一个**带 CORS 头的 500**，
    // 而不是让异常冒出去变成一个没有 CORS 头的裸错误页 ——
    // 那样浏览器只会报「CORS 错误」，把真正的原因盖住。
    try {
      // ---------- 鉴权 ----------
      const token = readBearerToken(request)
      const userId = token === '' ? null : await resolveUser(env.DB, token)
      if (userId === null) {
        return json({ error: 'unauthorized' }, 401, cors)
      }

      if (url.pathname === '/api/me' && request.method === 'GET') {
        const user = await readUser(env.DB, userId)
        // 令牌指向一个不存在的账号 —— 外键约束下几乎不可能发生，
        // 但真发生了就是数据不一致，不能假装成功返回 200。
        if (user === null) return json({ error: 'user_not_found' }, 404, cors)
        return json(user, 200, cors)
      }

      if (url.pathname === '/api/sync/pull' && request.method === 'POST') {
        return json({ records: await pullAll(env.DB, userId) }, 200, cors)
      }

      if (url.pathname === '/api/sync/pull-page' && request.method === 'POST') {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return json({ error: 'invalid_json' }, 400, cors)
        }
        const input = parsePullPageInput(body)
        if (input === null) return json({ error: 'invalid_body' }, 400, cors)
        return json(await pullPage(env.DB, userId, input), 200, cors)
      }

      if (url.pathname === '/api/sync/record' && request.method === 'GET') {
        const id = url.searchParams.get('id') ?? ''
        if (id === '') return json({ error: 'missing_id' }, 400, cors)
        return json({ record: await readRecord(env.DB, userId, id) }, 200, cors)
      }

      if (url.pathname === '/api/sync/mutate' && request.method === 'POST') {
        // 请求体不是合法 JSON 是**客户端的错**，要回 400。
        // 如果放任它冒到外面的 catch，就会被当成 500 服务端故障 ——
        // 排查的人会去翻服务端日志，而真正的问题在调用方。
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return json({ error: 'invalid_json' }, 400, cors)
        }

        const input = parseMutationInput(body)
        if (input === null) return json({ error: 'invalid_body' }, 400, cors)
        const result = await applyMutation(env.DB, userId, input, new Date().toISOString())
        return json(result, 200, cors)
      }

      return json({ error: 'not_found' }, 404, cors)
    } catch (error) {
      // 出错时绝不能返回「看起来成功」的响应 —— 客户端会把失败当成已应用，
      // 那才是真正的数据丢失。返回 500，让 outbox 保留 mutation 稍后重试。
      //
      // 细节只写进服务端日志（wrangler.toml 开了 observability），
      // 不回给调用方：未通过鉴权的请求也会走到这里，
      // 把内部错误文本回给陌生人是没必要的暴露。
      console.error('sync_backend_error', error)
      return json({ error: 'internal_error' }, 500, cors)
    }
  },
}
