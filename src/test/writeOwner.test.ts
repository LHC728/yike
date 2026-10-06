import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({
  state: { ready: true, transitioning: false, mode: 'cloud', provider: 'cloudflare', user: { id: 'owner-A' } },
  listeners: new Set<() => void>(),
}))

vi.mock('../auth/AuthService', () => ({
  authService: {
    getSnapshot: () => auth.state,
    subscribe: (listener: () => void) => { auth.listeners.add(listener); return () => auth.listeners.delete(listener) },
  },
  currentUserId: (state: typeof auth.state) => state.user.id,
}))

import { captureWriteOwner, isWriteOwnerCurrent, recordTarget } from '../app/writeOwner'
import { uiActions, uiStore } from '../app/uiStore'
import { toaster } from '../app/toastStore'
import { invalidateCloudSession } from '../cloud/sessionScope'

function emit(): void {
  for (const listener of auth.listeners) listener()
}

beforeEach(() => {
  auth.state = { ready: true, transitioning: false, mode: 'cloud', provider: 'cloudflare', user: { id: 'owner-A' } }
  invalidateCloudSession()
  emit()
  uiActions.reset()
  toaster.clear()
})

describe('UI 会话写入守护', () => {
  it('当前账号与会话同时匹配才能写入，未就绪和身份过渡均拒绝', () => {
    const owner = captureWriteOwner('owner-A')
    expect(isWriteOwnerCurrent(owner)).toBe(true)
    expect(isWriteOwnerCurrent(captureWriteOwner('owner-B'))).toBe(false)
    auth.state.ready = false
    expect(isWriteOwnerCurrent(owner)).toBe(false)
    auth.state.ready = true
    auth.state.transitioning = true
    expect(isWriteOwnerCurrent(owner)).toBe(false)
  })

  it('同一账号重新认证后，旧回调仍失效；recordTarget 不重新捕获代次', () => {
    const old = captureWriteOwner('owner-A')
    invalidateCloudSession()
    emit()
    expect(isWriteOwnerCurrent(recordTarget(old, 'record-A'))).toBe(false)
    expect(isWriteOwnerCurrent(captureWriteOwner('owner-A'))).toBe(true)
  })

  it('身份切换同步清理选择、搜索、日期与旧撤销，不等 React effect', () => {
    uiActions.openRecord('record-A')
    uiActions.openSearch()
    uiActions.openSettings()
    uiActions.selectDate('2026-10-01')
    toaster.show({ message: 'A 的旧撤销', actionLabel: '撤销', onAction: () => undefined })
    auth.state.user = { id: 'owner-B' }
    invalidateCloudSession()
    emit()
    expect(uiStore.getSnapshot()).toEqual({ selectedRecordId: null, searchOpen: false, settingsOpen: false, selectedDate: null })
    expect(toaster.getSnapshot()).toEqual([])
  })

  it('认证过渡只清旧撤销，保留设置表单挂载和本机输入', () => {
    uiActions.openSettings()
    uiActions.openRecord('record-A')
    toaster.show({ message: '旧撤销', actionLabel: '撤销', onAction: () => undefined })
    auth.state.transitioning = true
    invalidateCloudSession()
    emit()
    expect(uiStore.getSnapshot()).toMatchObject({ settingsOpen: true, selectedRecordId: 'record-A' })
    expect(toaster.getSnapshot()).toEqual([])
    auth.state.transitioning = false
    invalidateCloudSession()
    emit()
    expect(uiStore.getSnapshot().settingsOpen).toBe(true)
  })
})
