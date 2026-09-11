import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Download, Expand, ExternalLink, Film, ListVideo, Loader2, Music,
  Pause, Play, Repeat, Scissors, Trash2, Volume2, VolumeX, X, ZoomIn, ZoomOut,
} from 'lucide-react'
import { localLibraryApi } from '../api'
import { formatTimecode, isAudioAsset, isVideoAsset } from '../types'
import type { LocalAsset, LocalAssetClip } from '../types'
import type { LocalLibraryCopy } from '../copy'
import { captureAndUploadVideoPoster } from './poster'
import { useAssetClips, useClipExport } from './useAssetClips'

// The subset of LocalAsset the player needs. A synthetic target can be built
// from a clip record when playback is opened from a clip list.
export type MediaPlayTarget = Pick<LocalAsset,
  'id' | 'fileName' | 'displayTitle' | 'format' | 'mediaKind' | 'relativePath' | 'byteSize' | 'durationMs' | 'width' | 'height' | 'previewStatus' | 'originalUrl' | 'modifiedAtNs'
>

interface Props {
  target: MediaPlayTarget
  copy: LocalLibraryCopy
  initialClip?: { startMs: number, endMs: number, title?: string } | null
  onClose: () => void
  onOpenSystem?: () => void
  onPrevious?: () => void
  onNext?: () => void
  hasPrevious?: boolean
  hasNext?: boolean
  onClipsChanged?: (clips: LocalAssetClip[]) => void
}

interface ActiveRange {
  startMs: number
  endMs: number
  label: string
}

const PLAYBACK_RATES = [0.5, 1, 1.5, 2]
const CLIP_MARKER_COLORS = ['#38bdf8', '#a78bfa', '#f472b6', '#fbbf24', '#34d399']

// Timeline zoom: the view is a [start, end] window over the media duration;
// null means the full timeline is visible. The floor keeps a few frames on
// screen so the ruler stays readable at maximum zoom.
const TIMELINE_MIN_SPAN_MS = 250
const TIMELINE_ZOOM_FACTOR = 0.78

// Ruler tick candidates (ms). The first interval wide enough to keep major
// ticks ~72px apart wins; minors subdivide by 5.
const TICK_INTERVALS_MS = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000]
const TICK_TARGET_PX = 72

// requestVideoFrameCallback is not in every TS lib version; probe it defensively.
type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: { mediaTime: number }) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

