// 系统设置 · 本地资源库

import { useState, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { useCachedPageEffect } from '@/hooks/useCachedPageEffect'
import { localLibraryApi } from '@/features/library/local/api'
import {
  effectiveImportMode,
  shouldAskImportMode,
  type LocalLibraryImportMode,
  type LocalLibraryPreferences,
} from '@/features/library/local/types'
import { formatBytes } from '@/lib/utils'
import { Skeleton } from '@/components/admin/Skeleton'
import { GetLocalLibraryCacheStats } from '../../../wailsjs/go/main/App'
import { local_library } from '../../../wailsjs/go/models'
import {
  Loader2,
  HardDrive,
  RefreshCw,
  Database,
  Images,
  ChevronRight,
  MessageCircleQuestion,
  Image as ImageIcon,
} from 'lucide-react'
import { getErrorMessage, btnOutline, Section, Field } from './shared'
// ─── 本地资源库 ──────────────────────────────────────

type LocalLibraryCacheInfo = {
  loading: boolean
  stats: local_library.LocalLibraryCacheStats | null
  error: string | null
}

const IMPORT_MODE_LABELS: Record<LocalLibraryImportMode, string> = {
  copy: '复制到资源库',
  move: '移动到资源库',
}

export function useLocalLibraryCacheInfo() {
  const [cacheInfo, setCacheInfo] = useState<LocalLibraryCacheInfo>({ loading: true, stats: null, error: null })
  const requestIdRef = useRef(0)

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setCacheInfo(prev => ({ ...prev, loading: true, error: null }))
    try {
      const stats = await GetLocalLibraryCacheStats()
      if (requestId !== requestIdRef.current) return
      setCacheInfo({ loading: false, stats, error: null })
    } catch (error: unknown) {
      if (requestId !== requestIdRef.current) return
      setCacheInfo({
        loading: false,
        stats: null,
        error: error instanceof Error ? error.message : '本地资源库不可用',
      })
    }
  }, [])

  useCachedPageEffect(() => { void refresh() }, [refresh])
  return { ...cacheInfo, refresh }
}

