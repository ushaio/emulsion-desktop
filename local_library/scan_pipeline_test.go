package local_library

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// A row can be stale about the file it describes — indexed by a revision that
// did not read this format, or reclassified by a data migration that could not
// measure the file. Size and mtime agree either way, so the diff would otherwise
// park it on the fast path forever. It has to be re-inspected once — and only
// those rows: re-inspecting everything the library cannot read would defeat the
// whole point of the diff.
func TestClassifyScanEntriesReinspectsStaleRows(t *testing.T) {
	entries := []scanFileEntry{
		{Relative: "legacy.bmp", PathKey: "legacy.bmp", Absolute: filepath.Join("library", "legacy.bmp"), Size: 10, ModNS: 1},
		{Relative: "migrated.bmp", PathKey: "migrated.bmp", Absolute: filepath.Join("library", "migrated.bmp"), Size: 20, ModNS: 2},
		{Relative: "unreadable.bmp", PathKey: "unreadable.bmp", Absolute: filepath.Join("library", "unreadable.bmp"), Size: 30, ModNS: 3},
		{Relative: "current.bmp", PathKey: "current.bmp", Absolute: filepath.Join("library", "current.bmp"), Size: 40, ModNS: 4},
		{Relative: "notes.txt", PathKey: "notes.txt", Absolute: filepath.Join("library", "notes.txt"), Size: 50, ModNS: 5},
	}
	snapshot := map[string]assetIndexRow{
		// Indexed before BMP had a decoder.
		"legacy.bmp": {ID: "legacy", Availability: "active", ByteSize: 10, ModifiedAtNS: 1, MediaKind: "file", PreviewStatus: "unavailable"},
		// What the M016/M017 reclassify leaves behind: the right kind, no dimensions.
		"migrated.bmp": {ID: "migrated", Availability: "active", ByteSize: 20, ModifiedAtNS: 2, MediaKind: "image", PreviewStatus: "pending"},
		// A decode that already failed records width 0 too, and must not be
		// re-decoded on every single scan.
		"unreadable.bmp": {ID: "unreadable", Availability: "active", ByteSize: 30, ModifiedAtNS: 3, MediaKind: "image", PreviewStatus: "unavailable"},
		// Measured and ready: nothing to do.
		"current.bmp": {ID: "current", Availability: "active", ByteSize: 40, ModifiedAtNS: 4, MediaKind: "image", PreviewStatus: "ready", Width: 800, HasColors: true},
		// Not a format the library reads at all.
		"notes.txt": {ID: "notes", Availability: "active", ByteSize: 50, ModifiedAtNS: 5, MediaKind: "file", PreviewStatus: "unavailable"},
	}

	classification := classifyScanEntries(entries, snapshot)
	changed := make(map[string]bool, len(classification.Changed))
	for _, entry := range classification.Changed {
		changed[entry.PathKey] = true
	}
	if !changed["legacy.bmp"] {
		t.Error("a file whose stored media_kind predates its format's decoder was left on the fast path")
	}
	if !changed["migrated.bmp"] {
		t.Error("a reclassified row with no dimensions was left on the fast path, so it would never be measured")
	}
	if changed["unreadable.bmp"] {
		t.Error("an image whose decode already failed was re-inspected again; a corrupt file must not be decoded on every scan")
	}
	if changed["current.bmp"] {
		t.Error("an already measured image was re-inspected for no reason")
	}
	if changed["notes.txt"] {
		t.Error("an unsupported extension was re-inspected; the backfill must stay limited to extensions the library reads")
	}
	if classification.UnchangedHit != 3 {
		t.Errorf("UnchangedHit = %d, want 3", classification.UnchangedHit)
	}
	if len(classification.Thumbnails) != 0 {
		t.Errorf("Thumbnails = %v, want none: a re-inspected file queues its thumbnail from the write result", classification.Thumbnails)
	}
}

