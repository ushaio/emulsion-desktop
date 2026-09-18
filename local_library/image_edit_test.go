package local_library

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"math"
	"os"
	"path/filepath"
	"testing"
)

// newTestImage builds a small NRGBA whose pixels are numbered left to right,
// top to bottom, so a wrong axis or a wrong sign in the geometry shows up as an
// obviously misplaced number instead of a plausible-looking photo.
func newTestImage(width, height int) *image.NRGBA {
	target := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			target.SetNRGBA(x, y, color.NRGBA{R: uint8(y*width + x), A: 255})
		}
	}
	return target
}

type pixelTuple struct {
	R, G, B, A uint8
}

func tuplesOf(source image.Image) [][]pixelTuple {
	bounds := source.Bounds()
	rows := make([][]pixelTuple, bounds.Dy())
	for y := 0; y < bounds.Dy(); y++ {
		row := make([]pixelTuple, bounds.Dx())
		for x := 0; x < bounds.Dx(); x++ {
			r, g, b, a := source.At(bounds.Min.X+x, bounds.Min.Y+y).RGBA()
			row[x] = pixelTuple{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), uint8(a >> 8)}
		}
		rows[y] = row
	}
	return rows
}

func TestRotateQuarterTurns(t *testing.T) {
	// 3x2 source:
	//   0 1 2
	//   3 4 5
	source := newTestImage(3, 2)
	cases := []struct {
		name   string
		steps  int
		expect [][]int
	}{
		{"clockwise", 1, [][]int{{3, 0}, {4, 1}, {5, 2}}},
		{"half turn", 2, [][]int{{5, 4, 3}, {2, 1, 0}}},
		{"counter clockwise", 3, [][]int{{2, 5}, {1, 4}, {0, 3}}},
	}
	for _, testCase := range cases {
		geometry := buildEditGeometry(3, 2, 1, testCase.steps, false, false, ImageCropRect{Width: 1, Height: 1})
		if geometry.Width != len(testCase.expect[0]) || geometry.Height != len(testCase.expect) {
			t.Fatalf("%s: size = %dx%d, want %dx%d", testCase.name, geometry.Width, geometry.Height,
				len(testCase.expect[0]), len(testCase.expect))
		}
		rows := tuplesOf(transformEditedImage(source, geometry))
		for y, expectedRow := range testCase.expect {
			for x, expected := range expectedRow {
				if got := rows[y][x].R; int(got) != expected {
					t.Errorf("%s: pixel(%d,%d) = %d, want %d", testCase.name, x, y, got, expected)
				}
			}
		}
	}
}

func TestFlipAndCrop(t *testing.T) {
	// 3x2 source: 0 1 2 / 3 4 5
	source := newTestImage(3, 2)

	flipped := buildEditGeometry(3, 2, 1, 0, true, false, ImageCropRect{Width: 1, Height: 1})
	if rows := tuplesOf(transformEditedImage(source, flipped)); rows[0][0].R != 2 || rows[1][2].R != 3 {
		t.Errorf("horizontal flip produced %v, want 2 1 0 / 5 4 3", rows)
	}

	// The rightmost two columns: 1 2 / 4 5
	cropped := buildEditGeometry(3, 2, 1, 0, false, false, ImageCropRect{X: 1.0 / 3.0, Width: 2.0 / 3.0, Height: 1})
	if cropped.Width != 2 || cropped.Height != 2 {
		t.Fatalf("crop size = %dx%d, want 2x2", cropped.Width, cropped.Height)
	}
	rows := tuplesOf(transformEditedImage(source, cropped))
	if rows[0][0].R != 1 || rows[0][1].R != 2 || rows[1][0].R != 4 || rows[1][1].R != 5 {
		t.Errorf("crop produced %v, want 1 2 / 4 5", rows)
	}
}

