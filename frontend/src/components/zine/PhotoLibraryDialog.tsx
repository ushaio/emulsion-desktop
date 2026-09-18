import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Cloud, HardDrive, X } from 'lucide-react'

import { t } from '@/lib/i18n'
import { resolveAssetUrl } from '@/lib/api/core'
import type { ZineAsset } from '@/lib/zine/types'
import { usePreferences } from '@/store/preferences'
import { CloudLibrary } from '@/features/library/cloud/CloudLibrary'
import { LocalLibrary } from '@/features/library/local/LocalLibrary'
import type { LocalAsset } from '@/features/library/local/types'
import type { Photo } from '@/types'
import { GlassBackdrop } from '@/components/ui/liquid-glass'
import { cn } from '@/lib/utils'


export type LibrarySource = 'cloud' | 'local-library'

interface PhotoLibraryDialogBaseProps {
  source: LibrarySource | null
  onClose: () => void
  /**
   * 弹窗内可切换的取图来源（顶部 tab）。缺省只含当前 source，不显示切换控件。
   * 调用方按可用性裁剪（未连接站点时不传 'cloud'）。
   */
  sources?: LibrarySource[]
  /**
   * 用户切换来源时通知父级；父级必须同步更新受控的 source，
   * 否则下一次渲染会因 source 未变而把选择切回来。
   */
  onSourceChange?: (source: LibrarySource) => void
}

interface ZinePhotoLibraryDialogProps extends PhotoLibraryDialogBaseProps {
  existingAssets: ZineAsset[]
  onImportAssets: (assets: ZineAsset[]) => void
  existingPhotoIds?: never
  onImportPhotos?: never
}

interface CloudPhotoLibraryDialogProps extends PhotoLibraryDialogBaseProps {
  source: 'cloud' | null
  existingPhotoIds: string[]
  onImportPhotos: (photos: Photo[]) => void
  existingAssets?: never
  onImportAssets?: never
}

/** 本地资源库导入（如叙事编辑器离线选图）：返回原始 LocalAsset，由调用方决定落地方式 */
interface LocalPhotoLibraryDialogProps extends PhotoLibraryDialogBaseProps {
  source: 'local-library' | null
  existingLocalAssetIds?: string[]
  onImportLocalAssets: (assets: LocalAsset[]) => void
  existingPhotoIds?: never
  onImportPhotos?: never
  existingAssets?: never
  onImportAssets?: never
}

/**
 * 双来源：云端与本地资源库都可选，在弹窗内切换，各有独立回调。
 * 编辑器素材库用这个变体 —— 已连接站点时两个入口都开；未连接时只留本地资源库。
 */
interface DualPhotoLibraryDialogProps extends PhotoLibraryDialogBaseProps {
  existingPhotoIds?: string[]
  onImportPhotos?: (photos: Photo[]) => void
  onImportLocalAssets?: (assets: LocalAsset[]) => void
  existingAssets?: never
  onImportAssets?: never
  existingLocalAssetIds?: never
}

type PhotoLibraryDialogProps =
  | ZinePhotoLibraryDialogProps
  | CloudPhotoLibraryDialogProps
  | LocalPhotoLibraryDialogProps
  | DualPhotoLibraryDialogProps

function cloudPhotoToZineAsset(photo: Photo): ZineAsset {
  return {
    id: `library_${photo.id}`,
    source: 'library',
    origin: 'cloud-library',
    libraryPhotoId: photo.id,
    fileName: photo.title || photo.id,
    width: photo.width || 0,
    height: photo.height || 0,
    previewUrl: resolveAssetUrl(photo.thumbnailUrl || photo.url),
    fullUrl: resolveAssetUrl(photo.url),
    createdAt: Date.now(),
  }
}

function localPhotoToZineAsset(asset: LocalAsset): ZineAsset {
  return {
    id: `local-library_${asset.id}`,
    source: 'library',
    origin: 'local-library',
    libraryPhotoId: asset.id,
    fileName: asset.displayTitle || asset.fileName,
    width: asset.width,
    height: asset.height,
    previewUrl: asset.thumbnailUrl || asset.previewUrl,
    fullUrl: asset.originalUrl,
    createdAt: Date.now(),
  }
}

