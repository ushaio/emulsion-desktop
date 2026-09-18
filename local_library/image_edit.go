package local_library

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	"image/jpeg"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	nativewebp "github.com/HugoSmits86/nativewebp"
	avifcodec "github.com/gen2brain/avif"
	xdraw "golang.org/x/image/draw"
)

// Image edit save modes.
const (
	// ImageEditModeOverwrite replaces the original file in place.
	ImageEditModeOverwrite = "overwrite"
	// ImageEditModeCopy writes a sibling file next to the original and indexes
	// it as a separate asset, leaving the original untouched.
	ImageEditModeCopy = "copy"
)

const (
	// Edited JPEGs are re-encoded once, so they keep a near-original quality
	// instead of the distribution quality used for uploads and thumbnails.
	editEncodeQuality   = 95
	editMinCropFraction = 0.01
	// JPEG EXIF lives in an APP1 segment; 0x0112 is the Orientation tag.
	exifOrientationTag = 0x0112
)

var errNotEXIFSegment = errors.New("not a valid EXIF segment")

// editableImageFormats is the set of formats the Go toolchain can both decode
// and re-encode without CGO. It is reported back to the renderer so the editor
// entry point can be hidden for everything else.
var editableImageFormats = []string{"jpeg", "png", "webp", "avif"}

// ImageCropRect is a normalized crop rectangle. All values are fractions of the
// image the rectangle applies to, which is the original after its EXIF
// orientation has been applied and the requested rotation and flips baked in.
type ImageCropRect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// ApplyImageEditInput describes one editor session's result. Rotation is a
// clockwise quarter-turn count, flips are applied before the rotation and the
// crop is applied last, which is exactly the order the editor previews.
//
// AngleDeg is a clockwise free rotation in degrees laid on top of the quarter
// turns. Unlike them it cannot be expressed as an integer pixel map, so it
// resamples, and it insets the frame so the corners a rotation opens up are cut
// away rather than left empty — JPEG has no alpha to fill them with.
type ApplyImageEditInput struct {
	AssetID  AssetID        `json:"assetId"`
	Mode     string         `json:"mode"`
	Rotation int            `json:"rotation"`
	AngleDeg float64        `json:"angleDeg"`
	FlipH    bool           `json:"flipH"`
	FlipV    bool           `json:"flipV"`
	Crop     *ImageCropRect `json:"crop,omitempty"`
}

// ImageEditResult carries everything the renderer needs to refresh the asset
// without a second round trip: the new scan identity (so derivative URLs can be
// rebuilt) plus the already-rebuilt URLs.
type ImageEditResult struct {
	AssetID       AssetID `json:"assetId"`
	RelativePath  string  `json:"relativePath"`
	FileName      string  `json:"fileName"`
	ByteSize      int64   `json:"byteSize"`
	ModifiedAtNS  int64   `json:"modifiedAtNs"`
	Width         int     `json:"width"`
	Height        int     `json:"height"`
	PreviewStatus string  `json:"previewStatus"`
	ThumbnailURL  string  `json:"thumbnailUrl"`
	PreviewURL    string  `json:"previewUrl"`
	OriginalURL   string  `json:"originalUrl"`
	Created       bool    `json:"created"`
}

// editableImageFormat maps an asset's stored format to the codec that writes it
// back. Formats the Go toolchain can only decode — HEIC, TIFF, GIF and the RAW
// family — are deliberately excluded: rewriting them as JPEG would leave the
// file's extension and MIME type lying about its contents, a RAW file has no
// pixels to edit beyond its embedded preview, and re-encoding an animated GIF
// would silently flatten it to a single frame.
func editableImageFormat(format string) (string, bool) {
	switch strings.ToLower(format) {
	case "jpeg", "png", "webp", "avif":
		return strings.ToLower(format), true
	}
	return "", false
}

