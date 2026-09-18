package local_library

import (
	"context"
	"os"
	"strconv"
	"testing"
)

// M016 reclassifies BMP rows on open, the way M015 did video and audio, so a
// library indexed before BMP had a decoder shows those files as images without
// waiting for a scan — and so the thumbnail repair actions, which select on
// media_kind, can see them at all. The migration is gated on schema_version, so
// it only runs for a library written by an older build; the test rewinds that
// version to reproduce the upgrade.
func TestM016ReclassifiesBMPRowsOnOpen(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(internalPath(root), 0o700); err != nil {
		t.Fatalf("create internal dir: %v", err)
	}
	ctx := context.Background()

	store, err := openStoreWithMigration(root, nil, false)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	seeded := []indexedFile{
		{
			ID: "bmp", RelativePath: "photo.bmp", PathKey: "photo.bmp", FileName: "photo.bmp",
			Extension: ".bmp", Format: "bmp", MimeType: "image/bmp", MediaKind: "file",
			ByteSize: 10, ModifiedAtNS: 1, Orientation: 1, FrameCount: 1,
			PreviewStatus: "unavailable", PreviewError: "no decoder is available for this file type",
			MetadataStatus: "unavailable",
		},
		{
			ID: "txt", RelativePath: "notes.txt", PathKey: "notes.txt", FileName: "notes.txt",
			Extension: ".txt", Format: "txt", MimeType: "text/plain", MediaKind: "file",
			ByteSize: 20, ModifiedAtNS: 2, Orientation: 1, FrameCount: 1,
			PreviewStatus: "unavailable", MetadataStatus: "unavailable",
		},
	}
	for _, file := range seeded {
		if _, _, err := store.upsertAsset(ctx, file, "token-0"); err != nil {
			t.Fatalf("seed %s: %v", file.PathKey, err)
		}
	}
	// Rewind to the previous version: the migration only runs for a library
	// written by an older build.
	if _, err := store.db.ExecContext(ctx, `UPDATE library_meta SET value='15' WHERE key='schema_version'`); err != nil {
		t.Fatalf("rewind schema version: %v", err)
	}
	store.Close()

	reopened, err := openStoreWithMigration(root, nil, false)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	defer reopened.Close()

	var mediaKind, previewStatus, previewError, metadataStatus string
	if err := reopened.db.QueryRowContext(ctx,
		`SELECT media_kind,preview_status,preview_error,metadata_status FROM assets WHERE path_key='photo.bmp'`).
		Scan(&mediaKind, &previewStatus, &previewError, &metadataStatus); err != nil {
		t.Fatalf("read back the reclassified row: %v", err)
	}
	if mediaKind != "image" {
		t.Errorf("media_kind = %q, want image", mediaKind)
	}
	if previewStatus != "pending" {
		t.Errorf("preview_status = %q, want pending, so the thumbnail is queued", previewStatus)
	}
	if previewError != "" {
		t.Errorf("preview_error = %q, want empty: the row still claims no decoder exists", previewError)
	}
	if metadataStatus != "partial" {
		t.Errorf("metadata_status = %q, want partial until an inspect measures the file", metadataStatus)
	}

	// Whatever the library still cannot read keeps its placeholder.
	var untouched string
	if err := reopened.db.QueryRowContext(ctx, `SELECT media_kind FROM assets WHERE path_key='notes.txt'`).Scan(&untouched); err != nil {
		t.Fatalf("read back notes.txt: %v", err)
	}
	if untouched != "file" {
		t.Errorf("notes.txt media_kind = %q, want file", untouched)
	}

	var version string
	if err := reopened.db.QueryRowContext(ctx, `SELECT value FROM library_meta WHERE key='schema_version'`).Scan(&version); err != nil {
		t.Fatalf("read schema version: %v", err)
	}
	if version != strconv.Itoa(currentSchemaVersion) {
		t.Errorf("schema_version = %q, want %d", version, currentSchemaVersion)
	}
}

