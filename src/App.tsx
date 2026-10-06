import { useEffect, useMemo } from 'react'
import { AppRouter } from './app/router'
import { LoginPage } from './pages/LoginPage'
import { Toaster } from './components/Toaster'
import { toaster } from './app/toastStore'
import { authService, currentUserId } from './auth/AuthService'
import { useAuth } from './hooks/useSyncStatus'
import { createCloudAdapter } from './cloud/cloudProvider'
import { syncEngine } from './sync/SyncEngine'

export default function App() {
  const auth = useAuth()

  // 启动：初始化账号（本机模式或云端会话）
  useEffect(() => {
    void authService.init()
    return () => authService.dispose()
  }, [])

  const userId = useMemo(() => currentUserId(auth), [auth])

  // 账号就绪后启动同步引擎
  useEffect(() => {
    if (!auth.ready || auth.transitioning) {
      syncEngine.stop()
      return
    }
    syncEngine.configure({
      adapter: createCloudAdapter(),
      userId,
      mode: auth.mode,
    })
    syncEngine.start()
    return () => syncEngine.stop()
  }, [auth.ready, auth.transitioning, auth.mode, userId])

  // 从本机模式并入账号时，明确告诉用户数据还在
  useEffect(() => {
    if (auth.migratedCount <= 0) return
    toaster.show({
      message: `已把本机 ${auth.migratedCount} 条记录归入当前账号`,
      duration: 6000,
    })
    authService.clearMigratedCount()
  }, [auth.migratedCount])

  if (!auth.ready) {
    return (
      <>
        <div className="flex min-h-screen items-center justify-center">
          <span className="text-[13px] text-ink-soft">正在准备…</span>
        </div>
        <Toaster />
      </>
    )
  }

  if (auth.mode === 'cloud' && !auth.user) {
    return (
      <>
        <LoginPage />
        <Toaster />
      </>
    )
  }

  if (!userId) {
    return (
      <>
        <div className="flex min-h-screen items-center justify-center px-6 text-center">
          <span className="text-[13px] text-ink-soft">无法确定当前账号，请重新登录。</span>
        </div>
        <Toaster />
      </>
    )
  }

  return <AppRouter key={`${auth.mode}:${auth.provider ?? 'local'}:${userId}`} userId={userId} />
}
