import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { Check, Crop as CropIcon, FlipHorizontal, FlipVertical, Loader2, Redo2, RotateCcw, RotateCw, Undo2, X } from 'lucide-react'
import { toast } from 'sonner'
import { localLibraryApi, parseLocalLibraryError } from '../api'
import type { LocalLibraryCopy } from '../copy'
import type { LocalAsset, LocalImageEditMode, LocalImageEditResult } from '../types'
import { ImageSaveModeDialog } from '../dialogs/ImageSaveModeDialog'
import {
  FULL_CROP, MIN_CROP_FRACTION, anglePerPixel, aspectFrame, constrainedCrop, fitInsideBounds,
  flipCrop, freeRotation, normalizeAngleDegrees, normalizedRatio, resizeCrop, rotateCrop,
  rotateStepDegrees, snapAngleDegrees,
} from './crop-geometry'
import type { CropRect, FreeRotation } from './crop-geometry'

/** Smallest crop the handles will produce, in screen pixels. */
const MIN_CROP_PIXELS = 24
/** Breathing room between the image and the stage edges. */
const STAGE_PADDING = 56
/** While Shift is held a drag turns a quarter as fast, for dialling in a tenth. */
const ANGLE_FINE_SCALE = 0.25

/**
 * Relative tolerance when matching the loaded image's own ratio to a preset.
 * Pixel dimensions are rounded, so exact equality is too strict (1920×1081 is
 * still a 16:9 frame for editing purposes); 1% cannot reach the nearest
 * neighbour preset (1:1 vs 4:3 are 25% apart), so there is never an ambiguity.
 */
const ASPECT_MATCH_TOLERANCE = 0.01

/**
 * 画框比例命中的预设；对不上返回 null（自由）。容差是相对值，两预设最小相隔
 * 25%（1:1 vs 4:3），不会出现同时命中两个的歧义。
 */
function detectAspectPreset(frameWidth: number, frameHeight: number): number | null {
  if (!(frameWidth > 0) || !(frameHeight > 0)) return null
  const ratio = frameWidth / frameHeight
  const match = ASPECT_PRESETS.find((preset) => preset.value !== null
    && Math.abs(preset.value - ratio) <= preset.value * ASPECT_MATCH_TOLERANCE)
  return match ? match.value : null
}

/**
 * There is no CSS keyword for "rotate", so the cursor is an SVG: a shallow arc
 * with a single head, the shape a crop tool draws, as a black silhouette under a
 * white one so it stays legible over both a bright sky and a dark frame.
 *
 * Chromium draws nothing for an SVG cursor without an explicit width and height,
 * and does it silently — it falls back to the keyword after the comma, leaving a
 * grab hand and no error anywhere. That has bitten this file once, so the
 * drawing is checked by .tmp/rotation-check/cursor-check.cjs rather than by eye.
 */
const CURSOR_ARC = 'M4.95 9.15A7.6 7.6 0 0 1 19.43 10.42'
const CURSOR_HEAD = 'M20.43 15.11L16.60 11.02L22.27 9.82Z'

/**
 * How much of the cursor box the drawing fills. A cursor is read at its own
 * 32px, and one that fills the box crowds the picture it is drawn over — the
 * system's own pointers leave about a third of the box empty. Scaling about the
 * middle keeps the hotspot on the arc's centre, which is the point the frame
 * turns about, and leaves the ring of transparency even all the way round.
 */
const CURSOR_SCALE = 0.7

/** Mirrors the drawing about the middle of the 24-unit viewBox. */
const CURSOR_MIRROR = '<g transform="translate(24 0) scale(-1 1)">'

/**
 * Pointers either side of the pivot are mirror images, because a drag there
 * turns the image the other way: on the right a downward drag is clockwise, on
 * the left it is anticlockwise, and the head sits on the side the pointer is on
 * so it leans the way that drag will turn. The hotspot stays at the centre of
 * the arc in both.
 */