// M017 reclassifies 3FR rows on open for the same reason M016 reclassified BMP:
// the kind is what the grid, the filters and the thumbnail repair actions select
// against, and a file whose size and mtime never change is not inspected again,
// so a row left as 'file' would stay a thumbnail-less placeholder forever.
func TestM017Reclassifies3FRRowsOnOpen(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(internalPath(root), 0o700); err != nil {
		t.Fatalf("create internal dir: %v", err)
	}
	ctx := context.Background()

	store, err := openStoreWithMigration(root, nil, false)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	seeded := []indexedFile{
		{
			ID: "3fr", RelativePath: "shot.3fr", PathKey: "shot.3fr", FileName: "shot.3fr",
			Extension: ".3fr", Format: "3fr", MimeType: "image/x-hasselblad-3fr", MediaKind: "file",
			ByteSize: 10, ModifiedAtNS: 1, Orientation: 1, FrameCount: 1,
			PreviewStatus: "unavailable", PreviewError: "no decoder is available for this file type",
			MetadataStatus: "unavailable",
		},
		{
			ID: "raf", RelativePath: "other.raf", PathKey: "other.raf", FileName: "other.raf",
			Extension: ".raf", Format: "raf", MimeType: "image/x-fuji-raf", MediaKind: "file",
			ByteSize: 30, ModifiedAtNS: 3, Orientation: 1, FrameCount: 1,
			PreviewStatus: "unavailable", MetadataStatus: "unavailable",
		},
	}
	for _, file := range seeded {
		if _, _, err := store.upsertAsset(ctx, file, "token-0"); err != nil {
			t.Fatalf("seed %s: %v", file.PathKey, err)
		}
	}
	// Rewind to the version before M017: the migration only runs for a library
	// written by an older build.
	if _, err := store.db.ExecContext(ctx, `UPDATE library_meta SET value='16' WHERE key='schema_version'`); err != nil {
		t.Fatalf("rewind schema version: %v", err)
	}
	store.Close()

	reopened, err := openStoreWithMigration(root, nil, false)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	defer reopened.Close()

	var mediaKind, previewStatus, previewError, metadataStatus string
	if err := reopened.db.QueryRowContext(ctx,
		`SELECT media_kind,preview_status,preview_error,metadata_status FROM assets WHERE path_key='shot.3fr'`).
		Scan(&mediaKind, &previewStatus, &previewError, &metadataStatus); err != nil {
		t.Fatalf("read back the reclassified row: %v", err)
	}
	if mediaKind != "image" {
		t.Errorf("media_kind = %q, want image", mediaKind)
	}
	if previewStatus != "pending" {
		t.Errorf("preview_status = %q, want pending, so the thumbnail is queued", previewStatus)
	}
	if previewError != "" {
		t.Errorf("preview_error = %q, want empty: the row still claims no decoder exists", previewError)
	}
	if metadataStatus != "partial" {
		t.Errorf("metadata_status = %q, want partial until an inspect measures the file", metadataStatus)
	}

	// The migration is scoped to the format that gained a decoder: a RAW the
	// library already read keeps whatever the previous scan recorded.
	var rafKind string
	if err := reopened.db.QueryRowContext(ctx, `SELECT media_kind FROM assets WHERE path_key='other.raf'`).Scan(&rafKind); err != nil {
		t.Fatalf("read back other.raf: %v", err)
	}
	if rafKind != "file" {
		t.Errorf("other.raf media_kind = %q, want file: M017 only reclassifies 3FR", rafKind)
	}

	var version string
	if err := reopened.db.QueryRowContext(ctx, `SELECT value FROM library_meta WHERE key='schema_version'`).Scan(&version); err != nil {
		t.Fatalf("read schema version: %v", err)
	}
	if version != strconv.Itoa(currentSchemaVersion) {
		t.Errorf("schema_version = %q, want %d", version, currentSchemaVersion)
	}
}

