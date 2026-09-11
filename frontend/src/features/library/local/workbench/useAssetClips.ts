import { useCallback, useEffect, useRef, useState } from 'react'
import { EventsOn } from '../../../../../wailsjs/runtime/runtime'
import { localLibraryApi } from '../api'
import { parseLocalLibraryError } from '../api'
import type { LocalAssetClip, LocalClipExportProgress } from '../types'

export interface AssetClipsState {
  clips: LocalAssetClip[]
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  createClip: (input: { title: string, startMs: number, endMs: number, notes?: string, colorLabel?: string }) => Promise<LocalAssetClip | null>
  updateClip: (id: string, patch: { title?: string, notes?: string, startMs?: number, endMs?: number, colorLabel?: string, rating?: number }) => Promise<void>
  deleteClip: (id: string) => Promise<void>
}

/**
 * Loads and mutates the clips of one asset. Used by the player and the
 * details panel; both share the same reload semantics.
 */
export function useAssetClips(assetId: string | undefined): AssetClipsState {
  const [clips, setClips] = useState<LocalAssetClip[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)

  const reload = useCallback(async () => {
    if (!assetId) {
      setClips([])
      return
    }
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setLoading(true)
    try {
      const items = await localLibraryApi.listAssetClips(assetId)
      if (requestIdRef.current === requestId) setClips(items)
    } catch (cause) {
      if (requestIdRef.current === requestId) setError(parseLocalLibraryError(cause).message)
    } finally {
      if (requestIdRef.current === requestId) setLoading(false)
    }
  }, [assetId])

  useEffect(() => {
    void reload()
  }, [reload])

  const createClip = useCallback(async (input: { title: string, startMs: number, endMs: number, notes?: string, colorLabel?: string }) => {
    if (!assetId) return null
    try {
      const clip = await localLibraryApi.createAssetClip({ assetId, ...input })
      await reload()
      setError(null)
      return clip
    } catch (cause) {
      setError(parseLocalLibraryError(cause).message)
      return null
    }
  }, [assetId, reload])

  const updateClip = useCallback(async (id: string, patch: { title?: string, notes?: string, startMs?: number, endMs?: number, colorLabel?: string, rating?: number }) => {
    try {
      await localLibraryApi.updateAssetClip(id, patch)
      await reload()
      setError(null)
    } catch (cause) {
      setError(parseLocalLibraryError(cause).message)
    }
  }, [reload])

  const deleteClip = useCallback(async (id: string) => {
    try {
      await localLibraryApi.deleteAssetClip(id)
      await reload()
      setError(null)
    } catch (cause) {
      setError(parseLocalLibraryError(cause).message)
    }
  }, [reload])

  return { clips, loading, error, reload, createClip, updateClip, deleteClip }
}

export interface ClipExportState {
  ffmpegAvailable: boolean
  ffmpegChecked: boolean
  exportingClipId: string | null
  exportPercent: number
  exportMessage: string | null
  exportClip: (clipId: string) => Promise<void>
  clearMessage: () => void
}

/**
 * Shared clip-export driver: detects the system ffmpeg once, triggers the
 * save-dialog flow, and tracks progress arriving on the
 * "local-library:clip-export" event.
 */
export function useClipExport(messages: { started: string, completed: string, failed: string, cancelled: string, ffmpegMissingBody: string }): ClipExportState {
  const [ffmpegAvailable, setFFmpegAvailable] = useState(false)
  const [ffmpegChecked, setFFmpegChecked] = useState(false)
  const [exportingClipId, setExportingClipId] = useState<string | null>(null)
  const [exportPercent, setExportPercent] = useState(0)
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  useEffect(() => {
    let disposed = false
    localLibraryApi.detectFFmpeg()
      .then((path) => { if (!disposed) { setFFmpegAvailable(Boolean(path)); setFFmpegChecked(true) } })
      .catch(() => { if (!disposed) { setFFmpegAvailable(false); setFFmpegChecked(true) } })
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    const unsubscribe = EventsOn('local-library:clip-export', (raw: unknown) => {
      const progress = raw as LocalClipExportProgress
      if (!progress) return
      if (progress.state === 'progress') {
        setExportingClipId(progress.clipId)
        setExportPercent(progress.percent ?? 0)
        return
      }
      setExportingClipId(null)
      setExportPercent(0)
      if (progress.state === 'completed') setExportMessage(messagesRef.current.completed)
      else if (progress.state === 'failed') setExportMessage(`${messagesRef.current.failed}${progress.error ? `：${progress.error}` : ''}`)
      else if (progress.state === 'cancelled') setExportMessage(messagesRef.current.cancelled)
    })
    return unsubscribe
  }, [])

  const exportClip = useCallback(async (clipId: string) => {
    try {
      const result = await localLibraryApi.exportAssetClip(clipId)
      if (result.state === 'cancelled') {
        setExportMessage(messagesRef.current.cancelled)
        return
      }
      setExportingClipId(clipId)
      setExportPercent(0)
      setExportMessage(messagesRef.current.started)
    } catch (cause) {
      const message = parseLocalLibraryError(cause)
      setExportMessage(message.code === 'FFMPEG_UNAVAILABLE' ? messagesRef.current.ffmpegMissingBody : `${messagesRef.current.failed}：${message.message}`)
    }
  }, [])

  return { ffmpegAvailable, ffmpegChecked, exportingClipId, exportPercent, exportMessage, exportClip, clearMessage: () => setExportMessage(null) }
}
