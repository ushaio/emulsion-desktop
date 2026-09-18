'use client'

import React, { useState } from 'react'
import {
  Plus,
  Image as ImageIcon,
  Loader2,
  Calendar,
  Upload,
  RefreshCw,
  MoreVertical,
  HardDrive,
  Star,
  ImagePlus,
  Trash2,
} from 'lucide-react'
import { resolveAssetUrl } from '@/lib/api/core'
import type { StoryDto, PhotoDto } from '@/lib/api/types'
import { getStoryImageMatchCandidates, getStoryMarkdownImageUrls, getStoryReferencedPhotoIds } from '@/lib/story-rich-content'
import { getMilkdownPhotoIds, getMilkdownUploadIds } from '@mo-gallery/milkdown/media'
import { AdminButton } from '@/components/admin/AdminButton'
import { cn } from '@/lib/utils'
import { GlassBackdrop } from '@/components/ui/liquid-glass'
import { LibraryCardBadge, LibraryCardFocusRing, libraryTileStyle } from '@/components/ui/library'
import { pendingDisplayName, type PendingImage } from '@/lib/editor-pending-import'

// 待传项契约（含本地资源库来源）在 lib/editor-pending-import.ts 统一定义，Blog/Story 共用。
export type { PendingImage }

interface StoryPhotoPanelProps {
  disabled: boolean
  isCollapsed: boolean
  isImmersiveMode: boolean
  currentStory: StoryDto | null
  editorContent: string
  pendingImages: PendingImage[]
  pendingCoverId: string | null
  cdnDomain?: string
  isUploading: boolean
  uploadProgress: { current: number; total: number; currentFile: string }
  isDraggingOver: boolean
  draggedItemId: string | null
  draggedItemType: 'photo' | 'pending' | null
  dragOverItemId: string | null
  openMenuPhotoId: string | null
  openMenuPendingId: string | null
  t: (key: string) => string
  notify: (message: string, type?: 'success' | 'error' | 'info') => void
  onAddPhotos: () => void
  onInsertPhotoMarkdown: (photo: PhotoDto) => void
  onInsertGalleryMarkdown: (photoIds: string[]) => void
  /** 把待传项作为占位卡插入正文（上传成功后原位替换为真实图片） */
  onInsertPendingPlaceholder: (pending: PendingImage) => void
  onRemovePhoto: (photoId: string) => void
  onRemovePendingImage: (id: string) => void
  onSetCover: (photoId: string) => void
  onSetPendingCover: (id: string) => void

  onSetPhotoDate: (takenAt: string) => void
  onRetryFailedUploads: () => void
  onPhotoPanelDragOver: (e: React.DragEvent) => void
  onPhotoPanelDragLeave: (e: React.DragEvent) => void
  onPhotoPanelDrop: (e: React.DragEvent) => void
  onItemDragStart: (e: React.DragEvent, itemId: string, type: 'photo' | 'pending') => void
  onItemDragEnd: (e: React.DragEvent) => void
  onItemDragOver: (e: React.DragEvent, itemId: string) => void
  onItemDragLeave: () => void
  onItemDrop: (e: React.DragEvent, targetId: string, targetType: 'photo' | 'pending') => void
  onOpenMenuPhoto: (photoId: string | null) => void
  onOpenMenuPending: (pendingId: string | null) => void
  onOpenPasteUploadSettings: () => void
  /**
   * 「立即上传」：对待传项弹出上传设置并上传。
   * 注意与 onOpenPasteUploadSettings 是两个不同的弹窗 —— 后者走的是粘贴本地文件的链路
   * （uploadAndInsertFiles），看不到素材库里的待传项，两者不能混用。
   */
  onUploadPending: () => void
}