// The editor previews the image through the browser's own EXIF auto-orientation,
// so the Go pipeline has to reproduce orientedImage exactly or every edit on a
// photo carrying an orientation tag would come out sideways.
func TestEditGeometryMatchesOrientedImage(t *testing.T) {
	source := newTestImage(3, 2)
	for orientation := 1; orientation <= 8; orientation++ {
		expected := tuplesOf(orientedImage(source, orientation))
		geometry := buildEditGeometry(3, 2, orientation, 0, false, false, ImageCropRect{Width: 1, Height: 1})
		actual := tuplesOf(transformEditedImage(source, geometry))
		if len(actual) != len(expected) || len(actual[0]) != len(expected[0]) {
			t.Fatalf("orientation %d: size = %dx%d, want %dx%d", orientation,
				len(actual[0]), len(actual), len(expected[0]), len(expected))
		}
		for y := range expected {
			for x := range expected[y] {
				if actual[y][x] != expected[y][x] {
					t.Errorf("orientation %d: pixel(%d,%d) = %+v, want %+v", orientation, x, y, actual[y][x], expected[y][x])
				}
			}
		}
	}
}

func TestNormalizeEditRotationRejectsPartialTurns(t *testing.T) {
	if _, ok := normalizeEditRotation(45); ok {
		t.Error("normalizeEditRotation(45) accepted a non-quarter turn")
	}
	if rotation, ok := normalizeEditRotation(-90); !ok || rotation != 3 {
		t.Errorf("normalizeEditRotation(-90) = %d/%v, want 3/true", rotation, ok)
	}
	if rotation, ok := normalizeEditRotation(450); !ok || rotation != 1 {
		t.Errorf("normalizeEditRotation(450) = %d/%v, want 1/true", rotation, ok)
	}
}

func TestNormalizeEditCropClampsAndRejectsTiny(t *testing.T) {
	crop, err := normalizeEditCrop(&ImageCropRect{X: 0.8, Y: 0.9, Width: 0.5, Height: 0.5})
	if err != nil {
		t.Fatalf("normalizeEditCrop returned %v", err)
	}
	if crop.Width > 0.2 || crop.Height > 0.1 {
		t.Errorf("crop clamped to %+v, want it to stop at the far edge", crop)
	}
	if _, err := normalizeEditCrop(&ImageCropRect{Width: 0.001, Height: 0.001}); err == nil {
		t.Error("normalizeEditCrop accepted a crop smaller than the minimum")
	}
	if _, err := normalizeEditCrop(nil); err != nil {
		t.Errorf("normalizeEditCrop(nil) returned %v, want the full frame", err)
	}
}

// exifAPP1 builds a minimal little-endian EXIF block with one Orientation entry
// whose value is orientation, plus a non-zero IFD1 link standing in for an
// embedded thumbnail.
func exifAPP1(orientation uint16) []byte {
	tiff := make([]byte, 26)
	copy(tiff[0:2], "II")
	binary.LittleEndian.PutUint16(tiff[2:4], 0x002A)
	binary.LittleEndian.PutUint32(tiff[4:8], 8)
	binary.LittleEndian.PutUint16(tiff[8:10], 1)
	binary.LittleEndian.PutUint16(tiff[10:12], exifOrientationTag)
	binary.LittleEndian.PutUint16(tiff[12:14], 3)
	binary.LittleEndian.PutUint32(tiff[14:18], 1)
	binary.LittleEndian.PutUint16(tiff[18:20], orientation)
	// tiff[22:26] is IFD0's next-directory offset, deliberately pointing at 10.
	binary.LittleEndian.PutUint32(tiff[22:26], 10)

	segment := make([]byte, 0, 2+2+6+len(tiff))
	segment = append(segment, 0xFF, 0xE1)
	segment = binary.BigEndian.AppendUint16(segment, uint16(2+6+len(tiff)))
	segment = append(segment, "Exif\x00\x00"...)
	return append(segment, tiff...)
}

