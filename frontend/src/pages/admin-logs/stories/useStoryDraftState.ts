'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { PhotoDto, StoryDto } from '@/lib/api/types'
import { STORY_EDITOR_DRAFT_PREFIX, type StoryEditorDraftData } from '@/lib/client-db'
import { getStoryEditorDraftFromDB, markStoryEditorDraftSynced, rekeyStoryEditorDraft, saveStoryEditorDraftToDB } from '@/lib/client-db'
import type { PendingImage } from '@/components/admin/StoryPhotoPanel'
import { draftEntriesFromPendingImages, localAssetPreviewUrls, pendingImagesFromDraftEntries } from '@/lib/editor-pending-import'
import { AUTO_SAVE_DELAY } from './constants'
import type { DraftRestoreDialogState, StorySnapshot } from './types'
import { createEmptyStory } from './utils'

interface UseStoryDraftStateParams {
  allPhotos: PhotoDto[]
  currentStory: StoryDto | null
  pendingImages: PendingImage[]
  pendingCoverId: string | null
  stories: StoryDto[]
  storyEditMode: 'list' | 'editor'
  editFromDraft?: StoryEditorDraftData | null
  onDraftConsumed?: () => void
  notify: (message: string, type?: 'success' | 'error' | 'info') => void
  t: (key: string) => string
  loadAllPhotos: () => Promise<void>
  setCurrentStory: Dispatch<SetStateAction<StoryDto | null>>
  setPendingImages: Dispatch<SetStateAction<PendingImage[]>>
  setPendingCoverId: Dispatch<SetStateAction<string | null>>
  setStoryEditMode: Dispatch<SetStateAction<'list' | 'editor'>>
}

interface UseStoryDraftStateResult {
  editorSessionId: string
  draftSaved: boolean
  lastSavedAt: number | null
  initialStory: StorySnapshot | null
  isDirty: boolean
  draftRestoreDialog: DraftRestoreDialogState
  createStoryWithDraftCheck: () => Promise<void>
  editStoryWithDraftCheck: (story: StoryDto, source?: 'prompt' | 'draft' | 'database') => Promise<void>
  handleDraftRestore: () => void
  handleDraftDiscard: () => void
  handleDraftCancel: () => void
  markDraftSynced: (snapshot: StoryDto, storyId: string) => Promise<void>
  rekeySavedDraft: (oldDraftId: string, storyId: string) => Promise<void>
  saveDraft: () => Promise<void>
  resetDraftState: () => void
  acceptSavedStory: (story: StoryDto, sessionId: string) => boolean
}

function createSnapshot(story: StoryDto): StorySnapshot {
  return {
    title: story.title,
    editorType: story.editorType,
    contentEditorTypes: [...story.contentEditorTypes],
    tiptapContent: story.tiptapContent,
    tiptapContentJson: story.tiptapContentJson ?? null,
    milkContent: story.milkContent ?? null,
    isPublished: story.isPublished,
    createdAt: story.createdAt,
    storyDate: story.storyDate,
    photoIds: story.photos?.map((photo) => photo.id) || [],
    coverPhotoId: story.coverPhotoId,
    coverCrop: story.coverCrop ?? null,
  }
}

function getNewStoryIdFromDraft(draft: StoryEditorDraftData): string {
  if (draft.storyId) return draft.storyId
  if (draft.id.startsWith(STORY_EDITOR_DRAFT_PREFIX)) {
    const draftId = draft.id.slice(STORY_EDITOR_DRAFT_PREFIX.length)
    if (draftId && draftId !== 'new') return draftId
  }
  return crypto.randomUUID()
}

