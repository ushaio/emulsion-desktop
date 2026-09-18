'use client'

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { getEditorContent } from '@mo-gallery/api-client/editor-content'
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  BookText,
  Calendar,
  Edit3,
  FileArchive,
  Image as ImageIcon,
  RefreshCw,
  Search,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react'
import { AdminButton } from '@/components/admin/AdminButton'
import { AdminLoading } from '@/components/admin/AdminLoading'
import { SelectDropdown, type SelectDropdownOption } from '@/components/ui/SelectDropdown'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/ContextMenu'
import type { PhotoDto } from '@/lib/api'
import { resolveAssetUrl } from '@/lib/api/core'
import { getStoryCoverImageStyle } from '@/lib/story-cover'
import type { BlogDraftData, StoryDraftData, StoryEditorDraftData } from '@/lib/client-db'

/**
 * 叙事上传草稿（含待上传图片的本地预览 URL）。
 * `file` 可缺：本地资源库来源的待传项没有字节（上传时由 Go 按 assetId 读盘）。
 */
export interface LocalStoryDraft extends Omit<StoryDraftData, 'files'> {
  files: { id: string; file?: File; preview: string }[]
}

type LocalDraftSortKey = 'savedAt' | 'title'
type LocalDraftSortDir = 'asc' | 'desc'

interface LocalDraftSortPref {
  key: LocalDraftSortKey
  dir: LocalDraftSortDir
}

const SORT_PREF_KEY = 'mo-gallery:journal:local-sort'

function readSortPref(): LocalDraftSortPref {
  try {
    const raw = window.localStorage.getItem(SORT_PREF_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LocalDraftSortPref>
      return {
        key: parsed.key === 'title' ? 'title' : 'savedAt',
        dir: parsed.dir === 'asc' ? 'asc' : 'desc',
      }
    }
  } catch {
    // ignore quota / privacy mode errors
  }
  return { key: 'savedAt', dir: 'desc' }
}

type LocalDraftBadgeTone = 'synced' | 'pending' | 'muted'

const LOCAL_DRAFT_BADGE_STYLES: Record<LocalDraftBadgeTone, CSSProperties> = {
  synced: { backgroundColor: 'var(--accent)', color: 'var(--accent-foreground)' },
  pending: { backgroundColor: 'color-mix(in srgb, var(--primary) 14%, transparent)', color: 'var(--primary)' },
  muted: { backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)' },
}

interface LocalDraftRow {
  key: string
  title: string
  icon: LucideIcon
  /** 仅特殊状态才显示角标（纯本地新建的文档不加角标） */
  badge?: { label: string; tone: LocalDraftBadgeTone }
  /** 只读行（叙事上传草稿）不可进入编辑器 */
  openable: boolean
  onOpen?: () => void
  onDelete: () => void
  time: number
  photoCount: number
  coverUrl: string | null
  coverStyle?: CSSProperties
}

interface DraftListViewProps {
  storyDraft: LocalStoryDraft | null
  storyEditorDrafts: StoryEditorDraftData[]
  blogDrafts: BlogDraftData[]
  /** 叙事编辑草稿的待上传封面图 object URL（draftId → url） */
  storyEditorCovers: Record<string, string>
  photos: PhotoDto[]
  cdnDomain?: string
  loading: boolean
  selectedDraftId?: string | null
  onOpenStoryEditor: (draft: StoryEditorDraftData) => void
  onOpenBlog: (draft: BlogDraftData) => void
  onDeleteStoryDraft: () => void
  onDeleteStoryEditorDraft: (id: string) => void
  onDeleteBlogDraft: (blogId?: string) => void
  onCreateStory: () => void
  onCreateBlog: () => void
  onRefresh: () => void
  t: (key: string) => string
}

/** 叙事编辑草稿封面：优先待上传本地图片，其次云端图库照片（应用草稿的封面裁剪） */
function storyEditorDraftCover(
  draft: StoryEditorDraftData,
  objectCovers: Record<string, string>,
  photos: PhotoDto[],
  cdnDomain?: string,
): { url: string | null; style?: CSSProperties } {
  const style = getStoryCoverImageStyle({ coverCrop: draft.coverCrop ?? null })
  const localObjectUrl = objectCovers[draft.id]
  if (localObjectUrl) return { url: localObjectUrl, style }
  const photoId = draft.coverPhotoId || draft.photoIds?.[0]
  if (!photoId) return { url: null, style }
  const photo = photos.find((item) => item.id === photoId)
  if (!photo) return { url: null, style }
  return { url: resolveAssetUrl(photo.thumbnailUrl || photo.url, cdnDomain), style }
}


