'use client'

import { useCallback, useRef, useState } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { DragEvent } from 'react'
import ExifReader from 'exifreader'
import { resolveAssetUrl } from '@/lib/api/core'
import {
  addPhotosToAlbum,
  addPhotosToStory,
  type PhotoDto,
  type StoryDto,
} from '@/lib/api'
import { buildMediaMarkdown } from '@mo-gallery/milkdown/media'
import type { NarrativeMilkdownEditorHandle } from '@/components/NarrativeMilkdownEditor'
import type { PendingImage } from '@/components/admin/StoryPhotoPanel'
import type { UploadSettings } from '@/components/admin/ImageUploadSettingsModal'
import { STORY_PASTE_UPLOAD_SETTINGS_KEY, STORY_UPLOAD_SETTINGS_KEY } from './constants'
import type { UploadProgressState } from './types'
import { useStoryPasteUploads } from './useStoryPasteUploads'
import { uploadStoryPhotoFile } from './uploadStoryPhotoFile'
import { isMilkdownStoryReady } from './utils'
import { GetAllPhotos } from '../../../../wailsjs/go/main/App'
import { useUploadQueue } from '@/contexts/UploadQueueContext'
import {
  isLocalLibraryPending,
  pendingDisplayName,
  queueLocalAssetUploads,
  releasePendingPreview,
  waitForTaskOutcome,
} from '@/lib/editor-pending-import'

interface UseStoryEditorActionsParams {
  token: string | null
  currentStory: StoryDto | null
  allPhotos: PhotoDto[]
  stories: StoryDto[]
  pendingImages: PendingImage[]
  cdnDomain?: string
  initialUploadSettings: UploadSettings
  initialPasteUploadSettings: UploadSettings
  pendingPhotoIdsRef: MutableRefObject<string[] | null>
  /**
   * 编辑器句柄由调用方持有：doSaveStory 需要在保存时同步读取编辑器真实内容
   * （上传替换占位发生在 handleConfirmUpload 内部，不会回溯改写已在执行中的闭包），
   * 所以两处必须共用同一个 ref，不能在 hook 内部另建一个。
   */
  editorRef: MutableRefObject<NarrativeMilkdownEditorHandle | null>
  setCurrentStory: Dispatch<SetStateAction<StoryDto | null>>
  setAllPhotos: Dispatch<SetStateAction<PhotoDto[]>>
  setPendingImages: Dispatch<SetStateAction<PendingImage[]>>
  notify: (message: string, type?: 'success' | 'error' | 'info') => void
  t: (key: string) => string
  onRequestSave: () => Promise<void>
}

interface UseStoryEditorActionsResult {
  showUploadSettings: boolean
  setShowUploadSettings: Dispatch<SetStateAction<boolean>>
  showPasteUploadSettings: boolean
  setShowPasteUploadSettings: Dispatch<SetStateAction<boolean>>
  isUploading: boolean
  uploadProgress: UploadProgressState
  pendingPasteFilesRef: MutableRefObject<File[] | null>
  uploadSettings: UploadSettings
  pasteUploadSettings: UploadSettings
  hasConfirmedPasteSettings: boolean
  handlePhotoPanelDrop: (event: DragEvent) => Promise<void>
  handleRemovePendingImage: (id: string) => void
  handleConfirmUpload: (settings: UploadSettings) => Promise<void>
  handleRetryFailedUploads: () => void
  handlePasteFiles: (files: File[]) => void
  handleConfirmPasteUpload: (settings: UploadSettings) => Promise<void>
  handleInsertPhotoMarkdown: (photo: PhotoDto) => void
  handleInsertGalleryMarkdown: (photoIds: string[]) => void
  /** 把素材库里的待传项作为占位卡插入正文（上传成功后原位替换） */
  handleInsertPendingPlaceholder: (pending: PendingImage) => void
  restoreUploadSettings: (settings: UploadSettings) => void
  restorePasteUploadSettings: (settings: UploadSettings) => void
}