// M018 requeues the RAW previews the old blind-scan extractor gave up on. Such a
// row is worse than a plain failure: it already has a terminal preview_status and
// the scan treats a sized, terminally-failed row as up to date, so fixing the
// extractor alone would never revisit it. The migration is what lets the fix
// reach the files that are already in the index.
func TestM018RequeuesPreviewsThatExceededTheScanLimit(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(internalPath(root), 0o700); err != nil {
		t.Fatalf("create internal dir: %v", err)
	}
	ctx := context.Background()

	store, err := openStoreWithMigration(root, nil, false)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	// The shape the old extractor left behind: indexed as an image, failed, and
	// with no dimensions.
	seeded := []indexedFile{
		{
			ID: "scan-limited", RelativePath: "shot.3fr", PathKey: "shot.3fr", FileName: "shot.3fr",
			Extension: ".3fr", Format: "3fr", MimeType: "image/x-hasselblad-3fr", MediaKind: "image",
			ByteSize: 212373504, ModifiedAtNS: 1, Orientation: 1, FrameCount: 1,
			PreviewStatus: "unavailable", PreviewError: "decode metadata: RAW exceeds preview scan limit",
			MetadataStatus: "partial",
		},
		{
			ID: "genuinely-broken", RelativePath: "broken.nef", PathKey: "broken.nef", FileName: "broken.nef",
			Extension: ".nef", Format: "nef", MimeType: "image/x-nikon-nef", MediaKind: "image",
			ByteSize: 40, ModifiedAtNS: 2, Orientation: 1, FrameCount: 1,
			PreviewStatus: "unavailable", PreviewError: "decode metadata: RAW contains no decodable embedded JPEG preview",
			MetadataStatus: "partial",
		},
		{
			ID: "already-fine", RelativePath: "good.jpg", PathKey: "good.jpg", FileName: "good.jpg",
			Extension: ".jpg", Format: "jpeg", MimeType: "image/jpeg", MediaKind: "image",
			ByteSize: 50, ModifiedAtNS: 3, Orientation: 1, FrameCount: 1,
			PreviewStatus: "ready", MetadataStatus: "ready",
		},
	}
	for _, file := range seeded {
		if _, _, err := store.upsertAsset(ctx, file, "token-0"); err != nil {
			t.Fatalf("seed %s: %v", file.PathKey, err)
		}
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE library_meta SET value='17' WHERE key='schema_version'`); err != nil {
		t.Fatalf("rewind schema version: %v", err)
	}
	store.Close()

	reopened, err := openStoreWithMigration(root, nil, false)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	defer reopened.Close()

	// The requeued row: pending, so both the scan's unmeasured-image rule and
	// needsThumbnail pick it up, and the stale error is gone so the UI stops
	// showing a reason that no longer applies.
	var previewStatus, previewError, metadataStatus string
	if err := reopened.db.QueryRowContext(ctx,
		`SELECT preview_status,preview_error,metadata_status FROM assets WHERE path_key='shot.3fr'`).
		Scan(&previewStatus, &previewError, &metadataStatus); err != nil {
		t.Fatalf("read back the requeued row: %v", err)
	}
	if previewStatus != "pending" {
		t.Errorf("preview_status = %q, want pending so the file is inspected again", previewStatus)
	}
	if previewError != "" {
		t.Errorf("preview_error = %q, want empty: the old scan-limit reason no longer applies", previewError)
	}
	if metadataStatus != "partial" {
		t.Errorf("metadata_status = %q, want partial until an inspect measures the file", metadataStatus)
	}

	// A RAW that failed for a reason the extractor never had is left alone: this
	// migration is scoped to one failure message, not to every unavailable RAW.
	var brokenStatus, brokenError string
	if err := reopened.db.QueryRowContext(ctx,
		`SELECT preview_status,preview_error FROM assets WHERE path_key='broken.nef'`).
		Scan(&brokenStatus, &brokenError); err != nil {
		t.Fatalf("read back broken.nef: %v", err)
	}
	if brokenStatus != "unavailable" || brokenError == "" {
		t.Errorf("broken.nef = %q/%q, want its original unavailable state", brokenStatus, brokenError)
	}

	// A healthy asset is untouched.
	var goodStatus string
	if err := reopened.db.QueryRowContext(ctx, `SELECT preview_status FROM assets WHERE path_key='good.jpg'`).Scan(&goodStatus); err != nil {
		t.Fatalf("read back good.jpg: %v", err)
	}
	if goodStatus != "ready" {
		t.Errorf("good.jpg preview_status = %q, want ready", goodStatus)
	}

	var version string
	if err := reopened.db.QueryRowContext(ctx, `SELECT value FROM library_meta WHERE key='schema_version'`).Scan(&version); err != nil {
		t.Fatalf("read schema version: %v", err)
	}
	if version != strconv.Itoa(currentSchemaVersion) {
		t.Errorf("schema_version = %q, want %d", version, currentSchemaVersion)
	}
}
