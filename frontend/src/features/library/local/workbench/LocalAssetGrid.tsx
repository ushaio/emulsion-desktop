import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, Copy, File, FileImage, FilePenLine, Film, Folder, FolderInput, FolderOpen, FolderSearch2, Loader2, Music, Play, RefreshCw, RotateCcw, Scissors, Settings2, Trash2, Upload } from 'lucide-react'
import { CloudIcon, CloudOffIcon, CloudWarningIcon } from '@/components/icons/CloudIcons'
import { LivePhotoCanvas } from '@/components/media/LivePhotoCanvas'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/ContextMenu'
import { LivePhotoIcon } from '@/components/icons/LivePhotoIcon'
import { formatTimecode, isAudioAsset, isPhotoAsset, isVideoAsset } from '../types'
import type { FolderItem, LocalAsset } from '../types'
import type { types as wailsTypes } from '../../../../../wailsjs/go/models'
import { LibraryCountBar, LibraryEmptyState, formatLibraryCardSize, LibraryCardBadge, LibraryCardCaption, LibraryCardCheckbox, LibraryCardFavorite, LibraryCardFocusRing, LibraryJustifiedFiller, libraryJustifiedContainerClassName, libraryJustifiedTileStyle, libraryThumbnailClassName, libraryTileStyle } from '@/components/ui/library'
import type { LocalLibraryCopy } from '../copy'
import { captureAndUploadVideoPoster } from './poster'

const MASONRY_COLUMN_GAP = 4
const MASONRY_CARD_CAPTION_HEIGHT = 0
const MASONRY_CARD_MARGIN = 4

interface Props {
  assets: LocalAsset[]
  folders: FolderItem[]
  selectedIds: string[]
  focusedId?: string
  loading: boolean
  total: number
  copy: LocalLibraryCopy
  emptyTitle?: string
  emptyHint?: string
  canUpload: boolean
  storageSources: wailsTypes.StorageSourceDTO[]
  storageSourcesLoading: boolean
  viewMode: 'crop' | 'fit' | 'masonry'
  gridSize: number
  pathSegments: string[]
  resetKey: string
  directFolderOnly: boolean
  onToggleDirectFolderOnly: (value: boolean) => void
  onSelect: (asset: LocalAsset, intent?: { toggle?: boolean, range?: boolean }) => void
  onOpen: (asset: LocalAsset) => void
  onOpenFolder: (folder: FolderItem) => void
  onOpenInFileManager: (asset: LocalAsset) => void
  onClipboard: (asset: LocalAsset) => void
  onUpload: (asset: LocalAsset) => void
  onUploadSettings: (asset: LocalAsset) => void
  onUploadToStorage: (asset: LocalAsset, storageSourceId: string) => void
  onRefreshStorageSources: () => void
  onDelete: (asset: LocalAsset) => void
  onRename: (asset: LocalAsset) => void
  onMove: (asset: LocalAsset) => void
  onRestore: (asset: LocalAsset) => void
  onRetryPreview: (asset: LocalAsset) => void
  onRecheckMissing: (asset: LocalAsset) => void
  onRemoveMissing: (asset: LocalAsset) => void
}

export interface AssetCardProps {
  asset: LocalAsset
  dragIds: string[]
  selected: boolean
  focused: boolean
  copy: LocalLibraryCopy
  canUpload: boolean
  storageSources: wailsTypes.StorageSourceDTO[]
  storageSourcesLoading: boolean
  viewMode: 'crop' | 'fit' | 'masonry'
  gridSize: number
  onSelect: (asset: LocalAsset, intent?: { toggle?: boolean, range?: boolean }) => void
  onOpen: (asset: LocalAsset) => void
  onOpenInFileManager: (asset: LocalAsset) => void
  onClipboard: (asset: LocalAsset) => void
  onUpload: (asset: LocalAsset) => void
  onUploadSettings: (asset: LocalAsset) => void
  onUploadToStorage: (asset: LocalAsset, storageSourceId: string) => void
  onRefreshStorageSources: () => void
  onDelete: (asset: LocalAsset) => void
  onRename: (asset: LocalAsset) => void
  onMove: (asset: LocalAsset) => void
  onRestore: (asset: LocalAsset) => void
  onRetryPreview: (asset: LocalAsset) => void
  onRecheckMissing: (asset: LocalAsset) => void
  onRemoveMissing: (asset: LocalAsset) => void
}