// ApplyImageEdit re-encodes one library image with the requested crop, rotation
// and flips, then either replaces the original file or writes a sibling copy.
// The edit runs against the full-resolution original rather than a cached
// preview, and the EXIF orientation is baked into the pixels so the asset's
// stored orientation reads 1 afterwards.
func (m *Manager) ApplyImageEdit(input ApplyImageEditInput) (ImageEditResult, error) {
	mode := strings.ToLower(strings.TrimSpace(input.Mode))
	if mode != ImageEditModeOverwrite && mode != ImageEditModeCopy {
		return ImageEditResult{}, newError(ErrInvalidPath, "保存方式无效", map[string]any{"mode": input.Mode})
	}
	if !isOpaqueID(string(input.AssetID)) {
		return ImageEditResult{}, newError(ErrAssetNotFound, "资产标识无效", nil)
	}
	rotation, ok := normalizeEditRotation(input.Rotation)
	if !ok {
		return ImageEditResult{}, newError(ErrInvalidPath, "旋转角度必须是 90 度的整数倍", map[string]any{"rotation": input.Rotation})
	}
	quarters, freeAngle, ok := splitFreeAngle(input.AngleDeg)
	if !ok {
		return ImageEditResult{}, newError(ErrInvalidPath, "旋转角度无效", map[string]any{"angleDeg": input.AngleDeg})
	}
	rotation += quarters
	crop, err := normalizeEditCrop(input.Crop)
	if err != nil {
		return ImageEditResult{}, err
	}
	if rotation == 0 && freeAngle == 0 && !input.FlipH && !input.FlipV && crop.isFull() {
		return ImageEditResult{}, newError(ErrInvalidPath, "没有需要应用的编辑操作", nil)
	}

	session, err := m.requireAvailableSession()
	if err != nil {
		return ImageEditResult{}, err
	}

	// The original file is replaced or a sibling is created on disk, so this
	// shares the exclusive mutation lock move, rename and trash already hold.
	// Without it a concurrent move could relocate the asset between the stat
	// and the write, and the edit would land on a path the index no longer
	// points at.
	m.assetFileMutationMu.Lock()
	defer m.assetFileMutationMu.Unlock()

	source, err := session.store.derivativeSource(session.ctx, input.AssetID)
	if err != nil {
		return ImageEditResult{}, err
	}
	if source.Availability != "active" {
		return ImageEditResult{}, newError(ErrAssetNotFound, "资产当前不可用", map[string]any{"assetId": input.AssetID})
	}
	codec, supported := editableImageFormat(source.Format)
	if !supported {
		return ImageEditResult{}, unsupportedImageEditError(source.Format, source.MediaKind, input.AssetID)
	}
	if isTimedMediaKind(source.MediaKind) {
		return ImageEditResult{}, unsupportedImageEditError(source.Format, source.MediaKind, input.AssetID)
	}
	sourcePath, err := resolveWithinRoot(session.root, source.RelativePath)
	if err != nil {
		return ImageEditResult{}, err
	}

	encoded, width, height, err := renderEditedImage(sourcePath, source.Orientation, codec, rotation, freeAngle, input.FlipH, input.FlipV, crop)
	if err != nil {
		return ImageEditResult{}, err
	}

	created := mode == ImageEditModeCopy
	relativePath := source.RelativePath
	if created {
		// The copy keeps the original's name in the original's folder, so the
		// existing collision rule numbers it: "photo.jpg" -> "photo (1).jpg".
		relativePath = nextAvailableAssetName(session.root, source.RelativePath, map[string]struct{}{})
	}
	destinationPath := filepath.Join(session.root, filepath.FromSlash(relativePath))
	if writeErr := writeFileAtomically(destinationPath, encoded); writeErr != nil {
		return ImageEditResult{}, writeErr
	}
	session.ignoreWatcherPath(destinationPath, 5*time.Second)

	// Re-indexing is what bumps modified_at_ns/byte_size, which in turn is what
	// invalidates the derivative cache key. Skipping it would leave the grid
	// serving a thumbnail of the pre-edit pixels.
	reconciled, err := m.reconcilePath(session.ctx, session, relativePath, reconcileSourceImport, newID(), "")
	if err != nil {
		return ImageEditResult{}, err
	}
	// Rebuilds the thumbnail and, through it, the stored palette and the
	// preview's on-demand cache key.
	m.queueThumbnail(session, reconciled.AssetID)
	if created {
		m.emitEvent("assets_imported")
	} else {
		m.emitEvent("asset_updated")
	}

	info, err := os.Stat(destinationPath)
	if err != nil {
		return ImageEditResult{}, err
	}
	modifiedAtNS, byteSize := info.ModTime().UnixNano(), info.Size()
	thumbnailKey := derivativeCacheKey(reconciled.AssetID, modifiedAtNS, byteSize, derivativeThumbnail)
	previewKey := derivativeCacheKey(reconciled.AssetID, modifiedAtNS, byteSize, derivativePreview)
	assetID := string(reconciled.AssetID)
	return ImageEditResult{
		AssetID:      reconciled.AssetID,
		RelativePath: relativePath,
		FileName:     filepath.Base(destinationPath),
		ByteSize:     byteSize,
		ModifiedAtNS: modifiedAtNS,
		Width:        width,
		Height:       height,
		// A fresh write always re-queues the thumbnail, so the renderer shows a
		// generating state until the asset_preview_updated event arrives.
		PreviewStatus: "pending",
		ThumbnailURL:  "/__local-library/thumbnail/" + assetID + "?session=" + session.sessionID + "&v=" + thumbnailKey,
		PreviewURL:    "/__local-library/preview/" + assetID + "?session=" + session.sessionID + "&v=" + previewKey,
		// The original endpoint ignores "v", but the extra parameter changes the
		// URL the WebView already holds, which is what makes it re-read the file
		// instead of reusing the decoded bitmap it cached for the old path.
		OriginalURL: "/__local-library/original/" + assetID + "?session=" + session.sessionID + "&v=" + strconv.FormatInt(modifiedAtNS, 10),
		Created:     created,
	}, nil
}