/**
 * 本地文档列表（左栏）：结构与交互对齐叙事列表 StoryListView（compact），
 * 行内为封面帧 + 衬线标题 + mono 元信息，右键菜单提供编辑/删除。
 */
export function DraftListView({
  storyDraft,
  storyEditorDrafts,
  blogDrafts,
  storyEditorCovers,
  photos,
  cdnDomain,
  loading,
  selectedDraftId,
  onOpenStoryEditor,
  onOpenBlog,
  onDeleteStoryDraft,
  onDeleteStoryEditorDraft,
  onDeleteBlogDraft,
  onCreateStory,
  onCreateBlog,
  onRefresh,
  t,
}: DraftListViewProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [typeFilter, setTypeFilter] = useState('')
  const [sort, setSort] = useState<LocalDraftSortPref>(readSortPref)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const changeSort = (pref: LocalDraftSortPref) => {
    setSort(pref)
    try {
      window.localStorage.setItem(SORT_PREF_KEY, JSON.stringify(pref))
    } catch {
      // ignore quota / privacy mode errors
    }
  }

  const toggleSearchOpen = () => {
    setSearchOpen((prev) => {
      if (prev) setSearchQuery('')
      return !prev
    })
  }

  // Ctrl+F / Cmd+F 展开并聚焦搜索框（列表不可见或焦点在列表外可编辑控件时不劫持）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return
      const root = rootRef.current
      if (!root || root.offsetParent === null) return
      const target = event.target as HTMLElement | null
      const isEditableTarget = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (isEditableTarget && !(target && root.contains(target))) return
      event.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  const typeOptions: SelectDropdownOption[] = [
    { value: '', label: t('admin.local_all_types') },
    { value: 'story', label: t('nav.story') },
    { value: 'blog', label: t('admin.blog') },
  ]

  const sortOptions: SelectDropdownOption[] = [
    { value: 'savedAt', label: t('admin.story_sort_updated') },
    { value: 'title', label: t('admin.sort_title') },
  ]

  const rows = useMemo<LocalDraftRow[]>(() => {
    const normalizedSearch = searchQuery.trim().toLowerCase()
    const items: LocalDraftRow[] = []

    const matches = (title: string, content: string | undefined) =>
      !normalizedSearch ||
      title.toLowerCase().includes(normalizedSearch) ||
      (content || '').toLowerCase().includes(normalizedSearch)

    if (typeFilter !== 'blog' && storyDraft) {
      const content = getEditorContent(storyDraft)
      if (matches(storyDraft.title || '', content)) {
        items.push({
          key: storyDraft.id,
          title: storyDraft.title || t('story.untitled'),
          icon: BookOpen,
          badge: { label: t('admin.read_only'), tone: 'muted' },
          openable: false,
          onDelete: onDeleteStoryDraft,
          time: storyDraft.savedAt,
          photoCount: storyDraft.files?.length || 0,
          coverUrl: storyDraft.files?.find((file) => file.preview)?.preview || null,
        })
      }
    }

    if (typeFilter !== 'blog') {
      for (const draft of storyEditorDrafts) {
        const content = getEditorContent(draft)
        if (!matches(draft.title || '', content)) continue
        const cover = storyEditorDraftCover(draft, storyEditorCovers, photos, cdnDomain)
        items.push({
          key: draft.id,
          title: draft.title || t('story.untitled'),
          icon: Edit3,
          badge: draft.cloudSynced
            ? { label: t('admin.draft_synced'), tone: 'synced' }
            : draft.storyId ? { label: t('admin.draft_pending_sync'), tone: 'pending' } : undefined,
          openable: true,
          onOpen: () => onOpenStoryEditor(draft),
          onDelete: () => onDeleteStoryEditorDraft(draft.id),
          time: draft.savedAt,
          photoCount: (draft.photoIds?.length || 0) + (draft.files?.length || 0),
          coverUrl: cover.url,
          coverStyle: cover.style,
        })
      }
    }

    if (typeFilter !== 'story') {
      for (const draft of blogDrafts) {
        const content = getEditorContent(draft)
        if (!matches(draft.title || '', content)) continue
        items.push({
          key: draft.id,
          title: draft.title || t('admin.untitled'),
          icon: BookText,
          badge: draft.cloudSynced
            ? { label: t('admin.draft_synced'), tone: 'synced' }
            : draft.blogId ? { label: t('admin.draft_pending_sync'), tone: 'pending' } : undefined,
          openable: true,
          onOpen: () => onOpenBlog(draft),
          onDelete: () => onDeleteBlogDraft(draft.blogId),
          time: draft.savedAt,
          photoCount: 0,
          coverUrl: null,
        })
      }
    }

    const dir = sort.dir === 'asc' ? 1 : -1
    return items.sort((left, right) =>
      sort.key === 'title'
        ? dir * left.title.localeCompare(right.title)
        : dir * (left.time - right.time),
    )
  }, [
    blogDrafts,
    cdnDomain,
    onDeleteBlogDraft,
    onDeleteStoryDraft,
    onDeleteStoryEditorDraft,
    onOpenBlog,
    onOpenStoryEditor,
    photos,
    searchQuery,
    sort,
    storyDraft,
    storyEditorCovers,
    storyEditorDrafts,
    t,
    typeFilter,
  ])

  const hasDrafts = !!storyDraft || storyEditorDrafts.length > 0 || blogDrafts.length > 0
  const hasActiveFilters = typeFilter !== '' || searchQuery.trim() !== ''
  const hasNoMatches = hasDrafts && rows.length === 0

  const renderRow = (row: LocalDraftRow) => {
    const Icon = row.icon
    const isSelected = !!selectedDraftId && selectedDraftId === row.key
    return (
      <ContextMenu key={row.key}>
        <ContextMenuTrigger asChild>
          <div
            role={row.openable ? 'button' : undefined}
            tabIndex={row.openable ? 0 : undefined}
            onClick={row.openable ? row.onOpen : undefined}
            onKeyDown={(event) => {
              if (!row.openable || !row.onOpen) return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                row.onOpen()
              }
            }}
            className={`group relative flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors hover:border-primary/50 ${row.openable ? 'cursor-pointer' : ''}`}
            style={{
              borderColor: isSelected ? 'var(--primary)' : 'var(--border)',
              backgroundColor: isSelected
                ? 'color-mix(in srgb, var(--primary) 6%, transparent)'
                : 'var(--card)',
              boxShadow: isSelected ? '0 0 0 1px var(--primary)' : undefined,
            }}
          >
            {row.badge ? (
              <span
                className="absolute right-2 top-1.5 z-10 shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                style={LOCAL_DRAFT_BADGE_STYLES[row.badge.tone]}
              >
                {row.badge.label}
              </span>
            ) : null}

            {/* 封面帧 */}
            <div
              className="h-11 w-14 shrink-0 overflow-hidden rounded-md border"
              style={{ borderColor: 'var(--border)', backgroundColor: 'var(--muted)' }}
            >
              {row.coverUrl ? (
                <img src={row.coverUrl} alt="" loading="lazy" className="h-full w-full object-cover" style={row.coverStyle} />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <Icon className="h-4 w-4" style={{ color: 'var(--muted-foreground)' }} />
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="mb-0.5 flex items-center gap-2">
                <h4 className="truncate pr-10 font-serif text-sm transition-colors group-hover:text-primary">{row.title}</h4>
              </div>
              <div
                className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10px] uppercase tracking-wide"
                style={{ color: 'var(--muted-foreground)' }}
              >
                <span className="flex items-center gap-1.5">
                  <Calendar className="h-3 w-3" />
                  {new Date(row.time).toLocaleDateString()}
                </span>
                {row.photoCount > 0 ? (
                  <span className="flex items-center gap-1.5">
                    <ImageIcon className="h-3 w-3" />
                    {row.photoCount}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel className="max-w-56 truncate">{row.title}</ContextMenuLabel>
          <ContextMenuSeparator />
          {row.openable && row.onOpen ? (
            <ContextMenuItem onSelect={row.onOpen}>
              <Edit3 className="size-3.5" />
              {t('common.edit')}
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem variant="destructive" onSelect={row.onDelete}>
            <Trash2 className="size-3.5" />
            {t('common.delete')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  return (
    <div ref={rootRef} className="flex flex-1 flex-col gap-4 overflow-hidden">
      {/* 工具栏（紧凑规格对齐叙事列表） */}
      <div className="mx-3 shrink-0 border-b pb-3" style={{ borderColor: 'var(--border)' }}>
        <div className="flex flex-wrap items-center gap-1.5">
          <SelectDropdown
            value={typeFilter}
            options={typeOptions}
            onChange={(value) => setTypeFilter(value as string)}
            placeholder={t('admin.local_all_types')}
            className="min-w-0 flex-1"
          />
          <SelectDropdown
            value={sort.key}
            options={sortOptions}
            onChange={(value) => changeSort({ key: value as LocalDraftSortKey, dir: sort.dir })}
            className="min-w-0 flex-1"
          />
          <AdminButton
            onClick={() => changeSort({ key: sort.key, dir: sort.dir === 'desc' ? 'asc' : 'desc' })}
            adminVariant="outline"
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md p-0"
            title={sort.dir === 'desc' ? t('admin.story_sort_desc_hint') : t('admin.story_sort_asc_hint')}
          >
            {sort.dir === 'desc' ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
          </AdminButton>
          <AdminButton
            onClick={onRefresh}
            adminVariant="outline"
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md p-0"
            title={t('common.refresh')}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </AdminButton>
          <AdminButton
            onClick={toggleSearchOpen}
            adminVariant="outline"
            className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md p-0 ${searchQuery || searchOpen ? 'border-primary text-primary' : ''}`}
            title={t('common.search')}
            aria-pressed={searchOpen}
          >
            <Search className="h-3.5 w-3.5" />
          </AdminButton>
        </div>

        {searchOpen ? (
          <div className="relative mt-2 flex items-center">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
              style={{ color: 'var(--muted-foreground)' }}
            />
            <input
              ref={searchInputRef}
              type="text"
              placeholder={t('admin.search_placeholder')}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') toggleSearchOpen()
              }}
              className="w-full rounded-md border py-1.5 pl-8 pr-8 text-xs outline-none transition-colors focus:border-primary"
              style={{ borderColor: 'var(--border)', backgroundColor: 'var(--card)' }}
            />
            <button
              type="button"
              onClick={toggleSearchOpen}
              className="absolute right-2 rounded p-0.5 transition-colors hover:bg-accent"
              style={{ color: 'var(--muted-foreground)' }}
              title={t('common.close')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
      </div>

      <div className="custom-scrollbar flex-1 overflow-y-auto px-3">
        {loading ? (
          <AdminLoading text={t('common.loading')} className="min-h-[320px]" />
        ) : hasNoMatches ? (
          <div
            className="flex flex-col items-center justify-center rounded-lg border border-dashed px-4 py-20 text-center"
            style={{ borderColor: 'var(--border)', backgroundColor: 'color-mix(in srgb, var(--card) 50%, transparent)' }}
          >
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl border" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--muted)' }}>
              <Search className="h-6 w-6" style={{ color: 'var(--muted-foreground)' }} />
            </div>
            <p className="mb-4 text-xs" style={{ color: 'var(--muted-foreground)' }}>
              {t('admin.no_drafts_match_filters')}
            </p>
            {hasActiveFilters && (
              <AdminButton
                onClick={() => {
                  setSearchQuery('')
                  setTypeFilter('')
                }}
                adminVariant="outline"
                size="sm"
                className="flex items-center gap-1.5 rounded-md"
              >
                <X className="h-3.5 w-3.5" />
                {t('admin.clear_filters')}
              </AdminButton>
            )}
          </div>
        ) : !hasDrafts ? (
          <div
            className="flex flex-col items-center justify-center rounded-lg border border-dashed px-4 py-20 text-center"
            style={{ borderColor: 'var(--border)', backgroundColor: 'color-mix(in srgb, var(--card) 50%, transparent)' }}
          >
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl border" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--muted)' }}>
              <FileArchive className="h-6 w-6" style={{ color: 'var(--muted-foreground)' }} />
            </div>
            <h3 className="mb-1 text-sm font-semibold">{t('admin.local_drafts')}</h3>
            <p className="mb-4 text-xs" style={{ color: 'var(--muted-foreground)' }}>
              {t('admin.drafts_hint')}
            </p>
            <div className="flex items-center gap-2">
              <AdminButton onClick={onCreateStory} adminVariant="outline" size="sm" className="flex items-center gap-1.5 rounded-md">
                <BookOpen className="h-3.5 w-3.5" />
                {t('ui.create_story')}
              </AdminButton>
              <AdminButton onClick={onCreateBlog} adminVariant="outline" size="sm" className="flex items-center gap-1.5 rounded-md">
                <BookText className="h-3.5 w-3.5" />
                {t('ui.create_blog')}
              </AdminButton>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-[2px] pb-2">{rows.map(renderRow)}</div>
        )}
      </div>
    </div>
  )
}
