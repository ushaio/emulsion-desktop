package local_library

import (
	"os"
	"testing"
)

// TestParseMP4DurationLive checks the Go-side duration parser against real
// drone files. Skipped without the env var.
//
//	MO_GALLERY_FFMPEG_E2E_SOURCE=/path/to/video.mp4
func TestParseMP4DurationLive(t *testing.T) {
	source := os.Getenv("MO_GALLERY_FFMPEG_E2E_SOURCE")
	if source == "" {
		t.Skip("set MO_GALLERY_FFMPEG_E2E_SOURCE to run the live duration parse")
	}
	duration, err := parseMP4Duration(source)
	if err != nil {
		t.Fatalf("parseMP4Duration failed: %v", err)
	}
	t.Logf("duration: %d ms (%.1f min)", duration, float64(duration)/60000)
}