export function LocalLibraryTab({ onManageCache }: { onManageCache: () => void }) {
  const [preferences, setPreferences] = useState<LocalLibraryPreferences | null>(null)
  const [preferencesLoading, setPreferencesLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const localCacheInfo = useLocalLibraryCacheInfo()

  useCachedPageEffect(() => {
    void localLibraryApi.preferences()
      .then(setPreferences)
      .catch((error) => toast.error('读取本地资源库设置失败: ' + getErrorMessage(error)))
      .finally(() => setPreferencesLoading(false))
  }, [])

  const askEveryTime = preferences ? shouldAskImportMode(preferences) : false
  const defaultMode = effectiveImportMode(preferences ?? {})
  const defaultModeLabel = IMPORT_MODE_LABELS[defaultMode]

  const toggleAskEveryTime = async (next: boolean) => {
    if (saving || !preferences || next === askEveryTime) return
    const previous = preferences
    // 乐观更新：开关等一次 Wails 往返会显得迟滞，失败时回滚。
    setPreferences({ ...preferences, askEveryTime: next })
    setSaving(true)
    try {
      setPreferences(await localLibraryApi.setAskEveryTime(next))
      toast.success(next ? '已开启每次询问' : `已关闭每次询问，导入时按「${defaultModeLabel}」执行`)
    } catch (error) {
      setPreferences(previous)
      toast.error('保存失败: ' + getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const stats = localCacheInfo.stats

  return (
    <div className="space-y-6">
      <Section title="本地资源库">
        <Field label="应用内导入方式" description="选择或拖入库外照片时使用。系统文件资源管理器中的复制、移动操作不受此设置影响。">
          {preferencesLoading ? (
            <div className="flex h-14 items-center justify-center"><Loader2 size={16} className="animate-spin" /></div>
          ) : (
            <div className="space-y-2">
              <label
                className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border px-4 py-3 transition-colors hover:bg-secondary"
                style={{
                  borderColor: askEveryTime ? 'var(--primary)' : 'var(--border)',
                  backgroundColor: askEveryTime ? 'var(--accent)' : undefined,
                }}>
                <span className="flex min-w-0 items-center gap-2">
                  <MessageCircleQuestion size={16} className="shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">每次询问</span>
                    <span className="mt-0.5 block text-xs leading-5" style={{ color: 'var(--muted-foreground)' }}>
                      {askEveryTime
                        ? '每次导入库外照片都会弹窗选择导入方式。'
                        : `已关闭，导入时不再弹窗，直接按「${defaultModeLabel}」执行。`}
                    </span>
                  </span>
                </span>
                <input
                  className="appearance-switch"
                  type="checkbox"
                  role="switch"
                  aria-label="每次询问"
                  disabled={saving}
                  checked={askEveryTime}
                  onChange={(event) => void toggleAskEveryTime(event.target.checked)}
                />
              </label>
              <p className="text-[11px] leading-5" style={{ color: 'var(--muted-foreground)' }}>
                {askEveryTime
                  ? `弹窗中勾选「不再询问」并确认后，本开关会自动关闭，之后按所选方式导入。弹窗默认选中「${defaultModeLabel}」。`
                  : `当前默认方式：「${defaultModeLabel}」。重新开启「每次询问」即可恢复弹窗提示。`}
              </p>
            </div>
          )}
        </Field>
      </Section>

      <Section title="存储占用" description="统计当前资源库的 .mo-gallery 保留目录。资源库数据不可再生，不会被缓存清理删除。">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-5" style={{ color: 'var(--muted-foreground)' }}>
            缩略图与大图预览可由原文件重新生成；数据库、清单、备份和回收站属于资源库数据。
          </p>
          <button type="button" onClick={() => void localCacheInfo.refresh()} disabled={localCacheInfo.loading}
            className={`${btnOutline} shrink-0`} title="重新统计存储占用">
            <RefreshCw size={13} className={localCacheInfo.loading ? 'animate-spin' : ''} />
            重新统计
          </button>
        </div>

        {localCacheInfo.loading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full rounded-md" />
            <Skeleton className="h-14 w-full rounded-md" />
            <Skeleton className="h-14 w-full rounded-md" />
          </div>
        ) : stats ? (
          <div className="divide-y border-y" style={{ borderColor: 'var(--border)' }}>
            <StorageUsageRow icon={HardDrive} label=".mo-gallery 总占用" value={formatBytes(stats.internal.bytes)} detail={`${stats.internal.fileCount} 个文件`} />
            <StorageUsageRow icon={Database} label="资源库数据" value={formatBytes(stats.libraryData.bytes)} detail={`${stats.libraryData.fileCount} 个文件 · 不可作为缓存清理`} />
            <StorageUsageRow icon={Images} label="网格缩略图" value={formatBytes(stats.thumbnails.bytes)} detail={`${stats.thumbnails.fileCount} 个文件 · 长期保留以保证浏览速度`} />
            <StorageUsageRow icon={ImageIcon} label="大图预览" value={formatBytes(stats.previews.bytes)} detail={`${stats.previews.fileCount} 个文件 · 空间上限 ${formatBytes(stats.previewLimitBytes)}`} />
          </div>
        ) : (
          <div className="rounded-md border border-dashed px-4 py-6 text-center" style={{ borderColor: 'var(--border)' }}>
            <p className="text-xs font-medium">当前未打开本地资源库</p>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{localCacheInfo.error || '打开资源库后可查看实际磁盘占用。'}</p>
          </div>
        )}

        <div className="flex justify-end">
          <button type="button" onClick={onManageCache} className={btnOutline}>
            <Database size={13} />
            管理缓存
            <ChevronRight size={13} />
          </button>
        </div>
      </Section>
    </div>
  )
}

function StorageUsageRow({ icon: Icon, label, value, detail }: {
  icon: typeof Database
  label: string
  value: string
  detail: string
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: 'var(--muted)' }}>
        <Icon size={15} style={{ color: 'var(--muted-foreground)' }} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{label}</p>
        <p className="mt-0.5 text-[10px] leading-4" style={{ color: 'var(--muted-foreground)' }}>{detail}</p>
      </div>
      <span className="shrink-0 text-xs font-medium tabular-nums">{value}</span>
    </div>
  )
}
