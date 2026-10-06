/** 身份切换必须同步失效旧任务，不能等待 React effect 的下一次清理。 */
let revision = 0

export class SessionChangedError extends Error {
  constructor() {
    super('cloud_session_changed')
    this.name = 'SessionChangedError'
  }
}

export interface SessionScope {
  checkCurrent(): void
  signal: AbortSignal
}

export function invalidateCloudSession(): void {
  revision += 1
}

export function cloudSessionRevision(): number {
  return revision
}

export function noSessionCheck(): void {
  // 非会话调用仍可复用仓库事务，生产同步必须传入真实守护。
}