export function useStoryDraftState({
  allPhotos,
  currentStory,
  pendingImages,
  pendingCoverId,
  stories,
  storyEditMode,
  editFromDraft,
  onDraftConsumed,
  notify,
  t,
  loadAllPhotos,
  setCurrentStory,
  setPendingImages,
  setPendingCoverId,
  setStoryEditMode,
}: UseStoryDraftStateParams): UseStoryDraftStateResult {
  const [editorSessionId, setEditorSessionId] = useState(() => crypto.randomUUID())
  const editorSessionRef = useRef(editorSessionId)
  const draftWritesRef = useRef<Promise<void>>(Promise.resolve())
  const draftCloudIdsRef = useRef(new Map<string, string>())
  // 离线续写时图库（allPhotos）为空，无法解析的 photoId 记录在此，
  // 自动保存时合并回草稿，避免本地编辑把已关联照片冲掉
  const preservedPhotoIdsRef = useRef<Set<string>>(new Set())
  const [draftSaved, setDraftSaved] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [initialStory, setInitialStory] = useState<StorySnapshot | null>(null)
  const [draftRestoreDialog, setDraftRestoreDialog] = useState<DraftRestoreDialogState>({ isOpen: false, draft: null, story: null })
  // 图库是否已尝试加载（离线/空库时 allPhotos 恒为空，不能无限等待，否则编辑器打不开）
  const [photosHydrated, setPhotosHydrated] = useState(false)

  const enqueueDraftWrite = useCallback((operation: () => Promise<void>) => {
    const write = draftWritesRef.current.then(operation)
    draftWritesRef.current = write.catch(() => undefined)
    return write
  }, [])

  /** 把现取的缩略图贴回对应待传项（按 assetId 匹配，已移除的项自然跳过）。 */
  const applyLocalAssetPreviews = useCallback((previews: Map<string, string>) => {
    if (previews.size === 0) return
    setPendingImages((prev) => prev.map((image) => {
      if (!image.assetId) return image
      const previewUrl = previews.get(image.assetId)
      return previewUrl && previewUrl !== image.previewUrl ? { ...image, previewUrl } : image
    }))
  }, [setPendingImages])

  /**
   * 草稿 → 待传项。本地资源库项的元数据随草稿落盘，故同步即可还原；
   * 只有缩略图需要按 assetId 现取（URL 带会话与缓存键，跨重启必失效）。
   */
  const restorePendingImages = useCallback((files: StoryEditorDraftData['files'] | undefined): PendingImage[] => {
    const { pending, localAssetIdsNeedingPreview } = pendingImagesFromDraftEntries(files ?? [])
    if (localAssetIdsNeedingPreview.length > 0) {
      void localAssetPreviewUrls(localAssetIdsNeedingPreview)
        .then(applyLocalAssetPreviews)
        .catch((error) => console.error('Failed to refresh local asset previews:', error))
    }
    return pending
  }, [applyLocalAssetPreviews])

  const rekeySavedDraft = useCallback((oldDraftId: string, storyId: string) => {
    // Resolve queued autosaves to the cloud ID before moving the latest old row.
    draftCloudIdsRef.current.set(oldDraftId, storyId)
    draftCloudIdsRef.current.set(storyId, storyId)
    return enqueueDraftWrite(() => rekeyStoryEditorDraft(oldDraftId, storyId))
  }, [enqueueDraftWrite])

  const beginEditorSession = useCallback(() => {
    const sessionId = crypto.randomUUID()
    editorSessionRef.current = sessionId
    setEditorSessionId(sessionId)
  }, [])

  const acceptSavedStory = useCallback((story: StoryDto, sessionId: string) => {
    if (editorSessionRef.current !== sessionId) return false
    setInitialStory(createSnapshot(story))
    return true
  }, [])

  const isDirty = !!(
    storyEditMode === 'editor' &&
    currentStory &&
    initialStory &&
    (
      currentStory.title !== initialStory.title ||
      currentStory.editorType !== initialStory.editorType ||
      JSON.stringify([...currentStory.contentEditorTypes].sort()) !== JSON.stringify([...initialStory.contentEditorTypes].sort()) ||
      (currentStory.milkContent ?? null) !== initialStory.milkContent ||
      currentStory.tiptapContent !== initialStory.tiptapContent ||
      JSON.stringify(currentStory.tiptapContentJson ?? null) !== JSON.stringify(initialStory.tiptapContentJson ?? null) ||
      currentStory.isPublished !== initialStory.isPublished ||
      currentStory.storyDate !== initialStory.storyDate ||
      currentStory.coverPhotoId !== initialStory.coverPhotoId ||
      JSON.stringify(currentStory.coverCrop ?? null) !== JSON.stringify(initialStory.coverCrop ?? null) ||
      JSON.stringify(currentStory.photos?.map((photo) => photo.id) || []) !== JSON.stringify(initialStory.photoIds) ||
      pendingImages.length > 0 ||
      pendingCoverId !== null
    )
  )

  const resetDraftState = useCallback(() => {
    beginEditorSession()
    preservedPhotoIdsRef.current.clear()
    setInitialStory(null)
    setLastSavedAt(null)
    setDraftRestoreDialog({ isOpen: false, draft: null, story: null })
  }, [beginEditorSession])

  const saveDraft = useCallback(async () => {
    if (!currentStory) return

    const existingStory = stories.find((story) => story.id === currentStory.id)

    try {
      await enqueueDraftWrite(async () => {
        const cloudId = draftCloudIdsRef.current.get(currentStory.id)
        const photoIds = Array.from(new Set([
          ...currentStory.photos?.map((photo) => photo.id) || [],
          ...preservedPhotoIdsRef.current,
        ]))
        await saveStoryEditorDraftToDB({
          storyId: cloudId ?? (existingStory ? currentStory.id : undefined),
          draftId: cloudId || existingStory ? undefined : currentStory.id,
          title: currentStory.title,
          editorType: currentStory.editorType,
          contentEditorTypes: currentStory.contentEditorTypes,
          tiptapContent: currentStory.tiptapContent,
          tiptapContentJson: currentStory.tiptapContentJson ?? null,
          milkContent: currentStory.milkContent ?? null,
          isPublished: currentStory.isPublished,
          createdAt: currentStory.createdAt,
          coverPhotoId: currentStory.coverPhotoId,
          coverCrop: currentStory.coverCrop ?? null,
          pendingCoverId,
          photoIds,
          // 本地资源库项只落元数据（assetId/filePath/hash/exif），字节仍留在磁盘
          files: draftEntriesFromPendingImages(pendingImages),
        })
      })
      setLastSavedAt(Date.now())
      setDraftSaved(true)
      window.setTimeout(() => setDraftSaved(false), 2000)
    } catch (error) {
      console.error('Failed to save draft:', error)
    }
  }, [currentStory, enqueueDraftWrite, pendingCoverId, pendingImages, stories])

  const markDraftSynced = useCallback(async (snapshot: StoryDto, storyId: string) => {
    await enqueueDraftWrite(async () => {
      const draft = await getStoryEditorDraftFromDB(storyId)
      if (!draft) {
        // 本地记录缺失（例如新建后 2 秒内直接保存，防抖自动保存还没落盘）：
        // 用已保存的快照补齐本地记录并直接标记已同步，保持本地与云端 1:1 对应
        await saveStoryEditorDraftToDB({
          storyId,
          title: snapshot.title,
          editorType: snapshot.editorType,
          contentEditorTypes: snapshot.contentEditorTypes,
          tiptapContent: snapshot.tiptapContent,
          tiptapContentJson: snapshot.tiptapContentJson ?? null,
          milkContent: snapshot.milkContent ?? null,
          isPublished: snapshot.isPublished,
          createdAt: snapshot.createdAt,
          coverPhotoId: snapshot.coverPhotoId,
          coverCrop: snapshot.coverCrop ?? null,
          pendingCoverId: null,
          photoIds: snapshot.photos?.map((photo) => photo.id) || [],
          files: [],
          cloudSynced: true,
        })
        return
      }
      if (draft.title !== snapshot.title || draft.editorType !== snapshot.editorType
        || (draft.milkContent ?? null) !== (snapshot.milkContent ?? null)
        || draft.tiptapContent !== snapshot.tiptapContent
        || JSON.stringify(draft.tiptapContentJson ?? null) !== JSON.stringify(snapshot.tiptapContentJson ?? null)
        || draft.isPublished !== snapshot.isPublished
        || (draft.coverPhotoId ?? null) !== (snapshot.coverPhotoId ?? null)
        || JSON.stringify(draft.coverCrop ?? null) !== JSON.stringify(snapshot.coverCrop ?? null)
        || JSON.stringify(draft.photoIds) !== JSON.stringify(snapshot.photos.map((photo) => photo.id))
        || (draft.files?.length ?? 0) > 0 || draft.pendingCoverId) return
      await markStoryEditorDraftSynced(storyId, draft.savedAt)
    })
  }, [enqueueDraftWrite])

  const applyDraft = useCallback((draft: StoryEditorDraftData, baseStory: StoryDto) => {
    beginEditorSession()
    const restoredPhotos = draft.photoIds
      .map((id) => allPhotos.find((photo) => photo.id === id) || baseStory.photos?.find((photo) => photo.id === id))
      .filter((photo): photo is PhotoDto => Boolean(photo))
    // 图库未加载（离线）时记录未解析的 photoId，防止自动保存把它们从草稿里冲掉
    const restoredIds = new Set(restoredPhotos.map((photo) => photo.id))
    preservedPhotoIdsRef.current = new Set(draft.photoIds.filter((id) => !restoredIds.has(id)))

    const restoredStory: StoryDto = {
      ...baseStory,
      title: draft.title,
      editorType: draft.editorType,
      contentEditorTypes: [...draft.contentEditorTypes],
      tiptapContent: draft.tiptapContent,
      tiptapContentJson: draft.tiptapContentJson ?? null,
      milkContent: draft.milkContent ?? null,
      isPublished: draft.isPublished,
      createdAt: draft.createdAt || baseStory.createdAt,
      storyDate: draft.createdAt || baseStory.storyDate,
      coverPhotoId: draft.coverPhotoId ?? baseStory.coverPhotoId,
      coverCrop: draft.coverCrop ?? baseStory.coverCrop ?? null,
      photos: restoredPhotos,
    }
    setCurrentStory(restoredStory)
    setPendingImages(restorePendingImages(draft.files))
    setPendingCoverId(draft.pendingCoverId || null)
    setLastSavedAt(draft.savedAt)
    setInitialStory({ ...createSnapshot(restoredStory), photoIds: draft.photoIds })
    notify(t('admin.restored_from_draft'), 'info')
  }, [allPhotos, beginEditorSession, notify, restorePendingImages, setCurrentStory, setPendingCoverId, setPendingImages, t])

  const createStoryWithDraftCheck = useCallback(async () => {
    beginEditorSession()
    preservedPhotoIdsRef.current.clear()
    const newStory = createEmptyStory()
    setInitialStory(createSnapshot(newStory))
    setPendingImages([])
    setPendingCoverId(null)
    setCurrentStory(newStory)
    setStoryEditMode('editor')
  }, [beginEditorSession, setCurrentStory, setPendingCoverId, setPendingImages, setStoryEditMode])

  const editStoryWithDraftCheck = useCallback(async (
    story: StoryDto,
    source: 'prompt' | 'draft' | 'database' = 'prompt',
  ) => {
    beginEditorSession()
    preservedPhotoIdsRef.current.clear()
    const editableStory = { ...story }
    setInitialStory(createSnapshot(editableStory))

    if (source === 'database') {
      setPendingImages([])
      setPendingCoverId(null)
      setCurrentStory(editableStory)
      setStoryEditMode('editor')
      return
    }

    try {
      const draft = await getStoryEditorDraftFromDB(story.id)
      if (source === 'draft' && draft) {
        applyDraft(draft, story)
        setStoryEditMode('editor')
        return
      }
      if (source === 'prompt' && draft && !draft.cloudSynced && draft.savedAt && draft.savedAt > new Date(story.updatedAt).getTime()) {
        setCurrentStory(editableStory)
        setDraftRestoreDialog({ isOpen: true, draft, story: editableStory })
        return
      }
    } catch (error) {
      console.error('Failed to check draft:', error)
    }

    setPendingImages([])
    setPendingCoverId(null)
    setCurrentStory(editableStory)
    setStoryEditMode('editor')
  }, [applyDraft, beginEditorSession, setCurrentStory, setPendingCoverId, setPendingImages, setStoryEditMode])

  const handleDraftRestore = useCallback(() => {
    if (draftRestoreDialog.draft && draftRestoreDialog.story) {
      applyDraft(draftRestoreDialog.draft, draftRestoreDialog.story)
    }
    setDraftRestoreDialog({ isOpen: false, draft: null, story: null })
    setStoryEditMode('editor')
  }, [applyDraft, draftRestoreDialog, setStoryEditMode])

  const handleDraftDiscard = useCallback(() => {
    if (draftRestoreDialog.story) {
      setCurrentStory(draftRestoreDialog.story)
      setPendingImages([])
      setPendingCoverId(null)
    }
    setDraftRestoreDialog({ isOpen: false, draft: null, story: null })
    setStoryEditMode('editor')
  }, [draftRestoreDialog.story, setCurrentStory, setPendingCoverId, setPendingImages, setStoryEditMode])

  const handleDraftCancel = useCallback(() => {
    beginEditorSession()
    setDraftRestoreDialog({ isOpen: false, draft: null, story: null })
    setCurrentStory(null)
    setStoryEditMode('list')
  }, [beginEditorSession, setCurrentStory, setStoryEditMode])

  useEffect(() => {
    if (!editFromDraft) {
      // 草稿消费后重置，下一份草稿重新尝试加载图库（期间可能已连接站点）
      if (photosHydrated) setPhotosHydrated(false)
      return
    }
    if (allPhotos.length === 0 && !photosHydrated) {
      void loadAllPhotos().finally(() => setPhotosHydrated(true))
    }
  }, [allPhotos.length, editFromDraft, loadAllPhotos, photosHydrated])

  useEffect(() => {
    if (storyEditMode === 'editor' && allPhotos.length === 0) {
      void loadAllPhotos()
    }
  }, [allPhotos.length, loadAllPhotos, storyEditMode])

  useEffect(() => {
    if (storyEditMode !== 'editor' || !currentStory || !isDirty) return

    const timer = window.setTimeout(() => {
      void saveDraft()
    }, AUTO_SAVE_DELAY)

    return () => window.clearTimeout(timer)
  }, [currentStory, isDirty, pendingImages.length, saveDraft, storyEditMode])

  useEffect(() => {
    if (!editFromDraft || (editFromDraft.photoIds.length > 0 && allPhotos.length === 0 && !photosHydrated)) return

    queueMicrotask(() => {
      beginEditorSession()
      const milkContent = editFromDraft.milkContent ?? null
      const restoredPhotos = editFromDraft.photoIds
        .map((id) => allPhotos.find((photo) => photo.id === id))
        .filter((photo): photo is PhotoDto => Boolean(photo))
      // 图库未加载（离线）时记录未解析的 photoId，防止自动保存把它们从草稿里冲掉
      const restoredIds = new Set(restoredPhotos.map((photo) => photo.id))
      preservedPhotoIdsRef.current = new Set(editFromDraft.photoIds.filter((id) => !restoredIds.has(id)))

      setCurrentStory({
        id: getNewStoryIdFromDraft(editFromDraft),
        title: editFromDraft.title,
        editorType: editFromDraft.editorType,
        contentEditorTypes: [...editFromDraft.contentEditorTypes],
        tiptapContent: editFromDraft.tiptapContent,
        tiptapContentJson: editFromDraft.tiptapContentJson ?? null,
        milkContent,
        isPublished: editFromDraft.isPublished,
        storyDate: editFromDraft.createdAt,
        createdAt: editFromDraft.createdAt,
        updatedAt: new Date().toISOString(),
        coverPhotoId: editFromDraft.coverPhotoId ?? undefined,
        coverCrop: editFromDraft.coverCrop ?? null,
        photos: restoredPhotos,
      })
      setPendingImages(restorePendingImages(editFromDraft.files))
      setPendingCoverId(editFromDraft.pendingCoverId || null)
      setLastSavedAt(editFromDraft.savedAt)
      setInitialStory({
        title: editFromDraft.title,
        editorType: editFromDraft.editorType,
        contentEditorTypes: [...editFromDraft.contentEditorTypes],
        tiptapContent: editFromDraft.tiptapContent,
        tiptapContentJson: editFromDraft.tiptapContentJson ?? null,
        milkContent,
        isPublished: editFromDraft.isPublished,
        createdAt: editFromDraft.createdAt,
        storyDate: editFromDraft.createdAt,
        photoIds: editFromDraft.photoIds,
        coverPhotoId: editFromDraft.coverPhotoId ?? undefined,
        coverCrop: editFromDraft.coverCrop ?? null,
      })
      setStoryEditMode('editor')
      notify(t('admin.restored_from_draft'), 'info')
      onDraftConsumed?.()
    })
  }, [allPhotos, beginEditorSession, editFromDraft, notify, onDraftConsumed, photosHydrated, restorePendingImages, setCurrentStory, setPendingCoverId, setPendingImages, setStoryEditMode, t])

  return {
    editorSessionId,
    draftSaved,
    lastSavedAt,
    initialStory,
    isDirty,
    draftRestoreDialog,
    createStoryWithDraftCheck,
    editStoryWithDraftCheck,
    handleDraftRestore,
    handleDraftDiscard,
    handleDraftCancel,
    markDraftSynced,
    rekeySavedDraft,
    saveDraft,
    resetDraftState,
    acceptSavedStory,
  }
}
