package local_library

import (
	"bytes"
	"context"
	"fmt"
	"image/jpeg"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"time"
)

// Video posters have two producers. The primary one runs in Go through the
// bundled ffmpeg (renderVideoPosterWithFFmpeg, wired into the derivative
// pipeline), which keeps video decode out of the WebView entirely — the
// renderer process used to crash on HEVC/4K drone footage when the frontend
// decoded posters on canvas. The frontend canvas capture (POST to the handler
// below) remains as a fallback for installs without a usable ffmpeg, and only
// ever handles small H.264 files.

// maxPosterUploadBytes bounds the uploaded poster frame. The frontend caps
// captures at thumbnail resolution, so anything larger is a client bug.
const maxPosterUploadBytes = 8 * 1024 * 1024

func (m *Manager) handleAssetPosterUpload(w http.ResponseWriter, r *http.Request, id AssetID) {
	session, err := m.requireAvailableSession()
	if err != nil || session.sessionID != r.URL.Query().Get("session") || session.ctx.Err() != nil {
		http.Error(w, "asset unavailable", http.StatusNotFound)
		return
	}
	if !isOpaqueID(string(id)) {
		http.Error(w, "asset unavailable", http.StatusNotFound)
		return
	}
	mediaKind, kindErr := session.store.assetMediaKind(r.Context(), id)
	if kindErr != nil || mediaKind != "video" {
		http.Error(w, "poster not applicable", http.StatusNotFound)
		return
	}
	body := http.MaxBytesReader(w, r.Body, maxPosterUploadBytes)
	payload, readErr := io.ReadAll(body)
	if readErr != nil {
		http.Error(w, "poster payload too large or unreadable", http.StatusBadRequest)
		return
	}
	config, decodeErr := jpeg.DecodeConfig(bytes.NewReader(payload))
	if decodeErr != nil || config.Width <= 0 || config.Height <= 0 {
		http.Error(w, "poster must be a JPEG frame", http.StatusBadRequest)
		return
	}
	source, sourceErr := session.store.derivativeSource(r.Context(), id)
	if sourceErr != nil || source.Availability != "active" {
		http.Error(w, "asset unavailable", http.StatusNotFound)
		return
	}
	cacheKey := derivativeCacheKey(id, source.ModifiedAtNS, source.ByteSize, derivativeThumbnail)
	destination := derivativePath(session.root, id, derivativeThumbnail, cacheKey)
	if err := writePosterFile(destination, payload); err != nil {
		http.Error(w, "store poster failed", http.StatusInternalServerError)
		return
	}
	ctx := r.Context()
	if err := session.store.setDerivativeResult(ctx, id, derivativeThumbnail, cacheKey, thumbnailMaxDimension, config.Width, config.Height, int64(len(payload)), "ready", ""); err != nil {
		http.Error(w, "record poster failed", http.StatusInternalServerError)
		return
	}
	if err := session.store.setPreviewResult(ctx, id, "ready", ""); err != nil {
		http.Error(w, "record poster failed", http.StatusInternalServerError)
		return
	}
	// Drop posters from earlier versions of the file; the fresh cache key is
	// the only one that can be served.
	removeStaleDerivativeFiles(session.root, id, derivativeThumbnail, destination)
	m.emitPreviewStatus(session, id, "ready")
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(`{"status":"ready"}`))
}

// ffmpegPosterSem bounds concurrent ffmpeg poster extractions: the bundled
// binary decodes in software, so a scan over a drone folder must not multiply
// that across every derivative worker.
var ffmpegPosterSem = make(chan struct{}, 2)

const ffmpegPosterTimeout = 45 * time.Second

// renderVideoPosterWithFFmpeg extracts one frame with ffmpeg and writes it to
// destination atomically. Input seeking (-ss before -i) jumps by keyframe, so
// the cost is independent of file size. The frame lands at min(1s, duration/3)
// — the same spot the frontend fallback uses — to skip black opening frames.
func renderVideoPosterWithFFmpeg(ctx context.Context, ffmpeg, sourcePath, destination string, durationMS int64) error {
	select {
	case ffmpegPosterSem <- struct{}{}:
		defer func() { <-ffmpegPosterSem }()
	case <-ctx.Done():
		return ctx.Err()
	}
	seek := 0.0
	if durationMS > 0 {
		seek = float64(durationMS) / 3000.0
		if seek > 1.0 {
			seek = 1.0
		}
	}
	temp := destination + ".tmp-" + newID()
	runCtx, cancel := context.WithTimeout(ctx, ffmpegPosterTimeout)
	defer cancel()
	args := []string{
		"-hide_banner", "-loglevel", "error", "-nostdin",
		"-ss", strconv.FormatFloat(seek, 'f', 3, 64),
		"-i", sourcePath,
		"-frames:v", "1",
		"-vf", "scale='min(512,iw)':'min(512,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
		"-q:v", "4", "-f", "image2", "-y", temp,
	}
	if err := exec.CommandContext(runCtx, ffmpeg, args...).Run(); err != nil {
		_ = os.Remove(temp)
		if runCtx.Err() != nil {
			return fmt.Errorf("poster extraction timed out")
		}
		return fmt.Errorf("ffmpeg poster extraction failed: %w", err)
	}
	info, statErr := os.Stat(temp)
	if statErr != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		_ = os.Remove(temp)
		return fmt.Errorf("poster extraction produced no output")
	}
	_ = os.Chtimes(temp, time.Now(), time.Now())
	if err := os.Rename(temp, destination); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return nil
}

// inspectPosterFile reads the dimensions of a rendered poster for the
// derivative bookkeeping. Posters carry no dominant colours, matching what
// the frontend poster upload records.
func inspectPosterFile(path string) (width, height int, byteSize int64, err error) {
	file, openErr := os.Open(path)
	if openErr != nil {
		return 0, 0, 0, openErr
	}
	defer file.Close()
	config, decodeErr := jpeg.DecodeConfig(file)
	if decodeErr != nil || config.Width <= 0 || config.Height <= 0 {
		return 0, 0, 0, fmt.Errorf("poster is not a decodable JPEG")
	}
	info, statErr := file.Stat()
	if statErr != nil {
		return 0, 0, 0, statErr
	}
	return config.Width, config.Height, info.Size(), nil
}

// writePosterFile stores the frame atomically so a concurrent thumbnail
// request never observes a half-written JPEG.
func writePosterFile(destination string, payload []byte) error {
	if err := os.MkdirAll(dirOfFile(destination), 0o700); err != nil {
		return err
	}
	temp := destination + ".tmp-" + newID()
	out, err := os.Create(temp)
	if err != nil {
		return err
	}
	if _, err := out.Write(payload); err != nil {
		_ = out.Close()
		_ = os.Remove(temp)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(temp)
		return err
	}
	if err := os.Chtimes(temp, time.Now(), time.Now()); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return os.Rename(temp, destination)
}

func dirOfFile(path string) string {
	dir := path
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' || path[i] == '\\' {
			dir = path[:i]
			break
		}
	}
	return dir
}
