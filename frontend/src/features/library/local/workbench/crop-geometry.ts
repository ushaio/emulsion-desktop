/**
 * Crop-rectangle geometry for the image editor.
 *
 * Rectangles are normalized: x/y/width/height are fractions of the image the
 * rectangle applies to — the original after its EXIF orientation and the pending
 * rotation and flips have been applied. That is deliberately the same space the
 * backend expects, so nothing is converted between the preview and the save.
 *
 * This module is free of React and DOM imports so the maths can be exercised on
 * its own.
 */

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

export const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 }

/** The stage sizes the editor draws into, in screen pixels. */
export interface StageSize {
  width: number
  height: number
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

/**
 * Converts a pixel ratio into the ratio normalized space needs. The two axes are
 * fractions of differently sized dimensions, so a 1:1 crop of a 3:2 frame is not
 * 1:1 once normalized.
 */
export function normalizedRatio(pixelRatio: number, width: number, height: number) {
  return (pixelRatio * height) / width
}

/** The largest centred frame of the given pixel ratio. */
export function aspectFrame(pixelRatio: number, width: number, height: number): CropRect {
  const ratio = normalizedRatio(pixelRatio, width, height)
  const cropWidth = Math.min(1, ratio)
  const cropHeight = cropWidth / ratio
  return { x: (1 - cropWidth) / 2, y: (1 - cropHeight) / 2, width: cropWidth, height: cropHeight }
}

/** Shrinks and slides a rectangle until it sits inside the unit square. */
export function fitInsideBounds(
  rect: CropRect,
  ratio: number | null,
  minWidth: number,
  minHeight: number,
): CropRect {
  const floorWidth = Math.min(minWidth, 1)
  const floorHeight = Math.min(minHeight, 1)
  let width = clamp(rect.width, floorWidth, 1)
  let height = clamp(rect.height, floorHeight, 1)
  if (ratio) {
    // Width drives and the ratio fixes the height; if that drops below the
    // floor, the floor drives instead so the ratio still holds exactly.
    width = clamp(width, floorWidth, Math.min(1, ratio))
    height = width / ratio
    if (height < floorHeight) {
      height = floorHeight
      width = Math.min(height * ratio, 1)
    }
  }
  return {
    x: clamp(rect.x, 0, Math.max(0, 1 - width)),
    y: clamp(rect.y, 0, Math.max(0, 1 - height)),
    width,
    height,
  }
}

/**
 * Applies one drag step. Free-form resizing moves only the dragged edges; with a
 * locked ratio the dragged axis drives and the other follows, anchored at the
 * edge opposite the handle.
 */
export function resizeCrop(
  start: CropRect,
  handle: string,
  dx: number,
  dy: number,
  ratio: number | null,
  minWidth: number,
  minHeight: number,
): CropRect {
  if (handle === 'move') {
    return {
      ...start,
      x: clamp(start.x + dx, 0, Math.max(0, 1 - start.width)),
      y: clamp(start.y + dy, 0, Math.max(0, 1 - start.height)),
    }
  }
  const west = handle.includes('w')
  const east = handle.includes('e')
  const north = handle.includes('n')
  const south = handle.includes('s')
  const left = start.x
  const top = start.y
  const right = start.x + start.width
  const bottom = start.y + start.height

  if (!ratio) {
    // Each dragged edge stops at the image border, or at its own minimum size
    // when the box already sits too close to that border to keep one.
    let x = left
    let y = top
    let width = start.width
    let height = start.height
    if (west) {
      x = clamp(left + dx, 0, Math.max(0, right - minWidth))
      width = right - x
    }
    if (east) width = clamp(start.width + dx, Math.min(minWidth, 1 - left), 1 - left)
    if (north) {
      y = clamp(top + dy, 0, Math.max(0, bottom - minHeight))
      height = bottom - y
    }
    if (south) height = clamp(start.height + dy, Math.min(minHeight, 1 - top), 1 - top)
    return fitInsideBounds({ x, y, width, height }, null, minWidth, minHeight)
  }

  const anchorX = west ? right : left
  const anchorY = north ? bottom : top
  let width = start.width
  let height = start.height
  if (west || east) width = Math.max(minWidth, Math.abs((east ? right + dx : left + dx) - anchorX))
  if (north || south) height = Math.max(minHeight, Math.abs((north ? top + dy : bottom + dy) - anchorY))

  if ((west || east) && (north || south)) {
    // Corners follow whichever axis the pointer pushed further.
    if (width / ratio >= height) height = width / ratio
    else width = height * ratio
  } else if (west || east) {
    height = width / ratio
  } else {
    width = height * ratio
  }

  let x = west ? anchorX - width : left
  let y = north ? anchorY - height : top
  // An edge-only handle keeps the other axis centred on the original box.
  if (!west && !east) x = left + (start.width - width) / 2
  if (!north && !south) y = top + (start.height - height) / 2
  return fitInsideBounds({ x, y, width, height }, ratio, minWidth, minHeight)
}

/**
 * Quarter turns rotate the crop rectangle along with the pixels it frames, so a
 * crop survives a rotation instead of being reset.
 */
export function rotateCrop(crop: CropRect, clockwise: boolean): CropRect {
  return clockwise
    ? { x: 1 - crop.y - crop.height, y: crop.x, width: crop.height, height: crop.width }
    : { x: crop.y, y: 1 - crop.x - crop.width, width: crop.height, height: crop.width }
}

/** Mirrors the crop rectangle to follow the pixels it frames. */
export function flipCrop(crop: CropRect, horizontal: boolean): CropRect {
  return horizontal
    ? { ...crop, x: 1 - crop.x - crop.width }
    : { ...crop, y: 1 - crop.y - crop.height }
}

/* -------------------------------------------------------------------------- *
 * Free rotation
 *
 * A quarter turn keeps the frame axis-aligned, so the crop rectangle stays
 * normalized to the same shape. An arbitrary angle does not: the frame ends up
 * inside a larger axis-aligned box, and that box — not the frame — is what the
 * crop has to be normalized against, because it is what the backend resolves
 * the crop in. Everything below mirrors the freeRotation type in
 * local_library/image_edit.go, so the preview and the saved file agree; the two
 * sides have to be changed together.
 * -------------------------------------------------------------------------- */

export interface Point {
  x: number
  y: number
}

/**
 * A free clockwise rotation about the centre of the oriented frame, in frame
 * units: the frame spans [0, frameWidth] x [0, frameHeight] and the rotated
 * frame is the box the turn produces.
 */
export interface FreeRotation {
  cosine: number
  sine: number
  frameWidth: number
  frameHeight: number
  /** The bounding box of the rotated frame, rounded the way the backend does. */
  boxWidth: number
  boxHeight: number
}

export function freeRotation(frameWidth: number, frameHeight: number, angleDeg: number): FreeRotation {
  const radians = (angleDeg * Math.PI) / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  return {
    cosine,
    sine,
    frameWidth,
    frameHeight,
    // Rounded to whole pixels because that is the frame size the backend
    // resolves the crop against, so the reported output size matches the file.
    boxWidth: Math.round(Math.abs(frameWidth * cosine) + Math.abs(frameHeight * sine)),
    boxHeight: Math.round(Math.abs(frameWidth * sine) + Math.abs(frameHeight * cosine)),
  }
}

/** Maps a point of the rotated box back into the un-rotated frame. */
export function toFrameSpace(rotation: FreeRotation, x: number, y: number): Point {
  const dx = x - rotation.boxWidth / 2
  const dy = y - rotation.boxHeight / 2
  return {
    x: rotation.frameWidth / 2 + dx * rotation.cosine + dy * rotation.sine,
    y: rotation.frameHeight / 2 - dx * rotation.sine + dy * rotation.cosine,
  }
}

/** Maps a point of the un-rotated frame into the rotated box. */
export function toRotatedSpace(rotation: FreeRotation, x: number, y: number): Point {
  const dx = x - rotation.frameWidth / 2
  const dy = y - rotation.frameHeight / 2
  return {
    x: rotation.boxWidth / 2 + dx * rotation.cosine - dy * rotation.sine,
    y: rotation.boxHeight / 2 + dx * rotation.sine + dy * rotation.cosine,
  }
}

/**
 * Shrinks a crop until it lies inside the rotated frame's footprint. Without it
 * the corners a rotation opens up would be read from outside the image, and
 * JPEG has no alpha channel to leave them empty with. The rectangle keeps its
 * aspect ratio: its centre is first pulled into the footprint, then the
 * rectangle is scaled about that centre by the largest factor whose corners all
 * stay inside. Mirrors insetFreeRotationCrop in local_library/image_edit.go.
 */
export function insetFreeRotationCrop(crop: CropRect, rotation: FreeRotation): CropRect {
  if (rotation.boxWidth <= 0 || rotation.boxHeight <= 0) return crop
  // The one place this deliberately parts company with the Go function: at zero
  // the backend folds the crop into its integer pixel map and never reaches the
  // inset, so it has no equivalent branch to mirror. Skipping the work here is
  // what keeps a crop nobody has straightened bit-for-bit what the user dragged
  // instead of that plus the multiplication's rounding error — the editor tests
  // its crop against exact values to decide whether there is anything to save.
  if (rotation.sine === 0 && rotation.cosine === 1) return crop

  const boxWidth = rotation.boxWidth
  const boxHeight = rotation.boxHeight
  const halfWidth = (crop.width * boxWidth) / 2
  const halfHeight = (crop.height * boxHeight) / 2

  // Pull the rectangle's centre into the footprint: into frame space, clamp,
  // and back out. The clamp is what makes a crop dragged to a box corner follow
  // the image instead of poking out of it. The corner deltas below are measured
  // from the clamped point, which is the centre the scaled rectangle grows
  // around.
  const centre = toFrameSpace(rotation, (crop.x + crop.width / 2) * boxWidth, (crop.y + crop.height / 2) * boxHeight)
  const frameCentre: Point = {
    x: clamp(centre.x, 0, rotation.frameWidth),
    y: clamp(centre.y, 0, rotation.frameHeight),
  }
  const anchor = toRotatedSpace(rotation, frameCentre.x, frameCentre.y)

  // How far the corners may travel before one of them leaves the footprint.
  // Corner offsets are linear in the scale factor, so these are exact.
  let scale = 1
  const limit = (origin: number, delta: number, extent: number) => {
    if (delta > 0) return (extent - origin) / delta
    if (delta < 0) return origin / -delta
    return Number.POSITIVE_INFINITY
  }
  const corners: Point[] = [
    { x: anchor.x - halfWidth, y: anchor.y - halfHeight },
    { x: anchor.x + halfWidth, y: anchor.y - halfHeight },
    { x: anchor.x + halfWidth, y: anchor.y + halfHeight },
    { x: anchor.x - halfWidth, y: anchor.y + halfHeight },
  ]
  for (const corner of corners) {
    const inFrame = toFrameSpace(rotation, corner.x, corner.y)
    const deltaX = inFrame.x - frameCentre.x
    const deltaY = inFrame.y - frameCentre.y
    scale = Math.min(scale, limit(frameCentre.x, deltaX, rotation.frameWidth))
    scale = Math.min(scale, limit(frameCentre.y, deltaY, rotation.frameHeight))
  }
  if (!Number.isFinite(scale) || scale > 1) scale = 1
  if (scale < 0) scale = 0

  return {
    x: (anchor.x - halfWidth * scale) / boxWidth,
    y: (anchor.y - halfHeight * scale) / boxHeight,
    width: (halfWidth * scale * 2) / boxWidth,
    height: (halfHeight * scale * 2) / boxHeight,
  }
}

/**
 * Mirrors editMinCropFraction in local_library/image_edit.go: the backend
 * refuses a crop smaller than this fraction of either axis, so the editor must
 * never hand one over.
 */
export const MIN_CROP_FRACTION = 0.01

/** The largest crop of the given pixel ratio that fits inside the footprint. */
export function largestFittingCrop(rotation: FreeRotation, pixelRatio: number | null): CropRect {
  const frame = pixelRatio ? aspectFrame(pixelRatio, rotation.boxWidth, rotation.boxHeight) : FULL_CROP
  return insetFreeRotationCrop(frame, rotation)
}

/**
 * The crop the editor should hold at this rotation: the rectangle the user
 * asked for, pulled back inside the footprint.
 *
 * A crop parked in a corner that a later turn empties leaves the inset with
 * nothing it can preserve, and it collapses to nothing at all. The backend
 * rejects a crop that small outright, so the editor falls back to the largest
 * crop that still fits rather than carrying a rectangle that cannot be saved.
 */
export function constrainedCrop(candidate: CropRect, rotation: FreeRotation, pixelRatio: number | null): CropRect {
  const inset = insetFreeRotationCrop(candidate, rotation)
  if (inset.width >= MIN_CROP_FRACTION && inset.height >= MIN_CROP_FRACTION) return inset
  return largestFittingCrop(rotation, pixelRatio)
}

/** Folds an angle into (-180, 180], the range the editor reads out. */
export function normalizeAngleDegrees(angle: number) {
  const wrapped = ((angle % 360) + 360) % 360
  return wrapped > 180 ? wrapped - 360 : wrapped
}

/**
 * Angles this close to a whole quarter turn are pulled onto it. Landing exactly
 * on one matters: the backend spends a free rotation on a lossy resample, while
 * a whole turn folds back into the integer path, where nothing is resampled.
 *
 * The threshold sits below half the step the editor reads out, so the two agree
 * exactly: a displayed 0.0° is precisely zero and takes the lossless path, and
 * every value the readout can show is a real free rotation. A wider threshold
 * looks harmless and is not — at half a degree it swallowed every small
 * correction, and a straightening that needs a third of a degree is an ordinary
 * thing to need.
 */
export const ANGLE_SNAP_DEGREES = 0.04

export function snapAngleDegrees(angle: number) {
  const nearest = Math.round(angle / 90) * 90
  return Math.abs(angle - nearest) <= ANGLE_SNAP_DEGREES ? normalizeAngleDegrees(nearest) : angle
}

/**
 * How much of the pointer's travel becomes rotation.
 *
 * The pointer is read as an arc length about the centre, and an arc length over
 * a reference radius turns into an angle — so the rate is the *same* wherever
 * the drag is grabbed, which reading the pointer's angle about the centre is
 * not. That form is 1/r: it lurched near the middle and crawled at the edge, so
 * how fine the control felt depended on where the drag happened to start.
 * Scaling the radius with the frame decouples the rate from the window size too.
 */
export function anglePerPixel(diagonal: number) {
  return (180 / Math.PI) / clamp(diagonal * 0.9, 400, 1200)
}

/**
 * One step of a rotate drag, in degrees, clockwise when positive.
 *
 * The pointer's travel is projected onto the tangent at where it was standing —
 * the radius turned a quarter turn — so that moving around the centre turns the
 * image and moving towards or away from it does not. Screen space has y pointing
 * down, which is what makes the positive direction the clockwise one the canvas
 * turns a positive rotation.
 */
export function rotateStepDegrees(
  pivotX: number,
  pivotY: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  degreesPerPixel: number,
) {
  const radialX = fromX - pivotX
  const radialY = fromY - pivotY
  const radial = Math.hypot(radialX, radialY)
  // A grab landing on the pivot has no tangent to read, and dividing by its
  // radius would send the step to infinity.
  if (radial < 1) return 0
  const travelled = (toX - fromX) * (-radialY / radial) + (toY - fromY) * (radialX / radial)
  return travelled * degreesPerPixel
}
