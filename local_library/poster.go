package local_library

import (
	"bytes"
	"image/jpeg"
	"io"
	"net/http"
	"os"
	"time"
)

// The library cannot decode video frames in Go, so video thumbnails come from
// the frontend: the player captures one frame with a canvas and uploads it as
// a JPEG to POST /__local-library/poster/<id>?session=... The bytes land in
// the regular derivative thumbnail cache so the grid serves them like any
// other thumbnail.

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
