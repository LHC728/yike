import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { AuthService } from '../auth/AuthService'
import { saveCloudConfig } from '../cloud/cloudConfig'
import { saveCloudflareSession, readCloudflareSession } from '../cloud/cloudflareSession'
import { cloudSessionRevision } from '../cloud/sessionScope'
import { db } from '../db/db'
import { createRecord, LOCAL_USER_ID, migrateLocalRecordsToUser } from '../db/recordRepository'
import { cleanupDevices, openDevice } from './fakeCloudServer'

const fixture = vi.hoisted(() => ({ client: null as SupabaseClient | null }))
vi.mock('../cloud/supabaseClient', () => ({ getSupabaseClient: () => fixture.client }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function response(userId: string, status = 200): Response {
  return new Response(JSON.stringify({ userId, email: null }), { status })
}

function session(userId: string): Session {
  return { access_token: `token-${userId}`, refresh_token: `refresh-${userId}`, expires_in: 3600, token_type: 'bearer', user: { id: userId, email: `${userId}@example.com` } } as Session
}

function supabaseFixture() {
  let stored: Session | null = session('A')
  const callbacks: ((event: string, next: Session | null) => void)[] = []
  const unsubscribes: ReturnType<typeof vi.fn>[] = []
  const auth = {
    getSession: vi.fn(async () => ({ data: { session: stored }, error: null })),
    onAuthStateChange: vi.fn((callback: (event: string, next: Session | null) => void) => {
      callbacks.push(callback)
      const unsubscribe = vi.fn()
      unsubscribes.push(unsubscribe)
      return { data: { subscription: { unsubscribe } } }
    }),
    signOut: vi.fn(async () => {
      stored = null
      callbacks.at(-1)?.('SIGNED_OUT', null)
      return { error: null }
    }),
    verifyOtp: vi.fn(async ({ email }: { email: string }) => {
      stored = session(email)
      callbacks.at(-1)?.('SIGNED_IN', stored)
      return { data: { user: stored.user, session: stored }, error: null }
    }),
  }
  fixture.client = { auth } as unknown as SupabaseClient
  return { auth, callbacks, unsubscribes, setSession: (next: Session | null) => { stored = next }, getSession: () => stored }
}

let service: AuthService
beforeEach(async () => {
  localStorage.clear()
  fixture.client = null
  await openDevice(`auth-session-${crypto.randomUUID()}`)
})
afterEach(async () => {
  expect(service.getSnapshot().transitioning).toBe(false)
  service?.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  await cleanupDevices()
})

function configureCloudflare(): void {
  saveCloudConfig({ provider: 'cloudflare', url: 'https://a.invalid' })
  saveCloudflareSession({ token: 'token-A', userId: 'A', email: null })
  service = new AuthService()
}

function configureSupabase(): ReturnType<typeof supabaseFixture> {
  saveCloudConfig({ provider: 'supabase', url: 'https://x.supabase.co', anonKey: 'key' })
  const client = supabaseFixture()
  service = new AuthService()
  return client
}

describe('Cloudflare 认证操作的代次', () => {
  for (const oldStatus of [200, 401]) {
    it(`旧启动确认晚返回 ${oldStatus} 不改新登录 B 的身份或令牌`, async () => {
      configureCloudflare()
      const oldMe = deferred<Response>()
      const started = deferred<void>()
      vi.stubGlobal('fetch', vi.fn(async (_input: string, init: RequestInit) => {
        if (new Headers(init.headers).get('authorization') === 'Bearer token-A') {
          started.resolve(undefined)
          return oldMe.promise
        }
        return response('B')
      }))
      const initial = service.init()
      await started.promise
      await service.signOut()
      await service.signInWithCloudflare('https://b.invalid', 'token-B')
      oldMe.resolve(response('A', oldStatus))
      await initial
      expect(service.getSnapshot().user?.id).toBe('B')
      expect(readCloudflareSession()).toMatchObject({ userId: 'B', token: 'token-B' })
    })
  }

  it('退出后旧启动请求成功也不能恢复会话', async () => {
    configureCloudflare()
    const oldMe = deferred<Response>()
    const started = deferred<void>()
    vi.stubGlobal('fetch', vi.fn(async () => { started.resolve(undefined); return oldMe.promise }))
    const initial = service.init()
    await started.promise
    await service.signOut()
    oldMe.resolve(response('A'))
    await initial
    expect(readCloudflareSession()).toBeNull()
    expect(service.getSnapshot()).toMatchObject({ ready: true, transitioning: false, user: null })
  })

  it('两个登录交错完成只接受最后一次 B，等待验证期间拒绝旧 UI 身份', async () => {
    configureCloudflare()
    const oldMe = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init: RequestInit) => new Headers(init.headers).get('authorization') === 'Bearer token-A' ? oldMe.promise : response('B')))
    const revision = cloudSessionRevision()
    const oldLogin = service.signInWithCloudflare('https://a.invalid', 'token-A')
    expect(service.getSnapshot().transitioning).toBe(true)
    expect(cloudSessionRevision()).toBeGreaterThan(revision)
    await service.signInWithCloudflare('https://b.invalid', 'token-B')
    oldMe.resolve(response('A'))
    await oldLogin
    expect(service.getSnapshot().user?.id).toBe('B')
    expect(readCloudflareSession()?.userId).toBe('B')
  })

  it('离线启动仍立即使用缓存账号，网络失败不踢下线', async () => {
    configureCloudflare()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await service.init()
    expect(service.getSnapshot()).toMatchObject({ ready: true, transitioning: false, user: { id: 'A' } })
    expect(readCloudflareSession()?.userId).toBe('A')
  })

  it('登录失败恢复原账号与 ready，但旧写入代次不复活', async () => {
    configureCloudflare()
    vi.stubGlobal('fetch', vi.fn(async () => response('A')))
    await service.init()
    const revision = cloudSessionRevision()
    vi.stubGlobal('fetch', vi.fn(async () => response('', 401)))
    await expect(service.signInWithCloudflare('https://b.invalid', 'bad')).rejects.toThrow('401')
    expect(service.getSnapshot()).toMatchObject({ ready: true, transitioning: false, user: { id: 'A' } })
    expect(cloudSessionRevision()).toBeGreaterThan(revision)
  })

  it('迁移之前发布 B 身份，迁移中退出会整笔回滚本机记录和 outbox', async () => {
    configureCloudflare()
    const record = await createRecord({ userId: LOCAL_USER_ID, type: 'idea', content: '本机唯一草稿' })
    const originalOutbox = await db.outbox.toArray()
    vi.stubGlobal('fetch', vi.fn(async () => response('B')))
    const realPut = db.records.put.bind(db.records)
    const put = vi.spyOn(db.records, 'put').mockImplementationOnce((...args) => {
      expect(service.getSnapshot()).toMatchObject({ ready: true, transitioning: false, user: { id: 'B' } })
      void service.signOut()
      return realPut(...args)
    })
    await service.signInWithCloudflare('https://b.invalid', 'token-B')
    expect(put).toHaveBeenCalled()
    expect((await db.records.get(record.id))?.userId).toBe(LOCAL_USER_ID)
    expect(await db.outbox.toArray()).toEqual(originalOutbox)
    expect(service.getSnapshot().user).toBeNull()
  })
})