func unsupportedImageEditError(format, mediaKind string, id AssetID) error {
	if isTimedMediaKind(mediaKind) {
		return newError(ErrUnsupportedFile, "仅图片支持编辑", map[string]any{"assetId": id, "mediaKind": mediaKind})
	}
	return newError(ErrUnsupportedFile, "该格式暂不支持编辑", map[string]any{
		"assetId": id, "format": format, "editableFormats": editableImageFormats,
	})
}

func normalizeEditRotation(rotation int) (int, bool) {
	if rotation%90 != 0 {
		return 0, false
	}
	return ((rotation/90)%4 + 4) % 4, true
}

func normalizeEditCrop(crop *ImageCropRect) (ImageCropRect, error) {
	full := ImageCropRect{Width: 1, Height: 1}
	if crop == nil {
		return full, nil
	}
	if !isFinite(crop.X) || !isFinite(crop.Y) || !isFinite(crop.Width) || !isFinite(crop.Height) {
		return full, newError(ErrInvalidPath, "裁剪参数无效", nil)
	}
	value := ImageCropRect{
		X: math.Min(math.Max(crop.X, 0), 1), Y: math.Min(math.Max(crop.Y, 0), 1),
		Width: math.Min(math.Max(crop.Width, 0), 1), Height: math.Min(math.Max(crop.Height, 0), 1),
	}
	value.Width = math.Min(value.Width, 1-value.X)
	value.Height = math.Min(value.Height, 1-value.Y)
	if value.Width < editMinCropFraction || value.Height < editMinCropFraction {
		return full, newError(ErrInvalidPath, "裁剪区域过小", map[string]any{"minFraction": editMinCropFraction})
	}
	return value, nil
}

