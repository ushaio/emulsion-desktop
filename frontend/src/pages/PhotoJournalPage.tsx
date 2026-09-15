/**
 * 照片日志页 —— 叙事 + 博客 + 本地三个子页签。
 * 数据/交互逻辑与 web 后台 logs/page.tsx 一致（直接调用 @/lib/api 与 @/lib/client-db）；
 * 本地页签与叙事页签同构：左栏文档列表 + 右侧内容区（未选中时为空状态），
 * 文档来自本地 SQLite/IndexedDB，未连接站点也可创作。
 */
'use client'

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { useLocation } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage } from '@/contexts/LanguageContext'
import { useAdmin, AdminLogsProvider } from '@/pages/admin-logs/layout'
import { type PhotoDto } from '@/lib/api'
import { StoriesTab } from '@/pages/admin-logs/StoriesTab'
import { BlogTab } from '@/pages/admin-logs/BlogTab'
import { CollapsibleListPane, LIST_PANE_COLLAPSED_KEY } from '@/pages/admin-logs/shared/CollapsibleListPane'
import { DraftListView, type LocalStoryDraft } from '@/pages/admin-logs/drafts/DraftListView'
import { EditorEmptyState } from '@/pages/admin-logs/shared/EditorEmptyState'
import { PageHeader } from '@/components/layout/PageHeader'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { useCachedPageEffect } from '@/hooks/useCachedPageEffect'
import { useDataRevision } from '@/hooks/useDataRevision'
import {
  getAllDraftsFromDB,
  clearDraftFromDB,
  clearBlogDraftFromDB,
  clearStoryEditorDraftFromDB,
  type BlogDraftData,
  type StoryEditorDraftData,
} from '@/lib/client-db'
import { SimpleDeleteDialog } from '@/components/admin/SimpleDeleteDialog'
import { AdminButton } from '@/components/admin/AdminButton'
import {
  BookText,
  BookOpen,
  FileArchive,
  Plus,
} from 'lucide-react'

type JournalSubTab = 'blog' | 'stories' | 'drafts'

/**
 * 左栏面板头内的子页签导航（叙事/博客/本地），双击刷新。
 * 未连接站点时只剩「本地」一个页签，无切换意义，不渲染任何内容。
 */
function JournalSubTabNav({
  activeSubTab,
  onTabClick,
  totalDrafts,
  connected,
  t,
}: {
  activeSubTab: JournalSubTab
  onTabClick: (tab: JournalSubTab) => void
  totalDrafts: number
  /** 未连接站点时叙事/博客列表（云端内容）不可用，仅保留本地页签 */
  connected: boolean
  t: (key: string) => string
}) {
  if (!connected) return null
  return (
    <SegmentedTabs
      size="sm"
      ariaLabel={t('admin.logs')}
      className="min-w-0 flex-1"
      value={activeSubTab}
      onChange={onTabClick}
      options={[
        { value: 'stories' as const, icon: BookOpen, label: t('nav.story'), title: t('admin.double_click_refresh') },
        { value: 'blog' as const, icon: BookText, label: t('admin.blog'), title: t('admin.double_click_refresh') },
        {
          value: 'drafts',
          icon: FileArchive,
          label: t('admin.local'),
          title: t('admin.double_click_refresh'),
          trailing: (active: boolean) => totalDrafts > 0 ? (
            <span
              className="rounded-full px-1.5 py-0.5 text-[9px] leading-none"
              style={{
                backgroundColor: active ? 'var(--primary)' : 'var(--accent)',
                color: active ? 'var(--primary-foreground)' : 'var(--accent-foreground)',
              }}
            >
              {totalDrafts}
            </span>
          ) : null,
        },
      ]}
    />
  )
}

export function PhotoJournalPage() {
  return (
    <AdminLogsProvider>
      <PhotoJournalContent />
    </AdminLogsProvider>
  )
}

