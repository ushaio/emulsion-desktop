package local_library

import (
	"bytes"
	"context"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// threeFRPreview* and the camera strings describe the synthetic container the
// fixture builder writes. The TIFF type codes it needs (tiffTypeASCII and the
// rest) come from media.go, where the preview walk classifies field widths.
const (
	threeFRPreviewWidth  = 24
	threeFRPreviewHeight = 12
	threeFRMake          = "Hasselblad"
	threeFRModel         = "X1D II 50C"
	threeFRCapturedAt    = "2024:05:01 12:00:00"
)

// 3FR is a Hasselblad RAW wrapped in an ordinary little-endian TIFF container,
// and this toolchain has no decoder for the sensor data. What makes it usable is
// the JPEG preview embedded in the file, exactly like the other RAW formats:
// inspectMedia measures the preview, renderJPEGDerivative thumbnails it, and the
// extracted pixels are "original" as far as the preview frame is concerned.
func TestInspectMediaIndexes3FR(t *testing.T) {
	path := write3FRFixture(t, "shot.3fr")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	result := inspectMedia(path, info)
	if result.MediaKind != "image" {
		t.Errorf("MediaKind = %q, want image", result.MediaKind)
	}
	if result.Format != "3fr" || result.MimeType != "image/x-hasselblad-3fr" {
		t.Errorf("Format/MimeType = %q/%q, want 3fr/image/x-hasselblad-3fr", result.Format, result.MimeType)
	}
	// The dimensions come from the embedded preview: without it the sensor
	// dimensions are unknown to this build.
	if result.Width != threeFRPreviewWidth || result.Height != threeFRPreviewHeight {
		t.Errorf("dimensions = %dx%d, want %dx%d (error %q)",
			result.Width, result.Height, threeFRPreviewWidth, threeFRPreviewHeight, result.PreviewError)
	}
	if result.PreviewStatus != "pending" || result.MetadataStatus != "ready" {
		t.Errorf("PreviewStatus/MetadataStatus = %q/%q, want pending/ready (error %q)",
			result.PreviewStatus, result.MetadataStatus, result.PreviewError)
	}
	if result.EXIF.CameraMake != threeFRMake || result.EXIF.CameraModel != threeFRModel {
		t.Errorf("CameraMake/CameraModel = %q/%q, want %q/%q",
			result.EXIF.CameraMake, result.EXIF.CameraModel, threeFRMake, threeFRModel)
	}
	if result.EXIF.ISO == nil || *result.EXIF.ISO != 100 {
		t.Errorf("ISO = %v, want 100", result.EXIF.ISO)
	}
	if result.EXIF.Aperture == nil || math.Abs(*result.EXIF.Aperture-5.6) > 0.001 {
		t.Errorf("Aperture = %v, want 5.6", result.EXIF.Aperture)
	}
	if result.EXIF.FocalLengthMM == nil || *result.EXIF.FocalLengthMM != 45 {
		t.Errorf("FocalLengthMM = %v, want 45", result.EXIF.FocalLengthMM)
	}
	if result.CapturedAt == nil || result.CapturedAt.Year() != 2024 {
		t.Errorf("CapturedAt = %v, want the DateTimeOriginal year 2024", result.CapturedAt)
	}
	if result.Orientation != 1 {
		t.Errorf("Orientation = %d, want 1", result.Orientation)
	}

	// Both the preview frame and the grid thumbnail go through the extracted
	// preview; the palette has to be non-empty or reconcile.go never considers
	// the asset finished and queues it again forever.
	decoded, err := decodeImage(path)
	if err != nil {
		t.Fatalf("decodeImage: %v", err)
	}
	if bounds := decoded.Bounds(); bounds.Dx() != threeFRPreviewWidth || bounds.Dy() != threeFRPreviewHeight {
		t.Errorf("decoded bounds = %v, want %dx%d", bounds, threeFRPreviewWidth, threeFRPreviewHeight)
	}
	thumbnail := filepath.Join(filepath.Dir(path), "thumb.jpg")
	rendered, err := renderJPEGDerivative(context.Background(), path, thumbnail, thumbnailMaxDimension, 1)
	if err != nil {
		t.Fatalf("renderJPEGDerivative: %v", err)
	}
	if rendered.Width != threeFRPreviewWidth || rendered.Height != threeFRPreviewHeight {
		t.Errorf("rendered thumbnail source = %dx%d, want %dx%d",
			rendered.Width, rendered.Height, threeFRPreviewWidth, threeFRPreviewHeight)
	}
	if len(rendered.Colors) == 0 {
		t.Error("rendered thumbnail palette is empty")
	}
}

// A RAW with no readable preview must fail loudly instead of being indexed as a
// plain file, and it must not be retried on every scan.
func TestInspectMediaReports3FRWithoutPreview(t *testing.T) {
	path := filepath.Join(t.TempDir(), "truncated.3fr")
	if err := os.WriteFile(path, build3FRTIFF(t)[:14], 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	result := inspectMedia(path, info)
	if result.Format != "3fr" {
		t.Errorf("Format = %q, want 3fr: the extension decides when the header carries no preview", result.Format)
	}
	if result.PreviewStatus != "unavailable" {
		t.Errorf("PreviewStatus = %q, want unavailable", result.PreviewStatus)
	}
	if !strings.Contains(result.PreviewError, "preview") {
		t.Errorf("PreviewError = %q, want the missing embedded preview to be named", result.PreviewError)
	}
	if result.MetadataStatus != "partial" {
		t.Errorf("MetadataStatus = %q, want partial: nothing measured the file", result.MetadataStatus)
	}
}

// The format tables, the header sniff and the editable-format contract all have
// to agree on 3FR, because each one is a separate list. The lists the renderer
// keeps (types.ts, LocalAssetFilters.tsx, LocalLibraryPreview.tsx) mirror
// isRAWFormat/isRAWExtension on purpose.
func TestFormatTablesCover3FR(t *testing.T) {
	if !isSupportedMedia("photo.3FR") {
		t.Error("isSupportedMedia rejected .3FR; the extension lookup is case-insensitive")
	}
	format, mimeType := formatForExtension(".3fr")
	if format != "3fr" || mimeType != "image/x-hasselblad-3fr" {
		t.Errorf("formatForExtension(.3fr) = %q/%q, want 3fr/image/x-hasselblad-3fr", format, mimeType)
	}
	if format, mimeType = formatAndMIME("3fr"); format != "3fr" || mimeType != "image/x-hasselblad-3fr" {
		t.Errorf("formatAndMIME(3fr) = %q/%q, want 3fr/image/x-hasselblad-3fr", format, mimeType)
	}
	if !isRAWExtension(".3fr") || !isRAWExtension(".3FR") {
		t.Error("isRAWExtension rejected 3FR; RAW assets are never decoded directly")
	}
	if !isRAWFormat("3fr") {
		t.Error("isRAWFormat rejected 3fr; the preview extraction hangs off it")
	}
	if !supportsEXIFInspection("3fr", ".3fr") {
		t.Error("supportsEXIFInspection rejected 3fr; the container is plain TIFF, which is what goexif reads")
	}
	if _, ok := editableImageFormat("3fr"); ok {
		t.Error("editableImageFormat(3fr) reported an editable format; the sensor data cannot be re-encoded")
	}

	// The TIFF header alone cannot identify a Hasselblad RAW: a .3fr and a .tif
	// differ only in the extension.
	tiffHeader := build3FRTIFF(t)[:64]
	if detected, _, ok := detectMediaHeader(tiffHeader, ".3fr"); !ok || detected != "3fr" {
		t.Errorf("detectMediaHeader(TIFF header, .3fr) = %q/%v, want 3fr/true", detected, ok)
	}
	if detected, _, ok := detectMediaHeader(tiffHeader, ".tif"); !ok || detected != "tiff" {
		t.Errorf("detectMediaHeader(TIFF header, .tif) = %q/%v, want tiff/true", detected, ok)
	}
}

// tiffEntry is one IFD entry of the synthetic container. A value that does not
// fit into four bytes lives in the data area and refers to it by offset.
type tiffEntry struct {
	tag   uint16
	kind  uint16
	count uint32
	inline uint32
	data  []byte
}

func ifdBlockSize(entries []tiffEntry) int {
	return 2 + 12*len(entries) + 4
}

// build3FRTIFF lays out the container: the TIFF header, IFD0 (Make, Model,
// Orientation, the EXIF sub-IFD pointer, and the two entries that locate the
// preview), the EXIF sub-IFD, and then the out-of-line values of both.
//
// The strip offset/count entries start as placeholders; whoever appends the
// preview rewrites them through retarget3FRPreview, exactly as a camera records
// where it put its own preview.
func build3FRTIFF(t *testing.T) []byte {
	t.Helper()
	ifd0 := []tiffEntry{
		{tag: 0x010F, kind: tiffTypeASCII, count: uint32(len(threeFRMake) + 1), data: append([]byte(threeFRMake), 0)},
		{tag: 0x0110, kind: tiffTypeASCII, count: uint32(len(threeFRModel) + 1), data: append([]byte(threeFRModel), 0)},
		{tag: 0x0112, kind: tiffTypeShort, count: 1, inline: 1},
		{tag: 0x0111, kind: tiffTypeLong, count: 1},
		{tag: 0x0117, kind: tiffTypeLong, count: 1},
		{tag: 0x8769, kind: tiffTypeLong, count: 1},
	}
	exifIFD := []tiffEntry{
		{tag: 0x829A, kind: tiffTypeRational, count: 1, data: tiffRational(1, 250)},
		{tag: 0x829D, kind: tiffTypeRational, count: 1, data: tiffRational(56, 10)},
		{tag: 0x8827, kind: tiffTypeShort, count: 1, inline: 100},
		{tag: 0x9003, kind: tiffTypeASCII, count: uint32(len(threeFRCapturedAt) + 1), data: append([]byte(threeFRCapturedAt), 0)},
		{tag: 0x920A, kind: tiffTypeRational, count: 1, data: tiffRational(45, 1)},
	}
	const headerLen = 8
	exifIFDOffset := headerLen + ifdBlockSize(ifd0)
	ifd0[5].inline = uint32(exifIFDOffset)
	dataOffset := exifIFDOffset + ifdBlockSize(exifIFD)
	for _, entries := range [][]tiffEntry{ifd0, exifIFD} {
		for index := range entries {
			if entries[index].data == nil {
				continue
			}
			entries[index].inline = uint32(dataOffset)
			dataOffset += len(entries[index].data)
		}
	}

	buf := new(bytes.Buffer)
	write := func(value any) {
		if err := binary.Write(buf, binary.LittleEndian, value); err != nil {
			t.Fatalf("encode TIFF: %v", err)
		}
	}
	if _, err := buf.WriteString("II"); err != nil {
		t.Fatalf("encode TIFF: %v", err)
	}
	write(uint16(0x2A))
	write(uint32(headerLen))
	writeIFD(buf, t, ifd0)
	writeIFD(buf, t, exifIFD)
	for _, entries := range [][]tiffEntry{ifd0, exifIFD} {
		for _, entry := range entries {
			if entry.data != nil {
				buf.Write(entry.data)
			}
		}
	}
	return buf.Bytes()
}

func writeIFD(buf *bytes.Buffer, t *testing.T, entries []tiffEntry) {
	t.Helper()
	if err := binary.Write(buf, binary.LittleEndian, uint16(len(entries))); err != nil {
		t.Fatalf("encode IFD: %v", err)
	}
	for _, entry := range entries {
		for _, field := range []any{entry.tag, entry.kind, entry.count, entry.inline} {
			if err := binary.Write(buf, binary.LittleEndian, field); err != nil {
				t.Fatalf("encode IFD entry: %v", err)
			}
		}
	}
	if err := binary.Write(buf, binary.LittleEndian, uint32(0)); err != nil {
		t.Fatalf("encode IFD next offset: %v", err)
	}
}

func tiffRational(numerator, denominator uint32) []byte {
	payload := make([]byte, 8)
	binary.LittleEndian.PutUint32(payload[0:4], numerator)
	binary.LittleEndian.PutUint32(payload[4:8], denominator)
	return payload
}

// write3FRFixture writes the synthetic container followed by a real JPEG
// preview, with the container's strip pointers aimed at it.
func write3FRFixture(t *testing.T, name string) string {
	t.Helper()
	preview := threeFRPreviewJPEG(t, threeFRPreviewWidth, threeFRPreviewHeight)
	container := build3FRTIFF(t)
	container = retarget3FRPreview(t, container, int64(len(container)), int64(len(preview)))
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, append(container, preview...), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}

// threeFRPreviewJPEG encodes a preview whose colours make it identifiable, so a
// test can tell which of several embedded previews was chosen.
func threeFRPreviewJPEG(t *testing.T, width, height int) []byte {
	t.Helper()
	source := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			source.Set(x, y, color.RGBA{R: uint8(x * 9), G: uint8(y * 17), B: 0x50, A: 0xFF})
		}
	}
	encoded := new(bytes.Buffer)
	if err := jpeg.Encode(encoded, source, nil); err != nil {
		t.Fatalf("encode preview: %v", err)
	}
	return encoded.Bytes()
}

