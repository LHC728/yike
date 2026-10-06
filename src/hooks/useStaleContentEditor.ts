import { useState } from 'react'
import { snapshotOf, type LocalRecord, type RecordSnapshot } from '../domain/record'
import type { RecordWriteTarget } from '../domain/write'
import { captureWriteOwner, isWriteOwnerCurrent, recordTarget } from '../app/writeOwner'
import { recordActions } from './useRecords'

/** 两处正文编辑复用同一份 CAS 流程，不能一处保护、另一处仍覆盖旧快照。 */
export function useStaleContentEditor(
  record: LocalRecord | undefined,
  userId: string,
  onEditingChange?: ((editing: boolean) => void) | undefined,
) {
  const owner = captureWriteOwner(userId)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [baseline, setBaseline] = useState<RecordSnapshot | null>(null)
  const [target, setTarget] = useState<RecordWriteTarget | null>(null)
  const [stale, setStale] = useState<LocalRecord | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const blocked = !isWriteOwnerCurrent(owner)

  function begin(): void {
    if (!record || record.userId !== userId || record.deletedAtUtc !== null) return
    const nextTarget = recordTarget(owner, record.id)
    if (!isWriteOwnerCurrent(nextTarget)) return
    setTarget(nextTarget)
    setBaseline(snapshotOf(record))
    setDraft(record.content)
    setStale(null)
    setMessage(null)
    setEditing(true)
    onEditingChange?.(true)
  }

  async function save(expected: RecordSnapshot | null = baseline): Promise<void> {
    if (!target || target.userId !== owner.userId || !expected || saving || blocked) return
    const currentTarget = recordTarget(owner, target.recordId)
    setTarget(currentTarget)
    setSaving(true)
    try {
      const result = await recordActions.updateContent(currentTarget, draft, expected)
      if (!isWriteOwnerCurrent(currentTarget)) return
      if (result.status === 'stale') {
        setStale(result.current)
        setMessage(null)
      } else if (result.status === 'unavailable') {
        setMessage('这条记录暂时不能保存。你的草稿仍在输入框里，可以先复制保留。')
      } else {
        setEditing(false)
        onEditingChange?.(false)
        setStale(null)
        setMessage(null)
      }
    } finally {
      setSaving(false)
    }
  }

  function reload(): void {
    if (!target || target.userId !== owner.userId || saving || blocked) return
    const latest = record?.id === target.recordId && record.userId === userId ? record : stale
    if (!latest || latest.deletedAtUtc !== null) return
    setDraft(latest.content)
    setBaseline(snapshotOf(latest))
    setTarget(recordTarget(owner, latest.id))
    setStale(null)
    setMessage(null)
  }

  function cancel(): void {
    if (saving || blocked) return
    setEditing(false)
    onEditingChange?.(false)
    setStale(null)
    setMessage(null)
  }

  return {
    editing: editing && target !== null && target.userId === userId,
    draft, setDraft, stale, saving: saving || blocked, message,
    begin, save, reload, cancel,
    keepDraft: () => { if (stale) void save(snapshotOf(stale)) },
  }
}
