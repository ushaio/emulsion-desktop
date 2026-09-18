package local_library

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// TestRealHasselblad3FR is a live check against a real Hasselblad file, not a
// checked-in fixture: it only runs when MO_TEST_RAW_FILE points at one, and is
// skipped otherwise so the normal suite stays hermetic.
func TestRealHasselblad3FR(t *testing.T) {
	path := os.Getenv("MO_TEST_RAW_FILE")
	if path == "" {
		t.Skip("set MO_TEST_RAW_FILE to a real 3FR to run this check")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	t.Logf("file %s is %.2f MB", filepath.Base(path), float64(info.Size())/(1024*1024))

	result := inspectMedia(path, info)
	t.Logf("MediaKind=%q Format=%q MimeType=%q", result.MediaKind, result.Format, result.MimeType)
	t.Logf("PreviewStatus=%q PreviewError=%q MetadataStatus=%q", result.PreviewStatus, result.PreviewError, result.MetadataStatus)
	t.Logf("dimensions=%dx%d orientation=%d", result.Width, result.Height, result.Orientation)
	t.Logf("camera=%q model=%q lens=%q", result.EXIF.CameraMake, result.EXIF.CameraModel, result.EXIF.LensModel)
	if result.CapturedAt != nil {
		t.Logf("capturedAt=%s", result.CapturedAt.Format("2006-01-02 15:04:05"))
	}

	if result.MediaKind != "image" {
		t.Errorf("MediaKind = %q, want image", result.MediaKind)
	}
	if result.PreviewStatus == "unavailable" {
		t.Errorf("PreviewStatus = unavailable: %s", result.PreviewError)
	}
	if result.Width <= 0 || result.Height <= 0 {
		t.Errorf("dimensions = %dx%d, want a measured preview", result.Width, result.Height)
	}

	decoded, err := decodeImage(path)
	if err != nil {
		t.Fatalf("decodeImage: %v", err)
	}
	t.Logf("decoded image bounds = %v", decoded.Bounds())

	// The viewer path, exercised the way operations.go does it.
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("open for viewer: %v", err)
	}
	defer file.Close()
	preview, err := embeddedRAWPreviewWithValidator(context.Background(), file, validateOriginalViewDimensions)
	if err != nil {
		t.Fatalf("viewer extraction: %v", err)
	}
	t.Logf("viewer payload = %d bytes (%.2f MB)", len(preview), float64(len(preview))/(1024*1024))

	thumbnail := filepath.Join(t.TempDir(), "thumb.jpg")
	rendered, err := renderJPEGDerivative(context.Background(), path, thumbnail, thumbnailMaxDimension, result.Orientation)
	if err != nil {
		t.Fatalf("renderJPEGDerivative: %v", err)
	}
	t.Logf("thumbnail rendered %dx%d with %d colours", rendered.Width, rendered.Height, len(rendered.Colors))
	if len(rendered.Colors) == 0 {
		t.Error("thumbnail palette is empty: reconcile would requeue this asset forever")
	}
}