// A real Hasselblad 3FR puts its preview behind the sensor data, and the sensor
// data can be hundreds of megabytes: B0009586.3FR is 202 MB with the preview in
// the last 1.8 MB. The fixed-size scan read the first 64 MB, found nothing, and
// reported "RAW exceeds preview scan limit" — the asset was indexed but could
// never be shown. The container states where its preview is, so the extractor has
// to read that instead of guessing.
func TestExtractRAWPreviewFindsPreviewBeyondScanLimit(t *testing.T) {
	// A filler big enough that the preview sits past maxRAWPreviewScanBytes and
	// the blind scan cannot reach it. Written sparsely so the test does not cost
	// 80 MB of real disk.
	const fillerBytes = 80 << 20
	preview := threeFRPreviewJPEG(t, threeFRPreviewWidth, threeFRPreviewHeight)

	container := build3FRTIFF(t)
	previewOffset := int64(fillerBytes)
	container = retarget3FRPreview(t, container, previewOffset, int64(len(preview)))

	path := filepath.Join(t.TempDir(), "far-preview.3fr")
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("create %s: %v", path, err)
	}
	if _, err := file.WriteAt(container, 0); err != nil {
		t.Fatalf("write container: %v", err)
	}
	if _, err := file.WriteAt(preview, previewOffset); err != nil {
		t.Fatalf("write preview: %v", err)
	}
	if err := file.Truncate(previewOffset + int64(len(preview))); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	if info.Size() <= maxRAWPreviewScanBytes {
		t.Fatalf("fixture is %d bytes, want it larger than the %d-byte scan limit",
			info.Size(), maxRAWPreviewScanBytes)
	}

	// The inspector measures the preview, so the failure used to leave the row
	// with no dimensions at all.
	result := inspectMedia(path, info)
	if result.PreviewStatus != "pending" {
		t.Errorf("PreviewStatus = %q, want pending (error %q)", result.PreviewStatus, result.PreviewError)
	}
	if result.Width != threeFRPreviewWidth || result.Height != threeFRPreviewHeight {
		t.Errorf("dimensions = %dx%d, want %dx%d (error %q)",
			result.Width, result.Height, threeFRPreviewWidth, threeFRPreviewHeight, result.PreviewError)
	}

	// And the pixels have to be reachable for the grid thumbnail and the frame.
	decoded, err := decodeImage(path)
	if err != nil {
		t.Fatalf("decodeImage: %v", err)
	}
	if bounds := decoded.Bounds(); bounds.Dx() != threeFRPreviewWidth || bounds.Dy() != threeFRPreviewHeight {
		t.Errorf("decoded bounds = %v, want %dx%d", bounds, threeFRPreviewWidth, threeFRPreviewHeight)
	}
}

