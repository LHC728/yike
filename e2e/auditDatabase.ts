import { createRequire } from 'node:module'
import type { DexieConstructor } from 'dexie'
import type { Page } from '@playwright/test'

/** 浏览器持久化协议单独描述，避免 Node E2E 把应用的 bundler 依赖一起编译。 */
export interface AuditRecord {
  id: string
  userId: string
  type: 'idea' | 'todo' | 'project' | 'log'
  content: string
  progress: number | null
  deadlineLocalDate: string | null
  parentId: string | null
  createdAtUtc: string
  createdTimezone: string
  createdLocalDate: string
  updatedAtUtc: string
  updatedTimezone: string
  completedAtUtc: string | null
  completedTimezone: string | null
  deletedAtUtc: string | null
  serverVersion: number | null
  syncState: 'synced' | 'pending' | 'syncing' | 'conflict' | 'error'
}

interface AuditMutation {
  mutationId: string
  userId: string
  recordId: string
  operation: string
  baseServerVersion: number | null
  baseSnapshot: Omit<AuditRecord, 'id' | 'userId' | 'serverVersion' | 'syncState'>
  payload: Record<string, unknown>
}

interface AuditConflict {
  recordId: string
  userId: string
}

interface DatabaseSnapshot {
  records: AuditRecord[]
  outbox: AuditMutation[]
  conflicts: AuditConflict[]
}

interface AuditGate {
  started: boolean
  release: () => void
  done: Promise<unknown>
}

type AuditWindow = typeof globalThis & { Dexie: DexieConstructor; yikeAuditGate?: AuditGate }

/** 第二实例仍走 Dexie 公共写入通知；原生 IndexedDB 不会唤醒页面的 liveQuery。 */
export async function installDatabaseDriver(page: Page): Promise<void> {
  await page.addScriptTag({ path: createRequire(import.meta.url).resolve('dexie') })
}

export async function inspectDatabase(page: Page): Promise<DatabaseSnapshot> {
  return page.evaluate(async () => {
    const Driver = (globalThis as AuditWindow).Dexie
    const database = new Driver('inspiration-todo')
    await database.open()
    try {
      const [records, outbox, conflicts] = await Promise.all([
        database.table<AuditRecord, string>('records').toArray(),
        database.table<AuditMutation, string>('outbox').toArray(),
        database.table<AuditConflict, string>('conflicts').toArray(),
      ])
      return { records, outbox, conflicts }
    } finally {
      database.close()
    }
  })
}

export async function seedRecords(page: Page, records: AuditRecord[]): Promise<void> {
  await page.evaluate(async (rows) => {
    const database = new (globalThis as AuditWindow).Dexie('inspiration-todo')
    await database.open()
    try {
      await database.table<AuditRecord, string>('records').bulkPut(rows)
    } finally {
      database.close()
    }
  }, records)
}

/** 模拟已拉到的快照；只有测试记录的 outbox 可以按需移除。 */
export async function patchRecord(page: Page, recordId: string, patch: Partial<AuditRecord>, clearOutbox = false): Promise<void> {
  await page.evaluate(async ({ id, next, clear }) => {
    const database = new (globalThis as AuditWindow).Dexie('inspiration-todo')
    await database.open()
    try {
      const records = database.table<AuditRecord, string>('records')
      const outbox = database.table<AuditMutation, string>('outbox')
      await database.transaction('rw', records, outbox, async () => {
        const original = await records.get(id)
        if (!original) throw new Error('测试记录不存在')
        await records.put({ ...original, ...next })
        if (clear) await outbox.where('recordId').equals(id).delete()
      })
    } finally {
      database.close()
    }
  }, { id: recordId, next: patch, clear: clearOutbox })
}

/** 短暂占住本地写事务；延迟网络并不能让 Local First 的保存按钮等待。 */
export async function beginWriteBlock(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const scope = globalThis as AuditWindow
    const database = new scope.Dexie('inspiration-todo')
    await database.open()
    let release = (): void => undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const gate: AuditGate = { started: false, release: () => release(), done: Promise.resolve() }
    scope.yikeAuditGate = gate
    gate.done = database.transaction('rw', database.table('records'), database.table('outbox'), async () => {
      gate.started = true
      await scope.Dexie.waitFor(blocked, 15_000)
    }).finally(() => database.close())
  })
  await page.waitForFunction(() => Boolean((globalThis as AuditWindow).yikeAuditGate?.started))
}

export async function releaseWriteBlock(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const scope = globalThis as AuditWindow
    const gate = scope.yikeAuditGate
    if (!gate) return
    gate.release()
    await gate.done
    delete scope.yikeAuditGate
  })
}
