package local_library

import (
	"context"
	"testing"
)

// The palette backfill lives entirely in SQL that is only bound at runtime, so
// neither the compiler nor `go vet` would catch a broken condition. This walks
// the real write path: an asset carrying a v0 card must come back from the
// pending queue, and once its card is rewritten at the current version it must
// stay out of it.
func TestDominantColorsVersionBackfill(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	file := indexedFile{
		RelativePath: "a.jpg", PathKey: "a.jpg", FolderPath: "",
		FileName: "a.jpg", Extension: ".jpg", Format: "jpeg", MimeType: "image/jpeg",
		MediaKind: "image", ByteSize: 10, ModifiedAtNS: 1, Orientation: 1, FrameCount: 1,
		PreviewStatus: "pending", MetadataStatus: "ready",
	}
	assetID, _, err := store.upsertAsset(ctx, file, "token-1")
	if err != nil {
		t.Fatalf("upsertAsset: %v", err)
	}

	// Pretend an older build already warmed this asset: a ready preview with a
	// card stored at the pre-versioning default.
	if _, err := store.db.ExecContext(ctx,
		`UPDATE assets SET preview_status='ready', dominant_colors=?, dominant_colors_version=0 WHERE id=?`,
		`["#202c45","#1c3926"]`, assetID); err != nil {
		t.Fatalf("seed stale card: %v", err)
	}

	pending, err := store.pendingThumbnailAssets(ctx, true)
	if err != nil {
		t.Fatalf("pendingThumbnailAssets: %v", err)
	}
	if len(pending) != 1 || pending[0].ID != assetID {
		t.Fatalf("stale card was not queued for re-extraction: %d pending", len(pending))
	}

	if err := store.setPreviewResults(ctx, []previewWrite{{
		ID: assetID, Status: "ready", Colors: []string{"#f7ca4a", "#e8813a"}, SetColors: true,
	}}); err != nil {
		t.Fatalf("setPreviewResults: %v", err)
	}

	pending, err = store.pendingThumbnailAssets(ctx, true)
	if err != nil {
		t.Fatalf("pendingThumbnailAssets after rewrite: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("asset re-queued after backfill: %d pending, the card would be rebuilt on every scan", len(pending))
	}

	var colors string
	var version int
	if err := store.db.QueryRowContext(ctx, `SELECT dominant_colors,dominant_colors_version FROM assets WHERE id=?`, assetID).
		Scan(&colors, &version); err != nil {
		t.Fatalf("read back row: %v", err)
	}
	if version != dominantColorVersion {
		t.Errorf("dominant_colors_version = %d, want %d", version, dominantColorVersion)
	}
	if colors != `["#f7ca4a","#e8813a"]` {
		t.Errorf("dominant_colors = %s", colors)
	}
}

// An asset that can never yield a palette must not be dragged into the queue by
// the backfill clause; otherwise every scan would retry it forever.
func TestDominantColorsVersionIgnoresAssetsWithoutACard(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	file := indexedFile{
		RelativePath: "b.jpg", PathKey: "b.jpg", FolderPath: "",
		FileName: "b.jpg", Extension: ".jpg", Format: "jpeg", MimeType: "image/jpeg",
		MediaKind: "image", ByteSize: 10, ModifiedAtNS: 1, Orientation: 1, FrameCount: 1,
		PreviewStatus: "failed", MetadataStatus: "ready",
	}
	if _, _, err := store.upsertAsset(ctx, file, "token-1"); err != nil {
		t.Fatalf("upsertAsset: %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE assets SET preview_status='failed', dominant_colors='[]' WHERE path_key='b.jpg'`); err != nil {
		t.Fatalf("seed empty card: %v", err)
	}
	pending, err := store.pendingThumbnailAssets(ctx, true)
	if err != nil {
		t.Fatalf("pendingThumbnailAssets: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("asset without a card was queued: %d pending", len(pending))
	}
}