// When several previews are embedded, the largest usable one still wins — the
// policy the blind scan applied and that DNG/NEF/ARW files rely on. It has to
// survive now that the pointers, not the scan, are the primary source.
func TestExtractRAWPreviewPrefersLargestEmbeddedPreview(t *testing.T) {
	small := threeFRPreviewJPEG(t, 16, 8)
	large := threeFRPreviewJPEG(t, 64, 32)

	container := build3FRTIFF(t)
	// The container's own pointer keeps the small preview; the larger one is
	// appended as a second, contiguous range.
	smallOffset := int64(len(container))
	container = retarget3FRPreview(t, container, smallOffset, int64(len(small)))

	largeOffset := smallOffset + int64(len(small))
	path := filepath.Join(t.TempDir(), "two-previews.3fr")
	payload := append(container, small...)
	payload = append(payload, large...)
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}

	extracted, err := extractRAWPreview(path)
	if err != nil {
		t.Fatalf("extractRAWPreview: %v", err)
	}
	config, err := jpeg.DecodeConfig(bytes.NewReader(extracted))
	if err != nil {
		t.Fatalf("decode extracted preview: %v", err)
	}
	// The blind scan finds the 64x32 one and the pointer finds the 16x8 one; the
	// larger must win either way.
	if config.Width != 64 || config.Height != 32 {
		t.Errorf("extracted preview = %dx%d, want the larger 64x32 (large preview at %d)",
			config.Width, config.Height, largeOffset)
	}
}

// retarget3FRPreview rewrites the two IFD0 entries that locate the preview, so a
// fixture can place it wherever the test needs it. It patches strop 0x0111
// (StripOffsets) and 0x0117 (StripByteCounts) in place.
func retarget3FRPreview(t *testing.T, container []byte, offset, length int64) []byte {
	t.Helper()
	if len(container) < 8 || string(container[:2]) != "II" {
		t.Fatal("retarget3FRPreview expects the little-endian container build3FRTIFF writes")
	}
	entryCount := int(binary.LittleEndian.Uint16(container[8:10]))
	patched := 0
	for index := 0; index < entryCount; index++ {
		entry := container[10+index*12 : 10+index*12+12]
		tag := binary.LittleEndian.Uint16(entry[0:2])
		switch tag {
		case 0x0111:
			binary.LittleEndian.PutUint32(entry[8:12], uint32(offset))
			patched++
		case 0x0117:
			binary.LittleEndian.PutUint32(entry[8:12], uint32(length))
			patched++
		}
	}
	if patched != 2 {
		t.Fatalf("patched %d preview pointer entries, want 2: the fixture layout changed", patched)
	}
	return container
}