function rotateCursorUrl(mirrored: boolean) {
  const layer = (colour: string, width: number) =>
    `<g stroke="${colour}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="${CURSOR_ARC}" fill="none"/><path d="${CURSOR_HEAD}" fill="${colour}"/></g>`
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none">'
    + `<g transform="translate(12 12) scale(${CURSOR_SCALE}) translate(-12 -12)">`
    + (mirrored ? CURSOR_MIRROR : '')
    + layer('#0b0b0b', 3.5)
    + layer('#ffffff', 2)
    + (mirrored ? '</g>' : '')
    + '</g></svg>'
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, grab`
}

const ROTATE_CURSOR_RIGHT = rotateCursorUrl(false)
const ROTATE_CURSOR_LEFT = rotateCursorUrl(true)

/**
 * Aspect presets. The value is a pixel ratio; normalized crop rectangles derive
 * their own ratio from it because the two axes are normalized independently.
 */
/**
 * Aspect presets. The value is a pixel ratio; normalized crop rectangles derive
 * their own ratio from it because the two axes are normalized independently.
 * The label is derived from the key (`65-24` → `65:24`); `note` is a copy key
 * for the parenthetical hint shown after the ratio, because raw numbers like
 * 2.35:1 or 65:24 mean nothing to most people.
 */
const ASPECT_PRESETS: Array<{ key: string; value: number | null; note: 'theater' | 'cinema' | 'xpan' | null }> = [
  { key: 'free', value: null, note: null },
  { key: '1-1', value: 1, note: null },
  { key: '4-3', value: 4 / 3, note: null },
  { key: '3-4', value: 3 / 4, note: null },
  { key: '16-9', value: 16 / 9, note: null },
  { key: '9-16', value: 9 / 16, note: null },
  { key: '1.85-1', value: 1.85, note: 'theater' },
  { key: '2.35-1', value: 2.35, note: 'cinema' },
  { key: '65-24', value: 65 / 24, note: 'xpan' },
]

const HANDLES: Array<{ key: string; left: string; top: string; cursor: string }> = [
  { key: 'nw', left: '0%', top: '0%', cursor: 'nwse-resize' },
  { key: 'n', left: '50%', top: '0%', cursor: 'ns-resize' },
  { key: 'ne', left: '100%', top: '0%', cursor: 'nesw-resize' },
  { key: 'e', left: '100%', top: '50%', cursor: 'ew-resize' },
  { key: 'se', left: '100%', top: '100%', cursor: 'nwse-resize' },
  { key: 's', left: '50%', top: '100%', cursor: 'ns-resize' },
  { key: 'sw', left: '0%', top: '100%', cursor: 'nesw-resize' },
  { key: 'w', left: '0%', top: '50%', cursor: 'ew-resize' },
]

/** Resizing or sliding an edge of the crop rectangle. */
interface CropDrag {
  mode: 'crop'
  handle: string
  startX: number
  startY: number
  start: CropRect
  /** Frozen for the gesture, which is also what keeps it out of the effect deps. */
  turn: FreeRotation
}

/**
 * Turning the frame under a fixed crop by dragging outside it. The pointer's
 * travel is accumulated a step at a time rather than read as an angle about the
 * centre, so the rate stays put however far from the pivot the drag started; see
 * anglePerPixel.
 */
interface RotateDrag {
  mode: 'rotate'
  centreX: number
  centreY: number
  /** The crop the gesture began with, so the constraint is measured from it. */
  startCrop: CropRect
  degreesPerPixel: number
}

type DragState = CropDrag | RotateDrag

/**
 * One undoable editing state. Crop rectangles are replaced immutably (every
 * setter builds a new object), so sharing references between snapshots is safe.
 */
interface EditSnapshot {
  rotation: number
  angle: number
  flipH: boolean
  flipV: boolean
  crop: CropRect
  aspect: number | null
}

function sameSnapshot(a: EditSnapshot, b: EditSnapshot) {
  return a.rotation === b.rotation && a.angle === b.angle && a.flipH === b.flipH && a.flipV === b.flipV
    && a.aspect === b.aspect
    && a.crop.x === b.crop.x && a.crop.y === b.crop.y
    && a.crop.width === b.crop.width && a.crop.height === b.crop.height
}

interface Props {
  asset: LocalAsset
  copy: LocalLibraryCopy
  onClose: () => void
  onSaved: (result: LocalImageEditResult) => void
}

function percent(value: number) {
  return `${value * 100}%`
}

/**
 * Full-screen image editor for library photos. The canvas redraws the image with
 * the pending rotation, free angle and flips baked in at display resolution, and
 * the crop rectangle is expressed as fractions of that same post-transform
 * frame, which is exactly the coordinate space the backend expects — so the
 * preview is the result, and no second round trip is needed to show it.
 *
 * A quarter turn keeps the frame axis-aligned and the crop normalized to it. A
 * free angle does not: the frame ends up inside a larger axis-aligned box, the
 * crop is renormalized to that box, and it is inset so the corners the turn
 * opens up are cut away rather than left empty — the same thing the backend
 * does, which is what keeps the preview and the saved file identical.
 */
export function LocalImageEditor({ asset, copy, onClose, onSaved }: Props) {
  const stageRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /**
   * Where the rotate gesture is up to: the angle it has accumulated — unsnapped,
   * so that passing through zero does not clip the pointer's travel — and the
   * pointer position the next step is measured from. A ref because it changes on
   * every pointermove and nothing renders from it.
   */
  const rotateRef = useRef({ angle: 0, x: 0, y: 0 })
  const [stage, setStage] = useState({ width: 0, height: 0 })
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [rotation, setRotation] = useState(0)
  const [angle, setAngle] = useState(0)
  const [flipH, setFlipH] = useState(false)
  const [flipV, setFlipV] = useState(false)
  const [crop, setCrop] = useState<CropRect>(FULL_CROP)
  // 打开即同步识别比例：资产行的宽高 + EXIF 定向（orientation ∈ 5..8 画框宽高
  // 互换，与 <img>/后端 buildEditGeometry 的定向一致）。同步取值让比例胶囊从
  // 第一帧就正确，不会先亮「自由」再跳变；图片加载后按真实像素复核一次，
  // 行数据缺失或陈旧（外部覆盖后未重扫）时自动纠正。
  const initialFrameWidth = asset.orientation >= 5 ? asset.height : asset.width
  const initialFrameHeight = asset.orientation >= 5 ? asset.width : asset.height
  const initialAspect = detectAspectPreset(initialFrameWidth, initialFrameHeight)
  const [aspect, setAspect] = useState<number | null>(initialAspect)
  const [saving, setSaving] = useState(false)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [drag, setDrag] = useState<DragState | null>(null)
  /** Which side of the pivot the pointer is on; the rotate cursor mirrors with it. */
  const [cursorOnLeft, setCursorOnLeft] = useState(false)

  // 撤销/重做历史：index 始终指向「当前状态」所在的快照，每次实际发生变更后
  // 把新状态压栈（与栈顶相同则去重），撤销 = 应用 index-1，重做 = 应用 index+1。
  // 注意必须在变更后记录新状态：若记录「变更前」，第一次操作恰好等于初始快照
  // 会被去重吞掉，表现为第一次操作后撤销不可用、且撤销会一次跳过两个状态。
  const initialSnapshot: EditSnapshot = { rotation: 0, angle: 0, flipH: false, flipV: false, crop: FULL_CROP, aspect: initialAspect }
  const [history, setHistory] = useState<{ stack: EditSnapshot[], index: number }>(() => ({ stack: [initialSnapshot], index: 0 }))
  /** 当前编辑状态的镜像，供手势结束时的提交（onEnd 的闭包读不到实时 state）。 */
  const liveStateRef = useRef<EditSnapshot>(initialSnapshot)
  liveStateRef.current = { rotation, angle, flipH, flipV, crop, aspect }

  const pushHistory = (snapshot: EditSnapshot) => {
    setHistory((current) => {
      if (sameSnapshot(current.stack[current.index], snapshot)) return current
      const stack = [...current.stack.slice(0, current.index + 1), snapshot]
      return { stack, index: stack.length - 1 }
    })
  }

  const applySnapshot = (snapshot: EditSnapshot) => {
    setRotation(snapshot.rotation)
    setAngle(snapshot.angle)
    setFlipH(snapshot.flipH)
    setFlipV(snapshot.flipV)
    setCrop(snapshot.crop)
    setAspect(snapshot.aspect)
  }

  const undo = () => {
    if (history.index <= 0) return
    applySnapshot(history.stack[history.index - 1])
    setHistory({ stack: history.stack, index: history.index - 1 })
  }

  const redo = () => {
    if (history.index >= history.stack.length - 1) return
    applySnapshot(history.stack[history.index + 1])
    setHistory({ stack: history.stack, index: history.index + 1 })
  }

  useEffect(() => {
    const element = stageRef.current
    if (!element) return
    const measure = () => setStage({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let disposed = false
    setImage(null)
    setLoadFailed(false)
    const next = new Image()
    next.onload = () => { if (!disposed) setImage(next) }
    next.onerror = () => { if (!disposed) setLoadFailed(true) }
    // Editable formats are all ones the WebView decodes natively, so the editor
    // always works against the full-resolution original rather than a preview.
    next.src = asset.originalUrl
    return () => { disposed = true }
  }, [asset.originalUrl])

  // The frame is the image after its quarter turns: the size the free angle then
  // turns inside, and the size a crop would be normalized to at angle zero.
  const swapped = rotation === 90 || rotation === 270
  const frameWidth = image ? (swapped ? image.naturalHeight : image.naturalWidth) : 0
  const frameHeight = image ? (swapped ? image.naturalWidth : image.naturalHeight) : 0
  const freeTurn = useMemo(() => freeRotation(frameWidth, frameHeight, angle), [frameWidth, frameHeight, angle])

  // 打开即识别比例：图片分辨率能对上预设（1:1/4:3/3:4/16:9/9:16）就直接选中该
  // 比例，对不上保持自由。这只影响后续拖拽的比例锁定——全幅裁剪不会被改动，
  // 「有改动」也不会被误标。重置按钮回到这个初始比例而不是自由。
  const detectedAspectRef = useRef<number | null>(initialAspect)
  useEffect(() => {
    if (!image) return
    // <img> 按 EXIF 定向显示，naturalWidth/Height 已是用户看到的画框方向。
    const detected = detectAspectPreset(image.naturalWidth, image.naturalHeight)
    detectedAspectRef.current = detected
    setAspect(detected)
  }, [image])

  const display = useMemo(() => {
    if (freeTurn.boxWidth <= 0 || freeTurn.boxHeight <= 0 || stage.width <= 0 || stage.height <= 0) {
      return { width: 0, height: 0, scale: 0 }
    }
    // The box the turn produces is what has to fit, not the frame. The frame is
    // drawn at this same pixels-per-unit, so the whole turn — quarter turns
    // included — is one rotation of the frame inside the box. A stage narrower
    // than the padding would otherwise hand the canvas a negative scale, which
    // flips the image instead of shrinking it.
    const scale = Math.max(0, Math.min(
      (stage.width - STAGE_PADDING) / freeTurn.boxWidth,
      (stage.height - STAGE_PADDING) / freeTurn.boxHeight,
    ))
    return {
      width: Math.max(1, Math.round(freeTurn.boxWidth * scale)),
      height: Math.max(1, Math.round(freeTurn.boxHeight * scale)),
      scale,
    }
  }, [freeTurn.boxWidth, freeTurn.boxHeight, stage.width, stage.height])

  // The handles stop at a size the backend will still accept. Twenty-four screen
  // pixels is the floor on a small window, but a wide one makes the image many
  // times larger than that, and a crop the save step rejects would be a dead end
  // rather than a small crop.
  const minimums = useMemo(() => {
    const floorFor = (extent: number) => extent > 0
      ? Math.min(1, Math.max(MIN_CROP_PIXELS / extent, MIN_CROP_FRACTION))
      : MIN_CROP_FRACTION
    return { width: floorFor(display.width), height: floorFor(display.height) }
  }, [display.width, display.height])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !image || display.width <= 0 || display.height <= 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(display.width * dpr)
    canvas.height = Math.round(display.height * dpr)
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    // The frame is drawn at the box's own pixels-per-unit, so a quarter turn and
    // the free angle collapse into a single rotation of the frame about the
    // centre of the box it produces. Flip first, then rotate, which is the order
    // the backend applies them in.
    const drawWidth = frameWidth * display.scale * dpr
    const drawHeight = frameHeight * display.scale * dpr
    context.save()
    context.translate(canvas.width / 2, canvas.height / 2)
    context.rotate(((rotation + angle) * Math.PI) / 180)
    context.scale(flipH ? -1 : 1, flipV ? -1 : 1)
    context.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
    context.restore()
  }, [image, display.width, display.height, display.scale, rotation, angle, flipH, flipV, frameWidth, frameHeight])

  // Quarter turns and free angles both change the box the crop is normalized to,
  // which changes what a pixel ratio means in normalized space. Re-clamping here
  // keeps a locked ratio honest instead of letting it drift on every turn, and
  // the constraint keeps the crop inside the footprint the rotation leaves.
  useEffect(() => {
    if (display.width <= 0 || display.height <= 0) return
    const ratio = aspect ? normalizedRatio(aspect, display.width, display.height) : null
    setCrop((current) => {
      // 全幅 + 无任何旋转 + 画框本身就是这个比例 ⇒ 全幅就是该比例的完整帧。
      // 显示尺寸有取整误差，按它重新拟合会把全幅削掉亚像素级的一条并误标
      // 「有改动」，所以这种初始状态直接保持不动。
      const isFullCrop = current.x === 0 && current.y === 0 && current.width === 1 && current.height === 1
      if (aspect && isFullCrop && rotation === 0 && angle === 0 && !flipH && !flipV
        && frameWidth > 0 && Math.abs(aspect - frameWidth / frameHeight) <= aspect * ASPECT_MATCH_TOLERANCE) {
        return current
      }
      const fitted = ratio ? fitInsideBounds(current, ratio, minimums.width, minimums.height) : current
      return constrainedCrop(fitted, freeTurn, aspect)
    })
  }, [aspect, display.width, display.height, minimums.width, minimums.height, freeTurn, rotation, angle, flipH, flipV, frameWidth, frameHeight])

  useEffect(() => {
    if (!drag) return
    const onMove = (event: PointerEvent) => {
      if (drag.mode === 'rotate') {
        const previous = rotateRef.current
        const step = rotateStepDegrees(
          drag.centreX, drag.centreY,
          previous.x, previous.y,
          event.clientX, event.clientY,
          drag.degreesPerPixel * (event.shiftKey ? ANGLE_FINE_SCALE : 1),
        )
        // The accumulator holds the raw angle so that passing through zero does
        // not clip the pointer's travel; only the value the editor settles on is
        // pulled onto a whole quarter turn, where the backend stops resampling.
        const raw = previous.angle + step
        rotateRef.current = { angle: raw, x: event.clientX, y: event.clientY }
        const next = snapAngleDegrees(normalizeAngleDegrees(raw))
        setAngle(next)
        // Measured from the crop the gesture began with, so sweeping back
        // towards the starting angle returns the crop instead of shaving it
        // further on every frame the way re-constraining the live crop would.
        setCrop(constrainedCrop(drag.startCrop, freeRotation(frameWidth, frameHeight, next), aspect))
        return
      }
      if (display.width <= 0 || display.height <= 0) return
      const ratio = aspect ? normalizedRatio(aspect, display.width, display.height) : null
      const dx = (event.clientX - drag.startX) / display.width
      const dy = (event.clientY - drag.startY) / display.height
      const resized = resizeCrop(drag.start, drag.handle, dx, dy, ratio, minimums.width, minimums.height)
      // The handles clamp to the box, and the box is not the image: its corners
      // hold no pixels. Constraining is the same inset the backend applies on
      // save, so the preview stays what gets written.
      setCrop(constrainedCrop(resized, drag.turn, aspect))
    }
    const onEnd = () => {
      // 一次拖拽只记一条历史：手势期间连续 setState，结束时按实时状态提交
      // （与栈顶相同＝手势没有产生变化，去重为一条都不记）。
      if (drag) pushHistory(liveStateRef.current)
      setDrag(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
  }, [drag, display.width, display.height, aspect, minimums.width, minimums.height, frameWidth, frameHeight])

  useEffect(() => {
    if (saveDialogOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || drag || saving) return
      const key = event.key.toLowerCase()
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault()
        undo()
      } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose, saveDialogOpen, undo, redo, drag, saving])

  const beginCropDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const handle = (event.target as HTMLElement).dataset.handle
    if (!handle) return
    event.preventDefault()
    setDrag({ mode: 'crop', handle, startX: event.clientX, startY: event.clientY, start: crop, turn: freeTurn })
  }

  /**
   * Which side of the pivot the pointer is on, so the cursor can mirror with it.
   * Guarded so that crossing the middle line is the only thing that re-renders —
   * a bare setState here would run on every pointermove.
   */
  const trackCursorSide = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = boxRef.current?.getBoundingClientRect()
    if (!box) return
    const onLeft = event.clientX < box.left + box.width / 2
    setCursorOnLeft((current) => (current === onLeft ? current : onLeft))
  }

  const beginRotateDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (saving || loadFailed || !image || drag) return
    // A press landing on the crop rectangle or one of its handles is a crop
    // gesture. Everything else — the darkened surround, the letterboxing, the
    // padding around the frame — turns the image under the pointer, which is
    // also the only way in when the crop covers the whole frame.
    if ((event.target as HTMLElement).closest('[data-crop-box]')) return
    const box = boxRef.current?.getBoundingClientRect()
    if (!box) return
    event.preventDefault()
    const centreX = box.left + box.width / 2
    const centreY = box.top + box.height / 2
    rotateRef.current = { angle, x: event.clientX, y: event.clientY }
    setDrag({
      mode: 'rotate',
      centreX,
      centreY,
      startCrop: crop,
      degreesPerPixel: anglePerPixel(Math.hypot(box.width, box.height)),
    })
  }

  const rotate = (clockwise: boolean) => {
    const nextRotation = (rotation + (clockwise ? 90 : 270)) % 360
    const nextCrop = rotateCrop(crop, clockwise)
    pushHistory({ rotation: nextRotation, angle, flipH, flipV, crop: nextCrop, aspect })
    setRotation(nextRotation)
    setCrop(nextCrop)
  }

  const flip = (horizontal: boolean) => {
    const nextFlipH = horizontal ? !flipH : flipH
    const nextFlipV = horizontal ? flipV : !flipV
    // The rectangle mirrors with the pixels it frames.
    const nextCrop = flipCrop(crop, horizontal)
    pushHistory({ rotation, angle, flipH: nextFlipH, flipV: nextFlipV, crop: nextCrop, aspect })
    setFlipH(nextFlipH)
    setFlipV(nextFlipV)
    setCrop(nextCrop)
  }

  const selectAspect = (value: number | null) => {
    let nextCrop = crop
    if (value !== null && display.width > 0 && display.height > 0) {
      // A fresh preset takes the largest centred frame of that ratio, constrained
      // in case the rotation leaves that shape hanging over an empty corner.
      nextCrop = constrainedCrop(aspectFrame(value, display.width, display.height), freeTurn, value)
    }
    pushHistory({ rotation, angle, flipH, flipV, crop: nextCrop, aspect: value })
    setAspect(value)
    setCrop(nextCrop)
  }

  const reset = () => {
    const next = { rotation: 0, angle: 0, flipH: false, flipV: false, crop: FULL_CROP, aspect: detectedAspectRef.current }
    pushHistory(next)
    applySnapshot(next)
  }

  // Straightening constrains the crop as it goes, so clearing the angle leaves
  // the crop where the constraint left it; the reset button above restores both.
  const resetAngle = () => {
    pushHistory({ rotation, angle: 0, flipH, flipV, crop, aspect })
    setAngle(0)
  }

  const isFullFrame = crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1
  const hasChanges = image !== null && !(rotation === 0 && angle === 0 && !flipH && !flipV && isFullFrame)
  // The crop is normalized to the box the free angle produces, so the box is
  // what the pixels are counted against — the same figure the backend reaches
  // through freeRotation.resolveCrop.
  const outputSize = {
    width: Math.max(1, Math.round(freeTurn.boxWidth * crop.width)),
    height: Math.max(1, Math.round(freeTurn.boxHeight * crop.height)),
  }
  // The copy lands next to the original, so the folder is the original's own.
  const folder = asset.relativePath.includes('/')
    ? asset.relativePath.slice(0, asset.relativePath.lastIndexOf('/'))
    : ''

  const submit = async (mode: LocalImageEditMode) => {
    setSaving(true)
    try {
      const result = await localLibraryApi.editImage({
        assetId: asset.id,
        mode,
        rotation,
        angleDeg: angle,
        flipH,
        flipV,
        crop: isFullFrame ? undefined : crop,
      })
      onSaved(result)
    } catch (error) {
      // The editor stays open so the user can adjust and retry rather than
      // losing the whole crop to a transient write failure.
      toast.error(`${copy.editSaveFailed}: ${parseLocalLibraryError(error).message}`)
      setSaving(false)
      setSaveDialogOpen(false)
    }
  }

  const toolButton = (label: string, icon: React.ReactNode, onClick: () => void, active = false) => (
    <button type="button" onClick={onClick} disabled={saving || loadFailed}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] transition-colors disabled:opacity-40 ${active ? 'text-emerald-300' : 'text-white/75'} hover:bg-white/10`}
      aria-pressed={active} title={label}>
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  )

  return (
    <div className="fixed inset-0 z-[75] flex flex-col bg-black text-white" role="dialog" aria-modal="true" aria-label={copy.editImage}>
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4">
        <div className="flex min-w-0 items-center gap-3">
          <CropIcon size={17} className="shrink-0 text-white/60" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{copy.editImage}</div>
            <div className="truncate text-[10px] text-white/50">{asset.displayTitle || asset.fileName}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={undo} disabled={history.index <= 0 || saving} title={`${copy.editUndo} (Ctrl+Z)`} aria-label={copy.editUndo}
            className="rounded-md p-2 text-white/70 hover:bg-white/10 disabled:opacity-40">
            <Undo2 size={14} />
          </button>
          <button type="button" onClick={reset} disabled={!hasChanges || saving} title={copy.editReset}
            className="rounded-md px-2.5 py-2 text-[11px] text-white/70 hover:bg-white/10 disabled:opacity-40">
            {copy.editReset}
          </button>
          <button type="button" onClick={redo} disabled={history.index >= history.stack.length - 1 || saving} title={`${copy.editRedo} (Ctrl+Y)`} aria-label={copy.editRedo}
            className="rounded-md p-2 text-white/70 hover:bg-white/10 disabled:opacity-40">
            <Redo2 size={14} />
          </button>
          <button type="button" onClick={onClose} disabled={saving} className="rounded-md p-2 hover:bg-white/10 disabled:opacity-40" aria-label={copy.editExit}><X size={17} /></button>
          <button type="button" onClick={() => setSaveDialogOpen(true)} disabled={!hasChanges || saving}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-[11px] font-medium text-primary-foreground disabled:opacity-40">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            {copy.save}
          </button>
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-white/10 px-3 py-2">
        {toolButton(copy.editRotateLeft, <RotateCcw size={15} />, () => rotate(false))}
        {toolButton(copy.editRotateRight, <RotateCw size={15} />, () => rotate(true))}
        {toolButton(copy.editFlipHorizontal, <FlipHorizontal size={15} />, () => flip(true), flipH)}
        {toolButton(copy.editFlipVertical, <FlipVertical size={15} />, () => flip(false), flipV)}
        <span className="mx-1 h-5 w-px bg-white/15" />
        <span className="px-1 text-[11px] text-white/45">{copy.editAspect}</span>
        {ASPECT_PRESETS.map((preset) => {
          const selected = aspect === preset.value
          const note = preset.note === 'theater' ? copy.editAspectNoteTheater
            : preset.note === 'cinema' ? copy.editAspectNoteCinema
              : preset.note === 'xpan' ? copy.editAspectNoteXpan : null
          const label = preset.key === 'free' ? copy.editAspectFree : `${preset.key.replace('-', ':')}${note ? `(${note})` : ''}`
          return (
            <button key={preset.key} type="button" onClick={() => selectAspect(preset.value)} disabled={saving || loadFailed}
              className={`rounded-md px-2 py-1 text-[11px] transition-colors disabled:opacity-40 ${selected ? 'bg-white/20 text-white' : 'text-white/65 hover:bg-white/10'}`}
              aria-pressed={selected}>
              {label}
            </button>
          )
        })}
        {/* The value the drag outside the crop drives. It reads out rather than
            being typed into: the angle is only meaningful against the frame that
            is on screen, and one tenth of a degree is below what a pointer can
            aim at anyway. */}
        <div className="ml-auto flex items-center gap-1 pl-2" title={copy.editAngleHint}>
          <span className="text-[11px] text-white/45">{copy.editAngle}</span>
          <span className="min-w-[3.75rem] rounded-md bg-white/10 px-2 py-1 text-center text-[11px] tabular-nums text-white/85">
            {angle.toFixed(1)}°
          </span>
          <button type="button" onClick={resetAngle} disabled={angle === 0 || saving}
            className="rounded-md p-1.5 text-white/60 transition-colors hover:bg-white/10 disabled:opacity-30"
            aria-label={copy.editAngleReset} title={copy.editAngleReset}>
            <Undo2 size={13} />
          </button>
        </div>
      </div>

      {/* A press anywhere the crop is not turns the image: the darkened
          surround, the letterboxing, the padding around the frame. The rotate
          cursor over the whole stage is the only affordance the interaction
          gets, since a full-frame crop leaves nothing outside it to aim at.
          touch-none belongs here as well as on the crop overlay so a touch drag
          turns the frame instead of panning it. */}
      <div ref={stageRef} onPointerDown={beginRotateDrag} onPointerMove={trackCursorSide}
        style={{ cursor: cursorOnLeft ? ROTATE_CURSOR_LEFT : ROTATE_CURSOR_RIGHT }}
        className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden p-6">
        {loadFailed ? (
          <p className="text-xs text-white/60">{copy.editLoadFailed}</p>
        ) : !image ? (
          <div className="flex items-center gap-2 text-xs text-white/60"><Loader2 size={15} className="animate-spin" />{copy.loading}</div>
        ) : (
          <div ref={boxRef} className="relative" style={{ width: display.width, height: display.height }}>
            <canvas ref={canvasRef} className="block h-full w-full" />
            <div className="absolute inset-0 touch-none" onPointerDown={beginCropDrag}>
              <div className="pointer-events-none absolute inset-0 overflow-hidden">
                <div className="absolute border border-white/25"
                  style={{ left: percent(crop.x), top: percent(crop.y), width: percent(crop.width), height: percent(crop.height), boxShadow: '0 0 0 9999px rgba(0,0,0,0.6)' }} />
              </div>
              <div
                data-crop-box
                data-handle="move"
                className="absolute cursor-move border border-white"
                style={{ left: percent(crop.x), top: percent(crop.y), width: percent(crop.width), height: percent(crop.height) }}>
                <div className="pointer-events-none absolute inset-0">
                  <div className="absolute left-1/3 top-0 h-full w-px bg-white/35" />
                  <div className="absolute left-2/3 top-0 h-full w-px bg-white/35" />
                  <div className="absolute left-0 top-1/3 h-px w-full bg-white/35" />
                  <div className="absolute left-0 top-2/3 h-px w-full bg-white/35" />
                </div>
                {HANDLES.map((handle) => (
                  <div key={handle.key} data-handle={handle.key}
                    className="absolute size-3 rounded-sm border border-white bg-black/50"
                    style={{ left: handle.left, top: handle.top, transform: 'translate(-50%, -50%)', cursor: handle.cursor } as CSSProperties} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <footer className="flex h-10 shrink-0 items-center border-t border-white/10 px-4 text-[11px] text-white/55">
        <span className="truncate">
          {hasChanges ? copy.editOutputSize.replace('{width}', String(outputSize.width)).replace('{height}', String(outputSize.height)) : copy.editNoChanges}
          <span className="px-1.5 text-white/25">·</span>
          <span className="text-white/40">{copy.editAngleHint}</span>
        </span>
      </footer>

      {saveDialogOpen && (
        <ImageSaveModeDialog
          copy={copy}
          outputSize={outputSize}
          targetFolder={folder}
          saving={saving}
          onClose={() => { if (!saving) setSaveDialogOpen(false) }}
          onConfirm={(mode) => void submit(mode)}
        />
      )}
    </div>
  )
}
