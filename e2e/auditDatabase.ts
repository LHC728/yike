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

export type AuditSnapshot = Omit<AuditRecord, 'id' | 'userId' | 'serverVersion' | 'syncState'>

export interface AuditConflict {
  recordId: string
  userId: string
  kind: 'field' | 'delete-edit'
  fields: string[]
  base: AuditSnapshot
  local: AuditSnapshot
  remote: AuditSnapshot
  remoteVersion: number
  createdAt: string
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
  conflictUpdate?: { recordId: string; patch: Partial<AuditConflict> }
  conflictInsert?: AuditConflict
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

/** 冲突是拉取后持久化的三份快照，直接注入测试库以走真实裁决界面。 */
export async function seedConflict(page: Page, record: AuditRecord, conflict: AuditConflict): Promise<void> {
  await page.evaluate(async ({ row, entry }) => {
    const database = new (globalThis as AuditWindow).Dexie('inspiration-todo')
    await database.open()
    try {
      const records = database.table<AuditRecord, string>('records')
      const conflicts = database.table<AuditConflict, string>('conflicts')
      await database.transaction('rw', records, conflicts, async () => {
        await records.put(row)
        await conflicts.put(entry)
      })
    } finally {
      database.close()
    }
  }, { row: record, entry: conflict })
}

export async function patchConflict(page: Page, recordId: string, patch: Partial<AuditConflict>): Promise<void> {
  await page.evaluate(async ({ id, next }) => {
    const database = new (globalThis as AuditWindow).Dexie('inspiration-todo')
    await database.open()
    try {
      await database.table<AuditConflict, string>('conflicts').update(id, next)
    } finally {
      database.close()
    }
  }, { id: recordId, next: patch })
}

/** 将远端更新放进前一笔在途事务；后来的 UI 裁决只能在它提交之后读取。 */
export async function stageBlockedConflictUpdate(page: Page, recordId: string, patch: Partial<AuditConflict>): Promise<void> {
  await page.evaluate(({ id, next }) => {
    const gate = (globalThis as AuditWindow).yikeAuditGate
    if (!gate) throw new Error('未开始测试写事务')
    gate.conflictUpdate = { recordId: id, patch: next }
  }, { id: recordId, next: patch })
}

/** 尚未显示的冲突在前一笔事务提交时到达，验证已点击但仍排队的普通写入会拒绝。 */
export async function stageBlockedConflictInsert(page: Page, conflict: AuditConflict): Promise<void> {
  await page.evaluate((entry) => {
    const gate = (globalThis as AuditWindow).yikeAuditGate
    if (!gate) throw new Error('未开始测试写事务')
    gate.conflictInsert = entry
  }, conflict)
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
    gate.done = database.transaction('rw', database.table('records'), database.table('outbox'), database.table('conflicts'), async () => {
      gate.started = true
      await scope.Dexie.waitFor(blocked, 15_000)
      if (gate.conflictUpdate) {
        await database.table<AuditConflict, string>('conflicts').update(gate.conflictUpdate.recordId, gate.conflictUpdate.patch)
      }
      if (gate.conflictInsert) await database.table<AuditConflict, string>('conflicts').put(gate.conflictInsert)
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