const AssetCard = memo(function AssetCard({
  asset, dragIds, selected, focused, copy, canUpload, storageSources, storageSourcesLoading, viewMode, gridSize,
  onSelect, onOpen, onOpenInFileManager, onClipboard, onUpload, onUploadSettings, onUploadToStorage, onRefreshStorageSources, onDelete, onRename, onMove, onRestore, onRetryPreview, onRecheckMissing, onRemoveMissing,
}: AssetCardProps) {
  const [failedThumbnailUrl, setFailedThumbnailUrl] = useState<string | null>(null)
  const [hovering, setHovering] = useState(false)
  const [liveVideoEnded, setLiveVideoEnded] = useState(false)
  // 视频缩略图在 poster 上传前会 404；previewStatus 变化（pending → ready）
  // 时必须清除失败标记并强制 <img> 重挂载，否则卡片会一直停在占位图标。
  const imageFailed = failedThumbnailUrl === asset.thumbnailUrl
  useEffect(() => {
    setFailedThumbnailUrl(null)
  }, [asset.thumbnailUrl, asset.previewStatus])

  const label = asset.displayTitle || asset.fileName
  const isPhoto = isPhotoAsset(asset)
  const isVideo = isVideoAsset(asset)
  const isAudio = isAudioAsset(asset)
  const isLive = asset.isLivePhoto && !!asset.livePhotoVideoUrl
  const masonry = viewMode === 'masonry'
  const unavailable = asset.availability !== 'active'
  const missing = asset.availability === 'missing'
  const trashed = asset.availability === 'trashed'
  const previewUnavailable = asset.availability === 'active' && asset.previewStatus === 'unavailable'

  // Video thumbnails are frontend-captured poster frames; a mounted card with
  // a pending preview warms its own poster through the throttled capture queue.
  useEffect(() => {
    if (!isVideo || asset.previewStatus !== 'pending' || asset.availability !== 'active') return
    void captureAndUploadVideoPoster(asset)
  }, [asset, isVideo])

  const aspectRatio = isPhoto && asset.width > 0 && asset.height > 0 ? `${asset.width} / ${asset.height}` : undefined
  const ratio = isPhoto && asset.width > 0 && asset.height > 0 ? asset.width / asset.height : 4 / 3
  // 瓦片壳：瀑布流列内块随图比例；完整比例（设计稿 .just）高度固定、宽度随比例；
  // 裁切为方形瓦片。
  const shellClass = masonry
    ? 'mb-1 inline-block w-full break-inside-avoid align-top'
    : viewMode === 'fit'
      ? 'inline-block align-top'
      : 'h-full w-full'
  const shellStyle = masonry
    ? { aspectRatio: aspectRatio ?? '4 / 3' }
    : viewMode === 'fit'
      ? libraryJustifiedTileStyle(ratio, gridSize)
      : undefined
  const showLiveVideo = isLive && hovering && asset.availability === 'active' && !liveVideoEnded

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          draggable={asset.availability === 'active'}
          onDragStart={(event) => {
            if (asset.availability !== 'active') return
            // 集合/标签/收藏目标使用 dropEffect='link'，文件夹目标使用 'move'，
            // 因此源必须同时允许 link 与 move，否则引擎会取消投放（drop 不触发）。
            event.dataTransfer.effectAllowed = 'linkMove'
            const payload = JSON.stringify(dragIds)
            event.dataTransfer.setData('application/x-mo-gallery-asset-ids', payload)
            // WebView2 对纯自定义数据类型支持不稳定，写入标准类型确保负载能传送到投放目标。
            event.dataTransfer.setData('application/json', payload)
          }}
          onClick={(event) => {
            onSelect(asset, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey })
          }}
          onKeyDown={(event) => {
            if (event.key !== ' ' || event.target !== event.currentTarget) return
            event.preventDefault()
            onSelect(asset, { toggle: true })
          }}
          onDoubleClick={() => { if (!missing && !trashed) onOpen(asset) }}
          onMouseEnter={() => { setHovering(true); setLiveVideoEnded(false) }}
          onMouseLeave={() => { setHovering(false); setLiveVideoEnded(false) }}
          className={`group relative min-w-0 overflow-hidden rounded-md text-left transition focus:outline-none ${shellClass}`}
          style={{
            ...libraryTileStyle(),
            ...shellStyle,
          }}
        >
          <span className="block h-full w-full">
            {(isPhoto || isVideo) && !imageFailed && asset.previewStatus !== 'unavailable' ? (
              // 只要不是明确生成失败，就渲染 img 去请求缩略图，让处于 pending/generating
              // 的可见资产主动触发 /__local-library/thumbnail 请求，后端便以「可见」优先级
              // 优先生成，而不是等后台预热按序补齐（否则可见优先形同虚设）。
              // 视频的缩略图来自前端截帧上传的 poster，同样走这条请求路径。
              <img key={`${asset.thumbnailUrl}-${asset.previewStatus}`} src={asset.thumbnailUrl} alt={label} loading="lazy" draggable={false} onError={() => setFailedThumbnailUrl(asset.thumbnailUrl)} className={libraryThumbnailClassName(viewMode)} />
            ) : (
              <span className="flex h-full w-full flex-col items-center justify-center gap-2" style={{ color: 'var(--muted-foreground)' }}>
                {isVideo ? <Film size={25} strokeWidth={1.4} /> : isAudio ? <Music size={25} strokeWidth={1.4} /> : isPhoto ? <FileImage size={25} strokeWidth={1.4} /> : <File size={25} strokeWidth={1.4} />}
                <span className="max-w-[85%] truncate text-[10px] uppercase tracking-wider">{asset.format}</span>
              </span>
            )}
          </span>
          {showLiveVideo && (
            <LivePhotoCanvas
              src={asset.livePhotoVideoUrl!}
              active
              onEnded={() => setLiveVideoEnded(true)}
              className="pointer-events-none absolute inset-0 h-full w-full object-cover"
            />
          )}
          <LibraryCardCheckbox
            selected={selected}
            onToggle={() => onSelect(asset, { toggle: true })}
            label={selected ? copy.deselectLoaded : copy.selectLoaded}
          />
          <span className="absolute right-2 top-2 z-20 flex items-center gap-1">
            {isLive && <LibraryCardBadge title="Live Photo"><LivePhotoIcon size={13} /></LibraryCardBadge>}
            {asset.isAnimated && <LibraryCardBadge title="GIF"><Play size={11} fill="currentColor" /></LibraryCardBadge>}
            {asset.clipCount ? <LibraryCardBadge title={copy.clips.withClipsBadge.replace('{count}', String(asset.clipCount))} color="#38bdf8"><Scissors size={10} /> {asset.clipCount}</LibraryCardBadge> : null}
            {(isVideo || isAudio) && asset.durationMs ? <LibraryCardBadge title={copy.clips.durationLabel}>{formatTimecode(asset.durationMs)}</LibraryCardBadge> : null}
            {asset.cloudSyncState === 'deleted_remote'
              ? <LibraryCardBadge title={copy.cloudDeletedRemote} color="#f87171"><CloudOffIcon size={13} /></LibraryCardBadge>
              : asset.cloudSyncState === 'conflict'
                ? <LibraryCardBadge title={copy.cloudSyncConflict} color="#fbbf24"><CloudWarningIcon size={13} /></LibraryCardBadge>
                : (asset.uploadStatus === 'uploaded' || asset.isUploaded)
                  ? <LibraryCardBadge title={copy.filterUploaded}><CloudIcon size={13} /></LibraryCardBadge>
                  : null}
            <LibraryCardBadge>{asset.extension.replace('.', '')}</LibraryCardBadge>
          </span>
          {asset.isFavorite && <LibraryCardFavorite />}
          <LibraryCardFocusRing active={selected || focused} />
          <LibraryCardCaption name={label} meta={formatLibraryCardSize(asset.byteSize)} />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel className="max-w-64 truncate">{asset.fileName}</ContextMenuLabel>
        <ContextMenuSeparator />
        {missing ? (
          <>
            <ContextMenuItem onSelect={() => onRecheckMissing(asset)}><RefreshCw size={14} />{copy.recheckMissing}</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => onRemoveMissing(asset)}><Trash2 size={14} />{copy.removeMissingRecord}</ContextMenuItem>
          </>
        ) : trashed ? (
          <>
            {asset.trashEntryKind === 'folder' && <ContextMenuLabel className="max-w-64 whitespace-normal text-[10px] font-normal leading-4 text-muted-foreground">{copy.folderBatchHint}</ContextMenuLabel>}
            <ContextMenuItem onSelect={() => onRestore(asset)}><RotateCcw size={14} />{copy.restoreTrashedAsset}</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => onDelete(asset)}><Trash2 size={14} />{copy.permanentTrashedAsset}</ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuItem onSelect={() => onClipboard(asset)}><Copy size={14} />{copy.copyAsset}</ContextMenuItem>
            <ContextMenuItem onSelect={() => onOpenInFileManager(asset)}><FolderSearch2 size={14} />{copy.openInFileManager}</ContextMenuItem>
            <ContextMenuItem onSelect={() => onRename(asset)}><FilePenLine size={14} />{copy.renameAsset}</ContextMenuItem>
            <ContextMenuItem onSelect={() => onMove(asset)}><FolderInput size={14} />{copy.moveAssetsToFolder}</ContextMenuItem>
            {canUpload && isPhoto && (
            <ContextMenuSub>
              <ContextMenuSubTrigger onPointerEnter={() => {
                if (!storageSourcesLoading && storageSources.length === 0) onRefreshStorageSources()
              }}><Upload size={14} />{copy.uploadTo}</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuItem onSelect={() => onUpload(asset)}><Upload size={14} />{copy.uploadPage}</ContextMenuItem>
                <ContextMenuItem onSelect={() => onUploadSettings(asset)}><Settings2 size={14} />{copy.uploadSettings}</ContextMenuItem>
                <ContextMenuSeparator />
                {storageSourcesLoading ? (
                  <ContextMenuItem disabled><Loader2 size={14} className="animate-spin" />{copy.loadingStorageSources}</ContextMenuItem>
                ) : storageSources.length > 0 ? storageSources.map((source) => (
                  <ContextMenuItem key={source.id} onSelect={() => onUploadToStorage(asset, source.id)}>{source.name} ({source.type})</ContextMenuItem>
                )) : (
                  <ContextMenuItem disabled>{copy.noStorageSources}</ContextMenuItem>
                )}
              </ContextMenuSubContent>
            </ContextMenuSub>
            )}
            {previewUnavailable && isPhoto && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onRetryPreview(asset)}><RefreshCw size={14} />{copy.retryPreview}</ContextMenuItem>
              </>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => onDelete(asset)}><Trash2 size={14} />{copy.delete}</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
})