// The whole backfill against a real store and a real BMP on disk: a row written
// before BMP had a decoder is classified as changed, re-inspected, rewritten as
// an image with a pending preview, and the next scan leaves it alone. This is
// the path a library indexed before the format existed takes — there is no
// manual step, activating the library runs this scan.
func TestScanBackfillsABMPIndexedBeforeItsFormatWasSupported(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	const width, height = 37, 19
	path := writeBMPFixture(t, "legacy.bmp", width, height, nil)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	entry := scanFileEntry{
		Relative: "legacy.bmp", PathKey: "legacy.bmp", Absolute: path,
		Size: info.Size(), ModNS: info.ModTime().UnixNano(),
	}

	// What the index holds today: every column inspectMedia would fill in is
	// absent, because BMP was an opaque "file" when this row was written.
	stale := indexedFile{
		ID: "stale-bmp", RelativePath: "legacy.bmp", PathKey: "legacy.bmp", FolderPath: "",
		FileName: "legacy.bmp", Extension: ".bmp", Format: "bmp", MimeType: "image/bmp",
		MediaKind: "file", ByteSize: info.Size(), ModifiedAtNS: info.ModTime().UnixNano(),
		Orientation: 1, FrameCount: 1, PreviewStatus: "unavailable", MetadataStatus: "unavailable",
	}
	if _, _, err := store.upsertAsset(ctx, stale, "token-0"); err != nil {
		t.Fatalf("seeding the stale row: %v", err)
	}
	snapshot, err := store.indexSnapshot(ctx)
	if err != nil {
		t.Fatalf("indexSnapshot: %v", err)
	}
	seeded, ok := snapshot[entry.PathKey]
	if !ok {
		t.Fatal("the seeded row is missing from the index snapshot")
	}
	if seeded.Availability != "active" || seeded.MediaKind != "file" {
		t.Fatalf("seeded row = (availability %q, media_kind %q), want (active, file)", seeded.Availability, seeded.MediaKind)
	}

	classification := classifyScanEntries([]scanFileEntry{entry}, snapshot)
	if len(classification.Changed) != 1 {
		t.Fatalf("Changed = %d entries, want 1: the stale row was left on the fast path", len(classification.Changed))
	}

	written, err := store.writeIndexedFiles(ctx, []indexedFile{inspectScanEntry(entry)}, map[string]*string{"": nil}, "token-1")
	if err != nil {
		t.Fatalf("writeIndexedFiles: %v", err)
	}
	if len(written) != 1 || !written[0].NeedsPreview {
		t.Fatalf("write results = %+v, want one result with NeedsPreview set so the thumbnail is queued", written)
	}

	var mediaKind, previewStatus, mimeType string
	var storedWidth, storedHeight int
	if err := store.db.QueryRowContext(ctx, `SELECT media_kind,preview_status,mime_type,width,height FROM assets WHERE path_key=?`, entry.PathKey).
		Scan(&mediaKind, &previewStatus, &mimeType, &storedWidth, &storedHeight); err != nil {
		t.Fatalf("read back the rewritten row: %v", err)
	}
	if mediaKind != "image" {
		t.Errorf("media_kind = %q, want image: the grid keys its photo/file decision off this column", mediaKind)
	}
	if previewStatus != "pending" {
		t.Errorf("preview_status = %q, want pending", previewStatus)
	}
	if mimeType != "image/bmp" || storedWidth != width || storedHeight != height {
		t.Errorf("row = (%s, %dx%d), want (image/bmp, %dx%d)", mimeType, storedWidth, storedHeight, width, height)
	}

	// The backfill must terminate: a row it already rewrote is unchanged again.
	next, err := store.indexSnapshot(ctx)
	if err != nil {
		t.Fatalf("indexSnapshot after the rewrite: %v", err)
	}
	if again := classifyScanEntries([]scanFileEntry{entry}, next); len(again.Changed) != 0 {
		t.Errorf("the second scan re-inspected the row again (%d entries); the backfill does not terminate", len(again.Changed))
	}
}