func (crop ImageCropRect) isFull() bool {
	return crop.X == 0 && crop.Y == 0 && crop.Width == 1 && crop.Height == 1
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

// pixelMap is an integer affine map from destination pixels back to source
// pixels: sx = ox + sxx*dx + sxy*dy and sy = oy + syx*dx + syy*dy. Every step
// is in {-1, 0, 1}, because EXIF orientations, flips, 90-degree rotations and
// cropping are all axis-aligned. Maps of this shape compose into another map of
// the same shape, so the whole edit chain collapses into a single index
// expression and never materialises an intermediate full-size image.
type pixelMap struct {
	ox, oy   int
	sxx, sxy int
	syx, syy int
}

func identityPixelMap() pixelMap {
	return pixelMap{sxx: 1, syy: 1}
}

// composePixelMaps returns the map that feeds destination pixels through inner
// and then through outer.
func composePixelMaps(inner, outer pixelMap) pixelMap {
	return pixelMap{
		ox:  outer.ox + outer.sxx*inner.ox + outer.sxy*inner.oy,
		oy:  outer.oy + outer.syx*inner.ox + outer.syy*inner.oy,
		sxx: outer.sxx*inner.sxx + outer.sxy*inner.syx,
		sxy: outer.sxx*inner.sxy + outer.sxy*inner.syy,
		syx: outer.syx*inner.sxx + outer.syy*inner.syx,
		syy: outer.syx*inner.sxy + outer.syy*inner.syy,
	}
}

// exifPixelMap maps destination pixels of the oriented image back to the
// unrotated source, mirroring orientedImage's eight cases.
func exifPixelMap(orientation, width, height int) pixelMap {
	if orientation < 2 || orientation > 8 {
		return identityPixelMap()
	}
	// Orientations 5..8 transpose the image, so the source the map reads from
	// is still width x height and only the destination is swapped.
	switch orientation {
	case 2:
		return pixelMap{ox: width - 1, sxx: -1, syy: 1}
	case 3:
		return pixelMap{ox: width - 1, sxx: -1, oy: height - 1, syy: -1}
	case 4:
		return pixelMap{oy: height - 1, sxx: 1, syy: -1}
	case 5:
		return pixelMap{sxy: 1, syx: 1}
	case 6:
		return pixelMap{sxy: 1, oy: height - 1, syx: -1}
	case 7:
		return pixelMap{ox: width - 1, sxy: -1, oy: height - 1, syx: -1}
	default: // 8
		return pixelMap{ox: width - 1, sxy: -1, syx: 1}
	}
}

// flipPixelMap mirrors the source, which happens before any rotation.
func flipPixelMap(flipH, flipV bool, width, height int) pixelMap {
	result := identityPixelMap()
	if flipH {
		result.ox, result.sxx = width-1, -1
	}
	if flipV {
		result.oy, result.syy = height-1, -1
	}
	return result
}

// rotatePixelMap turns the source clockwise by 90*steps degrees.
func rotatePixelMap(steps, width, height int) pixelMap {
	switch ((steps % 4) + 4) % 4 {
	case 1:
		// The source pixel (sx,sy) lands at (height-1-sy, sx); invert that.
		return pixelMap{sxy: 1, oy: height - 1, syx: -1}
	case 2:
		return pixelMap{ox: width - 1, sxx: -1, oy: height - 1, syy: -1}
	case 3:
		// The source pixel (sx,sy) lands at (sy, width-1-sx).
		return pixelMap{ox: width - 1, sxy: -1, syx: 1}
	default:
		return identityPixelMap()
	}
}

// editGeometry is the collapsed chain plus the size of the image it produces.
type editGeometry struct {
	Map           pixelMap
	Width, Height int
}

// buildEditGeometry folds the EXIF orientation, the flips, the rotation and the
// crop into one map from edited pixels back to decoded pixels.
func buildEditGeometry(sourceWidth, sourceHeight, orientation, rotation int, flipH, flipV bool, crop ImageCropRect) editGeometry {
	orientedWidth, orientedHeight := sourceWidth, sourceHeight
	if orientation >= 5 && orientation <= 8 {
		orientedWidth, orientedHeight = sourceHeight, sourceWidth
	}
	combined := exifPixelMap(orientation, sourceWidth, sourceHeight)
	combined = composePixelMaps(combined, flipPixelMap(flipH, flipV, orientedWidth, orientedHeight))

	width, height := orientedWidth, orientedHeight
	rotation = ((rotation % 4) + 4) % 4
	combined = composePixelMaps(combined, rotatePixelMap(rotation, width, height))
	if rotation%2 == 1 {
		width, height = height, width
	}

	cropX := clampEditIndex(int(math.Round(crop.X*float64(width))), width)
	cropY := clampEditIndex(int(math.Round(crop.Y*float64(height))), height)
	cropWidth := clampEditIndex(int(math.Round(crop.Width*float64(width))), width-cropX)
	cropHeight := clampEditIndex(int(math.Round(crop.Height*float64(height))), height-cropY)
	combined = composePixelMaps(combined, pixelMap{ox: cropX, oy: cropY, sxx: 1, syy: 1})
	return editGeometry{Map: combined, Width: cropWidth, Height: cropHeight}
}

func clampEditIndex(value, limit int) int {
	if value < 0 {
		return 0
	}
	if value > limit {
		return limit
	}
	return value
}

func clampEditFloat(value, low, high float64) float64 {
	return math.Min(math.Max(value, low), high)
}

// editAngleEpsilon is how close to a whole number of degrees an angle has to be
// before it counts as one. Below it a free rotation would only add resampling
// blur without visibly moving a pixel, and exact quarter turns are better spent
// on the integer path, which is lossless.
const editAngleEpsilon = 1e-6

// splitFreeAngle decomposes a clockwise free rotation into whole quarter turns
// plus a residual strictly below 90 degrees. The caller adds the quarter turns
// to the integer rotation, so a free rotation that happens to land on a right
// angle still costs no resampling.
func splitFreeAngle(angleDeg float64) (quarters int, residual float64, ok bool) {
	if !isFinite(angleDeg) {
		return 0, 0, false
	}
	normalized := math.Mod(angleDeg, 360)
	if normalized < 0 {
		normalized += 360
	}
	quarters = int(normalized / 90)
	residual = normalized - float64(quarters)*90
	if residual >= 90-editAngleEpsilon {
		quarters++
		residual = 0
	}
	if residual <= editAngleEpsilon {
		residual = 0
	}
	return quarters % 4, residual, true
}

// freeRotation is the resampling stage that follows the integer map: a turn by
// an arbitrary angle about the centre of the oriented frame. It cannot be folded
// into pixelMap, whose steps are whole pixels and whose composition is what lets
// the edit chain collapse into a single index expression, so it is applied as
// each destination pixel is read instead.
//
// Coordinates are continuous: the frame spans [0, frameWidth] x [0, frameHeight]
// and pixel i has its sample point at i+0.5. Rotating the frame clockwise about
// its centre produces the "rotated frame", whose bounding box is width x height.
type freeRotation struct {
	cosine, sine float64

	frameWidth, frameHeight int
	width, height           int

	frameCentreX, frameCentreY     float64
	rotatedCentreX, rotatedCentreY float64
}

func newFreeRotation(frameWidth, frameHeight int, angleDeg float64) freeRotation {
	radians := angleDeg * math.Pi / 180
	cosine, sine := math.Cos(radians), math.Sin(radians)
	fw, fh := float64(frameWidth), float64(frameHeight)
	width := int(math.Round(math.Abs(fw*cosine) + math.Abs(fh*sine)))
	height := int(math.Round(math.Abs(fw*sine) + math.Abs(fh*cosine)))
	return freeRotation{
		cosine: cosine, sine: sine,
		frameWidth: frameWidth, frameHeight: frameHeight,
		width: width, height: height,
		frameCentreX: fw / 2, frameCentreY: fh / 2,
		rotatedCentreX: float64(width) / 2, rotatedCentreY: float64(height) / 2,
	}
}

// toFrameSpace maps a point in the rotated frame back into the un-rotated frame.
func (fr freeRotation) toFrameSpace(x, y float64) (float64, float64) {
	dx, dy := x-fr.rotatedCentreX, y-fr.rotatedCentreY
	return fr.frameCentreX + dx*fr.cosine + dy*fr.sine,
		fr.frameCentreY - dx*fr.sine + dy*fr.cosine
}

// toRotatedSpace maps a point in the un-rotated frame into the rotated frame.
func (fr freeRotation) toRotatedSpace(x, y float64) (float64, float64) {
	dx, dy := x-fr.frameCentreX, y-fr.frameCentreY
	return fr.rotatedCentreX + dx*fr.cosine - dy*fr.sine,
		fr.rotatedCentreY + dx*fr.sine + dy*fr.cosine
}

// resolveCrop turns a crop normalized to the rotated frame into whole pixels.
func (fr freeRotation) resolveCrop(crop ImageCropRect) (x, y, width, height int) {
	x = clampEditIndex(int(math.Round(crop.X*float64(fr.width))), fr.width)
	y = clampEditIndex(int(math.Round(crop.Y*float64(fr.height))), fr.height)
	width = clampEditIndex(int(math.Round(crop.Width*float64(fr.width))), fr.width-x)
	height = clampEditIndex(int(math.Round(crop.Height*float64(fr.height))), fr.height-y)
	return x, y, width, height
}

// insetFreeRotationCrop shrinks a crop until it lies inside the un-rotated
// frame's footprint within the rotated frame. Without it the corners a rotation
// opens up would be read from outside the image, and JPEG has no alpha channel
// to leave them empty with. The rectangle keeps its aspect ratio: its centre is
// first pulled into the footprint, then the rectangle is scaled about that
// centre by the largest factor whose corners all stay inside.
func insetFreeRotationCrop(crop ImageCropRect, fr freeRotation) ImageCropRect {
	rotatedWidth, rotatedHeight := float64(fr.width), float64(fr.height)
	centreX := (crop.X + crop.Width/2) * rotatedWidth
	centreY := (crop.Y + crop.Height/2) * rotatedHeight
	halfWidth := crop.Width * rotatedWidth / 2
	halfHeight := crop.Height * rotatedHeight / 2

	// Pull the centre into the footprint: into frame space, clamp, and back out.
	frameX, frameY := fr.toFrameSpace(centreX, centreY)
	frameX = clampEditFloat(frameX, 0, float64(fr.frameWidth))
	frameY = clampEditFloat(frameY, 0, float64(fr.frameHeight))
	centreX, centreY = fr.toRotatedSpace(frameX, frameY)

	// How far the corners may travel before one of them leaves the footprint.
	scale := 1.0
	limit := func(centre, delta, extent float64) float64 {
		if delta > editAngleEpsilon {
			return (extent - centre) / delta
		}
		if delta < -editAngleEpsilon {
			return centre / -delta
		}
		return math.Inf(1)
	}
	for _, corner := range [4][2]float64{
		{centreX - halfWidth, centreY - halfHeight},
		{centreX + halfWidth, centreY - halfHeight},
		{centreX + halfWidth, centreY + halfHeight},
		{centreX - halfWidth, centreY + halfHeight},
	} {
		cornerX, cornerY := fr.toFrameSpace(corner[0], corner[1])
		deltaX, deltaY := cornerX-frameX, cornerY-frameY
		scale = math.Min(scale, limit(frameX, deltaX, float64(fr.frameWidth)))
		scale = math.Min(scale, limit(frameY, deltaY, float64(fr.frameHeight)))
	}
	if math.IsInf(scale, 0) || scale > 1 {
		scale = 1
	}
	if scale < 0 {
		scale = 0
	}

	return ImageCropRect{
		X:      (centreX - halfWidth*scale) / rotatedWidth,
		Y:      (centreY - halfHeight*scale) / rotatedHeight,
		Width:  halfWidth * scale * 2 / rotatedWidth,
		Height: halfHeight * scale * 2 / rotatedHeight,
	}
}

// renderFreeRotatedImage resamples the oriented frame through the free rotation
// and crops the result. Every destination pixel is mapped back through the
// inverse rotation to a fractional frame coordinate and then through the integer
// map to the source, so the rotation never materialises a rotated copy of the
// image to draw from.
func renderFreeRotatedImage(source *image.NRGBA, m pixelMap, fr freeRotation, cropX, cropY, cropWidth, cropHeight int) *image.NRGBA {
	bounds := source.Bounds()
	originX, originY := bounds.Min.X, bounds.Min.Y
	sourceWidth, sourceHeight := bounds.Dx(), bounds.Dy()
	maxX, maxY := float64(sourceWidth-1), float64(sourceHeight-1)
	target := image.NewNRGBA(image.Rect(0, 0, cropWidth, cropHeight))
	for row := 0; row < cropHeight; row++ {
		rotatedY := float64(cropY+row) + 0.5
		offset := target.PixOffset(0, row)
		for column := 0; column < cropWidth; column++ {
			rotatedX := float64(cropX+column) + 0.5
			frameX, frameY := fr.toFrameSpace(rotatedX, rotatedY)
			// The integer map addresses pixel indices, whose sample points sit
			// half a pixel in from the continuous origin used above.
			indexX, indexY := frameX-0.5, frameY-0.5
			sourceX := float64(m.ox) + float64(m.sxx)*indexX + float64(m.sxy)*indexY
			sourceY := float64(m.oy) + float64(m.syx)*indexX + float64(m.syy)*indexY
			sampleBilinear(source, target.Pix[offset:offset+4], originX, originY, maxX, maxY, sourceX, sourceY)
			offset += 4
		}
	}
	return target
}

// sampleBilinear reads one interpolated pixel. Coordinates are clamped to the
// image rather than left transparent: a rotation is a whole-frame operation, so
// a read that falls outside is always a rounding artefact at the edge, and an
// empty corner would be black in JPEG but see-through in PNG and AVIF.
func sampleBilinear(source *image.NRGBA, target []byte, originX, originY int, maxX, maxY, x, y float64) {
	x = clampEditFloat(x, 0, maxX)
	y = clampEditFloat(y, 0, maxY)
	left, top := int(math.Floor(x)), int(math.Floor(y))
	right, bottom := left+1, top+1
	if right > int(maxX) {
		right = left
	}
	if bottom > int(maxY) {
		bottom = top
	}
	weightX, weightY := x-float64(left), y-float64(top)

	topLeft := source.PixOffset(originX+left, originY+top)
	topRight := source.PixOffset(originX+right, originY+top)
	bottomLeft := source.PixOffset(originX+left, originY+bottom)
	bottomRight := source.PixOffset(originX+right, originY+bottom)
	weights := [4]float64{
		(1 - weightX) * (1 - weightY),
		weightX * (1 - weightY),
		(1 - weightX) * weightY,
		weightX * weightY,
	}
	indices := [4]int{topLeft, topRight, bottomLeft, bottomRight}

	alpha := 0.0
	for index, position := range indices {
		alpha += weights[index] * float64(source.Pix[position+3])
	}
	if alpha <= 0 {
		target[0], target[1], target[2], target[3] = 0, 0, 0, 0
		return
	}
	// Channels are stored un-premultiplied, so weight them premultiplied and
	// divide the colour back out; blending them directly would darken the
	// semi-transparent edges of a PNG.
	for channel := 0; channel < 3; channel++ {
		premultiplied := 0.0
		for index, position := range indices {
			premultiplied += weights[index] * float64(source.Pix[position+channel]) * float64(source.Pix[position+3]) / 255
		}
		target[channel] = uint8(clampEditFloat(math.Round(premultiplied*255/alpha), 0, 255))
	}
	target[3] = uint8(clampEditFloat(math.Round(alpha), 0, 255))
}

// toNRGBA converts a decoded image once, using a same-size resample pass.
// Converting per pixel through color.Color costs an order of magnitude more at
// photo sizes because every At() re-converts YCbCr through the color interface.
func toNRGBA(source image.Image) *image.NRGBA {
	if nrgba, ok := source.(*image.NRGBA); ok {
		return nrgba
	}
	bounds := source.Bounds()
	target := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	xdraw.ApproxBiLinear.Scale(target, target.Bounds(), source, bounds, xdraw.Over, nil)
	return target
}

// transformEditedImage walks the destination once, reading each pixel straight
// from the decoded source through the composed map. Out-of-range reads (which
// rounding at the crop edge can produce) stay transparent rather than wrapping.
func transformEditedImage(source *image.NRGBA, geometry editGeometry) *image.NRGBA {
	bounds := source.Bounds()
	originX, originY := bounds.Min.X, bounds.Min.Y
	width, height := bounds.Dx(), bounds.Dy()
	target := image.NewNRGBA(image.Rect(0, 0, geometry.Width, geometry.Height))
	m := geometry.Map
	for dy := 0; dy < geometry.Height; dy++ {
		sx := m.ox + m.sxy*dy
		sy := m.oy + m.syy*dy
		offset := target.PixOffset(0, dy)
		for dx := 0; dx < geometry.Width; dx++ {
			if sx >= 0 && sy >= 0 && sx < width && sy < height {
				from := source.PixOffset(originX+sx, originY+sy)
				copy(target.Pix[offset:offset+4], source.Pix[from:from+4])
			}
			offset += 4
			sx += m.sxx
			sy += m.syx
		}
	}
	return target
}

// renderEditedImage decodes the original at full resolution, applies the edit
// chain and re-encodes it in the asset's own format.
//
// angleDeg is a free clockwise rotation on top of the quarter turns. When it
// resolves to zero the whole chain stays on the integer map and not a single
// pixel is resampled; otherwise the rotation is applied as a second stage that
// reads the integer-mapped source through bilinear interpolation. The crop is
// interpreted against the frame that rotation produces, which is what the editor
// previews, and is inset automatically so the corners it opens up are cut away.
func renderEditedImage(sourcePath string, orientation int, format string, rotation int, angleDeg float64, flipH, flipV bool, crop ImageCropRect) ([]byte, int, int, error) {
	quarters, freeAngle, ok := splitFreeAngle(angleDeg)
	if !ok {
		return nil, 0, 0, newError(ErrInvalidPath, "旋转角度无效", map[string]any{"angleDeg": angleDeg})
	}
	rotation += quarters

	decoded, err := decodeImage(sourcePath)
	if err != nil {
		return nil, 0, 0, newError(ErrInvalidLibrary, "图片解码失败，无法编辑", map[string]any{"cause": err.Error()})
	}
	bounds := decoded.Bounds()
	if err := validateDimensions(bounds.Dx(), bounds.Dy()); err != nil {
		return nil, 0, 0, newError(ErrInvalidLibrary, "图片尺寸超出编辑限制", map[string]any{"cause": err.Error()})
	}
	geometry := buildEditGeometry(bounds.Dx(), bounds.Dy(), orientation, rotation, flipH, flipV, ImageCropRect{Width: 1, Height: 1})
	source := toNRGBA(decoded)

	var transformed *image.NRGBA
	if freeAngle == 0 {
		// The integer-only path: the crop is folded into the map, so the whole
		// edit is still a single index traversal and nothing is interpolated.
		geometry = buildEditGeometry(bounds.Dx(), bounds.Dy(), orientation, rotation, flipH, flipV, crop)
		if geometry.Width <= 0 || geometry.Height <= 0 {
			return nil, 0, 0, newError(ErrInvalidPath, "裁剪后尺寸无效", nil)
		}
		transformed = transformEditedImage(source, geometry)
	} else {
		free := newFreeRotation(geometry.Width, geometry.Height, freeAngle)
		inset := insetFreeRotationCrop(crop, free)
		cropX, cropY, cropWidth, cropHeight := free.resolveCrop(inset)
		if cropWidth <= 0 || cropHeight <= 0 {
			return nil, 0, 0, newError(ErrInvalidPath, "裁剪后尺寸无效", nil)
		}
		transformed = renderFreeRotatedImage(source, geometry.Map, free, cropX, cropY, cropWidth, cropHeight)
		geometry = editGeometry{Width: cropWidth, Height: cropHeight}
	}
	encoded, err := encodeEditedImage(format, transformed)
	if err != nil {
		return nil, 0, 0, newError(ErrInvalidLibrary, "图片编码失败", map[string]any{"format": format, "cause": err.Error()})
	}
	if format == "jpeg" {
		encoded = preserveJPEGMetadata(sourcePath, encoded)
	}
	return encoded, geometry.Width, geometry.Height, nil
}

func encodeEditedImage(format string, source image.Image) ([]byte, error) {
	var output bytes.Buffer
	var err error
	switch format {
	case "png":
		err = png.Encode(&output, source)
	case "webp":
		err = nativewebp.Encode(&output, source, &nativewebp.Options{CompressionLevel: nativewebp.BestCompression})
	case "avif":
		err = avifcodec.Encode(&output, source, avifcodec.Options{
			Quality:           editEncodeQuality,
			QualityAlpha:      editEncodeQuality,
			Speed:             8,
			ChromaSubsampling: image.YCbCrSubsampleRatio420,
		})
	default:
		err = jpeg.Encode(&output, source, &jpeg.Options{Quality: editEncodeQuality})
	}
	if err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

// writeFileAtomically writes next to the target and renames into place, so a
// crash or a full disk never leaves a half-written photo where the library
// expects the original. os.Rename replaces an existing file on both Windows and
// POSIX, which is what makes the overwrite path atomic.
func writeFileAtomically(path string, data []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(path), ".mo-gallery-edit-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	discard := func() {
		_ = temp.Close()
		_ = os.Remove(tempPath)
	}
	if _, err := temp.Write(data); err != nil {
		discard()
		return err
	}
	if err := temp.Sync(); err != nil {
		discard()
		return err
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	return nil
}

// preserveJPEGMetadata copies the original's APPn segments onto the freshly
// encoded JPEG. The standard encoder writes no EXIF, XMP or ICC profile, so
// without this step an overwritten photo would silently lose its capture date,
// camera and GPS data and the library's timeline would collapse.
//
// APP14 (Adobe) is deliberately skipped: it describes the colour transform of
// the original scan data, which no longer applies after re-encoding as YCbCr.
func preserveJPEGMetadata(sourcePath string, encoded []byte) []byte {
	if len(encoded) < 2 || encoded[0] != 0xFF || encoded[1] != 0xD8 {
		return encoded
	}
	original, err := os.ReadFile(sourcePath)
	if err != nil {
		return encoded
	}
	segments := jpegAppSegments(original)
	if len(segments) == 0 {
		return encoded
	}
	for index, segment := range segments {
		if len(segment) < 2 || segment[1] != 0xE1 || !hasEXIFSignature(segment) {
			continue
		}
		normalized, normalizeErr := normalizeEXIFSegment(segment)
		if normalizeErr != nil {
			// A block we cannot validate may still carry an orientation tag, and
			// a surviving one would rotate the thumbnail a second time. Dropping
			// the block is the safe failure mode.
			segments[index] = nil
			continue
		}
		segments[index] = normalized
	}
	return spliceJPEGSegments(encoded, segments)
}

// jpegAppSegments collects the APPn segments of a JPEG, up to the first
// non-APPn marker. The slices alias the input buffer.
func jpegAppSegments(data []byte) [][]byte {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return nil
	}
	var segments [][]byte
	for offset := 2; offset+4 <= len(data) && data[offset] == 0xFF; {
		marker := data[offset+1]
		if marker < 0xE0 || marker > 0xEF {
			break
		}
		size := int(binary.BigEndian.Uint16(data[offset+2 : offset+4]))
		if size < 2 || offset+2+size > len(data) {
			break
		}
		// Skip the Adobe transform tag: it advertises how the original pixels
		// were colour-transformed, and the re-encoded data is plain YCbCr.
		if marker != 0xEE {
			segments = append(segments, data[offset:offset+2+size])
		}
		offset += 2 + size
	}
	return segments
}

func hasEXIFSignature(segment []byte) bool {
	return len(segment) >= 10 && string(segment[4:10]) == "Exif\x00\x00"
}

// spliceJPEGSegments re-inserts metadata segments after the encoder's own APPn
// run, replacing it so no duplicate APP0/JFIF marker survives. A nil entry in
// segments is skipped.
func spliceJPEGSegments(encoded []byte, segments [][]byte) []byte {
	offset := 2
	for offset+4 <= len(encoded) && encoded[offset] == 0xFF {
		marker := encoded[offset+1]
		if marker < 0xE0 || marker > 0xEF {
			break
		}
		size := int(binary.BigEndian.Uint16(encoded[offset+2 : offset+4]))
		if size < 2 || offset+2+size > len(encoded) {
			break
		}
		offset += 2 + size
	}
	total := 0
	for _, segment := range segments {
		total += len(segment)
	}
	if total == 0 {
		return encoded
	}
	output := make([]byte, 0, len(encoded)+total)
	output = append(output, encoded[:2]...)
	for _, segment := range segments {
		output = append(output, segment...)
	}
	return append(output, encoded[offset:]...)
}

// normalizeEXIFSegment sets the EXIF Orientation tag to 1 and drops the IFD1
// link. The edit bakes the source orientation into the pixels, so a surviving
// orientation tag would rotate the image a second time when the thumbnail
// renderer applies it, and the IFD1 thumbnail still depicts the pre-edit image.
func normalizeEXIFSegment(segment []byte) ([]byte, error) {
	if len(segment) < 16 || segment[0] != 0xFF || segment[1] != 0xE1 {
		return nil, errNotEXIFSegment
	}
	declared := int(binary.BigEndian.Uint16(segment[2:4]))
	if declared < 8 || 2+declared > len(segment) {
		return nil, errNotEXIFSegment
	}
	tiff := segment[10 : 2+declared]
	var order binary.ByteOrder
	switch {
	case tiff[0] == 'I' && tiff[1] == 'I':
		order = binary.LittleEndian
	case tiff[0] == 'M' && tiff[1] == 'M':
		order = binary.BigEndian
	default:
		return nil, errNotEXIFSegment
	}
	if order.Uint16(tiff[2:4]) != 0x002A {
		return nil, errNotEXIFSegment
	}
	ifdOffset := int(order.Uint32(tiff[4:8]))
	if ifdOffset < 8 || ifdOffset+2 > len(tiff) {
		return nil, errNotEXIFSegment
	}
	entries := int(order.Uint16(tiff[ifdOffset : ifdOffset+2]))
	// A directory of more entries than fit in the block means the length field
	// disagrees with the contents, so nothing here is trustworthy.
	if ifdOffset+2+entries*12+4 > len(tiff) {
		return nil, errNotEXIFSegment
	}
	entry := ifdOffset + 2
	for index := 0; index < entries; index++ {
		if order.Uint16(tiff[entry:entry+2]) == exifOrientationTag {
			// Orientation is a single SHORT, so the value is inlined and never
			// an offset into the block.
			if order.Uint16(tiff[entry+2:entry+4]) != 3 || order.Uint32(tiff[entry+4:entry+8]) != 1 {
				return nil, errNotEXIFSegment
			}
			order.PutUint16(tiff[entry+8:entry+10], 1)
		}
		entry += 12
	}
	// entry now points at IFD0's next-directory offset, which links IFD1.
	order.PutUint32(tiff[entry:entry+4], 0)
	return segment, nil
}
