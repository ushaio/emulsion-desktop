package local_library

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// TestRenderVideoPosterWithFFmpegLive runs the real poster extraction against
// a real video file. It is skipped unless both env vars are set, so CI (which
// has no ffmpeg and no sample media) stays green:
//
//	MO_GALLERY_FFMPEG_E2E=/path/to/emulsion-ffmpeg(.exe)
//	MO_GALLERY_FFMPEG_E2E_SOURCE=/path/to/video.mp4
func TestRenderVideoPosterWithFFmpegLive(t *testing.T) {
	ffmpeg := os.Getenv("MO_GALLERY_FFMPEG_E2E")
	source := os.Getenv("MO_GALLERY_FFMPEG_E2E_SOURCE")
	if ffmpeg == "" || source == "" {
		t.Skip("set MO_GALLERY_FFMPEG_E2E and MO_GALLERY_FFMPEG_E2E_SOURCE to run the live poster extraction")
	}
	destination := filepath.Join(t.TempDir(), "poster.jpg")
	if err := renderVideoPosterWithFFmpeg(context.Background(), ffmpeg, source, destination, 60000); err != nil {
		t.Fatalf("poster extraction failed: %v", err)
	}
	width, height, byteSize, err := inspectPosterFile(destination)
	if err != nil {
		t.Fatalf("poster inspection failed: %v", err)
	}
	if width <= 0 || height <= 0 || byteSize == 0 {
		t.Fatalf("unexpected poster geometry: %dx%d %d bytes", width, height, byteSize)
	}
	t.Logf("poster: %dx%d, %d bytes", width, height, byteSize)
}
