/**
 * 编辑器素材库「待传素材」的共享契约与本地资源库适配层。
 * 叙事编辑器（文章创作 → 叙事）在用；博客侧若接入同一套素材库可直接复用。
 *
 * 为什么需要它：从本地资源库选中的照片属于「本地来源」，与拖入本地文件同类，
 * 但云端上传必须走本地资源库的**原生链路**，才能在 Go 侧自动回写云关联：
 *
 *   PrepareLocalAssetUpload(assetIds)              → PreparedFile{ assetId, filePath, hash, exif }
 *   addTasks([{ filePath, assetId, hash, exif }])  → UploadLocalAsset()（Go 侧 setLocalAssetCloudLink）
 *
 * 与「本地文件」来源的区别（关键）：
 * - 待传项**不需要 File 对象**：UploadLocalAsset 自己按 assetId 从磁盘读原图；
 * - 预览图直接复用资源库缩略图 URL，不做 fetch(blob)；
 * - 来源判定只看 `assetId`（UploadQueueContext 也按 assetId 选 UploadLocalAsset）。
 *   `filePath` 只是队列内 hashes/exifs 两张表的键，**不能**当作来源判据：
 *   草稿恢复出来的项若因缺 filePath 被判成「本地文件」，会走 HTTP 直传把空文件传上去。
 * - 缩略图 URL 带 session + 缓存键（local_library/store.go:1162、operations.go:641），
 *   跨重启必然失效 ⇒ 草稿**不存 URL**，恢复时按 assetId 现取（见 localAssetPreviewUrls）。
 */

import { PrepareLocalAssetUpload } from '../../wailsjs/go/main/App'
import type { image } from '../../wailsjs/go/models'
import type { UploadSettings as QueueUploadSettings, UploadTask } from '@/contexts/UploadQueueContext'
import { localLibraryApi } from '@/features/library/local/api'
import type { LocalAsset } from '@/features/library/local/types'
import type { DraftFileEntry } from '@/lib/client-db'
import type { UploadSettings } from '@/components/admin/ImageUploadSettingsModal'

/** Wails 生成的 ExifData 带 convertValues，跨层传递需剔除。 */
export type PreparedExif = Omit<image.ExifData, 'convertValues'>

/**
 * 素材库待传项。两类来源并存：
 *
 * - **本地文件**（拖拽 / 粘贴 / 选择文件）：有 `file`，上传走 HTTP 直传；
 * - **本地资源库**：无 `file`，只有 `assetId` + 原生链路元数据（`filePath`/`hash`/`exif`）。
 *
 * 因此 `file` 可选，展示名一律用 `pendingDisplayName`。
 */
export interface PendingImage {
  id: string
  /** 仅「本地文件」来源存在。 */
  file?: File
  /** 展示用文件名；本地文件来源等于 file.name。 */
  fileName?: string
  previewUrl: string
  status: 'pending' | 'uploading' | 'success' | 'failed'
  progress: number
  error?: string
  photoId?: string
  takenAt?: string
  /** 本地资源库资产 ID：既决定走原生链路，也是上传成功后建立云关联的依据。 */
  assetId?: string
  /**
   * 导入时解析出的磁盘路径。
   * 上传时**不读它**（Go 按 assetId 现取）；它只作队列内哈希/EXIF 表的键，
   * 所以草稿恢复出来的项即便暂时没有它也能正常上传。
   */
  filePath?: string
  fileSize?: number
  hash?: string
  exif?: PreparedExif
}

/** 待传项的展示文件名，兼容两类来源。 */
export function pendingDisplayName(pending: Pick<PendingImage, 'fileName' | 'file'>): string {
  return pending.fileName || pending.file?.name || ''
}

/**
 * 是否为「本地资源库」来源（上传走 UploadLocalAsset 原生链路）。
 *
 * 判据只有 `assetId` —— 与 UploadQueueContext 分发 UploadLocalAsset / UploadFile 的口径一致。
 * 不要掺入 `filePath`：草稿恢复出来的项在补路径前没有 filePath，
 * 一旦因此被判成「本地文件」，就会连同不存在的 File 走 HTTP 直传，静默传一个空文件上去。
 */
export function isLocalLibraryPending(pending: Pick<PendingImage, 'assetId'>): boolean {
  return Boolean(pending.assetId)
}

/** addTasks 的入参形状（UploadQueueContext 未导出该别名，就地声明保持类型安全）。 */
export interface UploadTaskInput {
  filePath: string
  assetId?: string
  fileName: string
  fileSize: number
  hash: string
  exif?: PreparedExif
  checkDuplicate?: boolean
}

/** 解析结果：原生上传链路所需的最小字段集 + 预览图。 */
export interface ResolvedLocalAsset {
  assetId: string
  filePath: string
  fileName: string
  fileSize: number
  hash: string
  exif?: PreparedExif
  /** 预览图 URL，仅本次会话有效。 */
  previewUrl: string
  takenAt?: string
}

