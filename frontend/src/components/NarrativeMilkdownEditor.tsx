'use client'

import { forwardRef, useCallback, useRef } from 'react'
import { MilkdownEditor } from '@mo-gallery/milkdown'
import type { MilkdownEditorHandle, MilkdownEditorProps } from '@mo-gallery/milkdown'
import { uploadPhoto } from '@/lib/api/photos'
import { resolveAssetUrl } from '@/lib/api/core'
import type { PhotoDto } from '@/lib/api/types'
import { usePreferences } from '@/store/preferences'

export type NarrativeMilkdownEditorHandle = MilkdownEditorHandle

interface NarrativeMilkdownEditorProps extends MilkdownEditorProps {
  token?: string | null
  photos?: PhotoDto[]
  cdnDomain?: string
  onPhotoUploaded?: (photo: PhotoDto) => void
  /**
   * 待传项 id → 本地预览图（blob: / 本地资源库缩略图）。
   * 用于让正文里的占位卡插入后**立刻回显这张图**（不落进文档，理由见下）。
   */
  pendingPreviews?: Map<string, string>
}

/** Desktop supplies storage and photo URLs; all editing belongs to Milkdown. */
const NarrativeMilkdownEditor = forwardRef<MilkdownEditorHandle, NarrativeMilkdownEditorProps>(function NarrativeMilkdownEditor({ token, photos, cdnDomain, onPhotoUploaded, pendingPreviews, ...props }, ref) {
  const language = usePreferences((state) => state.language)
  /**
   * 预览表放进 ref 而不是直接闭包：宿主每次待传项变化都会重建 Map，
   * 若闭包捕获它，`resolveUploadPreview` 的身份就会跟着变、连锁触发编辑器的重渲染 effect。
   * 读取时取最新值即可（编辑器会在预览就绪时通过 refreshUploadPreviews 主动通知）。
   */
  const previewsRef = useRef(pendingPreviews)
  previewsRef.current = pendingPreviews
  const resolveUploadPreview = useCallback((uploadId: string) => previewsRef.current?.get(uploadId), [])
  const resolveMediaUrl = useCallback((src: string, photoId?: string) => {
    const photo = photoId ? photos?.find((entry) => entry.id === photoId) : undefined
    return resolveAssetUrl(photo?.url || src, cdnDomain)
  }, [cdnDomain, photos])
  const onUpload = useCallback(async (file: File) => {
    if (!token) throw new Error(language === 'zh' ? '请先连接站点，再上传图片。' : 'Connect to your site before uploading images.')
    const photo = await uploadPhoto({ token, file, title: file.name, tags: [], origin_flag: 'desktop' })
    if (!photo.url) throw new Error(language === 'zh' ? '图片地址不可用。' : 'The image URL is unavailable.')
    onPhotoUploaded?.(photo)
    return photo.url
  }, [language, onPhotoUploaded, token])

  return <MilkdownEditor {...props} ref={ref} language={language} resolveMediaUrl={resolveMediaUrl} resolveUploadPreview={resolveUploadPreview} onUpload={onUpload} />
})

export default NarrativeMilkdownEditor