func TestNormalizeEXIFSegmentRewritesOrientationAndDropsIFD1(t *testing.T) {
	segment := exifAPP1(6)
	if !hasEXIFSignature(segment) {
		t.Fatal("the test segment was not recognised as EXIF")
	}
	normalized, err := normalizeEXIFSegment(segment)
	if err != nil {
		t.Fatalf("normalizeEXIFSegment returned %v", err)
	}
	tiff := normalized[10:]
	if got := binary.LittleEndian.Uint16(tiff[18:20]); got != 1 {
		t.Errorf("orientation = %d, want 1", got)
	}
	if got := binary.LittleEndian.Uint32(tiff[22:26]); got != 0 {
		t.Errorf("IFD1 link = %d, want 0", got)
	}
}

func TestNormalizeEXIFSegmentRejectsTruncatedBlock(t *testing.T) {
	if _, err := normalizeEXIFSegment(exifAPP1(6)[:14]); err == nil {
		t.Error("normalizeEXIFSegment accepted a truncated EXIF block")
	}
}

func TestSpliceJPEGSegmentsReplacesTheEncodersAppRun(t *testing.T) {
	// SOI, the encoder's JFIF APP0, then a DQT standing in for the rest.
	encoded := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0xAA, 0xBB, 0xFF, 0xDB, 0x00, 0x02}
	exif := exifAPP1(6)
	output := spliceJPEGSegments(encoded, [][]byte{exif})
	if output[0] != 0xFF || output[1] != 0xD8 {
		t.Fatalf("output does not start with SOI: %v", output[:2])
	}
	if output[2] != 0xFF || output[3] != 0xE1 {
		t.Errorf("the original EXIF segment was not spliced in: %v", output[:4])
	}
	tail := output[2+len(exif):]
	if len(tail) != 4 || tail[0] != 0xFF || tail[1] != 0xDB {
		t.Errorf("tail = %v, want the encoder's DQT onwards without its APP0", tail)
	}
}

func TestEditableImageFormatCoverage(t *testing.T) {
	for _, format := range []string{"heif", "tiff", "gif", "bmp", "cr3", "cr2", "nef"} {
		if _, ok := editableImageFormat(format); ok {
			t.Errorf("editableImageFormat(%q) reported an editable format", format)
		}
	}
	for _, format := range []string{"jpeg", "png", "webp", "avif"} {
		if _, ok := editableImageFormat(format); !ok {
			t.Errorf("editableImageFormat(%q) reported the format as unsupported", format)
		}
	}
}

// renderEditedImage is the whole pipeline against a real file: decode, bake the
// EXIF orientation, rotate, re-encode and splice the metadata back on.
func TestRenderEditedImageKeepsEXIFAndNormalisesOrientation(t *testing.T) {
	base, err := encodeEditedImage("jpeg", newTestImage(4, 2))
	if err != nil {
		t.Fatalf("building the fixture failed: %v", err)
	}
	path := filepath.Join(t.TempDir(), "photo.jpg")
	if writeErr := os.WriteFile(path, spliceJPEGSegments(base, [][]byte{exifAPP1(6)}), 0o600); writeErr != nil {
		t.Fatalf("writing the fixture failed: %v", writeErr)
	}

	encoded, width, height, err := renderEditedImage(path, 6, "jpeg", 1, 0, false, false, ImageCropRect{Width: 1, Height: 1})
	if err != nil {
		t.Fatalf("renderEditedImage returned %v", err)
	}
	// A 4x2 frame carried as orientation 6 reads as 2x4, and the clockwise
	// quarter turn puts it back at 4x2.
	if width != 4 || height != 2 {
		t.Errorf("output size = %dx%d, want 4x2", width, height)
	}
	decoded, format, decodeErr := image.Decode(bytes.NewReader(encoded))
	if decodeErr != nil {
		t.Fatalf("the re-encoded JPEG does not decode: %v", decodeErr)
	}
	if format != "jpeg" {
		t.Errorf("re-encoded format = %q, want jpeg", format)
	}
	if decoded.Bounds().Dx() != 4 || decoded.Bounds().Dy() != 2 {
		t.Errorf("decoded size = %dx%d, want 4x2", decoded.Bounds().Dx(), decoded.Bounds().Dy())
	}

	var exifSegment []byte
	for _, segment := range jpegAppSegments(encoded) {
		if len(segment) >= 2 && segment[1] == 0xE1 && hasEXIFSignature(segment) {
			exifSegment = segment
		}
	}
	if exifSegment == nil {
		t.Fatal("the edit dropped the EXIF block")
	}
	tiff := exifSegment[10:]
	if got := binary.LittleEndian.Uint16(tiff[18:20]); got != 1 {
		t.Errorf("spliced EXIF orientation = %d, want 1", got)
	}
	if got := binary.LittleEndian.Uint32(tiff[22:26]); got != 0 {
		t.Errorf("spliced EXIF IFD1 link = %d, want 0", got)
	}
}

