import { useState } from 'react'
import { ChevronRight, LogOut } from 'lucide-react'
import { useAuth } from '../hooks/useSyncStatus'
import { authService } from '../auth/AuthService'
import { usePendingCount, useAllRecords } from '../hooks/useRecords'
import { syncEngine } from '../sync/SyncEngine'
import { useSyncStatus } from '../sync/syncStatus'
import {
  CLOUD_PROVIDER_LABEL,
  readCloudConfig,
  readEnvCloudConfig,
  readStoredCloudConfig,
  saveCloudConfig,
  type CloudProviderKind,
} from '../cloud/cloudConfig'
import { saveCloudflareSession } from '../cloud/cloudflareSession'
import { CloudRequestError } from '../cloud/cloudflareClient'
import { resetSupabaseClient } from '../cloud/supabaseClient'
import { THEME_OPTIONS, themeActions, useThemeMode } from '../app/themeStore'
import { formatChineseDateTime, localDateOf } from '../utils/time'
import { buildExportFile, downloadJson, exportFileName } from '../utils/exportRecords'
import { uiActions } from '../app/uiStore'
import { Modal } from './Modal'

interface SettingsSheetProps {
  open: boolean
  userId: string | null
}

const PHASE_TEXT: Record<string, string> = {
  idle: '已就绪',
  syncing: '正在同步…',
  synced: '已同步',
  offline: '离线',
  error: '暂时无法同步',
  local: '仅本机（未连接云端）',
  'signed-out': '未登录',
}

const PROVIDERS: readonly CloudProviderKind[] = ['supabase', 'cloudflare']

/**
 * 设置（方案 §4）：只放账号和同步状态，不作为主模块。
 */