async function readTakenAt(file: File) {
  try {
    const tags = await ExifReader.load(file)
    const dateTime = tags.DateTimeOriginal || tags.DateTime
    if (!dateTime?.description) return undefined

    const match = dateTime.description.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
    if (!match) return undefined

    const [, year, month, day, hour, minute, second] = match
    return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`
  } catch {
    return undefined
  }
}

export function useStoryEditorActions({
  token,
  currentStory,
  allPhotos,
  stories,
  pendingImages,
  cdnDomain,
  initialUploadSettings,
  initialPasteUploadSettings,
  pendingPhotoIdsRef,
  editorRef,
  setCurrentStory,
  setAllPhotos,
  setPendingImages,
  notify,
  t,
  onRequestSave,
}: UseStoryEditorActionsParams): UseStoryEditorActionsResult {
  const editorReady = isMilkdownStoryReady(currentStory)
  const pendingPasteFilesRef = useRef<File[] | null>(null)
  // 本地资源库来源的待传项经全局队列上传（UploadLocalAsset 自动写回云关联）
  const { addTasks, getTasks } = useUploadQueue()

  const [showUploadSettings, setShowUploadSettings] = useState(false)
  const [showPasteUploadSettings, setShowPasteUploadSettings] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState>({ current: 0, total: 0, currentFile: '' })
  const [hasConfirmedPasteSettings, setHasConfirmedPasteSettings] = useState(false)
  const [uploadSettings, setUploadSettings] = useState<UploadSettings>(initialUploadSettings)
  const [pasteUploadSettings, setPasteUploadSettings] = useState<UploadSettings>(initialPasteUploadSettings)

  const persistUploadSettings = useCallback((settings: UploadSettings) => {
    setUploadSettings(settings)

    if (typeof window === 'undefined') return

    try {
      window.localStorage.setItem(STORY_UPLOAD_SETTINGS_KEY, JSON.stringify(settings))
    } catch (error) {
      console.error('Failed to persist upload settings:', error)
    }
  }, [])

  const persistPasteUploadSettings = useCallback((settings: UploadSettings) => {
    setPasteUploadSettings(settings)
    setHasConfirmedPasteSettings(true)

    if (typeof window === 'undefined') return

    try {
      window.localStorage.setItem(STORY_PASTE_UPLOAD_SETTINGS_KEY, JSON.stringify(settings))
    } catch (error) {
      console.error('Failed to persist paste upload settings:', error)
    }
  }, [])

  const restorePasteUploadSettings = useCallback((settings: UploadSettings) => {
    setPasteUploadSettings(settings)
  }, [])

  const restoreUploadSettings = useCallback((settings: UploadSettings) => {
    setUploadSettings(settings)
  }, [])

  const insertDirective = useCallback((markdown: string) => {
    if (!editorReady || !editorRef.current) return false
    editorRef.current.insertMarkdown(markdown)
    const milkContent = editorRef.current.getValue()
    setCurrentStory((prev) => (prev && prev.id === currentStory?.id && isMilkdownStoryReady(prev) ? { ...prev, milkContent } : prev))
    return true
  }, [currentStory?.id, editorReady, setCurrentStory])

  const syncEditorContent = useCallback(() => {
    if (!editorReady || !editorRef.current) return
    const milkContent = editorRef.current.getValue()
    setCurrentStory((prev) => (prev && prev.id === currentStory?.id && isMilkdownStoryReady(prev) ? { ...prev, milkContent } : prev))
  }, [currentStory?.id, editorReady, setCurrentStory])

  const insertUploadPlaceholder = useCallback((placeholder: {
    uploadId: string
    fileName: string
    imageWidth: number
    imageHeight: number
  }) => {
    if (!editorReady) return
    editorRef.current?.insertImageUploadPlaceholder(placeholder)
    syncEditorContent()
  }, [editorReady, syncEditorContent])

  const resolveUploadPlaceholder = useCallback((uploadId: string, photo: PhotoDto) => {
    if (!editorReady) return false
    const resolved = editorRef.current?.resolveImageUploadPlaceholder(uploadId, {
      src: resolveAssetUrl(photo.url, cdnDomain),
      alt: photo.title,
      photoId: photo.id,
    }) ?? false
    syncEditorContent()
    return resolved
  }, [cdnDomain, editorReady, syncEditorContent])

  const failUploadPlaceholder = useCallback((uploadId: string) => {
    if (!editorReady) return
    editorRef.current?.failImageUploadPlaceholder(uploadId)
    syncEditorContent()
  }, [editorReady, syncEditorContent])

  const addPhotoToCurrentStory = useCallback((photo: PhotoDto) => {
    setCurrentStory((prev) => {
      if (!prev) return prev
      if (prev.photos.some((item) => item.id === photo.id)) return prev
      return { ...prev, photos: [...prev.photos, photo] }
    })
  }, [setCurrentStory])

  const addPhotoToCache = useCallback((photo: PhotoDto) => {
    setAllPhotos((prev) => (prev.some((item) => item.id === photo.id) ? prev : [photo, ...prev]))
  }, [setAllPhotos])

  const findExistingPhotoById = useCallback(async (photoId: string) => {
    const cachedPhoto = currentStory?.photos.find((photo) => photo.id === photoId)
      || allPhotos.find((photo) => photo.id === photoId)

    if (cachedPhoto) {
      return cachedPhoto
    }

    const photos = await GetAllPhotos() as unknown as PhotoDto[]
    setAllPhotos(photos || [])
    return (photos || []).find((photo: PhotoDto) => photo.id === photoId) ?? null
  }, [allPhotos, currentStory?.photos, setAllPhotos])

  const { uploadAndInsertFiles } = useStoryPasteUploads({
    token: token || '',
    notify,
    setUploadProgress,
    insertUploadPlaceholder,
    resolveUploadPlaceholder,
    failUploadPlaceholder,
    findExistingPhotoById,
    addPhotoToCache,
    addPhotoToCurrentStory,
    persistPasteUploadSettings,
    setShowPasteUploadSettings,
    setIsUploading,
    pendingPasteFilesRef,
  })

  const handlePhotoPanelDrop = useCallback(async (event: DragEvent) => {
    event.preventDefault()
    if (!editorReady) return
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith('image/'))
    if (files.length === 0) return

    const newPending = await Promise.all(files.map(async (file) => ({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file),
      status: 'pending' as const,
      progress: 0,
      takenAt: await readTakenAt(file),
    })))

    setPendingImages((prev) => [...prev, ...newPending])
  }, [editorReady, setPendingImages])

  const handleRemovePendingImage = useCallback((id: string) => {
    setPendingImages((prev) => {
      const item = prev.find((image) => image.id === id)
      // 本地资源库来源用的是资源库 URL，不能 revoke
      if (item) releasePendingPreview(item.previewUrl)
      return prev.filter((image) => image.id !== id)
    })
  }, [setPendingImages])

  const handleConfirmUpload = useCallback(async (settings: UploadSettings) => {
    if (!token || !currentStory || !editorReady) return

    persistUploadSettings(settings)
    setShowUploadSettings(false)
    setIsUploading(true)
    const toUpload = pendingImages.filter((image) => image.status === 'pending' || image.status === 'failed')
    setUploadProgress({ current: 0, total: toUpload.length, currentFile: '' })

    const uploadedPhotoIds: string[] = []
    const uploadedPhotos: PhotoDto[] = []
    // 逐项累计成功数：去重命中时两项可能映射到同一 photoId，
    // 用 uploadedPhotoIds.length 反推失败数会把成功误判成失败。
    let successCount = 0
    // 待传项 id → 上传所得 photoId：用于把正文里该待传项的占位卡换成真图。
    // 待传项 id 就是插卡时的 uploadId（见 handleInsertPendingPlaceholder）。
    const photoIdByPendingId = new Map<string, string>()

    // ── 本地资源库来源：走原生链路 ────────────────────────────────
    // UploadLocalAsset 在 Go 侧完成上传并自动写回云关联（app.go:844/860），
    // 因此这里不需要 fetch(blob)，也不需要手动 SetLocalAssetCloudLink。
    // 交给全局队列后并行处理，最后统一等待终态再收尾。
    const localLibraryItems = toUpload.filter(isLocalLibraryPending)
    const queuedTasks = queueLocalAssetUploads(localLibraryItems, settings, addTasks)
    if (queuedTasks.length > 0) {
      for (const item of localLibraryItems) {
        setPendingImages((prev) => prev.map((image) => image.id === item.id ? { ...image, status: 'uploading' as const, progress: 0 } : image))
      }
      const outcome = await waitForTaskOutcome(queuedTasks, getTasks)
      const taskById = new Map(getTasks().map((task) => [task.id, task]))
      localLibraryItems.forEach((item, index) => {
        const task = queuedTasks[index]
        const state = task ? taskById.get(task.id) : undefined
        const photoId = state?.photoId
        if (state?.status === 'completed' && photoId) {
          successCount += 1
          if (!uploadedPhotoIds.includes(photoId)) uploadedPhotoIds.push(photoId)
          photoIdByPendingId.set(item.id, photoId)
          setPendingImages((prev) => prev.map((image) => image.id === item.id ? { ...image, status: 'success' as const, progress: 100, photoId } : image))
        } else {
          setPendingImages((prev) => prev.map((image) => image.id === item.id ? { ...image, status: 'failed' as const, error: state?.error || 'Upload failed' } : image))
        }
      })
      // 队列结果带出 photoId，但 DTO 不在手边：批量解析一次供后续关联/插入使用
      const photoDetails = outcome.photoIds.length > 0
        ? await Promise.all(outcome.photoIds.map((id) => findExistingPhotoById(id).catch(() => null)))
        : []
      for (const photo of photoDetails) {
        if (photo && !uploadedPhotos.some((item) => item.id === photo.id)) uploadedPhotos.push(photo)
      }
    }

    // ── 本地文件来源：沿用 HTTP 直传 ──────────────────────────────
    const localFileItems = toUpload.filter((image) => !isLocalLibraryPending(image))
    for (let index = 0; index < localFileItems.length; index += 1) {
      const pending = localFileItems[index]
      const file = pending.file
      if (!file) continue
      setUploadProgress({ current: index + 1, total: localFileItems.length, currentFile: file.name })
      setPendingImages((prev) => prev.map((image) => image.id === pending.id ? { ...image, status: 'uploading' as const, progress: 0 } : image))

      try {
        const { photo, reusedDuplicate } = await uploadStoryPhotoFile({
          token,
          file,
          settings,
          findExistingPhotoById,
          onProgress: (progress) => {
            setPendingImages((prev) => prev.map((image) => image.id === pending.id ? { ...image, progress } : image))
          },
        })

        if (!uploadedPhotoIds.includes(photo.id)) {
          uploadedPhotoIds.push(photo.id)
        }
        if (!uploadedPhotos.some((item) => item.id === photo.id)) {
          uploadedPhotos.push(photo)
        }
        photoIdByPendingId.set(pending.id, photo.id)
        successCount += 1
        setPendingImages((prev) => prev.map((image) => image.id === pending.id ? { ...image, status: 'success' as const, progress: 100, photoId: photo.id } : image))
        // 本地资源库来源不到这里：它由 isLocalLibraryPending 分流到原生链路，
        // 云关联由 Go 侧 UploadLocalAsset 自动回写（app.go:844/860），无需前端再补。
        if (reusedDuplicate) {
          addPhotoToCache(photo)
          notify(`图片已存在，已复用：${photo.title}`, 'info')
        }
      } catch (error) {
        setPendingImages((prev) => prev.map((image) => image.id === pending.id ? { ...image, status: 'failed' as const, error: error instanceof Error ? error.message : 'Upload failed' } : image))
      }
    }

    if (settings.albumIds?.length && uploadedPhotoIds.length > 0) {
      for (const albumId of settings.albumIds) {
        try {
          await addPhotosToAlbum(token, albumId, uploadedPhotoIds)
        } catch {}
      }
    } else if (settings.albumId && uploadedPhotoIds.length > 0) {
      try {
        await addPhotosToAlbum(token, settings.albumId, uploadedPhotoIds)
      } catch {}
    }

    // ── 正文占位卡 → 真实图片 ────────────────────────────────────
    // 素材库的待传项插入正文时留下 kind='upload' 的占位卡（uploadId = 待传项 id）。
    // 这里按 uploadId 原位替换；失败项标记为 failed 卡，让用户看得见并手动移除。
    // 必须放在本函数**内部**：调用方（StoriesTab.doSaveStory）随后会同步读取编辑器内容，
    // 若把替换留到返回之后，保存到的仍是占位正文。
    // 上传成功但 DTO 解析失败（uploadedPhotos 里没有）时记下来，不让静默留下 pending 卡。
    const unresolvedPlaceholderNames: string[] = []
    if (editorRef.current) {
      for (const item of toUpload) {
        const photoId = photoIdByPendingId.get(item.id)
        const photo = photoId ? uploadedPhotos.find((entry) => entry.id === photoId) : undefined
        if (photo) {
          // 同一待传项可能插了多张卡，updateUpload 会把该 uploadId 的**全部**卡片一起替换
          editorRef.current.resolveImageUploadPlaceholder(item.id, {
            src: resolveAssetUrl(photo.url, cdnDomain),
            alt: photo.title,
            photoId: photo.id,
          })
        } else {
          // 上传失败的（含未走到上传的项）→ 失败卡；上传成功但取不到 DTO 的 → 也标记，
          // 否则会留下一张永远不动的「待上传」卡，把保存永久拦住。
          editorRef.current.failImageUploadPlaceholder(item.id)
          if (photoId) unresolvedPlaceholderNames.push(pendingDisplayName(item))
        }
      }
      syncEditorContent()
    }
    if (unresolvedPlaceholderNames.length > 0) {
      notify(
        `${unresolvedPlaceholderNames.length} 张图片已上传但正文占位未能替换，请手动移除对应卡片：${unresolvedPlaceholderNames.slice(0, 3).join('、')}`,
        'error',
      )
    }

    if (uploadedPhotos.length > 0) {
      const isNew = !stories.find((story) => story.id === currentStory.id)
      if (isNew) {
        setCurrentStory((prev) => {
          if (!prev) return prev
          const existingIds = new Set((prev.photos || []).map((photo) => photo.id))
          const nextPhotos = uploadedPhotos.filter((photo) => !existingIds.has(photo.id))
          return nextPhotos.length > 0 ? { ...prev, photos: [...(prev.photos || []), ...nextPhotos] } : prev
        })
      } else {
        try {
          const existingIds = new Set((currentStory.photos || []).map((photo) => photo.id))
          const newPhotoIds = uploadedPhotoIds.filter((photoId) => !existingIds.has(photoId))
          if (newPhotoIds.length > 0) {
            await addPhotosToStory(token, currentStory.id, newPhotoIds)
          }
          setCurrentStory((prev) => {
            if (!prev) return prev
            const currentIds = new Set((prev.photos || []).map((photo) => photo.id))
            const nextPhotos = uploadedPhotos.filter((photo) => !currentIds.has(photo.id))
            return nextPhotos.length > 0 ? { ...prev, photos: [...(prev.photos || []), ...nextPhotos] } : prev
          })
        } catch {}
      }
    }

    setPendingImages((prev) => {
      prev.filter((image) => image.status === 'success').forEach((image) => releasePendingPreview(image.previewUrl))
      return prev.filter((image) => image.status !== 'success')
    })
    setIsUploading(false)

    // 用本批逐项累计的成功数计失败：闭包里的 pendingImages 是上传前快照，读不到本轮状态迁移
    const failedCount = toUpload.length - successCount
    if (failedCount === 0) {
      // Pass uploaded photo IDs via ref so doSaveStory can merge them
      // (setCurrentStory hasn't re-rendered yet, so the closure state is stale)
      pendingPhotoIdsRef.current = uploadedPhotoIds
      await onRequestSave()
      return
    }

    notify(`${failedCount} ${t('admin.upload_failed_count')}`, 'error')
  }, [addPhotoToCache, addTasks, cdnDomain, currentStory, editorReady, findExistingPhotoById, getTasks, notify, onRequestSave, pendingImages, persistUploadSettings, setCurrentStory, setPendingImages, stories, syncEditorContent, t, token])

  const handleRetryFailedUploads = useCallback(() => {
    if (!editorReady) return
    setPendingImages((prev) => prev.map((image) => image.status === 'failed' ? { ...image, status: 'pending' as const, error: undefined, progress: 0 } : image))
    setShowUploadSettings(true)
  }, [editorReady, setPendingImages])

  const handlePasteFiles = useCallback((files: File[]) => {
    if (!token || !currentStory || !editorReady) return

    if (!hasConfirmedPasteSettings) {
      pendingPasteFilesRef.current = files
      setShowPasteUploadSettings(true)
      return
    }

    void uploadAndInsertFiles(files, pasteUploadSettings)
  }, [currentStory, editorReady, hasConfirmedPasteSettings, pasteUploadSettings, setShowPasteUploadSettings, token, uploadAndInsertFiles])

  const handleConfirmPasteUpload = useCallback(async (settings: UploadSettings) => {
    if (!editorReady) return
    persistPasteUploadSettings({ ...settings, tags: settings.tags ?? [] })

    const files = pendingPasteFilesRef.current
    if (!files?.length) {
      setShowPasteUploadSettings(false)
      return
    }

    await uploadAndInsertFiles(files, settings)
  }, [editorReady, persistPasteUploadSettings, uploadAndInsertFiles])

  /**
   * 待传项 → 正文占位卡。
   *
   * uploadId 直接用待传项的 `id`：草稿落盘时会保存待传项 id，重启恢复后 id 不变，
   * 因此「占位 ↔ 待传项」的对应关系能跨重启存活，上传成功时还能原位替换。
   * 状态取 'pending'（与粘贴链路的 'uploading' 区分）：此刻上传根本还没开始，
   * 显示成「正在上传」会误导。同一待传项允许插多次（同 uploadId 多张卡，一起被替换）。
   */
  const handleInsertPendingPlaceholder = useCallback((pending: PendingImage) => {
    if (!editorReady || !editorRef.current) return
    editorRef.current.insertImageUploadPlaceholder({
      uploadId: pending.id,
      fileName: pendingDisplayName(pending),
      status: 'pending',
    })
    syncEditorContent()
    notify(t('admin.notify_placeholder_inserted'), 'success')
  }, [editorReady, notify, syncEditorContent, t])

  const handleInsertPhotoMarkdown = useCallback((photo: PhotoDto) => {
    if (!editorReady || !editorRef.current) return
    addPhotoToCurrentStory(photo)
    if (!photo.url) {
      notify('Photo URL is unavailable', 'error')
      return
    }
    if (insertDirective(buildMediaMarkdown({ kind: 'image', src: photo.url, title: photo.title, photoId: photo.id }))) {
      notify('Inserted Markdown image', 'success')
    }
  }, [addPhotoToCurrentStory, editorReady, insertDirective, notify])

  const handleInsertGalleryMarkdown = useCallback((photoIds: string[]) => {
    if (!editorReady || !editorRef.current) return
    if (photoIds.length === 0) {
      notify('No photos available to insert', 'info')
      return
    }

    const photosToInsert = photoIds
      .map((photoId) => currentStory?.photos?.find((photo) => photo.id === photoId))
      .filter((photo): photo is PhotoDto => Boolean(photo))

    if (photosToInsert.length === 0) {
      notify('No photos available to insert', 'info')
      return
    }

    const images = photosToInsert
      .filter((photo) => Boolean(photo.url))
      .map((photo) => ({ src: photo.url!, alt: photo.title, photoId: photo.id }))
    if (!images.length) {
      notify('Photo URL is unavailable', 'error')
      return
    }
    if (insertDirective(buildMediaMarkdown({ kind: 'gallery', images }))) {
      notify('Inserted Markdown gallery', 'success')
    }
  }, [currentStory?.photos, editorReady, insertDirective, notify])

  return {
    showUploadSettings,
    setShowUploadSettings,
    showPasteUploadSettings,
    setShowPasteUploadSettings,
    isUploading,
    uploadProgress,
    pendingPasteFilesRef,
    uploadSettings,
    pasteUploadSettings,
    hasConfirmedPasteSettings,
    handlePhotoPanelDrop,
    handleRemovePendingImage,
    handleConfirmUpload,
    handleRetryFailedUploads,
    handlePasteFiles,
    handleConfirmPasteUpload,
    handleInsertPhotoMarkdown,
    handleInsertGalleryMarkdown,
    handleInsertPendingPlaceholder,
    restoreUploadSettings,
    restorePasteUploadSettings,
  }
}