function StoryPhotoPanelBoundary({
  disabled,
  children,
}: {
  disabled: boolean
  children: React.ReactNode
}) {
  const guardDisabledInteraction = (event: React.SyntheticEvent) => {
    if (disabled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  return (
    <fieldset
      disabled={disabled}
      aria-disabled={disabled}
      className="contents border-0 p-0"
      onClickCapture={guardDisabledInteraction}
      onDragStartCapture={guardDisabledInteraction}
      onDragEndCapture={guardDisabledInteraction}
      onDragOverCapture={guardDisabledInteraction}
      onDragLeaveCapture={guardDisabledInteraction}
      onDropCapture={guardDisabledInteraction}
    >
      {children}
    </fieldset>
  )
}

export function StoryPhotoPanel({
  disabled,
  isCollapsed,
  isImmersiveMode,
  currentStory,
  editorContent,
  pendingImages,
  pendingCoverId,
  cdnDomain,
  isUploading,
  uploadProgress,
  isDraggingOver,
  draggedItemId,
  draggedItemType,
  dragOverItemId,
  openMenuPhotoId,
  openMenuPendingId,
  t,
  notify,
  onAddPhotos,
  onInsertPhotoMarkdown,
  onInsertPendingPlaceholder,
  onRemovePhoto,
  onRemovePendingImage,
  onSetCover,
  onSetPendingCover,
  onSetPhotoDate,
  onRetryFailedUploads,
  onPhotoPanelDragOver,
  onPhotoPanelDragLeave,
  onPhotoPanelDrop,
  onItemDragStart,
  onItemDragEnd,
  onItemDragOver,
  onItemDragLeave,
  onItemDrop,
  onOpenMenuPhoto,
  onOpenMenuPending,
  onOpenPasteUploadSettings,
  onUploadPending,
}: StoryPhotoPanelProps) {
  const insertedImageUrls = getStoryMarkdownImageUrls(editorContent)
  const referencedPhotoIds = new Set([...getStoryReferencedPhotoIds(editorContent), ...getMilkdownPhotoIds(editorContent)])
  /**
   * 正文里占位卡的 uploadId 集合。待传项的 `id` 就是插卡时的 uploadId，
   * 所以「待传项已排入正文」＝ ids 里含该项 id（与已上传照片的 isPhotoInserted 同一口径）。
   * 上传成功后占位被替换成图片卡（uploadId 随之消失），但此时该项已从待传列表移除，
   * 不需要跨越这个状态变化。
   */
  const insertedUploadIds = getMilkdownUploadIds(editorContent)

  const isPendingInserted = (pending: PendingImage) => insertedUploadIds.has(pending.id)

  const isPhotoInserted = (photo: PhotoDto) => {
    if (referencedPhotoIds.has(photo.id)) {
      return true
    }

    const candidates = getStoryImageMatchCandidates({
      url: photo.url,
      thumbnailUrl: photo.thumbnailUrl,
      cdnDomain,
    })

    return Array.from(candidates).some((candidate) => insertedImageUrls.has(candidate))
  }

  const getCombinedItems = () => {
    const photoItems = (currentStory?.photos || []).map((photo) => ({ id: photo.id, type: 'photo' as const }))
    const pendingItems = pendingImages.map((image) => ({ id: image.id, type: 'pending' as const }))
    return [...photoItems, ...pendingItems]
  }

  const [filterTab, setFilterTab] = useState<'all' | 'used' | 'unused'>('all')

  const filteredItems = getCombinedItems().filter((item) => {
    if (filterTab === 'all') return true
    // 待传项与已上传照片同口径：正文里已有占位/图片即「已使用」。
    // 原先写死 `pending => unused`，会让已排进正文的待传图出现在「未使用」里。
    if (item.type === 'pending') {
      const pending = pendingImages.find((image) => image.id === item.id)
      if (!pending) return false
      const inserted = isPendingInserted(pending)
      return filterTab === 'used' ? inserted : !inserted
    }
    const photo = currentStory?.photos?.find((p) => p.id === item.id)
    if (!photo) return false
    const inserted = isPhotoInserted(photo)
    return filterTab === 'used' ? inserted : !inserted
  })

  const filterTabs = [
    { key: 'all' as const, label: t('story.material_all') },
    { key: 'used' as const, label: t('story.material_used') },
    { key: 'unused' as const, label: t('story.material_unused') },
  ]

  if (isCollapsed) {
    return null
  }

  return (
    <StoryPhotoPanelBoundary disabled={disabled}>
      <div
      className={cn(
        'flex h-full min-w-[320px] flex-col overflow-hidden border border-border bg-card',
        isDraggingOver ? 'border-primary bg-primary/5' : 'border-border',
      )}
      onDragOver={onPhotoPanelDragOver}
      onDragLeave={onPhotoPanelDragLeave}
      onDrop={onPhotoPanelDrop}
    >
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border/70 bg-card px-3 py-1">
        <div className="flex items-center gap-2">
          <ImageIcon className="h-4 w-4 text-primary" />
          <span className="text-xs font-bold uppercase tracking-[0.24em] text-foreground">
            {t('story.material_library')}
          </span>
          {pendingImages.length > 0 ? (
            /* 主题色 chip：待传数量随主题 accent 走，不再写死琥珀色。
               可点击 —— 直接把待传项交给上传队列，不必先点保存。 */
            <button
              type="button"
              onClick={onUploadPending}
              title={t('admin.upload_pending_now')}
              className="border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.2em] text-primary transition-colors hover:bg-primary/20"
            >
              {pendingImages.length} {t('admin.pending_uploads')}
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <AdminButton
            type="button"
            onClick={onOpenPasteUploadSettings}
            adminVariant="outlineMuted"
            size="xs"
            className="h-7 border-border/70 bg-background/70"
          >
            {t('admin.upload_settings')}
          </AdminButton>
          <AdminButton
            onClick={onAddPhotos}
            adminVariant="ghost"
            size="xs"
            className="flex h-7 items-center gap-1 px-2 text-primary hover:bg-primary/10"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>{t('admin.add_photos')}</span>
          </AdminButton>
        </div>
      </div>

      {isUploading ? (
        <div className="border-b border-border bg-primary/5 px-4 py-2">
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="max-w-[200px] truncate text-muted-foreground">
              {uploadProgress.currentFile}
            </span>
            <span className="font-medium text-primary">
              {uploadProgress.current}/{uploadProgress.total}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}
            />
          </div>
        </div>
      ) : null}

      {!isUploading && pendingImages.some((image) => image.status === 'failed') ? (
        <div className="flex items-center justify-between border-b border-destructive/20 bg-destructive/10 px-4 py-2">
          <span className="text-xs text-destructive">
            {pendingImages.filter((image) => image.status === 'failed').length} {t('admin.upload_failed_count')}
          </span>
          <AdminButton
            onClick={onRetryFailedUploads}
            adminVariant="link"
            className="flex items-center gap-1 text-xs text-destructive"
          >
            <RefreshCw className="h-3 w-3" />
            {t('admin.retry')}
          </AdminButton>
        </div>
      ) : null}

      {/* 素材筛选标签：全部 / 已使用 / 未使用 */}
      <div className="flex shrink-0 gap-0.5 border-b border-border/50 bg-card px-4 py-1.5">
        {filterTabs.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilterTab(key)}
            className={`rounded-md px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider transition-colors ${
              filterTab === key
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
        {filteredItems.length > 0 ? (
          /* 一行 3 张：面板 340px（宽屏 390px）时瓦片约 97–114px。
             间距取 gap-2 而非资源库全宽网格的 gap-1 —— 相邻瓦片的右下序号与左下状态角标
             之间只剩 4px 的话，两枚深色胶囊会连成一片读不出来。 */
          <div className="grid grid-cols-3 gap-2">
            {filteredItems.map((item, idx) => {
              if (item.type === 'photo') {
                const photo = currentStory?.photos?.find((current) => current.id === item.id)
                if (!photo) return null

                return (
                  <div key={photo.id} className="relative">
                    <div
                      draggable
                      onDragStart={(event) => onItemDragStart(event, photo.id, 'photo')}
                      onDragEnd={onItemDragEnd}
                      onDragOver={(event) => onItemDragOver(event, photo.id)}
                      onDragLeave={onItemDragLeave}
                      onDrop={(event) => onItemDrop(event, photo.id, 'photo')}
                      className={`group relative aspect-[4/5] cursor-grab overflow-hidden rounded-md transition-opacity active:cursor-grabbing ${
                        draggedItemId === photo.id && draggedItemType === 'photo' ? 'opacity-50' : ''
                      }`}
                      style={libraryTileStyle()}
                    >
                      {/* 更多操作（左上）：EXIF 时间等次要动作；与右上角悬停操作簇分角摆放，互不遮挡 */}
                      <AdminButton
                        onClick={(event) => {
                          event.stopPropagation()
                          onOpenMenuPhoto(openMenuPhotoId === photo.id ? null : photo.id)
                        }}
                        adminVariant="iconOnDarkCompact"
                        className="absolute left-1.5 top-1.5 z-20 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                      >
                        <MoreVertical className="h-3 w-3" />
                      </AdminButton>

                      <img
                        src={resolveAssetUrl(photo.thumbnailUrl || photo.url, cdnDomain)}
                        alt={photo.title}
                        className="h-full w-full object-cover pointer-events-none"
                      />

                      {isPhotoInserted(photo) ? (
                        <div aria-hidden className="absolute inset-0 z-10" style={{ backgroundColor: 'rgba(9,9,11,0.42)' }} />
                      ) : null}

                      {/* 状态角标（左下）：与资源库瓦片、文章列表卡片同一枚胶囊 */}
                      {currentStory?.coverPhotoId === photo.id && !pendingCoverId ? (
                        <span className="absolute bottom-2 left-2 z-20">
                          <LibraryCardBadge background="var(--primary)" color="var(--primary-foreground)">
                            {t('admin.cover')}
                          </LibraryCardBadge>
                        </span>
                      ) : null}

                      {/* 顺序角标（右下）：与文章列表卡片的「照片数」同位同形 */}
                      <span className="absolute bottom-2 right-2 z-20">
                        <LibraryCardBadge>
                          <span className="font-mono">{idx + 1}</span>
                        </LibraryCardBadge>
                      </span>

                      {/* 悬停操作（右上）：与文章列表卡片一致 —— 图标簇 + 原生提示，不铺满遮罩、不挡图 */}
                      <div className="absolute right-1.5 top-1.5 z-20 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <AdminButton
                          onClick={(event) => {
                            event.stopPropagation()
                            onSetCover(photo.id)
                          }}
                          adminVariant="iconOnDarkCompact"
                          title={t('admin.cover')}
                        >
                          <Star className="h-3 w-3" />
                        </AdminButton>
                        <AdminButton
                          onClick={(event) => {
                            event.stopPropagation()
                            onInsertPhotoMarkdown(photo)
                          }}
                          adminVariant="iconOnDarkCompact"
                          title={t('admin.insert_photo')}
                        >
                          <ImagePlus className="h-3 w-3" />
                        </AdminButton>
                        <AdminButton
                          onClick={(event) => {
                            event.stopPropagation()
                            if (isPhotoInserted(photo)) {
                              notify(t('story.material_in_use'), 'info')
                              return
                            }
                            onRemovePhoto(photo.id)
                          }}
                          adminVariant="iconOnDarkCompactDanger"
                          className={isPhotoInserted(photo) ? 'cursor-not-allowed opacity-50' : undefined}
                          title={isPhotoInserted(photo) ? t('story.material_in_use') : t('common.delete')}
                        >
                          <Trash2 className="h-3 w-3" />
                        </AdminButton>
                      </div>

                      {/* 投放高亮：画在缩略图之上、瓦片边界之内的内圈描边。
                          不用 box-shadow —— 套在图片下会被完全压住，向外扩又会与相邻瓦片互相覆盖。 */}
                      <LibraryCardFocusRing active={dragOverItemId === photo.id} />
                    </div>

                    {openMenuPhotoId === photo.id ? (
                      <>
                        <div
                          className="fixed inset-0 z-40"
                          onClick={(event) => {
                            event.stopPropagation()
                            onOpenMenuPhoto(null)
                          }}
                        />
                        <div className="absolute right-0 top-8 z-50 min-w-[160px] border border-border bg-background py-1 shadow-lg"><GlassBackdrop material="regular" />
                          {photo.takenAt ? (
                            <AdminButton
                              onClick={(event) => {
                                event.stopPropagation()
                                onSetPhotoDate(photo.takenAt!)
                                onOpenMenuPhoto(null)
                                notify(t('admin.set_publish_time_success'), 'success')
                              }}
                              adminVariant="ghost"
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted"
                            >
                              <Calendar className="h-3.5 w-3.5" />
                              {t('admin.set_as_publish_time')}
                            </AdminButton>
                          ) : (
                            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                              <Calendar className="h-3.5 w-3.5" />
                              {t('admin.no_exif_time')}
                            </div>
                          )}
                        </div>
                      </>
                    ) : null}
                  </div>
                )
              }

              const pending = pendingImages.find((image) => image.id === item.id)
              if (!pending) return null

              const isPendingCover = pendingCoverId === pending.id

              return (
                <div key={pending.id} className="relative">
                  <div
                    draggable={pending.status !== 'uploading'}
                    onDragStart={(event) => onItemDragStart(event, pending.id, 'pending')}
                    onDragEnd={onItemDragEnd}
                    onDragOver={(event) => onItemDragOver(event, pending.id)}
                    onDragLeave={onItemDragLeave}
                    onDrop={(event) => onItemDrop(event, pending.id, 'pending')}
                    className={`group relative aspect-[4/5] overflow-hidden rounded-md transition-opacity ${
                      draggedItemId === pending.id && draggedItemType === 'pending' ? 'opacity-50' : ''
                    } ${pending.status !== 'uploading' ? 'cursor-grab active:cursor-grabbing' : ''}`}
                    style={libraryTileStyle()}
                    >
                    {/* 更多操作（左上）：与照片瓦片同角同位 */}
                    {pending.status !== 'uploading' ? (
                      <AdminButton
                        onClick={(event) => {
                          event.stopPropagation()
                          onOpenMenuPending(openMenuPendingId === pending.id ? null : pending.id)
                        }}
                        adminVariant="iconOnDarkCompact"
                        className="absolute left-1.5 top-1.5 z-20 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                      >
                        <MoreVertical className="h-3 w-3" />
                      </AdminButton>
                    ) : null}

                    {pending.previewUrl ? (
                      <img src={pending.previewUrl} alt="" className="h-full w-full object-cover pointer-events-none" />
                    ) : (
                      /* 草稿恢复的本地资源库项：缩略图按 assetId 现取，取到前先占位 */
                      <div
                        className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center"
                        style={{ backgroundColor: 'var(--muted)' }}
                      >
                        <HardDrive className="h-5 w-5 opacity-40" />
                        <span className="line-clamp-2 text-[9px] leading-tight text-muted-foreground">
                          {pendingDisplayName(pending)}
                        </span>
                      </div>
                    )}

                    {/* 状态角标（左下）：待传 / 失败 / 封面 —— 状态用胶囊表达，不再借虚线边框 */}
                    <span className="absolute bottom-2 left-2 z-20 flex flex-wrap items-center gap-1">
                      {isPendingCover ? (
                        <LibraryCardBadge background="var(--primary)" color="var(--primary-foreground)">
                          {t('admin.cover')}
                        </LibraryCardBadge>
                      ) : null}
                      {pending.status === 'pending' ? (
                        /* 主题色胶囊：与「封面」同一套 var(--primary) 口径；
                           待传项被设为封面时左下角会出现两枚同色胶囊，靠文案区分 */
                        <LibraryCardBadge background="var(--primary)" color="var(--primary-foreground)">
                          {t('admin.pending_uploads')}
                        </LibraryCardBadge>
                      ) : null}
                      {pending.status === 'failed' ? (
                        <LibraryCardBadge background="#f87171">
                          {t('admin.failed')}
                        </LibraryCardBadge>
                      ) : null}
                    </span>

                    {/* 顺序角标（右下）：与文章列表卡片的「照片数」同位同形 */}
                    <span className="absolute bottom-2 right-2 z-20">
                      <LibraryCardBadge>
                        <span className="font-mono">{idx + 1}</span>
                      </LibraryCardBadge>
                    </span>

                    {/* 上传中：只有进度值得铺满遮罩，其余状态交给左下角胶囊 */}
                    {pending.status === 'uploading' ? (
                      <div
                        className="absolute inset-0 z-10 flex items-center justify-center"
                        style={{ backgroundColor: 'rgba(9,9,11,0.55)' }}
                      >
                        <div className="flex flex-col items-center">
                          <Loader2 className="h-5 w-5 animate-spin text-white" />
                          <span className="mt-1 text-[10px] text-white">{pending.progress}%</span>
                        </div>
                      </div>
                    ) : null}

                    {/* 悬停操作（右上）：与照片瓦片、文章列表卡片一致 */}
                    {pending.status !== 'uploading' ? (
                      <div className="absolute right-1.5 top-1.5 z-20 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        {!isPendingCover ? (
                          <AdminButton
                            onClick={(event) => {
                              event.stopPropagation()
                              onSetPendingCover(pending.id)
                            }}
                            adminVariant="iconOnDarkCompact"
                            title={t('admin.cover')}
                          >
                            <Star className="h-3 w-3" />
                          </AdminButton>
                        ) : null}
                        {/* 插入正文占位：待传项也能排进文章，上传成功后原位变成真图。
                            与已上传照片的「插入照片」同位同形，学习成本为零。 */}
                        <AdminButton
                          onClick={(event) => {
                            event.stopPropagation()
                            onInsertPendingPlaceholder(pending)
                          }}
                          adminVariant="iconOnDarkCompact"
                          title={t('admin.insert_photo')}
                        >
                          <ImagePlus className="h-3 w-3" />
                        </AdminButton>
                        <AdminButton
                          onClick={(event) => {
                            event.stopPropagation()
                            onRemovePendingImage(pending.id)
                          }}
                          adminVariant="iconOnDarkCompactDanger"
                          title={t('common.delete')}
                        >
                          <Trash2 className="h-3 w-3" />
                        </AdminButton>
                      </div>
                    ) : null}

                    <LibraryCardFocusRing active={dragOverItemId === pending.id} />
                  </div>

                  {openMenuPendingId === pending.id ? (
                    <>
                      <div
                        className="fixed inset-0 z-40"
                        onClick={(event) => {
                          event.stopPropagation()
                          onOpenMenuPending(null)
                        }}
                      />
                      <div className="absolute right-0 top-8 z-50 min-w-[160px] border border-border bg-background py-1 shadow-lg">
                        {pending.takenAt ? (
                          <AdminButton
                            onClick={(event) => {
                              event.stopPropagation()
                              onSetPhotoDate(pending.takenAt!)
                              onOpenMenuPending(null)
                              notify(t('admin.set_publish_time_success'), 'success')
                            }}
                            adminVariant="ghost"
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted"
                          >
                            <Calendar className="h-3.5 w-3.5" />
                            {t('admin.set_as_publish_time')}
                          </AdminButton>
                        ) : (
                          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                            <Calendar className="h-3.5 w-3.5" />
                            {t('admin.no_exif_time')}
                          </div>
                        )}
                      </div>
                    </>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
            {filterTab === 'used' ? (
              <p className="mb-1 text-center text-xs">{t('story.material_no_used')}</p>
            ) : filterTab === 'unused' ? (
              <p className="mb-1 text-center text-xs">{t('story.material_no_unused')}</p>
            ) : (
              <>
                <Upload className="mb-3 h-12 w-12 opacity-20" />
                <p className="mb-1 text-center text-xs">{t('admin.drag_images_here')}</p>
                <p className="mb-3 text-center text-[10px] opacity-60">{t('admin.drag_images_insert_hint')}</p>
                <AdminButton onClick={onAddPhotos} adminVariant="link" className="text-xs text-primary">
                  {t('admin.select_from_library')}
                </AdminButton>
              </>
            )}
          </div>
        )}
        </div>
      </div>
    </StoryPhotoPanelBoundary>
  )
}