export function SettingsSheet({ open, userId }: SettingsSheetProps) {
  const auth = useAuth()
  const status = useSyncStatus()
  const pending = usePendingCount(userId)
  const records = useAllRecords(userId)
  const themeMode = useThemeMode()

  // 每次打开由调用方通过 key 重新挂载，表单初值直接来自本机配置
  const stored = readCloudConfig()
  const [provider, setProvider] = useState<CloudProviderKind>(stored?.provider ?? 'supabase')
  const [url, setUrl] = useState(() => stored?.url ?? '')
  const [key, setKey] = useState(() => (stored?.provider === 'supabase' ? stored.anonKey : ''))
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  // 「云端连接」是另一件事（配外部服务），跟「账号 / 外观 / 同步状态」
  // （这台设备自己的事）不在一个层级，所以拆成二级页，主设置只留一行入口。
  // 每次打开由调用方的 key 重新挂载，这个 state 会自动回到 'main'。
  const [view, setView] = useState<'main' | 'cloud'>('main')

  if (!open) return null

  const envConfig = readEnvCloudConfig()
  const storedConfig = readStoredCloudConfig()

  async function handleSaveCloud() {
    if (busy) return
    setBusy(true)
    setError(null)

    const trimmedUrl = url.trim()

    // 清空地址 = 断开云端，回到本机模式
    if (trimmedUrl === '') {
      saveCloudConfig(null)
      saveCloudflareSession(null)
      resetSupabaseClient()
      setSaved(true)
      setTimeout(() => window.location.reload(), 600)
      return
    }

    if (provider === 'cloudflare') {
      // 填了令牌就顺手验证一次 —— 先验证再落盘，不留坏配置
      if (token.trim() !== '') {
        try {
          await authService.signInWithCloudflare(trimmedUrl, token)
        } catch (err) {
          setBusy(false)
          setError(
            err instanceof CloudRequestError && err.status === 401
              ? '这个令牌不被接受。可能是打错了，或者它已经被吊销。'
              : err instanceof TypeError
                ? '连不上这个地址。检查一下 Worker 地址是否写对了。'
                : err instanceof Error
                  ? err.message
                  : '连接失败，请稍后再试。',
          )
          return
        }
      } else {
        saveCloudConfig({ provider: 'cloudflare', url: trimmedUrl })
      }
    } else {
      if (key.trim() === '') {
        setBusy(false)
        setError('Supabase 需要同时填地址和 anon key。')
        return
      }
      saveCloudConfig({ provider: 'supabase', url: trimmedUrl, anonKey: key })
      resetSupabaseClient()
    }

    setSaved(true)
    // 连接配置变化需要重新初始化账号与同步
    setTimeout(() => window.location.reload(), 600)
  }

  async function handleSignOut() {
    await authService.signOut()
    uiActions.closeSettings()
  }

  function handleExport() {
    // 导出的是 useAllRecords（本机 IndexedDB 全量，含软删墓碑），
    // 不是当前页面的过滤结果 —— 备份要的是完整，不是「看得见的那些」。
    const now = new Date()
    const file = buildExportFile(records, now.toISOString())
    // 文件名用本地日期：用户一眼能对上「这是我哪天导的」
    downloadJson(exportFileName(localDateOf(now)), JSON.stringify(file, null, 2))
  }

  const isCloud = view === 'cloud'

  return (
    <Modal
      open
      onClose={uiActions.closeSettings}
      title={isCloud ? '云端连接' : '设置'}
      // 只有二级页才给返回：一级的「设置」返回了没地方去
      onBack={isCloud ? () => setView('main') : undefined}
      widthClass="md:max-w-md"
    >
      {!isCloud ? (
        <>
          <section className="mb-6">
            <h3 className="text-[12.5px] font-medium text-ink-soft">账号</h3>
            <div className="mt-2 space-y-1.5 text-[14px] text-ink-soft">
              <div className="flex justify-between gap-4">
                <span className="text-ink-soft">模式</span>
                <span>{auth.mode === 'local' ? '本机模式' : '云端账号'}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-ink-soft">后端</span>
                <span data-testid="settings-provider">
                  {auth.provider ? CLOUD_PROVIDER_LABEL[auth.provider] : '—'}
                </span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-ink-soft">账号</span>
                <span className="truncate">{auth.user?.email ?? (auth.user ? '访问令牌' : '—')}</span>
              </div>
            </div>

            {auth.mode === 'cloud' && auth.user ? (
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="tap tap-active mt-3 flex h-10 items-center gap-2 rounded-xl border border-line px-3.5 text-[14px] text-ink-soft"
              >
                <LogOut size={15} strokeWidth={1.7} />
                退出登录
              </button>
            ) : null}
          </section>

          <section className="mb-6">
            <h3 className="text-[12.5px] font-medium text-ink-soft">外观</h3>
            <div className="mt-2.5 flex gap-2">
              {THEME_OPTIONS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => themeActions.setMode(item.value)}
                  aria-pressed={themeMode === item.value}
                  data-testid={`settings-theme-${item.value}`}
                  className={`tap tap-active h-9 flex-1 rounded-xl border text-[13px] ${
                    themeMode === item.value
                      ? 'border-idea/40 bg-idea-soft text-idea'
                      : 'border-line text-ink-soft'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[12px] leading-5 text-ink-soft">
              只影响这台设备的显示，不影响记录本身。
            </p>
          </section>

          <section className="mb-6">
            <h3 className="text-[12.5px] font-medium text-ink-soft">同步状态</h3>
            <div className="mt-2 space-y-1.5 text-[14px] text-ink-soft">
              <div className="flex justify-between gap-4">
                <span className="text-ink-soft">状态</span>
                <span data-testid="settings-sync-phase">{PHASE_TEXT[status.phase] ?? status.phase}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-ink-soft">待同步</span>
                <span data-testid="settings-pending">{pending} 条</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-ink-soft">本机记录</span>
                <span>{records.length} 条</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-ink-soft">上次同步</span>
                <span>
                  {status.lastSyncedAt ? formatChineseDateTime(status.lastSyncedAt) : '—'}
                </span>
              </div>
            </div>

            {status.message ? (
              <p className="mt-2.5 rounded-xl bg-idea-soft px-3 py-2 text-[13px] leading-5 text-idea">
                {status.message}
              </p>
            ) : null}

            {auth.mode === 'cloud' && auth.user ? (
              <button
                type="button"
                onClick={() => void syncEngine.sync('manual')}
                className="tap tap-active mt-3 h-10 rounded-xl border border-line px-3.5 text-[14px] text-ink-soft"
              >
                立即同步
              </button>
            ) : null}

            {/* 导出：这是用户自己手里的完整底稿，跟「待同步 / 本机记录」
                是一组信息（都是「我有多少数据」），所以放在同一个区块里。 */}
            <button
              type="button"
              disabled={records.length === 0}
              onClick={handleExport}
              data-testid="settings-export"
              className="tap tap-active mt-2 h-10 rounded-xl border border-line px-3.5 text-[14px] text-ink-soft disabled:opacity-50"
            >
              导出全部记录
            </button>
            <p className="mt-2 text-[12px] leading-5 text-ink-soft">
              存成一份 JSON 文件（含已删除的）。留个底稿，或者拿去别处分析。
            </p>
          </section>

          {/* 云端连接的入口。当前状态直接写在右侧 ——
              不进子页也该知道连没连上，否则得点进去才知道，等于把状态藏起来了。 */}
          <button
            type="button"
            onClick={() => setView('cloud')}
            data-testid="settings-open-cloud"
            className="tap tap-active flex w-full items-center justify-between gap-4 border-t border-line-soft pt-4"
          >
            <span className="text-[14px] text-ink-soft">云端连接</span>
            <span className="flex items-center gap-1 text-[13px] text-ink-soft">
              {envConfig
                ? '已由环境变量提供'
                : storedConfig
                  ? CLOUD_PROVIDER_LABEL[storedConfig.provider]
                  : '未连接'}
              {/* 箭头是纯装饰，可以用 ink-faint（它只有 3.1:1，不承载信息） */}
              <ChevronRight size={15} strokeWidth={1.7} className="text-ink-faint" />
            </span>
          </button>
        </>
      ) : (
        <section>
          <h3 className="text-[12.5px] font-medium text-ink-soft">云端连接</h3>
          {envConfig ? (
            <p className="mt-2 text-[13px] leading-5 text-ink-soft">
              已由构建期环境变量提供连接信息。
            </p>
          ) : (
            <>
              <p className="mt-2 text-[13px] leading-5 text-ink-soft">
                连接后手机和电脑会自动同步。留空则保持仅本机使用，所有功能仍然完整可用。
              </p>

              <div className="mt-2.5 flex gap-2">
                {PROVIDERS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setProvider(item)}
                    aria-pressed={provider === item}
                    data-testid={`settings-provider-${item}`}
                    className={`tap tap-active h-9 flex-1 rounded-xl border text-[13px] ${
                      provider === item
                        ? 'border-idea/40 bg-idea-soft text-idea'
                        : 'border-line text-ink-soft'
                    }`}
                  >
                    {CLOUD_PROVIDER_LABEL[item]}
                  </button>
                ))}
              </div>

              <div className="mt-2.5 space-y-2">
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder={
                    provider === 'cloudflare'
                      ? 'https://yike-sync.xxxx.workers.dev'
                      : 'https://xxxx.supabase.co'
                  }
                  aria-label="云端地址"
                  autoComplete="off"
                  className="w-full rounded-xl border border-line bg-canvas px-3 py-2 text-[14px] text-ink outline-none focus:border-idea/40"
                />

                {provider === 'supabase' ? (
                  <input
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                    placeholder="anon key"
                    aria-label="Supabase anon key"
                    autoComplete="off"
                    className="w-full rounded-xl border border-line bg-canvas px-3 py-2 text-[14px] text-ink outline-none focus:border-idea/40"
                  />
                ) : (
                  <input
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="访问令牌（留空表示只改地址）"
                    aria-label="访问令牌"
                    autoComplete="off"
                    className="w-full rounded-xl border border-line bg-canvas px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-idea/40"
                  />
                )}
              </div>

              {error ? (
                <p data-testid="settings-cloud-error" className="mt-2 text-[13px] leading-5 text-danger">
                  {error}
                </p>
              ) : null}

              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSaveCloud()}
                className="tap tap-active mt-2.5 h-10 rounded-xl bg-idea px-4 text-[14px] font-medium text-on-idea disabled:opacity-50"
              >
                {saved ? '已保存，正在重载…' : busy ? '正在验证…' : '保存连接'}
              </button>

              {storedConfig ? (
                <p className="mt-2 text-[12px] leading-5 text-ink-soft">
                  当前已保存本机连接配置（{CLOUD_PROVIDER_LABEL[storedConfig.provider]}）。
                </p>
              ) : null}
            </>
          )}
        </section>
      )}
    </Modal>
  )
}