// splitFreeAngle is what keeps a free rotation from costing anything it does not
// have to: whole quarter turns fold back into the integer path, where nothing is
// resampled, and only the residual goes through the resampler.
func TestSplitFreeAngle(t *testing.T) {
	cases := []struct {
		angle    float64
		quarters int
		residual float64
	}{
		{0, 0, 0},
		{3, 0, 3},
		{89.5, 0, 89.5},
		{90, 1, 0},
		{95, 1, 5},
		{180, 2, 0},
		{270, 3, 0},
		{359.5, 3, 89.5},
		{-12.25, 3, 77.75},
		{-90, 3, 0},
	}
	for _, testCase := range cases {
		quarters, residual, ok := splitFreeAngle(testCase.angle)
		if !ok {
			t.Errorf("splitFreeAngle(%v) rejected a valid angle", testCase.angle)
			continue
		}
		if quarters != testCase.quarters || math.Abs(residual-testCase.residual) > 1e-9 {
			t.Errorf("splitFreeAngle(%v) = %d quarters + %v, want %d + %v",
				testCase.angle, quarters, residual, testCase.quarters, testCase.residual)
		}
	}
	for _, invalid := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if _, _, ok := splitFreeAngle(invalid); ok {
			t.Errorf("splitFreeAngle(%v) accepted an angle it cannot decompose", invalid)
		}
	}
}

// assertCropInsideFootprint fails when any corner of the crop maps outside the
// frame, which is where a rotation would have left nothing to read.
func assertCropInsideFootprint(t *testing.T, crop ImageCropRect, free freeRotation, angle float64) {
	t.Helper()
	tolerance := float64(free.frameWidth+free.frameHeight) * 1e-9
	for _, xn := range []float64{crop.X, crop.X + crop.Width} {
		for _, yn := range []float64{crop.Y, crop.Y + crop.Height} {
			x, y := free.toFrameSpace(xn*float64(free.width), yn*float64(free.height))
			if x < -tolerance || x > float64(free.frameWidth)+tolerance ||
				y < -tolerance || y > float64(free.frameHeight)+tolerance {
				t.Errorf("corner (%.4f, %.4f) of %+v fell outside the %dx%d frame, which a turn by %v opened up",
					x, y, crop, free.frameWidth, free.frameHeight, angle)
			}
		}
	}
}

// sameCrop compares two rectangles as finely as the arithmetic can be trusted:
// the inset multiplies and divides by the box size, so a crop it leaves alone
// comes back within a rounding error rather than bit for bit.
func sameCrop(a, b ImageCropRect, tolerance float64) bool {
	return math.Abs(a.X-b.X) <= tolerance && math.Abs(a.Y-b.Y) <= tolerance &&
		math.Abs(a.Width-b.Width) <= tolerance && math.Abs(a.Height-b.Height) <= tolerance
}