const FolderStripCard = memo(function FolderStripCard({ folder, copy, onOpen, cardWidth }: {
  folder: FolderItem
  copy: LocalLibraryCopy
  onOpen: (folder: FolderItem) => void
  cardWidth: number
}) {
  return (
    <button
      type="button"
      aria-label={`${copy.openFolder}: ${folder.name}`}
      title={copy.doubleClickOpenFolder}
      data-local-library-import-folder={folder.relativePath}
      onDoubleClick={() => onOpen(folder)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onOpen(folder)
        }
      }}
      className="group flex h-full shrink-0 flex-col overflow-hidden rounded-lg border bg-card text-left transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40"
      style={{ width: cardWidth, borderColor: 'color-mix(in srgb, var(--border) 65%, transparent)', '--wails-drop-target': 'drop' } as CSSProperties}
    >
      <span className="flex min-h-0 flex-1 items-center justify-center bg-secondary/60">
        <Folder size={36} strokeWidth={1.25} style={{ color: 'var(--primary)' }} />
      </span>
      <span className="block w-full px-2.5 py-1.5">
        <span className="block truncate text-xs font-medium">{folder.name}</span>
        <span className="mt-0.5 block truncate text-[10px]" style={{ color: 'var(--muted-foreground)' }}>{folder.assetCount.toLocaleString()} {copy.assets}</span>
      </span>
    </button>
  )
})