describe('Supabase 的 SDK 写入与初始化', () => {
  it('旧 getSession 晚于验证码登录返回，不覆盖 B 或重复订阅', async () => {
    const client = configureSupabase()
    const old = deferred<{ data: { session: Session | null }; error: null }>()
    client.auth.getSession.mockImplementationOnce(() => old.promise)
    const initial = service.init()
    await service.verifyEmailCode('B', '123456')
    old.resolve({ data: { session: session('A') }, error: null })
    await initial
    expect(service.getSnapshot().user?.id).toBe('B')
    expect(client.auth.onAuthStateChange).toHaveBeenCalledTimes(1)
  })

  it('先开始的 SDK 退出必须先结束，后开始的 B 登录才能落盘', async () => {
    const client = configureSupabase()
    await service.init()
    const oldSignOut = deferred<void>()
    const started = deferred<void>()
    client.auth.signOut.mockImplementationOnce(async () => {
      started.resolve(undefined)
      await oldSignOut.promise
      client.setSession(null)
      client.callbacks.at(-1)?.('SIGNED_OUT', null)
      return { error: null }
    })
    const signOut = service.signOut()
    await started.promise
    const login = service.verifyEmailCode('B', '123456')
    await Promise.resolve()
    expect(client.auth.verifyOtp).not.toHaveBeenCalled()
    oldSignOut.resolve(undefined)
    await Promise.all([signOut, login])
    expect(client.getSession()?.user.id).toBe('B')
    expect(service.getSnapshot()).toMatchObject({ ready: true, transitioning: false, user: { id: 'B' } })
  })

  it('较早的验证码响应不能覆盖较晚登录，SDK 落盘顺序也保持 B 最后', async () => {
    const client = configureSupabase()
    await service.init()
    const oldVerify = deferred<void>()
    const started = deferred<void>()
    client.auth.verifyOtp.mockImplementationOnce(async () => {
      started.resolve(undefined)
      await oldVerify.promise
      const a = session('A')
      client.setSession(a)
      client.callbacks.at(-1)?.('SIGNED_IN', a)
      return { data: { session: a, user: a.user }, error: null }
    })
    const a = service.verifyEmailCode('A', '111111')
    await started.promise
    const b = service.verifyEmailCode('B', '222222')
    oldVerify.resolve(undefined)
    await Promise.all([a, b])
    expect(client.getSession()?.user.id).toBe('B')
    expect(service.getSnapshot().user?.id).toBe('B')
  })

  it('StrictMode 的 init → dispose → init 正常重订阅，旧初始化与旧回调失效', async () => {
    const client = configureSupabase()
    const old = deferred<{ data: { session: Session | null }; error: null }>()
    client.auth.getSession.mockImplementationOnce(() => old.promise)
    const first = service.init()
    service.dispose()
    client.setSession(session('B'))
    await service.init()
    client.callbacks[0]?.('SIGNED_IN', session('A'))
    old.resolve({ data: { session: session('A') }, error: null })
    await first
    expect(client.unsubscribes[0]).toHaveBeenCalledTimes(1)
    expect(client.auth.onAuthStateChange).toHaveBeenCalledTimes(2)
    expect(service.getSnapshot().user?.id).toBe('B')
  })
})

