import { authService, currentUserId } from '../auth/AuthService'
import { cloudSessionRevision } from '../cloud/sessionScope'
import type { RecordWriteTarget, WriteOwner } from '../domain/write'
import { uiActions } from './uiStore'
import { toaster } from './toastStore'

function activeIdentity(): string {
  const auth = authService.getSnapshot()
  return `${auth.mode}:${auth.provider ?? ''}:${currentUserId(auth) ?? ''}`
}

let observedIdentity = activeIdentity()
let observedRevision = cloudSessionRevision()

// 与 auth 同步发布身份变化；等到 effect 才清理会给旧面板和旧撤销留出一帧。
authService.subscribe(() => {
  const identity = activeIdentity()
  const revision = cloudSessionRevision()
  const changedIdentity = identity !== observedIdentity
  if (changedIdentity) uiActions.reset()
  if (changedIdentity || revision !== observedRevision) toaster.clear()
  observedIdentity = identity
  observedRevision = revision
})

export function captureWriteOwner(userId: string): WriteOwner {
  return { userId, sessionRevision: cloudSessionRevision() }
}

export function recordTarget(owner: WriteOwner, recordId: string): RecordWriteTarget {
  return { ...owner, recordId }
}

export function isWriteOwnerCurrent(owner: WriteOwner): boolean {
  const auth = authService.getSnapshot()
  return auth.ready && !auth.transitioning && currentUserId(auth) === owner.userId &&
    cloudSessionRevision() === owner.sessionRevision
}