function estimateMasonryEntryHeight(asset: LocalAsset, columnWidth: number) {
  const aspectRatio = isPhotoAsset(asset) && asset.width > 0 && asset.height > 0
    ? asset.width / asset.height
    : 4 / 3

  return Math.round(columnWidth / aspectRatio) + MASONRY_CARD_CAPTION_HEIGHT + MASONRY_CARD_MARGIN
}

function distributeMasonryEntries(assets: LocalAsset[], columnCount: number, columnWidth: number) {
  const columns = Array.from({ length: columnCount }, () => [] as LocalAsset[])
  const heights = Array.from({ length: columnCount }, () => 0)

  for (const asset of assets) {
    let targetColumn = 0
    for (let index = 1; index < heights.length; index += 1) {
      if (heights[index] < heights[targetColumn]) targetColumn = index
    }

    columns[targetColumn].push(asset)
    heights[targetColumn] += estimateMasonryEntryHeight(asset, columnWidth)
  }

  return columns
}

/**
 * 与 index.css 里隐藏一体化标题栏的两条规则一一对应。两者都会让内容区在叠加层
 * 打开期间多出标题栏的高度（36px），那是叠加层造成的假变化，网格不应据此重排。
 */
const WINDOW_CHROME_HIDDEN_BODY_CLASSES = ['mo-fullscreen-preview', 'mo-immersive']

