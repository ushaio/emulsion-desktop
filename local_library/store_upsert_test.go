package local_library

import (
	"context"
	"os"
	"testing"
)

// openTestStore opens a store the way Manager.Create does: the internal
// .mo-gallery directory must exist before SQLite can create library.db.
func openTestStore(t *testing.T) *store {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(internalPath(root), 0o700); err != nil {
		t.Fatalf("create internal dir: %v", err)
	}
	store, err := openStoreWithMigration(root, nil, false)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

// The single-asset and batch upserts build their INSERT column lists by hand.
// A schema migration that adds a column must update the column list, the
// VALUES placeholders, and the argument list in lockstep; a mismatch only
// surfaces at runtime ("N values for M columns"). This test runs both write
// paths end-to-end against a real store so the SQLite binder catches it.
func TestUpsertAssetColumnCounts(t *testing.T) {
	store := openTestStore(t)

	ctx := context.Background()
	imageFile := indexedFile{
		ID: "test-image", RelativePath: "a.jpg", PathKey: "a.jpg", FolderPath: "",
		FileName: "a.jpg", Extension: ".jpg", Format: "jpeg", MimeType: "image/jpeg",
		MediaKind: "image", ByteSize: 10, ModifiedAtNS: 1, Orientation: 1, FrameCount: 1,
		PreviewStatus: "pending", MetadataStatus: "ready",
	}
	videoFile := indexedFile{
		ID: "test-video", RelativePath: "b.mp4", PathKey: "b.mp4", FolderPath: "",
		FileName: "b.mp4", Extension: ".mp4", Format: "mp4", MimeType: "video/mp4",
		MediaKind: "video", ByteSize: 20, ModifiedAtNS: 2, DurationMS: 1234, Orientation: 1, FrameCount: 1,
		PreviewStatus: "pending", MetadataStatus: "partial",
	}

	if _, _, err := store.upsertAsset(ctx, videoFile, "token-1"); err != nil {
		t.Fatalf("upsertAsset video insert: %v", err)
	}
	if _, _, err := store.upsertAsset(ctx, videoFile, "token-1"); err != nil {
		t.Fatalf("upsertAsset video update: %v", err)
	}
	if _, _, err := store.upsertAsset(ctx, imageFile, "token-1"); err != nil {
		t.Fatalf("upsertAsset image insert: %v", err)
	}

	if _, err := store.writeIndexedFiles(ctx, []indexedFile{videoFile, imageFile}, map[string]*string{"": nil}, "token-2"); err != nil {
		t.Fatalf("writeIndexedFiles: %v", err)
	}

	var mediaKind string
	var durationMS int64
	if err := store.db.QueryRowContext(ctx, `SELECT media_kind,duration_ms FROM assets WHERE path_key='b.mp4'`).Scan(&mediaKind, &durationMS); err != nil {
		t.Fatalf("read back video row: %v", err)
	}
	if mediaKind != "video" || durationMS != 1234 {
		t.Fatalf("video row = (%s, %d), want (video, 1234)", mediaKind, durationMS)
	}
}

// reportAssetMediaMetadata backfills the duration the frontend player
// observes; verify it only changes the stored values when they differ.
func TestReportAssetMediaMetadata(t *testing.T) {
	store := openTestStore(t)

	ctx := context.Background()
	file := indexedFile{
		RelativePath: "a.mp3", PathKey: "a.mp3", FolderPath: "",
		FileName: "a.mp3", Extension: ".mp3", Format: "mp3", MimeType: "audio/mpeg",
		MediaKind: "audio", ByteSize: 30, ModifiedAtNS: 3, Orientation: 1, FrameCount: 1,
		PreviewStatus: "pending", MetadataStatus: "partial",
	}
	assetID, _, err := store.upsertAsset(ctx, file, "token")
	if err != nil {
		t.Fatalf("upsertAsset: %v", err)
	}

	if err := store.reportAssetMediaMetadata(ctx, assetID, 61000, 0, 0); err != nil {
		t.Fatalf("report metadata: %v", err)
	}
	var durationMS int64
	if err := store.db.QueryRowContext(ctx, `SELECT duration_ms FROM assets WHERE id=?`, assetID).Scan(&durationMS); err != nil {
		t.Fatalf("read back duration: %v", err)
	}
	if durationMS != 61000 {
		t.Fatalf("duration_ms = %d, want 61000", durationMS)
	}
	// Reporting the same values again is a no-op, not an error.
	if err := store.reportAssetMediaMetadata(ctx, assetID, 61000, 0, 0); err != nil {
		t.Fatalf("idempotent report: %v", err)
	}
}
