package local_library

import (
	"context"
	"image"
	"image/color"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/image/bmp"
)

// BMP is indexed as a still image: it carries no EXIF, so metadata is ready as
// soon as the pixel dimensions decode. Go's standard library has no BMP
// decoder, so this only works through the explicit codec wiring in decodeImage
// and decodeMediaConfigReaderContext.
func TestInspectMediaIndexesBMP(t *testing.T) {
	const width, height = 37, 19
	cases := []struct {
		name  string
		file  string
		patch func([]byte)
	}{
		{name: "BITMAPINFOHEADER", file: "sample.bmp"},
		// Some encoders leave junk in BITMAPFILEHEADER's reserved fields, which
		// is why the codec is called directly instead of through image.Decode:
		// its registered magic ("BM????\x00\x00\x00\x00") requires them to be
		// zeroed.
		{name: "reserved field is not zeroed", file: "junk.bmp", patch: func(data []byte) {
			copy(data[6:10], []byte{0xde, 0xad, 0xbe, 0xef})
		}},
		// The extension is lower-cased before the format is looked up, but the
		// header sniff must not depend on the extension at all.
		{name: "upper case extension", file: "SHOUT.BMP"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			path := writeBMPFixture(t, testCase.file, width, height, testCase.patch)
			info, err := os.Stat(path)
			if err != nil {
				t.Fatalf("stat %s: %v", path, err)
			}
			result := inspectMedia(path, info)
			if result.MediaKind != "image" {
				t.Errorf("MediaKind = %q, want image", result.MediaKind)
			}
			if result.Format != "bmp" || result.MimeType != "image/bmp" {
				t.Errorf("Format/MimeType = %q/%q, want bmp/image/bmp", result.Format, result.MimeType)
			}
			if result.Width != width || result.Height != height {
				t.Errorf("dimensions = %dx%d, want %dx%d", result.Width, result.Height, width, height)
			}
			if result.PreviewStatus != "pending" || result.MetadataStatus != "ready" {
				t.Errorf("PreviewStatus/MetadataStatus = %q/%q, want pending/ready (error %q)",
					result.PreviewStatus, result.MetadataStatus, result.PreviewError)
			}
			if result.Orientation != 1 {
				t.Errorf("Orientation = %d, want 1: BMP carries no orientation tag", result.Orientation)
			}

			decoded, err := decodeImage(path)
			if err != nil {
				t.Fatalf("decodeImage: %v", err)
			}
			if bounds := decoded.Bounds(); bounds.Dx() != width || bounds.Dy() != height {
				t.Errorf("decoded bounds = %v, want %dx%d", bounds, width, height)
			}

			// The grid tile goes through the same decode. Its palette also has
			// to be non-empty, or reconcile.go never considers the asset
			// finished and queues it again forever.
			thumbnail := filepath.Join(filepath.Dir(path), "thumb.jpg")
			rendered, err := renderJPEGDerivative(context.Background(), path, thumbnail, thumbnailMaxDimension, 1)
			if err != nil {
				t.Fatalf("renderJPEGDerivative: %v", err)
			}
			if rendered.Width != width || rendered.Height != height {
				t.Errorf("rendered thumbnail source = %dx%d, want %dx%d", rendered.Width, rendered.Height, width, height)
			}
			if len(rendered.Colors) == 0 {
				t.Error("rendered thumbnail palette is empty")
			}
		})
	}
}

// The format tables, the header sniff and the editable-format contract all have
// to agree on BMP, because each one is a separate list.
func TestFormatTablesCoverBMP(t *testing.T) {
	if !isSupportedMedia("photo.BMP") {
		t.Error("isSupportedMedia rejected .BMP; the extension lookup is case-insensitive")
	}
	format, mimeType := formatForExtension(".bmp")
	if format != "bmp" || mimeType != "image/bmp" {
		t.Errorf("formatForExtension(.bmp) = %q/%q, want bmp/image/bmp", format, mimeType)
	}
	if format, mimeType = formatAndMIME("bmp"); format != "bmp" || mimeType != "image/bmp" {
		t.Errorf("formatAndMIME(bmp) = %q/%q, want bmp/image/bmp", format, mimeType)
	}
	if !isBMPHeader([]byte("BM\x00\x00\x00\x00\x00\x00\x00\x00\x36\x00\x00\x00\x28\x00\x00\x00")) {
		t.Error("isBMPHeader rejected a BITMAPINFOHEADER file")
	}
	if isBMPHeader([]byte("BM\x00\x00\x00\x00\x00\x00\x00\x00\x36\x00\x00\x00\x2a\x00\x00\x00")) {
		t.Error("isBMPHeader accepted a DIB header length the decoder cannot read")
	}
	if isBMPHeader([]byte("BM")) {
		t.Error("isBMPHeader accepted a truncated header")
	}
	if _, ok := editableImageFormat("bmp"); ok {
		t.Error("editableImageFormat(bmp) reported an editable format; BMP is indexed but not editable")
	}
}

// writeBMPFixture encodes a BMP and applies patch to the raw bytes, so a test
// can break a field the encoder always writes correctly.
func writeBMPFixture(t *testing.T, name string, width, height int, patch func([]byte)) string {
	t.Helper()
	source := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			source.Set(x, y, color.RGBA{R: uint8(x * 5), G: uint8(y * 11), B: 0x40, A: 0xFF})
		}
	}
	path := filepath.Join(t.TempDir(), name)
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("create %s: %v", path, err)
	}
	if err := bmp.Encode(file, source); err != nil {
		_ = file.Close()
		t.Fatalf("encode BMP: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close %s: %v", path, err)
	}
	if patch == nil {
		return path
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	patch(data)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("rewrite %s: %v", path, err)
	}
	return path
}