export function MediaPlayerFrame({
  target, copy, initialClip, onClose, onOpenSystem, onPrevious, onNext, hasPrevious = false, hasNext = false, onClipsChanged,
}: Props) {
  const clipsCopy = copy.clips
  const videoRef = useRef<HTMLVideoElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const draggingTimelineRef = useRef(false)

  const [durationMs, setDurationMs] = useState(target.durationMs ?? 0)
  const [currentTimeMs, setCurrentTimeMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [rateIndex, setRateIndex] = useState(1)
  const [loopSelection, setLoopSelection] = useState(true)
  const [markIn, setMarkIn] = useState<number | null>(null)
  const [markOut, setMarkOut] = useState<number | null>(null)
  const [activeRange, setActiveRange] = useState<ActiveRange | null>(null)
  const [panelOpen, setPanelOpen] = useState(true)
  const [editingClipId, setEditingClipId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [mediaError, setMediaError] = useState(false)
  // Timeline zoom window; null = full view. Reset whenever the asset or its
  // duration changes.
  const [view, setView] = useState<[number, number] | null>(null)
  const [timelineWidth, setTimelineWidth] = useState(0)
  // Frame rate: assumed 30 until playback calibrates it from presented-frame
  // timestamps, then frame stepping is exact.
  const [calibratedFps, setCalibratedFps] = useState<number | null>(null)

  const isVideo = isVideoAsset(target)
  const isAudio = isAudioAsset(target)
  const title = target.displayTitle || target.fileName

  const { clips, loading: clipsLoading, error: clipsError, createClip, updateClip, deleteClip } = useAssetClips(target.id)
  const exportState = useClipExport({
    started: clipsCopy.exportStarted,
    completed: clipsCopy.exportCompleted,
    failed: clipsCopy.exportFailed,
    cancelled: clipsCopy.exportCancelled,
    ffmpegMissingBody: clipsCopy.ffmpegMissingBody,
  })

  const viewStart = view?.[0] ?? 0
  const viewEnd = view?.[1] ?? durationMs
  const viewSpan = Math.max(1, viewEnd - viewStart)

  useEffect(() => {
    document.body.classList.add('mo-fullscreen-preview')
    return () => document.body.classList.remove('mo-fullscreen-preview')
  }, [])

  useEffect(() => {
    onClipsChanged?.(clips)
  }, [clips, onClipsChanged])

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButtonRef.current?.focus()
    return () => previousFocus?.focus()
  }, [])

  useEffect(() => {
    const message = exportState.exportMessage ?? clipsError
    setStatusMessage(message)
  }, [exportState.exportMessage, clipsError])

  // A new asset (or a duration learned from metadata) restarts the timeline
  // at full zoom-out.
  useEffect(() => {
    setView(null)
  }, [target.id, durationMs])

  // Track the ruler width so tick density can adapt to the real pixel space.
  useEffect(() => {
    const element = timelineRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width && width > 0) setTimelineWidth(width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Ref mirrors: the rAF progress loop and the wheel handler must always read
  // the latest state without re-subscribing.
  const activeRangeRef = useRef<ActiveRange | null>(null)
  useEffect(() => { activeRangeRef.current = activeRange }, [activeRange])
  const loopSelectionRef = useRef(loopSelection)
  useEffect(() => { loopSelectionRef.current = loopSelection }, [loopSelection])
  const viewRef = useRef<[number, number] | null>(null)
  useEffect(() => { viewRef.current = view }, [view])
  const durationMsRef = useRef(durationMs)
  useEffect(() => { durationMsRef.current = durationMs }, [durationMs])

  const seekTo = useCallback((ms: number) => {
    const video = videoRef.current
    if (!video) return
    const total = durationMsRef.current
    const bounded = Math.max(0, total > 0 ? Math.min(ms, total) : ms)
    video.currentTime = bounded / 1000
    setCurrentTimeMs(bounded)
  }, [])

  const playRange = useCallback((range: ActiveRange) => {
    setActiveRange(range)
    const video = videoRef.current
    if (!video) return
    video.currentTime = range.startMs / 1000
    setCurrentTimeMs(range.startMs)
    void video.play().catch(() => {})
  }, [])

  // Opened with a specific clip (e.g. from the clip list): play it directly.
  useEffect(() => {
    if (!initialClip || durationMs <= 0) return
    playRange({ startMs: initialClip.startMs, endMs: initialClip.endMs, label: initialClip.title || '' })
  }, [initialClip, durationMs, playRange])

  const handleLoadedMetadata = () => {
    const video = videoRef.current
    if (!video) return
    const loadedDuration = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0
    if (loadedDuration > 0) setDurationMs(loadedDuration)
    // Backfill metadata Go could not parse (audio durations, video dimensions)
    // and capture the grid poster for videos without one.
    if (loadedDuration > 0 && (loadedDuration !== target.durationMs || (isVideo && target.width === 0))) {
      void localLibraryApi.reportAssetMediaMetadata(
        target.id,
        loadedDuration,
        video.videoWidth || 0,
        video.videoHeight || 0,
      ).catch(() => {})
    }
    if (isVideo && target.previewStatus === 'pending') {
      void captureAndUploadVideoPoster(target)
    }
  }

  // fps calibration: requestVideoFrameCallback reports the media timestamp of
  // every presented frame; the median gap between consecutive frames is the
  // frame duration. Until enough playback has happened, frame stepping uses
  // the 30fps default.
  const fpsRef = useRef(30)
  useEffect(() => {
    const video = videoRef.current as FrameCallbackVideo | null
    if (!video || isAudio || typeof video.requestVideoFrameCallback !== 'function') return
    let cancelled = false
    let handle = 0
    const samples: number[] = []
    const onFrame = (_now: number, metadata: { mediaTime: number }) => {
      if (cancelled) return
      samples.push(metadata.mediaTime)
      if (samples.length > 14) samples.shift()
      if (samples.length >= 8) {
        const deltas: number[] = []
        for (let index = 1; index < samples.length; index += 1) {
          const delta = samples[index] - samples[index - 1]
          if (delta > 0.004 && delta < 0.2) deltas.push(delta)
        }
        if (deltas.length >= 4) {
          deltas.sort((left, right) => left - right)
          const median = deltas[Math.floor(deltas.length / 2)]
          const fps = Math.round(1 / median)
          if (fps >= 8 && fps <= 240 && fps !== fpsRef.current) {
            fpsRef.current = fps
            setCalibratedFps(fps)
          }
        }
      }
      handle = video.requestVideoFrameCallback!(onFrame)
    }
    handle = video.requestVideoFrameCallback(onFrame)
    return () => {
      cancelled = true
      if (typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(handle)
    }
  }, [target.id, isAudio])

  const stepFrames = useCallback((direction: number) => {
    const video = videoRef.current
    if (!video || durationMsRef.current <= 0) return
    video.pause()
    const frameMs = 1000 / fpsRef.current
    seekTo(Math.round(video.currentTime * 1000 + direction * frameMs))
  }, [seekTo])

  // 片段边界与循环逻辑：播放位置越过 activeRange 终点时循环或暂停。
  // 播放越过缩放窗口边缘时自动平移，让播放头始终可见。
  const handlePlaybackPosition = (timeMs: number) => {
    setCurrentTimeMs(timeMs)
    const range = activeRangeRef.current
    const video = videoRef.current
    if (!range || !video) return
    if (timeMs >= range.endMs - 40) {
      if (loopSelectionRef.current) {
        video.currentTime = range.startMs / 1000
        setCurrentTimeMs(range.startMs)
      } else {
        video.pause()
      }
    }
    const currentView = viewRef.current
    const total = durationMsRef.current
    if (currentView && total > 0) {
      const span = currentView[1] - currentView[0]
      if (timeMs >= currentView[1] - span * 0.05 || timeMs < currentView[0]) {
        const nextStart = Math.min(Math.max(0, Math.round(timeMs - span * 0.1)), Math.max(0, total - span))
        setView([nextStart, nextStart + span])
      }
    }
  }

  const handleTimeUpdate = () => {
    const video = videoRef.current
    if (!video) return
    handlePlaybackPosition(video.currentTime * 1000)
  }

  // Chromium 的 timeupdate 事件最稀疏时约 1 秒才触发一次，单独依赖它会让
  // 时间轴一秒一跳。播放期间改用 requestAnimationFrame 每帧读取
  // video.currentTime，进度条与时间码因此是逐帧平滑的；拖动时间轴时让位
  // 给指针事件驱动的 seek。
  useEffect(() => {
    if (!playing) return
    const tick = () => {
      const video = videoRef.current
      if (video && !draggingTimelineRef.current) {
        handlePlaybackPosition(video.currentTime * 1000)
      }
    }
    let frame = requestAnimationFrame(function loop() {
      tick()
      frame = requestAnimationFrame(loop)
    })
    return () => cancelAnimationFrame(frame)
  }, [playing])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      if (activeRange && (video.currentTime * 1000 < activeRange.startMs || video.currentTime * 1000 >= activeRange.endMs - 40)) {
        video.currentTime = activeRange.startMs / 1000
      }
      void video.play().catch(() => {})
    } else {
      video.pause()
    }
  }, [activeRange])

  const markInAt = useCallback(() => {
    setMarkIn(Math.round(currentTimeMs))
  }, [currentTimeMs])

  const markOutAt = useCallback(() => {
    setMarkOut(Math.round(currentTimeMs))
  }, [currentTimeMs])

  const selection = markIn !== null && markOut !== null && markOut - markIn >= 200
    ? { startMs: Math.min(markIn, markOut), endMs: Math.max(markIn, markOut) }
    : null

  const addClip = async () => {
    const range = selection
      ? { startMs: selection.startMs, endMs: selection.endMs }
      : durationMs > 0
        ? { startMs: 0, endMs: durationMs }
        : null
    if (!range) return
    const fallbackTitle = `${formatTimecode(range.startMs)} - ${formatTimecode(range.endMs)}`
    const created = await createClip({ title: fallbackTitle, startMs: range.startMs, endMs: range.endMs })
    if (created) {
      setMarkIn(null)
      setMarkOut(null)
      setPanelOpen(true)
    }
  }

  const clearSelection = () => {
    setMarkIn(null)
    setMarkOut(null)
    setActiveRange(null)
  }

  const zoomAt = useCallback((ratio: number, factor: number) => {
    setView((previous) => {
      const total = durationMsRef.current
      if (total <= 0) return previous
      const start = previous?.[0] ?? 0
      const end = previous?.[1] ?? total
      const span = end - start
      if (span <= 0) return previous
      const anchor = start + ratio * span
      const nextSpan = Math.min(total, Math.max(TIMELINE_MIN_SPAN_MS, Math.round(span * factor)))
      let nextStart = Math.round(anchor - ratio * nextSpan)
      if (nextStart < 0) nextStart = 0
      if (nextStart + nextSpan > total) nextStart = total - nextSpan
      return nextSpan >= total ? null : [nextStart, nextStart + nextSpan]
    })
  }, [])

  const zoomIn = useCallback(() => zoomAt(0.5, TIMELINE_ZOOM_FACTOR), [zoomAt])
  const zoomOut = useCallback(() => zoomAt(0.5, 1 / TIMELINE_ZOOM_FACTOR), [zoomAt])

  // React's onWheel is passive; the timeline needs preventDefault so the
  // wheel zooms instead of scrolling the page.
  useEffect(() => {
    const element = timelineRef.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const total = durationMsRef.current
      if (total <= 0) return
      const bounds = element.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width))
      zoomAt(ratio, event.deltaY < 0 ? TIMELINE_ZOOM_FACTOR : 1 / TIMELINE_ZOOM_FACTOR)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const seekFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = timelineRef.current
    if (!element || durationMs <= 0) return
    const bounds = element.getBoundingClientRect()
    const ratio = (event.clientX - bounds.left) / bounds.width
    const currentView = viewRef.current
    if (!currentView) {
      const clamped = Math.min(1, Math.max(0, ratio))
      seekTo(Math.round(clamped * durationMs))
      return
    }
    const [start, end] = currentView
    const span = end - start
    if (ratio < 0) {
      // Dragging past the left edge while zoomed pans the window backwards.
      if (start > 0) {
        const nextStart = Math.max(0, Math.round(start - span * 0.25))
        setView([nextStart, nextStart + span])
        seekTo(nextStart)
      } else {
        seekTo(0)
      }
      return
    }
    if (ratio > 1) {
      if (end < durationMs) {
        const nextStart = Math.min(durationMs - span, Math.round(start + span * 0.25))
        setView([nextStart, nextStart + span])
        seekTo(nextStart + span)
      } else {
        seekTo(durationMs)
      }
      return
    }
    seekTo(Math.round(start + ratio * span))
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (editingClipId !== null) return
      switch (event.key) {
        case 'Escape':
          event.preventDefault()
          onClose()
          break
        case ' ':
          event.preventDefault()
          if (!event.repeat) togglePlay()
          break
        case ',':
          event.preventDefault()
          stepFrames(-1)
          break
        case '.':
          event.preventDefault()
          stepFrames(1)
          break
        case 'i':
        case 'I':
          event.preventDefault()
          markInAt()
          break
        case 'o':
        case 'O':
          event.preventDefault()
          markOutAt()
          break
        case 'ArrowLeft':
          event.preventDefault()
          seekTo(currentTimeMs - (event.shiftKey ? 5000 : 1000))
          break
        case 'ArrowRight':
          event.preventDefault()
          seekTo(currentTimeMs + (event.shiftKey ? 5000 : 1000))
          break
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [currentTimeMs, editingClipId, markInAt, markOutAt, onClose, seekTo, stepFrames, togglePlay])

  const clipMarkers = useMemo(() => clips.map((clip, index) => ({
    clip,
    color: CLIP_MARKER_COLORS[index % CLIP_MARKER_COLORS.length],
  })), [clips])

  // Media time → ruler percentage under the current zoom window.
  const toPercent = (ms: number) => ((ms - viewStart) / viewSpan) * 100
  const progressPercent = Math.min(100, Math.max(0, toPercent(currentTimeMs)))

  const { majorTicks, minorTicks, majorInterval } = useMemo(() => {
    if (durationMs <= 0 || timelineWidth < 40) return { majorTicks: [] as number[], minorTicks: [] as number[], majorInterval: 0 }
    const majorInterval = TICK_INTERVALS_MS.find((interval) => (interval / viewSpan) * timelineWidth >= TICK_TARGET_PX) ?? 3600000
    const minorInterval = majorInterval / 5
    const majors: number[] = []
    for (let time = Math.ceil(viewStart / majorInterval) * majorInterval; time <= viewEnd; time += majorInterval) majors.push(time)
    const minors: number[] = []
    if ((minorInterval / viewSpan) * timelineWidth >= 7) {
      for (let time = Math.ceil(viewStart / minorInterval) * minorInterval; time <= viewEnd; time += minorInterval) {
        if (time % majorInterval !== 0) minors.push(time)
      }
    }
    return { majorTicks: majors, minorTicks: minors, majorInterval }
  }, [durationMs, timelineWidth, viewStart, viewEnd, viewSpan])

  const formatTick = (ms: number, majorInterval: number) => {
    if (majorInterval < 1000) return `${(ms / 1000).toFixed(majorInterval <= 200 ? 2 : 1)}s`
    return formatTimecode(ms)
  }

  const frameIndex = Math.floor((currentTimeMs * fpsRef.current) / 1000)

  const commitClipTitle = async (clipId: string) => {
    const nextTitle = editingTitle.trim()
    setEditingClipId(null)
    if (!nextTitle) return
    await updateClip(clipId, { title: nextTitle })
  }

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-black/95 text-white" role="dialog" aria-modal="true" aria-label={title}>
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          {isAudio ? <Music size={16} className="shrink-0 text-white/60" /> : <Film size={16} className="shrink-0 text-white/60" />}
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{title}</div>
            <div className="truncate text-[10px] text-white/50">{target.relativePath}</div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setPanelOpen((open) => !open)} className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs hover:bg-white/10 ${panelOpen ? 'text-emerald-300' : 'text-white/70'}`} aria-label={clipsCopy.sectionTitle}>
            <ListVideo size={14} />
            {clipsCopy.sectionTitle}
            {clips.length > 0 && <span className="rounded-full bg-white/15 px-1.5 text-[10px]">{clips.length}</span>}
          </button>
          {onOpenSystem && <button type="button" onClick={onOpenSystem} className="rounded-md p-2 hover:bg-white/10" title={copy.openSystem} aria-label={copy.openSystem}><ExternalLink size={17} /></button>}
          <button ref={closeButtonRef} type="button" onClick={onClose} className="rounded-md p-2 hover:bg-white/10" aria-label={copy.close}><X size={19} /></button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-5">
            {hasPrevious && <button type="button" aria-label={copy.previous} onClick={onPrevious} className="absolute left-4 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/10 p-3 hover:bg-white/20"><ChevronLeft size={22} /></button>}
            {mediaError ? (
              <div className="max-w-md text-center text-sm text-white/60">
                {copy.originalUnavailable}
                <div className="mt-1 text-[11px] text-white/40">{target.format.toUpperCase()} · {isAudio ? clipsCopy.audioAsset : clipsCopy.videoAsset}</div>
              </div>
            ) : isAudio ? (
              <div className="flex flex-col items-center gap-4">
                <Music size={72} strokeWidth={1} className="text-white/40" />
                <div className="font-mono text-4xl tabular-nums tracking-tight text-white/80">{formatTimecode(currentTimeMs)}</div>
                <div className="text-xs text-white/40">{target.format.toUpperCase()}</div>
              </div>
            ) : (
              <video
                ref={videoRef}
                key={target.id}
                src={target.originalUrl}
                playsInline
                preload="metadata"
                className="max-h-full max-w-full select-none object-contain"
                onLoadedMetadata={handleLoadedMetadata}
                onTimeUpdate={handleTimeUpdate}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onError={() => setMediaError(true)}
                onClick={togglePlay}
              />
            )}
            {isAudio && (
              <video
                ref={videoRef}
                key={`audio-${target.id}`}
                src={target.originalUrl}
                preload="metadata"
                className="hidden"
                onLoadedMetadata={handleLoadedMetadata}
                onTimeUpdate={handleTimeUpdate}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onError={() => setMediaError(true)}
              />
            )}
            {hasNext && <button type="button" aria-label={copy.next} onClick={onNext} className="absolute right-4 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/10 p-3 hover:bg-white/20"><ChevronRight size={22} /></button>}
          </div>

          {/* Zoomable ruler + timeline */}
          <div className="shrink-0 border-t border-white/10 px-5 pb-3 pt-1">
            <div
              ref={timelineRef}
              className="group relative h-16 cursor-pointer touch-none select-none overflow-hidden"
              onPointerDown={(event) => {
                draggingTimelineRef.current = true
                event.currentTarget.setPointerCapture(event.pointerId)
                seekFromPointer(event)
              }}
              onPointerMove={(event) => { if (draggingTimelineRef.current) seekFromPointer(event) }}
              onPointerUp={(event) => {
                draggingTimelineRef.current = false
                event.currentTarget.releasePointerCapture(event.pointerId)
              }}
              onDoubleClick={() => setView(null)}
            >
              {/* Zoom window indicator */}
              {view && durationMs > 0 && (
                <div className="pointer-events-none absolute left-1 top-0.5 font-mono text-[9px] tabular-nums text-white/40">
                  {formatTimecode(view[0], true)} – {formatTimecode(view[1], true)}
                </div>
              )}
              {/* Zoom controls */}
              <div className="absolute right-1 top-0.5 flex items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                <button type="button" aria-label={clipsCopy.zoomOut} title={clipsCopy.zoomOut} disabled={!view} onClick={zoomOut} onPointerDown={(event) => event.stopPropagation()} className="rounded p-1 text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-30"><ZoomOut size={12} /></button>
                <button type="button" aria-label={clipsCopy.fitTimeline} title={clipsCopy.fitTimeline} disabled={!view} onClick={() => setView(null)} onPointerDown={(event) => event.stopPropagation()} className="rounded p-1 text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-30"><Expand size={12} /></button>
                <button type="button" aria-label={clipsCopy.zoomIn} title={clipsCopy.zoomIn} disabled={viewSpan <= TIMELINE_MIN_SPAN_MS} onClick={zoomIn} onPointerDown={(event) => event.stopPropagation()} className="rounded p-1 text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-30"><ZoomIn size={12} /></button>
              </div>

              {/* Ruler ticks */}
              {durationMs > 0 && majorTicks.map((time) => (
                <div key={`major-${time}`} className="pointer-events-none absolute bottom-[26px] h-2.5 w-px bg-white/25" style={{ left: `${toPercent(time)}%` }}>
                  <span className="absolute -top-4 left-0 -translate-x-1/2 whitespace-nowrap font-mono text-[9px] tabular-nums text-white/40">{formatTick(time, majorInterval)}</span>
                </div>
              ))}
              {durationMs > 0 && minorTicks.map((time) => (
                <div key={`minor-${time}`} className="pointer-events-none absolute bottom-[26px] h-1.5 w-px bg-white/15" style={{ left: `${toPercent(time)}%` }} />
              ))}

              {/* Hit area / track */}
              <div className="absolute inset-x-0 bottom-3 h-3 rounded-full bg-white/15" />
              {/* Elapsed fill */}
              <div className="pointer-events-none absolute bottom-3 h-3 rounded-full bg-white/40" style={{ left: 0, width: `${progressPercent}%` }} />
              {/* Clip markers */}
              {durationMs > 0 && clipMarkers.map(({ clip, color }) => (
                <div
                  key={clip.id}
                  className="absolute bottom-3 h-3 rounded-sm opacity-80 transition-opacity hover:opacity-100"
                  title={`${clip.title || formatTimecode(clip.startMs)} · ${formatTimecode(clip.startMs)} - ${formatTimecode(clip.endMs)}`}
                  style={{
                    left: `${toPercent(clip.startMs)}%`,
                    width: `${Math.max(0.4, ((clip.endMs - clip.startMs) / viewSpan) * 100)}%`,
                    backgroundColor: color,
                  }}
                  onPointerDown={(event) => {
                    event.stopPropagation()
                    playRange({ startMs: clip.startMs, endMs: clip.endMs, label: clip.title })
                  }}
                />
              ))}
              {/* Active clip range */}
              {activeRange && durationMs > 0 && (
                <div
                  className="absolute bottom-2 h-7 rounded-sm border border-emerald-300/50 bg-emerald-300/15"
                  style={{
                    left: `${toPercent(activeRange.startMs)}%`,
                    width: `${Math.max(0.5, ((activeRange.endMs - activeRange.startMs) / viewSpan) * 100)}%`,
                  }}
                  title={activeRange.label}
                />
              )}
              {/* Selection preview */}
              {selection && durationMs > 0 && (
                <div
                  className="absolute bottom-2 h-7 rounded-sm border border-sky-300/60 bg-sky-300/20"
                  style={{
                    left: `${toPercent(selection.startMs)}%`,
                    width: `${Math.max(0.5, ((selection.endMs - selection.startMs) / viewSpan) * 100)}%`,
                  }}
                />
              )}
              {/* Playhead */}
              <div className="pointer-events-none absolute bottom-2 h-5 rounded bg-white shadow transition-transform group-hover:scale-y-110" style={{ left: `calc(${progressPercent}% - 2px)`, width: 4 }} />
              {/* Mark in / out handles */}
              {markIn !== null && durationMs > 0 && (
                <div className="absolute bottom-[30px] flex flex-col items-center" style={{ left: `${toPercent(markIn)}%` }} title={clipsCopy.markIn}>
                  <span className="h-2 w-2 -translate-x-1/2 rounded-full bg-sky-300" />
                  <span className="-translate-x-1/2 text-[9px] text-sky-300">I</span>
                </div>
              )}
              {markOut !== null && durationMs > 0 && (
                <div className="absolute bottom-[30px] flex flex-col items-center" style={{ left: `${toPercent(markOut)}%` }} title={clipsCopy.markOut}>
                  <span className="h-2 w-2 -translate-x-1/2 rounded-full bg-amber-300" />
                  <span className="-translate-x-1/2 text-[9px] text-amber-300">O</span>
                </div>
              )}
            </div>

            {/* Centered transport */}
            <div className="mt-1 flex items-center justify-center gap-1.5">
              {hasPrevious && <button type="button" aria-label={copy.previous} onClick={onPrevious} className="rounded-full p-2 text-white/70 hover:bg-white/10"><ChevronLeft size={18} /></button>}
              {!isAudio && (
                <button type="button" aria-label={clipsCopy.frameBack} title={clipsCopy.frameBack} disabled={durationMs <= 0} onClick={() => stepFrames(-1)} className="rounded-md p-2 text-white/70 hover:bg-white/10 disabled:opacity-40"><ChevronsLeft size={17} /></button>
              )}
              <button type="button" onClick={togglePlay} className="rounded-full bg-white/15 p-2.5 hover:bg-white/25" aria-label={playing ? 'Pause' : 'Play'}>
                {playing ? <Pause size={20} /> : <Play size={20} />}
              </button>
              {!isAudio && (
                <button type="button" aria-label={clipsCopy.frameForward} title={clipsCopy.frameForward} disabled={durationMs <= 0} onClick={() => stepFrames(1)} className="rounded-md p-2 text-white/70 hover:bg-white/10 disabled:opacity-40"><ChevronsRight size={17} /></button>
              )}
              {hasNext && <button type="button" aria-label={copy.next} onClick={onNext} className="rounded-full p-2 text-white/70 hover:bg-white/10"><ChevronRight size={18} /></button>}
              <span className="mx-1.5 h-5 w-px bg-white/15" />
              <button type="button" onClick={() => setMuted((value) => !value)} className="rounded-md p-2 hover:bg-white/10" aria-label={muted ? 'Unmute' : 'Mute'}>
                {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
              </button>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="font-mono text-xs tabular-nums text-white/70">
                {formatTimecode(currentTimeMs, true)} / {formatTimecode(durationMs)}
              </span>
              {!isAudio && durationMs > 0 && (
                <span className="font-mono text-[10px] tabular-nums text-white/40">
                  帧 {frameIndex}{calibratedFps ? ` · ${calibratedFps}fps` : ''}
                </span>
              )}
              <button
                type="button"
                onClick={() => {
                  const next = (rateIndex + 1) % PLAYBACK_RATES.length
                  setRateIndex(next)
                  if (videoRef.current) videoRef.current.playbackRate = PLAYBACK_RATES[next]
                }}
                className="rounded-md px-2 py-1 text-xs text-white/70 hover:bg-white/10"
                title="Playback speed"
              >
                {PLAYBACK_RATES[rateIndex]}×
              </button>
              <button
                type="button"
                onClick={() => setLoopSelection((value) => !value)}
                className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs hover:bg-white/10 ${loopSelection ? 'text-emerald-300' : 'text-white/60'}`}
                title={clipsCopy.loopSelection}
              >
                <Repeat size={13} />
                {clipsCopy.loopSelection}
              </button>

              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                <button type="button" onClick={markInAt} className="flex items-center gap-1.5 rounded-md border border-white/15 px-2.5 py-1.5 text-xs text-white/80 hover:bg-white/10" title={clipsCopy.markIn}>
                  <span className="font-mono text-[10px] text-sky-300">I</span>
                  {markIn !== null ? formatTimecode(markIn) : clipsCopy.markIn}
                </button>
                <button type="button" onClick={markOutAt} className="flex items-center gap-1.5 rounded-md border border-white/15 px-2.5 py-1.5 text-xs text-white/80 hover:bg-white/10" title={clipsCopy.markOut}>
                  <span className="font-mono text-[10px] text-amber-300">O</span>
                  {markOut !== null ? formatTimecode(markOut) : clipsCopy.markOut}
                </button>
                {selection && (
                  <button
                    type="button"
                    onClick={() => playRange({ startMs: selection.startMs, endMs: selection.endMs, label: clipsCopy.loopSelection })}
                    className="rounded-md border border-sky-300/40 px-2.5 py-1.5 text-xs text-sky-200 hover:bg-sky-300/10"
                  >
                    {clipsCopy.playClip}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void addClip()}
                  disabled={durationMs <= 0}
                  className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                  style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}
                >
                  <Scissors size={13} />
                  {clipsCopy.addClip}
                </button>
                {(markIn !== null || markOut !== null || activeRange) && (
                  <button type="button" onClick={clearSelection} className="rounded-md px-2.5 py-1.5 text-xs text-white/60 hover:bg-white/10">
                    {clipsCopy.clearSelection}
                  </button>
                )}
              </div>
            </div>
            {statusMessage && (
              <div className="mt-2 flex items-center gap-2 rounded-md border border-white/15 bg-white/5 px-3 py-1.5 text-[11px] text-white/75">
                {exportState.exportingClipId && <Loader2 size={12} className="animate-spin" />}
                <span className="min-w-0 flex-1 truncate">{statusMessage}</span>
                <button type="button" onClick={() => setStatusMessage(null)} className="shrink-0 text-white/50 hover:text-white" aria-label={copy.close}><X size={12} /></button>
              </div>
            )}
          </div>
        </div>

        {/* Clips side panel */}
        {panelOpen && (
          <aside className="flex w-72 min-w-0 shrink-0 flex-col border-l border-white/10">
            <div className="flex h-11 shrink-0 items-center justify-between border-b border-white/10 px-3">
              <span className="text-xs font-medium text-white/80">{clipsCopy.sectionTitle}</span>
              {clipsLoading && <Loader2 size={12} className="animate-spin text-white/50" />}
            </div>
            <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
              {clips.length === 0 ? (
                <div className="px-3 py-8 text-center text-[11px] leading-5 text-white/40">
                  {clipsCopy.sectionEmpty}
                  <div className="mt-1">{clipsCopy.sectionHint}</div>
                </div>
              ) : clips.map((clip) => {
                const exporting = exportState.exportingClipId === clip.id
                return (
                  <div key={clip.id} className="mb-1.5 rounded-lg border border-white/10 bg-white/5 p-2.5">
                    {editingClipId === clip.id ? (
                      <input
                        autoFocus
                        value={editingTitle}
                        onChange={(event) => setEditingTitle(event.target.value)}
                        onBlur={() => void commitClipTitle(clip.id)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void commitClipTitle(clip.id)
                          if (event.key === 'Escape') setEditingClipId(null)
                        }}
                        className="w-full rounded border border-white/20 bg-black/40 px-2 py-1 text-xs outline-none focus:border-white/40"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setEditingClipId(clip.id); setEditingTitle(clip.title) }}
                        className="block w-full truncate text-left text-xs font-medium text-white/90 hover:text-white"
                        title={clip.title}
                      >
                        {clip.title || formatTimecode(clip.startMs)}
                      </button>
                    )}
                    <div className="mt-1 font-mono text-[10px] tabular-nums text-white/50">
                      {formatTimecode(clip.startMs)} – {formatTimecode(clip.endMs)}
                      <span className="ml-1.5 text-white/35">({formatTimecode(clip.endMs - clip.startMs)})</span>
                    </div>
                    <div className="mt-2 flex items-center gap-1">
                      <button type="button" onClick={() => playRange({ startMs: clip.startMs, endMs: clip.endMs, label: clip.title })} className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-white/70 hover:bg-white/10">
                        <Play size={11} />{clipsCopy.playClip}
                      </button>
                      <button
                        type="button"
                        disabled={!exportState.ffmpegAvailable || exporting}
                        onClick={() => void exportState.exportClip(clip.id)}
                        title={!exportState.ffmpegAvailable ? clipsCopy.exportDisabledHint : clipsCopy.export}
                        className="flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-white/70 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {exporting ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                        {exporting ? `${exportState.exportPercent}%` : clipsCopy.export}
                      </button>
                      <button type="button" onClick={() => void deleteClip(clip.id)} className="ml-auto flex items-center gap-1 rounded px-1.5 py-1 text-[10px] text-white/50 hover:bg-red-500/20 hover:text-red-200" title={clipsCopy.deleteClip}>
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
            {!exportState.ffmpegAvailable && exportState.ffmpegChecked && (
              <div className="shrink-0 border-t border-white/10 px-3 py-2.5 text-[10px] leading-4 text-white/45">
                {clipsCopy.exportDisabledHint}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  )
}
