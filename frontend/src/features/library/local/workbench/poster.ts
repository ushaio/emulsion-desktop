import type { LocalAsset } from '../types'
import { isVideoAsset } from '../types'

// Go cannot decode video frames, so video thumbnails are captured by the
// frontend: one frame is drawn to a canvas and POSTed to the local library
// asset server, which stores it as the regular grid thumbnail.

/** The subset of an asset needed to capture and upload a poster frame. */
export type PosterTarget = Pick<LocalAsset, 'id' | 'originalUrl' | 'previewStatus' | 'mediaKind' | 'format' | 'modifiedAtNs' | 'byteSize'>

const POSTER_MAX_DIMENSION = 512
const POSTER_JPEG_QUALITY = 0.85
// Decoding several large videos at once starves the WebView media pipeline;
// a small queue keeps grid warm-up polite.
const POSTER_CAPTURE_CONCURRENCY = 2

let activeCaptures = 0
const captureQueue: Array<() => void> = []

async function acquireCaptureSlot(): Promise<() => void> {
  if (activeCaptures < POSTER_CAPTURE_CONCURRENCY) {
    activeCaptures += 1
    return releaseCaptureSlot
  }
  await new Promise<void>((resolve) => captureQueue.push(resolve))
  activeCaptures += 1
  return releaseCaptureSlot
}

function releaseCaptureSlot() {
  activeCaptures = Math.max(0, activeCaptures - 1)
  const next = captureQueue.shift()
  if (next) next()
}

// One attempt per (asset, content version): a failed capture is not retried
// until the file changes, so a broken video cannot loop forever in the grid.
const attemptedPosterKeys = new Set<string>()

function posterUploadURL(asset: PosterTarget): string {
  const session = new URLSearchParams(asset.originalUrl.split('?')[1] || '').get('session')
  return `/__local-library/poster/${asset.id}${session ? `?session=${encodeURIComponent(session)}` : ''}`
}

function capturePosterFrame(video: HTMLVideoElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) {
      resolve(null)
      return
    }
    const scale = Math.min(1, POSTER_MAX_DIMENSION / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (!context) {
      resolve(null)
      return
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', POSTER_JPEG_QUALITY)
  })
}

/**
 * Captures one frame of a video asset and uploads it as the grid thumbnail.
 * Returns true when the backend accepted the poster (the grid refreshes via
 * the asset_preview_updated event). Safe to call repeatedly: each asset
 * content version is captured at most once per session.
 */
export async function captureAndUploadVideoPoster(asset: PosterTarget): Promise<boolean> {
  if (!isVideoAsset(asset) || asset.previewStatus !== 'pending' || !asset.originalUrl) return false
  const key = `${asset.id}:${asset.modifiedAtNs}:${asset.byteSize}`
  if (attemptedPosterKeys.has(key)) return false
  attemptedPosterKeys.add(key)

  const release = await acquireCaptureSlot()
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  video.src = asset.originalUrl
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('poster capture timed out')), 15000)
      video.onloadedmetadata = () => { window.clearTimeout(timer); resolve() }
      video.onerror = () => { window.clearTimeout(timer); reject(new Error('poster source failed to load')) }
    })
    const seekTarget = Number.isFinite(video.duration) && video.duration > 0
      ? Math.min(1, video.duration / 3)
      : 0
    if (seekTarget > 0) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 5000)
        video.onseeked = () => { window.clearTimeout(timer); resolve() }
        video.currentTime = seekTarget
      })
    }
    const blob = await capturePosterFrame(video)
    if (!blob) return false
    const response = await fetch(posterUploadURL(asset), { method: 'POST', body: blob })
    return response.ok
  } catch {
    return false
  } finally {
    video.removeAttribute('src')
    video.load()
    release()
  }
}