// The frame a free rotation produces is a box around the frame, and its corners
// hold no pixels. These numbers are pinned because the editor's TypeScript
// mirror (frontend/src/features/library/local/workbench/crop-geometry.ts) has to
// produce the same ones — that is what makes the preview the saved file.
func TestFreeRotationBoxAndInset(t *testing.T) {
	cases := []struct {
		name          string
		width, height int
		angle         float64
		crop          ImageCropRect
		boxWidth      int
		boxHeight     int
		inset         ImageCropRect
	}{
		{
			name: "a full frame straightened", width: 3000, height: 2000, angle: 3.5,
			crop: ImageCropRect{Width: 1, Height: 1},
			boxWidth: 3117, boxHeight: 2179,
			inset: ImageCropRect{
				X: 0.07720706788532362, Y: 0.07720706788532362,
				Width: 0.8455858642293528, Height: 0.8455858642293528,
			},
		},
		{
			name: "a crop that is already inside", width: 4032, height: 3024, angle: 1.75,
			crop:     ImageCropRect{X: 0.05, Y: 0.4, Width: 0.3, Height: 0.55},
			boxWidth: 4122, boxHeight: 3146,
			inset: ImageCropRect{X: 0.05, Y: 0.4, Width: 0.3, Height: 0.55},
		},
		{
			name: "a free turn past a right angle", width: 3000, height: 2000, angle: 95,
			crop: ImageCropRect{Width: 1, Height: 1},
			boxWidth: 2254, boxHeight: 3163,
			inset: ImageCropRect{
				X: 0.10334718867167163, Y: 0.10334718867167166,
				Width: 0.7933056226566567, Height: 0.7933056226566567,
			},
		},
	}
	for _, testCase := range cases {
		free := newFreeRotation(testCase.width, testCase.height, testCase.angle)
		if free.width != testCase.boxWidth || free.height != testCase.boxHeight {
			t.Errorf("%s: box = %dx%d, want %dx%d", testCase.name, free.width, free.height,
				testCase.boxWidth, testCase.boxHeight)
		}
		inset := insetFreeRotationCrop(testCase.crop, free)
		if math.Abs(inset.X-testCase.inset.X) > 1e-12 || math.Abs(inset.Y-testCase.inset.Y) > 1e-12 ||
			math.Abs(inset.Width-testCase.inset.Width) > 1e-12 || math.Abs(inset.Height-testCase.inset.Height) > 1e-12 {
			t.Errorf("%s: inset = %+v, want %+v", testCase.name, inset, testCase.inset)
		}
	}
}

func TestInsetFreeRotationCropKeepsCropsInsideTheFootprint(t *testing.T) {
	for _, angle := range []float64{-45, -30, -12.25, 0.001, 3.5, 7.5, 45, 89.5, 95, 179} {
		for _, size := range [][2]int{{3000, 2000}, {2000, 3000}, {1600, 1600}, {4032, 3024}} {
			free := newFreeRotation(size[0], size[1], angle)
			anchored := insetFreeRotationCrop(ImageCropRect{Width: 1, Height: 1}, free)
			if anchored.Width <= 0 || anchored.Height <= 0 {
				t.Fatalf("a full frame at %v on %dx%d was emptied by the inset", angle, size[0], size[1])
			}
			assertCropInsideFootprint(t, anchored, free, angle)

			// Re-insetting is a no-op, which is what lets the editor apply the
			// constraint on every frame of a drag without ratcheting the crop
			// down a little further each time.
			again := insetFreeRotationCrop(anchored, free)
			if math.Abs(again.X-anchored.X) > 1e-9 || math.Abs(again.Y-anchored.Y) > 1e-9 ||
				math.Abs(again.Width-anchored.Width) > 1e-9 || math.Abs(again.Height-anchored.Height) > 1e-9 {
				t.Errorf("angle %v on %dx%d: the inset is not idempotent (%+v then %+v)",
					angle, size[0], size[1], anchored, again)
			}

			// A crop the user placed inside is left alone: the constraint only
			// ever takes pixels away, so a crop that has them all keeps them.
			inner := ImageCropRect{
				X: anchored.X + anchored.Width/4, Y: anchored.Y + anchored.Height/4,
				Width: anchored.Width / 2, Height: anchored.Height / 2,
			}
			if kept := insetFreeRotationCrop(inner, free); !sameCrop(kept, inner, 1e-12) {
				t.Errorf("angle %v on %dx%d: a crop that already fits was moved to %+v", angle, size[0], size[1], kept)
			}
		}
	}

	// A zero angle is where the whole edit stays on the lossless integer path,
	// and there the crop is folded straight into the pixel map instead of going
	// through the inset at all. The editor's mirror short-circuits it for the
	// same reason: so that a crop nobody has straightened is what the user
	// dragged, rather than that plus a rounding error.
	crop := ImageCropRect{X: 0.1, Y: 0.2, Width: 0.3, Height: 0.4}
	if got := insetFreeRotationCrop(crop, newFreeRotation(3000, 2000, 0)); !sameCrop(got, crop, 1e-12) {
		t.Errorf("a zero rotation moved the crop to %+v", got)
	}
}