export interface ResolveLocalAssetsResult {
  resolved: ResolvedLocalAsset[]
  failed: { assetId: string; fileName: string; error: string }[]
}

/**
 * 把本地资源库资产解析为原生上传链路所需的元数据。
 *
 * 走 Go 的 PrepareLocalAssetUpload：内部 WithOriginalPaths 取磁盘绝对路径，
 * 再复用 UploadService.PrepareUpload 计算 hash 与 EXIF。
 * PreparedFile 按传入 id 顺序对齐（app.go:793-795），故可稳定回填预览图。
 */
export async function resolveLocalAssetsForUpload(assets: LocalAsset[]): Promise<ResolveLocalAssetsResult> {
  if (assets.length === 0) return { resolved: [], failed: [] }

  const byId = new Map(assets.map((asset) => [asset.id, asset]))
  const prepared = await PrepareLocalAssetUpload(assets.map((asset) => asset.id))

  const resolved: ResolvedLocalAsset[] = []
  const failed: ResolveLocalAssetsResult['failed'] = []

  for (const file of prepared || []) {
    const assetId = file.assetId || ''
    const asset = byId.get(assetId)
    const fileName = file.fileName || asset?.fileName || ''
    if (file.error || !file.filePath) {
      failed.push({ assetId, fileName, error: file.error || '无法读取原图' })
      continue
    }
    resolved.push({
      assetId,
      filePath: file.filePath,
      fileName,
      fileSize: Number(file.fileSize) || asset?.byteSize || 0,
      hash: file.hash,
      exif: file.exif as PreparedExif | undefined,
      previewUrl: asset?.thumbnailUrl || asset?.previewUrl || '',
      takenAt: asset?.capturedAt,
    })
  }

  return { resolved, failed }
}

/** 已解析的本地资源库项 → 待传项。 */
export function toPendingImages(items: ResolvedLocalAsset[]): PendingImage[] {
  return items.map((item) => ({
    id: crypto.randomUUID(),
    previewUrl: item.previewUrl,
    fileName: item.fileName,
    status: 'pending' as const,
    progress: 0,
    takenAt: item.takenAt,
    assetId: item.assetId,
    filePath: item.filePath,
    fileSize: item.fileSize,
    hash: item.hash,
    exif: item.exif,
  }))
}

/** 本地文件（拖拽 / 粘贴）→ 待传项。 */
export function toPendingImagesFromFiles(files: File[], takenAt?: (file: File) => string | undefined): PendingImage[] {
  return files.map((file) => ({
    id: crypto.randomUUID(),
    file,
    fileName: file.name,
    previewUrl: URL.createObjectURL(file),
    status: 'pending' as const,
    progress: 0,
    takenAt: takenAt?.(file),
  }))
}

/**
 * 草稿条目 → 待传项（同步，恢复时立即可用，不必等磁盘解析）。
 *
 * 本地资源库项的 assetId / filePath / hash / exif 都随草稿落盘（导入时就已解析过一次），
 * 所以恢复后即可直接交给上传队列 —— 真正读盘由 Go 按 assetId 现取，路径挪了也不怕。
 * 只有缩略图必须现取（会话级 URL 跨重启失效），缺图的 assetId 由
 * `localAssetIdsNeedingPreview` 带出，交给 localAssetPreviewUrls。
 */
export function pendingImagesFromDraftEntries(entries: DraftFileEntry[]): {
  pending: PendingImage[]
  localAssetIdsNeedingPreview: string[]
} {
  const localAssetIdsNeedingPreview: string[] = []
  const pending = entries
    .map((entry): PendingImage | null => {
      if (entry.assetId) {
        if (!localAssetIdsNeedingPreview.includes(entry.assetId)) {
          localAssetIdsNeedingPreview.push(entry.assetId)
        }
        return {
          id: entry.id,
          fileName: entry.fileName,
          previewUrl: '',
          status: 'pending',
          progress: 0,
          takenAt: entry.takenAt,
          assetId: entry.assetId,
          filePath: entry.filePath,
          fileSize: entry.fileSize,
          hash: entry.hash,
          exif: entry.exif as PreparedExif | undefined,
        }
      }
      // 本地文件来源：字节就在草稿里，还原成 blob URL 即可
      const file = entry.file
      if (!file) return null
      return {
        id: entry.id,
        file,
        fileName: entry.fileName || file.name,
        previewUrl: URL.createObjectURL(file),
        status: 'pending',
        progress: 0,
        takenAt: entry.takenAt,
      }
    })
    .filter((item): item is PendingImage => item !== null)
  return { pending, localAssetIdsNeedingPreview }
}

/** Go 侧 listAssets 的 limit 上限（local_library/store.go:1033）。 */
const LOCAL_ASSET_QUERY_LIMIT = 200

/**
 * 按 assetId 取回**新鲜**的缩略图 URL（草稿里刻意不存 URL）。
 * 资源库未打开或查询失败时返回空表：调用方保持原样即可
 * —— 宁可暂时没有图，也不能因此丢掉待传项。
 */