function PhotoJournalContent() {
  const { t } = useLanguage()
  const { token, isAuthenticated } = useAuth()
  const { settings } = useAdmin()
  const location = useLocation()
  const automationRequest = useMemo(() => {
    const params = new URLSearchParams(location.search)
    const documentId = params.get('automationDocument')?.trim() || ''
    const documentKind = params.get('automationKind')
    const source: 'draft' | 'database' = params.get('automationSource') === 'database' ? 'database' : 'draft'
    return documentId && (documentKind === 'story' || documentKind === 'blog')
      ? { documentId, documentKind, source }
      : null
  }, [location.search])
  // 首页照片流「写叙事」交接：带选中照片直接进入新建叙事
  const newStoryPhotoIds = useMemo(() => {
    const params = new URLSearchParams(location.search)
    return (params.get('newStoryPhotos') ?? '').split(',').map(id => id.trim()).filter(Boolean)
  }, [location.search])
  const [photos, setPhotos] = useState<PhotoDto[]>([])

  const [activeSubTab, setActiveSubTab] = useState<'blog' | 'stories' | 'drafts'>(isAuthenticated ? 'stories' : 'drafts')

  // 草稿编辑态：从草稿列表进入叙事/博客编辑器时保持草稿页签与左栏列表不变，
  // 右侧由对应的编辑器容器显示（StoriesTab/BlogTab 以 hideListPane 隐藏其自带列表栏）
  const [draftEditKind, setDraftEditKind] = useState<'story' | 'blog' | null>(null)

  // 断连站点时回到草稿页签（叙事/博客列表是云端内容）；编辑中的内容有防抖自动落盘兜底
  const wasAuthenticatedRef = useRef(isAuthenticated)
  useEffect(() => {
    if (wasAuthenticatedRef.current && !isAuthenticated) {
      setActiveSubTab('drafts')
    }
    wasAuthenticatedRef.current = isAuthenticated
  }, [isAuthenticated])

  useEffect(() => {
    if (automationRequest) setActiveSubTab(automationRequest.documentKind === 'blog' ? 'blog' : 'stories')
  }, [automationRequest])

  const [storyDraft, setStoryDraft] = useState<LocalStoryDraft | null>(null)
  const [blogDrafts, setBlogDrafts] = useState<BlogDraftData[]>([])
  const [storyEditorDrafts, setStoryEditorDrafts] = useState<StoryEditorDraftData[]>([])
  // 叙事编辑草稿的本地封面预览（待上传图片 object URL，随 loadDrafts 统一 revoke）
  const [storyEditorCovers, setStoryEditorCovers] = useState<Record<string, string>>({})
  const [loadingDrafts, setLoadingDrafts] = useState(false)

  // 左栏选中的本地文档（仅用于行高亮；内容由对应编辑器持有）
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null)

  const [editFromDraft, setEditFromDraft] = useState<StoryEditorDraftData | null>(null)
  const [editBlogFromDraft, setEditBlogFromDraft] = useState<BlogDraftData | null>(null)

  const [deleteDialog, setDeleteDialog] = useState<{
    isOpen: boolean
    type: 'story' | 'blog' | 'storyEditor'
    id?: string
  }>({ isOpen: false, type: 'story' })

  const photosRevision = useDataRevision('photos')

  const lastClickRef = useRef<{ tab: string; time: number }>({ tab: '', time: 0 })
  const [storiesRefreshKey, setStoriesRefreshKey] = useState(0)
  const [blogRefreshKey, setBlogRefreshKey] = useState(0)
  const [storiesCreateRequestKey, setStoriesCreateRequestKey] = useState(0)
  const [blogCreateRequestKey, setBlogCreateRequestKey] = useState(0)

  // 沉浸模式由叙事/博客两个编辑器各自维护（互不影响），任一沉浸时隐藏页面级 chrome
  const [isStoriesImmersive, setIsStoriesImmersive] = useState(false)
  const [isBlogImmersive, setIsBlogImmersive] = useState(false)
  const isImmersiveMode = isStoriesImmersive || isBlogImmersive

  // 切到其他菜单页（离开 /photo-journal，编辑器不再显示）时退出沉浸模式
  useEffect(() => {
    if (location.pathname !== '/photo-journal') {
      setIsStoriesImmersive(false)
      setIsBlogImmersive(false)
    }
  }, [location.pathname])

  // 左栏列表折叠状态（叙事/博客共用，跨页面保留）
  const [listPaneCollapsed, setListPaneCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(LIST_PANE_COLLAPSED_KEY) === 'true'
    } catch {
      return false
    }
  })

  const toggleListPane = useCallback(() => {
    setListPaneCollapsed((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(LIST_PANE_COLLAPSED_KEY, String(next))
      } catch {
        // ignore quota / privacy mode errors
      }
      return next
    })
  }, [])

  const notify = useCallback((message: string, type?: 'success' | 'error' | 'info') => {
    if (type === 'error') toast.error(message)
    else if (type === 'success') toast.success(message)
    else toast(message)
  }, [])

  // 博客插入照片与本地文档封面（云端图库照片，未连接站点时跳过）需要全部照片
  useCachedPageEffect(() => {
    if (activeSubTab !== 'blog' || !isAuthenticated) return
    ;(async () => {
      try {
        const data = await (
          window as unknown as { go: { main: { App: { GetAllPhotos: () => Promise<PhotoDto[]> } } } }
        ).go.main.App.GetAllPhotos()
        setPhotos(data || [])
      } catch (err) {
        console.error('Failed to load photos:', err)
      }
    })()
  }, [activeSubTab, photosRevision])

  // 本地文档封面预览 URL 缓存：仅当来源图片变化时才重建，
  // 这样刷新列表（如退出编辑器后的静默刷新）不会让封面重新加载闪烁。
  const coverCacheRef = useRef<Map<string, { key: string; url: string }>>(new Map())

  const cachedCoverUrl = useCallback((cacheId: string, key: string, file: File): string => {
    const cache = coverCacheRef.current
    const cached = cache.get(cacheId)
    if (cached && cached.key === key) return cached.url
    if (cached) URL.revokeObjectURL(cached.url)
    const url = URL.createObjectURL(file)
    cache.set(cacheId, { key, url })
    return url
  }, [])

  const releaseUnusedCovers = useCallback((liveIds: Set<string>) => {
    const cache = coverCacheRef.current
    for (const [id, entry] of Array.from(cache.entries())) {
      if (!liveIds.has(id)) {
        URL.revokeObjectURL(entry.url)
        cache.delete(id)
      }
    }
  }, [])

  useEffect(() => () => {
    releaseUnusedCovers(new Set())
  }, [releaseUnusedCovers])

  /** 读取本地文档；silent 用于退出编辑器等场景（不显示 loading，避免列表闪烁） */
  const loadDrafts = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) setLoadingDrafts(true)

    try {
      const { storyDraft: rawStoryDraft, blogDrafts, storyEditorDrafts } = await getAllDraftsFromDB()
      const liveCoverIds = new Set<string>()

      if (rawStoryDraft) {
        const rawFiles = rawStoryDraft.files ?? []
        const filesWithPreviews = rawFiles.map((f, index) => {
          if (index !== 0 || !(f.file instanceof File)) return { id: f.id, file: f.file, preview: '' }
          const cacheId = `quick_story_draft:${f.id}`
          liveCoverIds.add(cacheId)
          try {
            return { id: f.id, file: f.file, preview: cachedCoverUrl(cacheId, `${f.id}|${rawFiles.length}`, f.file) }
          } catch (e) {
            console.error('Failed to create object URL:', e)
            return { id: f.id, file: f.file, preview: '' }
          }
        })

        setStoryDraft({
          ...rawStoryDraft,
          files: filesWithPreviews,
        })
      } else {
        setStoryDraft(null)
      }

      setBlogDrafts(blogDrafts)
      setStoryEditorDrafts(storyEditorDrafts)

      // 叙事编辑草稿：为待上传封面图（pendingCoverId 优先，否则首图）创建本地预览
      const covers: Record<string, string> = {}
      for (const draft of storyEditorDrafts) {
        const coverEntry = draft.files?.find((file) => file.id === draft.pendingCoverId) ?? draft.files?.[0]
        if (!(coverEntry?.file instanceof File)) continue
        const cacheId = `storyEditor:${draft.id}`
        liveCoverIds.add(cacheId)
        try {
          // 封面裁剪在渲染时由 coverStyle 实时计算，缓存 key 只需识别"来源图片是否变了"
          const key = `${draft.pendingCoverId ?? ''}|${coverEntry.id}|${draft.files?.length ?? 0}`
          covers[draft.id] = cachedCoverUrl(cacheId, key, coverEntry.file)
        } catch (e) {
          console.error('Failed to create object URL:', e)
        }
      }
      releaseUnusedCovers(liveCoverIds)
      setStoryEditorCovers(covers)
    } catch (err) {
      console.error('Failed to load drafts:', err)
      notify(t('common.error'), 'error')
    } finally {
      if (!options?.silent) setLoadingDrafts(false)
    }
  }, [cachedCoverUrl, notify, releaseUnusedCovers, t])

  useCachedPageEffect(() => {
    if (activeSubTab === 'drafts') {
      void loadDrafts()
    }
  }, [activeSubTab, loadDrafts])

  /** 删除后按存储实际状态重算列表（静默，不闪烁） */
  async function confirmDelete() {
    try {
      if (deleteDialog.type === 'blog') {
        await clearBlogDraftFromDB(deleteDialog.id)
      } else if (deleteDialog.type === 'storyEditor') {
        await clearStoryEditorDraftFromDB(deleteDialog.id)
      } else {
        await clearDraftFromDB()
      }
      const deletedId = deleteDialog.type === 'story' ? 'quick_story_draft' : deleteDialog.id
      if (deletedId && selectedDraftId === deletedId) setSelectedDraftId(null)
      await loadDrafts({ silent: true })
      notify(t('admin.draft_deleted'))
    } catch (err) {
      console.error('Failed to delete draft:', err)
      notify(t('common.error'), 'error')
    } finally {
      setDeleteDialog({ isOpen: false, type: 'story' })
    }
  }

  function handleEditStoryFromDraft(draft: StoryEditorDraftData) {
    setSelectedDraftId(draft.id)
    setEditFromDraft(draft)
    setDraftEditKind('story')
  }

  function handleEditBlogFromDraft(draft: BlogDraftData) {
    setSelectedDraftId(draft.id)
    setEditBlogFromDraft(draft)
    setDraftEditKind('blog')
  }

  const totalDrafts = useMemo(() => {
    let count = blogDrafts.length + storyEditorDrafts.length
    if (storyDraft) count++
    return count
  }, [storyDraft, blogDrafts, storyEditorDrafts])

  const cdnDomain = settings?.cdn_domain

  function handleTabClick(tab: 'blog' | 'stories' | 'drafts') {
    const now = Date.now()
    if (lastClickRef.current.tab === tab && now - lastClickRef.current.time < 300) {
      if (tab === 'drafts') {
        loadDrafts()
      } else if (tab === 'stories') {
        setStoriesRefreshKey((k) => k + 1)
      } else if (tab === 'blog') {
        setBlogRefreshKey((k) => k + 1)
      }
    }
    lastClickRef.current = { tab, time: now }
    // 切换页签即退出草稿编辑态（编辑器保持挂载，内容已自动落盘）
    setDraftEditKind(null)
    setSelectedDraftId(null)
    setActiveSubTab(tab)
  }

  function handleCreateArticle(kind?: 'stories' | 'blog') {
    const target = kind ?? (activeSubTab === 'blog' ? 'blog' : 'stories')
    if (activeSubTab === 'drafts') {
      // 从本地页签新建：左栏文档列表保持不动，编辑器在右栏打开
      setSelectedDraftId(null)
      setDraftEditKind(target === 'blog' ? 'blog' : 'story')
    } else {
      setActiveSubTab(target)
    }
    if (target === 'stories') {
      setStoriesCreateRequestKey((key) => key + 1)
    } else {
      setBlogCreateRequestKey((key) => key + 1)
    }
  }

  // 顶栏始终显示「照片日志」标题（包括编辑态），仅沉浸全屏时隐藏。
  // 内容区内边距恒定（不随编辑态切换），确保打开/关闭文章时左栏列表不产生位移。
  const chromeVisible = !isImmersiveMode
  const contentPadding = 'pt-0'

  // 左栏面板头内的子页签导航（叙事/博客/草稿）
  const subTabNav = (
    <JournalSubTabNav
      activeSubTab={activeSubTab}
      onTabClick={handleTabClick}
      totalDrafts={totalDrafts}
      connected={isAuthenticated}
      t={t}
    />
  )

  // 未连接站点时也可从本地页签新建文档（本地文档即草稿）；
  // 退出编辑时静默刷新列表（保持左栏不动，避免整表 loading 造成的闪烁）
  const handleEditorClosed = useCallback(() => {
    if (draftEditKind) {
      setDraftEditKind(null)
      setSelectedDraftId(null)
      void loadDrafts({ silent: true })
    } else if (!isAuthenticated) {
      setActiveSubTab('drafts')
    }
  }, [draftEditKind, isAuthenticated, loadDrafts])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 桌面端页头 */}
      <div className={chromeVisible ? 'block' : 'hidden'}>
        <PageHeader
          title={t('admin.logs')}
          actions={!isAuthenticated ? (
            <div className="flex items-center gap-2">
              <AdminButton
                onClick={() => handleCreateArticle('stories')}
                adminVariant="primary"
                className="flex h-8 items-center gap-1.5 rounded-md px-3"
                title={t('ui.create_story')}
                aria-label={t('ui.create_story')}
              >
                <Plus className="h-4 w-4" />
                <span>{t('ui.create_story')}</span>
              </AdminButton>
              <AdminButton
                onClick={() => handleCreateArticle('blog')}
                adminVariant="primary"
                className="flex h-8 items-center gap-1.5 rounded-md px-3"
                title={t('ui.create_blog')}
                aria-label={t('ui.create_blog')}
              >
                <Plus className="h-4 w-4" />
                <span>{t('ui.create_blog')}</span>
              </AdminButton>
            </div>
          ) : activeSubTab !== 'drafts' ? (
            <AdminButton
              onClick={() => handleCreateArticle()}
              adminVariant="primary"
              className="flex h-8 items-center gap-1.5 rounded-md px-3"
              title={activeSubTab === 'stories' ? t('ui.create_story') : t('ui.create_blog')}
              aria-label={activeSubTab === 'stories' ? t('ui.create_story') : t('ui.create_blog')}
            >
              <Plus className="h-4 w-4" />
              <span>{activeSubTab === 'stories' ? t('ui.create_story') : t('ui.create_blog')}</span>
            </AdminButton>
          ) : undefined}
        />
      </div>

      {/* 子页签内容（导航已并入左栏面板头）。
          本地页签与叙事/博客同构：左栏文档列表 + 右侧内容区；编辑时左栏保持列表，
          右侧由对应编辑器容器显示（hideListPane 隐藏其自带列表栏）。 */}
      <div className={`flex flex-1 overflow-hidden ${contentPadding} ${draftEditKind ? '' : 'gap-4'}`}>
        {activeSubTab === 'drafts' ? (
          <CollapsibleListPane
            collapsed={listPaneCollapsed}
            onToggle={toggleListPane}
            t={t}
            header={subTabNav}
            showCollapsedRail={!draftEditKind}
          >
            <DraftListView
              storyDraft={storyDraft}
              storyEditorDrafts={storyEditorDrafts}
              blogDrafts={blogDrafts}
              storyEditorCovers={storyEditorCovers}
              photos={photos}
              cdnDomain={cdnDomain}
              loading={loadingDrafts}
              selectedDraftId={selectedDraftId}
              onOpenStoryEditor={handleEditStoryFromDraft}
              onOpenBlog={handleEditBlogFromDraft}
              onDeleteStoryDraft={() => setDeleteDialog({ isOpen: true, type: 'story' })}
              onDeleteStoryEditorDraft={(id) => setDeleteDialog({ isOpen: true, type: 'storyEditor', id })}
              onDeleteBlogDraft={(blogId) => setDeleteDialog({ isOpen: true, type: 'blog', id: blogId })}
              onCreateStory={() => handleCreateArticle('stories')}
              onCreateBlog={() => handleCreateArticle('blog')}
              onRefresh={() => void loadDrafts()}
              t={t}
            />
          </CollapsibleListPane>
        ) : null}
        {/* 未打开任何本地文档时的右侧空状态（保持与叙事页签一致的左右布局） */}
        {activeSubTab === 'drafts' && !draftEditKind ? (
          <main className="min-w-0 flex-1 overflow-hidden">
            <EditorEmptyState
              icon={FileArchive}
              title={t('admin.local_drafts')}
              hint={t('admin.select_local_hint')}
              actionLabel={t('ui.create_story')}
              onAction={() => handleCreateArticle('stories')}
            />
          </main>
        ) : null}
        {/* 博客编辑器容器：博客页签，或从草稿进入博客编辑 */}
        <div className={activeSubTab === 'blog' || draftEditKind === 'blog' ? 'h-full min-w-0 flex-1' : 'hidden'}>
          <BlogTab
            photos={photos}
            settings={settings}
            t={t}
            notify={notify}
            refreshKey={blogRefreshKey}
            createRequestKey={blogCreateRequestKey}
            editBlogFromDraft={editBlogFromDraft}
            editBlogId={automationRequest?.documentKind === 'blog' ? automationRequest.documentId : undefined}
            editSource={automationRequest?.source}
            onDraftConsumed={() => setEditBlogFromDraft(null)}
            onEditorClosed={handleEditorClosed}
            listPaneCollapsed={listPaneCollapsed}
            onToggleListPane={toggleListPane}
            subTabNav={subTabNav}
            active={activeSubTab === 'blog' || draftEditKind === 'blog'}
            hideListPane={draftEditKind === 'blog'}
            isImmersiveMode={isBlogImmersive}
            setIsImmersiveMode={setIsBlogImmersive}
          />
        </div>
        {/* 叙事编辑器容器：叙事页签，或从草稿进入叙事编辑 */}
        <div className={activeSubTab === 'stories' || draftEditKind === 'story' ? 'h-full min-w-0 flex-1' : 'hidden'}>
          <StoriesTab
            token={token}
            t={t}
            notify={notify}
            editFromDraft={editFromDraft}
            editStoryId={automationRequest?.documentKind === 'story' ? automationRequest.documentId : undefined}
            editSource={automationRequest?.source}
            onDraftConsumed={() => setEditFromDraft(null)}
            onEditorClosed={handleEditorClosed}
            newStoryPhotoIds={newStoryPhotoIds.length > 0 ? newStoryPhotoIds : undefined}
            refreshKey={storiesRefreshKey}
            createRequestKey={storiesCreateRequestKey}
            listPaneCollapsed={listPaneCollapsed}
            onToggleListPane={toggleListPane}
            subTabNav={subTabNav}
            active={activeSubTab === 'stories' || draftEditKind === 'story'}
            hideListPane={draftEditKind === 'story'}
            isImmersiveMode={isStoriesImmersive}
            setIsImmersiveMode={setIsStoriesImmersive}
          />
        </div>
      </div>

      <SimpleDeleteDialog
        isOpen={deleteDialog.isOpen}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteDialog({ isOpen: false, type: 'story' })}
        t={t}
      />
    </div>
  )
}