it('迁移守护在事务尾抛出时，两表保留原样', async () => {
  service = new AuthService()
  const record = await createRecord({ userId: LOCAL_USER_ID, type: 'idea', content: '禁止半迁移' })
  const original = await db.outbox.toArray()
  let calls = 0
  await expect(migrateLocalRecordsToUser('B', () => {
    calls += 1
    if (calls >= 4) throw new Error('obsolete')
  })).rejects.toThrow('obsolete')
  expect((await db.records.get(record.id))?.userId).toBe(LOCAL_USER_ID)
  expect(await db.outbox.toArray()).toEqual(original)
})


describe('认证完成的每个稳定出口', () => {
  it('Cloudflare 无缓存初始化、成功登录和退出都结束 transitioning', async () => {
    configureCloudflare()
    saveCloudflareSession(null)
    vi.stubGlobal('fetch', vi.fn(async () => response('B')))
    await service.init()
    expect(service.getSnapshot()).toMatchObject({ ready: true, transitioning: false, user: null })
    await service.signInWithCloudflare('https://b.invalid', 'token-B')
    expect(service.getSnapshot()).toMatchObject({ ready: true, transitioning: false, user: { id: 'B' } })
    await service.signOut()
    expect(service.getSnapshot()).toMatchObject({ ready: true, transitioning: false, user: null })
  })

  it('Supabase 初始化、验证码成功、退出都结束 transitioning', async () => {
    configureSupabase()
    await service.init()
    expect(service.getSnapshot()).toMatchObject({ ready: true, transitioning: false, user: { id: 'A' } })
    await service.verifyEmailCode('B', '123456')
    expect(service.getSnapshot()).toMatchObject({ ready: true, transitioning: false, user: { id: 'B' } })
    await service.signOut()
    expect(service.getSnapshot()).toMatchObject({ ready: true, transitioning: false, user: null })
  })

  it('Supabase 验证失败恢复原账号，也结束 transitioning', async () => {
    const client = configureSupabase()
    await service.init()
    client.auth.verifyOtp.mockRejectedValueOnce(new Error('invalid_otp'))
    await expect(service.verifyEmailCode('B', 'bad')).rejects.toThrow('invalid_otp')
    expect(service.getSnapshot()).toMatchObject({ ready: true, transitioning: false, user: { id: 'A' } })
  })

  it('B 失败时 previous 处于 A 的过渡状态，也恢复为可用身份', async () => {
    configureCloudflare()
    vi.stubGlobal('fetch', vi.fn(async () => response('A')))
    await service.init()
    const old = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init: RequestInit) => new Headers(init.headers).get('authorization') === 'Bearer token-C' ? old.promise : response('', 401)))
    const c = service.signInWithCloudflare('https://c.invalid', 'token-C')
    await expect(service.signInWithCloudflare('https://b.invalid', 'bad')).rejects.toThrow('401')
    expect(service.getSnapshot()).toMatchObject({ ready: true, transitioning: false, user: { id: 'A' } })
    old.resolve(response('C'))
    await c
    expect(service.getSnapshot()).toMatchObject({ ready: true, transitioning: false, user: { id: 'A' } })
  })
})


it('A SDK 验证已落盘、较晚 B 失败时，恢复身份与当前 SDK A 保持一致', async () => {
  const client = configureSupabase()
  client.setSession(session('C'))
  await service.init()
  const gate = deferred<void>()
  const started = deferred<void>()
  client.auth.verifyOtp.mockImplementationOnce(async () => {
    started.resolve(undefined)
    await gate.promise
    const a = session('A')
    client.setSession(a)
    client.callbacks.at(-1)?.('SIGNED_IN', a)
    return { data: { session: a, user: a.user }, error: null }
  }).mockRejectedValueOnce(new Error('B_invalid_otp'))
  const a = service.verifyEmailCode('A', '111111')
  await started.promise
  const b = service.verifyEmailCode('B', 'bad')
  const rejected = expect(b).rejects.toThrow('B_invalid_otp')
  gate.resolve(undefined)
  await a
  await rejected
  expect(client.getSession()?.user.id).toBe('A')
  expect(service.getSnapshot()).toMatchObject({ ready: true, transitioning: false, user: { id: 'A' } })
})


it('验证码失败后的 getSession 也抛错，当前操作仍回到可重试登录', async () => {
  const client = configureSupabase()
  await service.init()
  client.auth.verifyOtp.mockRejectedValueOnce(new Error('invalid_otp'))
  client.auth.getSession.mockRejectedValueOnce(new Error('storage_unavailable'))
  await expect(service.verifyEmailCode('B', 'bad')).rejects.toThrow('invalid_otp')
  expect(service.getSnapshot()).toMatchObject({ ready: true, transitioning: false, user: null })
})