export function PhotoLibraryDialog(props: PhotoLibraryDialogProps) {
  const { source, onClose, sources, onSourceChange } = props
  const language = usePreferences((state) => state.language)
  const [selectedCloudPhotos, setSelectedCloudPhotos] = useState<Photo[]>([])
  const [selectedLocalAssets, setSelectedLocalAssets] = useState<LocalAsset[]>([])
  const [selectionSource, setSelectionSource] = useState(source)

  // 受控同步：父级改变 source（打开/关闭/换源）时对齐内部状态并清空选择
  if (source !== selectionSource) {
    setSelectionSource(source)
    setSelectedCloudPhotos([])
    setSelectedLocalAssets([])
  }

  useEffect(() => {
    if (!source) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, source])
  const handleCloudSelection = useCallback((photos: Photo[]) => {
    setSelectedCloudPhotos(photos)
  }, [])
  const handleLocalSelection = useCallback((assets: LocalAsset[]) => {
    setSelectedLocalAssets(assets)
  }, [])

  /** 只有多来源且父级能同步受控值时才显示切换 tab */
  const availableSources = sources && sources.length > 1 && onSourceChange ? sources : []
  const handleSwitchSource = useCallback((next: LibrarySource) => {
    setSelectionSource(next)
    setSelectedCloudPhotos([])
    setSelectedLocalAssets([])
    onSourceChange?.(next)
  }, [onSourceChange])

  const existingCloudIds = 'existingPhotoIds' in props
    ? (props.existingPhotoIds ?? [])
    : 'existingAssets' in props
      ? (props.existingAssets ?? [])
        .filter((asset) => asset.origin === 'cloud-library' || (!asset.origin && asset.id.startsWith('library_')))
        .map((asset) => asset.libraryPhotoId ?? asset.id.replace(/^library_/, ''))
      : []
  const existingLocalIds = 'existingLocalAssetIds' in props
    ? (props.existingLocalAssetIds ?? [])
    : 'existingAssets' in props
      ? (props.existingAssets ?? [])
        .filter((asset) => asset.origin === 'local-library' || (!asset.origin && asset.id.startsWith('local-library_')))
        .map((asset) => asset.libraryPhotoId ?? asset.id.replace(/^local-library_/, ''))
      : []

  if (!source || typeof document === 'undefined') return null

  const cloud = source === 'cloud'
  const title = t(cloud ? 'admin.zine_import_cloud' : 'admin.zine_import_local_library', language)
  const Icon = cloud ? Cloud : HardDrive
  const selectedCount = cloud ? selectedCloudPhotos.length : selectedLocalAssets.length
  function handleImport() {
    if (cloud) {
      if ('onImportPhotos' in props) props.onImportPhotos?.(selectedCloudPhotos)
      else if ('onImportAssets' in props) props.onImportAssets?.(selectedCloudPhotos.map(cloudPhotoToZineAsset))
    } else {
      if ('onImportLocalAssets' in props) props.onImportLocalAssets?.(selectedLocalAssets)
      else if ('onImportAssets' in props) props.onImportAssets?.(selectedLocalAssets.map(localPhotoToZineAsset))
    }
    onClose()
  }

  return createPortal(
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="fixed inset-0 z-[120] bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="pointer-events-none fixed inset-0 z-[121] flex items-center justify-center p-4">
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          initial={{ opacity: 0, scale: 0.97, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          className="lg-sheet pointer-events-auto flex h-[min(90vh,900px)] w-[min(96vw,1400px)] flex-col overflow-hidden rounded-lg border bg-background shadow-2xl"
          style={{ borderColor: 'var(--border)' }}
        ><GlassBackdrop material="regular" />
          <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4" style={{ borderColor: 'var(--border)' }}>
            <Icon size={16} style={{ color: 'var(--muted-foreground)' }} />
            <h2 className="min-w-0 max-w-[40%] truncate text-sm font-semibold">{title}</h2>
            {availableSources.length > 1 ? (
              <div className="flex shrink-0 items-center gap-0.5 rounded-md border p-0.5" style={{ borderColor: 'var(--border)' }}>
                {availableSources.map((item) => {
                  const active = item === source
                  const SourceIcon = item === 'cloud' ? Cloud : HardDrive
                  return (
                    <button
                      key={item}
                      type="button"
                      onClick={() => handleSwitchSource(item)}
                      aria-pressed={active}
                      className={cn(
                        'flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors',
                        active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <SourceIcon size={12} />
                      {t(item === 'cloud' ? 'admin.zine_source_cloud' : 'admin.zine_source_local_library', language)}
                    </button>
                  )
                })}
              </div>
            ) : null}
            <div className="min-w-0 flex-1" />
            <button type="button" onClick={onClose} aria-label={t('common.close', language)} title={t('common.close', language)} className="flex h-8 w-8 items-center justify-center rounded-md transition hover:bg-accent">
              <X size={16} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {cloud ? (
              <CloudLibrary selectionMode existingPhotoIds={existingCloudIds} onSelectionChange={handleCloudSelection} />
            ) : (
              <LocalLibrary selectionMode existingAssetIds={existingLocalIds} onSelectionChange={handleLocalSelection} />
            )}
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-3" style={{ borderColor: 'var(--border)' }}>
            <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{t('admin.zine_selected_count', language, { count: selectedCount })}</span>
            <button type="button" disabled={selectedCount === 0} onClick={handleImport} className="rounded-md px-4 py-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>{t('admin.zine_import_selected', language)}</button>
          </div>
        </motion.div>
      </div>
    </>,
    document.body,
  )
}