function isWindowChromeHidden() {
  return WINDOW_CHROME_HIDDEN_BODY_CLASSES.some((name) => document.body.classList.contains(name))
}

export function LocalAssetGrid({
  assets, folders, selectedIds, focusedId, loading, total, copy, emptyTitle, emptyHint, canUpload, storageSources, storageSourcesLoading, viewMode, gridSize, pathSegments, resetKey, directFolderOnly, onToggleDirectFolderOnly,
  onSelect, onOpen, onOpenFolder, onOpenInFileManager, onClipboard, onUpload, onUploadSettings, onUploadToStorage, onRefreshStorageSources, onDelete, onRename, onMove, onRestore, onRetryPreview, onRecheckMissing, onRemoveMissing,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const assetScrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(900)
  const [height, setHeight] = useState(600)

  useEffect(() => {
    const element = rootRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width)
      // 高度只反映「窗口有多大」，不反映叠加层是否收起了窗口标题栏。
      // 大屏预览与沉浸模式靠隐藏一体化标题栏来腾地方（index.css 里
      // body.mo-fullscreen-preview / body.mo-immersive 两条规则），那会让本容器
      // 临时高出标题栏那 36px。这是叠加层自己的布局变化，不是用户改了窗口大小；
      // 一旦采纳，关闭预览时它要晚一帧（ResizeObserver → setState → 重渲染）
      // 才回退，文件夹条与下方网格就会抖一下 —— 滚到顶部时最明显，因为不在顶部
      // 时浏览器会自动补偿滚动位置。叠加层不透明，期间的高度本来也看不见，
      // 故直接不采纳，关闭时高度已与状态相同，连重渲染都不会发生。
      if (isWindowChromeHidden()) return
      setHeight(entry.contentRect.height)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const columns = Math.max(1, Math.floor((width - 24) / gridSize))
  const columnWidth = Math.max(1, (width - 24 - Math.max(0, columns - 1) * 4) / columns)
  // 与设计稿一致：方形瓦片无标题行，列间距 4px（gap-1）+ 行底 pb-1。
  const rowHeight = Math.round(columnWidth) + 4
  const rowCount = Math.ceil(assets.length / columns)
  const isMasonry = viewMode === 'masonry'
  // 文件夹区固定占用内容区约 1/4 高度，横向滚动展示
  const folderStripHeight = folders.length > 0 ? Math.max(112, Math.min(192, Math.round(Math.max(0, height) / 4))) : 0
  const folderCardWidth = Math.max(84, Math.min(168, Math.round(folderStripHeight * 0.78)))
  const masonryColumns = useMemo(
    () => distributeMasonryEntries(assets, columns, columnWidth),
    [assets, columnWidth, columns],
  )
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => assetScrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 3,
  })
  const rows = virtualizer.getVirtualItems()

  useEffect(() => {
    virtualizer.measure()
  }, [rowHeight, virtualizer])

  useEffect(() => {
    assetScrollRef.current?.scrollTo({ top: 0 })
    virtualizer.scrollToOffset(0)
  }, [resetKey, virtualizer])

  const gridStyle = useMemo(() => ({ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }), [columns])
  const locationHeader = (
    <LibraryCountBar
      className="px-3"
      icon={FolderOpen}
      title={
        <span className="flex min-w-0 items-center overflow-hidden whitespace-nowrap" title={pathSegments.join(' > ')}>
          {pathSegments.map((segment, index) => (
            <span key={`${segment}-${index}`} className="contents">
              {index > 0 && <ChevronRight size={10} className="shrink-0 opacity-45" />}
              <span
                className={`min-w-0 truncate ${index === pathSegments.length - 1 ? 'font-medium' : ''}`}
                style={{ color: index === pathSegments.length - 1 ? 'var(--foreground)' : undefined }}
              >
                {segment}
              </span>
            </span>
          ))}
        </span>
      }
      count={
        <>
          {folders.length > 0 && (
            <>
              {folders.length.toLocaleString()} {copy.folders} ·{' '}
            </>
          )}
          {total.toLocaleString()} {copy.count}
        </>
      }
    />
  )

  const isEmpty = !loading && assets.length === 0
  const assetCard = (asset: LocalAsset) => (
    <AssetCard key={asset.id} asset={asset} dragIds={selectedIds.includes(asset.id) ? selectedIds.filter((id) => assets.find((item) => item.id === id)?.availability === 'active') : [asset.id]} selected={selectedIds.includes(asset.id)} focused={focusedId === asset.id} copy={copy} canUpload={canUpload} viewMode={viewMode} gridSize={gridSize}
      storageSources={storageSources} storageSourcesLoading={storageSourcesLoading}
      onSelect={onSelect} onOpen={onOpen} onOpenInFileManager={onOpenInFileManager} onClipboard={onClipboard} onUpload={onUpload} onUploadSettings={onUploadSettings} onUploadToStorage={onUploadToStorage} onRefreshStorageSources={onRefreshStorageSources} onDelete={onDelete} onRename={onRename} onMove={onMove} onRestore={onRestore}
      onRetryPreview={onRetryPreview} onRecheckMissing={onRecheckMissing} onRemoveMissing={onRemoveMissing} />
  )
  const folderStrip = folderStripHeight > 0 && (
    <div className="shrink-0 border-b" style={{ borderColor: 'var(--border)', height: folderStripHeight }}>
      <div className="custom-scrollbar h-full overflow-x-auto overflow-y-hidden px-3 pb-1.5 pt-1.5">
        <div className="flex h-full items-stretch gap-2.5">
          {folders.map((folder) => (
            <FolderStripCard key={folder.id} folder={folder} copy={copy} onOpen={onOpenFolder} cardWidth={folderCardWidth} />
          ))}
        </div>
      </div>
    </div>
  )
  // 网格区域的外层内边距。文件夹条以下是一条硬分割线，首行贴着线会显得被压住，
  // 故有文件夹条时补上间距（与下方 pb-4 对称）。
  // 没有文件夹条时不补：计数条自身的 mb-1 是刻意留小的，只为避免首行卡片的
  // focus 轮廓被遮住（见 LibraryCountBar 的组件注释），不该顺手改掉那个节奏。
  const gridAreaClassName = folderStripHeight > 0 ? 'px-3 pb-4 pt-4' : 'px-3 pb-4'

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-col overflow-hidden" data-local-library-guide="grid">
      <div ref={assetScrollRef} className="custom-scrollbar min-h-0 flex-1 overflow-y-auto">
        {locationHeader}
        {folderStrip}
        <div className={gridAreaClassName}>
        {isEmpty ? (
          <div className="flex items-center justify-center px-8 py-16">
            <LibraryEmptyState
              icon={FileImage}
              title={emptyTitle || copy.empty}
              description={emptyHint || copy.emptyHint}
            />
          </div>
        ) : (
          <>
            {loading && assets.length === 0 ? (
              <div className="grid gap-1" style={gridStyle} aria-label={copy.loading}>
                {Array.from({ length: Math.min(12, Math.max(columns * 2, 6)) }, (_, index) => (
                  <div key={index} className="aspect-square animate-pulse overflow-hidden rounded-md bg-secondary/70" />
                ))}
              </div>
            ) : isMasonry ? (
              <>
                <div className="flex items-start" style={{ gap: MASONRY_COLUMN_GAP }}>
                  {masonryColumns.map((columnAssets, columnIndex) => (
                    <div key={columnIndex} className="min-w-0 flex-1">
                      {columnAssets.map((asset) => assetCard(asset))}
                    </div>
                  ))}
                </div>
              </>
            ) : viewMode === 'fit' ? (
              <div className={libraryJustifiedContainerClassName()}>
                {assets.map((asset) => assetCard(asset))}
                <LibraryJustifiedFiller />
              </div>
            ) : (
              <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
                {rows.map((row) => {
                  const start = row.index * columns
                  const rowAssets = assets.slice(start, start + columns)
                  return (
                    <div key={row.key} ref={virtualizer.measureElement} data-index={row.index} className="absolute left-0 top-0 grid w-full gap-1 pb-1"
                      style={{ ...gridStyle, height: rowHeight, transform: `translateY(${row.start}px)` }}>
                      {rowAssets.map((asset) => assetCard(asset))}
                    </div>
                  )
                })}
              </div>
            )}
            {loading && <div className="flex items-center justify-center gap-2 py-5 text-xs" style={{ color: 'var(--muted-foreground)' }}><Loader2 size={14} className="animate-spin" />{copy.loading}</div>}
          </>
        )}
        </div>
      </div>
    </div>
  )
}