// A crop parked in a corner that a later turn empties has no pixels left to keep
// and no aspect ratio to preserve, so the inset collapses it to nothing. That is
// why the editor constrains every crop it holds rather than only the angle: a
// crop like this one could not be saved, because normalizeEditCrop rejects
// anything under editMinCropFraction.
func TestInsetFreeRotationCropEmptiesACropWithNothingBehindIt(t *testing.T) {
	corner := ImageCropRect{X: 0.9, Y: 0.9, Width: 0.1, Height: 0.1}
	// With the frame axis-aligned the rectangle sits squarely on the image, so
	// the inset has nothing to do at all.
	if straight := insetFreeRotationCrop(corner, newFreeRotation(3000, 2000, 0)); !sameCrop(straight, corner, 1e-12) {
		t.Errorf("a zero rotation moved a corner crop to %+v", straight)
	}
	// Turn the frame five degrees and that same corner is off the image: the
	// diagonals the turn opens up leave nothing behind it.
	collapsed := insetFreeRotationCrop(corner, newFreeRotation(3000, 2000, 5))
	if collapsed.Width >= editMinCropFraction || collapsed.Height >= editMinCropFraction {
		t.Errorf("a corner crop at 5 degrees survived as %+v, so this test no longer describes the editor's fallback", collapsed)
	}
}

// The free rotation end to end, against real pixels. The crop is resolved
// against the box the turn produces, and every output pixel has to be opaque: a
// rotation that sampled past the frame would leave a hole, and PNG is the one
// editable format with an alpha channel to show it.
func TestRenderEditedImageFreeRotation(t *testing.T) {
	base, err := encodeEditedImage("png", newTestImage(64, 48))
	if err != nil {
		t.Fatalf("building the fixture failed: %v", err)
	}
	path := filepath.Join(t.TempDir(), "photo.png")
	if writeErr := os.WriteFile(path, base, 0o600); writeErr != nil {
		t.Fatalf("writing the fixture failed: %v", writeErr)
	}

	encoded, width, height, err := renderEditedImage(path, 1, "png", 0, 7.5, false, false, ImageCropRect{Width: 1, Height: 1})
	if err != nil {
		t.Fatalf("renderEditedImage returned %v", err)
	}
	// A 64x48 frame turned 7.5 degrees lands in a 70x56 box, and the largest
	// rectangle that fits inside it is 52x42. These are the numbers the editor
	// reports as its output size before saving.
	if width != 52 || height != 42 {
		t.Errorf("output size = %dx%d, want 52x42", width, height)
	}
	decoded, format, decodeErr := image.Decode(bytes.NewReader(encoded))
	if decodeErr != nil {
		t.Fatalf("the re-encoded PNG does not decode: %v", decodeErr)
	}
	if format != "png" {
		t.Errorf("re-encoded format = %q, want png", format)
	}
	if got := decoded.Bounds(); got.Dx() != 52 || got.Dy() != 42 {
		t.Errorf("decoded size = %dx%d, want 52x42", got.Dx(), got.Dy())
	}
	rows := tuplesOf(decoded)
	for y := range rows {
		for x := range rows[y] {
			if rows[y][x].A != 255 {
				t.Fatalf("pixel (%d,%d) came out with alpha %d: the rotation read past the frame", x, y, rows[y][x].A)
			}
		}
	}
	// A full-frame crop that is inset has to lose pixels; a turn that changed
	// nothing would mean the angle never reached the renderer.
	if width >= 64 || height >= 48 {
		t.Errorf("output %dx%d is not smaller than the source, so the turn did nothing", width, height)
	}
}