export async function localAssetPreviewUrls(assetIds: string[]): Promise<Map<string, string>> {
  const ids = Array.from(new Set(assetIds.filter(Boolean)))
  if (ids.length === 0) return new Map()
  const page = await localLibraryApi.listAssets({ ids, limit: Math.min(ids.length, LOCAL_ASSET_QUERY_LIMIT) })
  const previews = new Map<string, string>()
  for (const asset of page.items) {
    const url = asset.thumbnailUrl || asset.previewUrl
    if (url) previews.set(asset.id, url)
  }
  return previews
}

/**
 * 待传项 → 草稿条目（写盘方向，与 pendingImagesFromDraftEntries 对称）。
 *
 * 本地资源库项把导入时已解析的 filePath/hash/exif 一并落盘，
 * 恢复后即可直接上传，无需再读一遍原图；缩略图 URL 刻意不存（会话级，必失效）。
 */
export function draftEntriesFromPendingImages(items: PendingImage[]): DraftFileEntry[] {
  return items.map((item) => ({
    id: item.id,
    file: item.file,
    fileName: pendingDisplayName(item),
    takenAt: item.takenAt,
    assetId: item.assetId,
    filePath: item.filePath,
    fileSize: item.fileSize,
    hash: item.hash,
    exif: item.exif,
  }))
}

/**
 * 把本地资源库待传项交给全局上传队列，由 UploadLocalAsset 完成上传并自动写回云关联。
 * 队列是异步的：结果经 getTasks() 轮询取回（见 waitForTaskOutcome）。
 *
 * `filePath` 缺失不影响正确性：队列按 assetId 选 UploadLocalAsset，
 * 并由 Go 现取磁盘路径；这里的 filePath 只作队列内的键，故缺失时退化为 assetId。
 */
export function queueLocalAssetUploads(
  items: PendingImage[],
  settings: UploadSettings,
  addTasks: (files: UploadTaskInput[], settings: QueueUploadSettings) => UploadTask[],
): UploadTask[] {
  const ready = items.filter(isLocalLibraryPending)
  if (ready.length === 0) return []
  return addTasks(
    ready.map((item) => ({
      filePath: item.filePath || item.assetId || '',
      assetId: item.assetId,
      fileName: pendingDisplayName(item),
      fileSize: item.fileSize || 0,
      hash: item.hash || '',
      exif: item.exif,
    })),
    toQueueSettings(settings),
  )
}

/**
 * 编辑器上传设置 → 队列上传设置。
 *
 * storageSourceId 直接沿用：Desktop 插件源会以**同一个 id** 同步到云端
 * （storage_source_sync.go:41/62/70），所以编辑器从 HTTP 拿到的源 id
 * 与 Go 插件注册表一致，无需换算。
 * storagePluginId 留空即可 —— Go 侧为空时按 storageSourceId 反查
 * （services/upload.go:572），而编辑器拿不到 pluginId。
 */
export function toQueueSettings(settings: UploadSettings) {
  return {
    title: settings.title || '',
    tags: settings.tags || [],
    albumIds: settings.albumIds,
    storyId: settings.storyId,
    storageSourceId: settings.storageSourceId || '',
    storagePath: settings.storagePath || '',
    storagePathFull: settings.storagePathFull,
    compressEnabled: settings.compressionMode !== 'none',
    compressionFormat: settings.compressionFormat || 'avif',
    maxSizeMB: settings.maxSizeMB || 0,
    showFlag: settings.showFlag ?? true,
    stripGPS: Boolean(settings.stripGps),
  }
}

/**
 * 等待指定上传任务抵达终态。
 * 队列并发为 3 且任务可能排队，故轮询实时状态（getTasks）而非监听单次事件。
 */
export async function waitForTaskOutcome(
  tasks: UploadTask[],
  getTasks: () => UploadTask[],
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<{ ok: boolean; photoIds: string[]; error?: string }> {
  const intervalMs = options?.intervalMs ?? 200
  const timeoutMs = options?.timeoutMs ?? 10 * 60 * 1000
  const ids = new Set(tasks.map((task) => task.id))
  if (ids.size === 0) return { ok: true, photoIds: [] }
  const startedAt = Date.now()

  for (;;) {
    const current = getTasks().filter((task) => ids.has(task.id))
    const finished = current.filter((task) => task.status === 'completed' || task.status === 'failed')
    if (current.length > 0 && finished.length === current.length) {
      const failed = finished.filter((task) => task.status === 'failed')
      return {
        ok: failed.length === 0,
        photoIds: finished.map((task) => task.photoId).filter((id): id is string => Boolean(id)),
        error: failed.length > 0 ? failed.map((task) => task.error || task.fileName).join('; ') : undefined,
      }
    }
    if (Date.now() - startedAt > timeoutMs) {
      return { ok: false, photoIds: [], error: '上传超时' }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** 释放待传项预览图。本地资源库项用的是资源库 URL（非 blob:），不能 revoke。 */
export function releasePendingPreview(previewUrl: string | undefined) {
  if (previewUrl && previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl)
}
