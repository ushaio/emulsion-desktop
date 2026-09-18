package local_library

import (
	"context"
	"os"
	"strings"
	"testing"
)

// The dirty queue is maintained by triggers, so every write path that touches
// assets, exif, tags or collections has to survive it. SQLite discards a
// trigger body's own conflict clause when the statement that fires the trigger
// carries one of its own, and an UPSERT's clause covers only its own conflict
// target — the rest of that statement resolves under the default ABORT.
// upsertEXIF is an UPSERT, and by the time it runs the asset is already queued
// by the assets UPDATE in the same transaction, so a body relying on INSERT OR
// IGNORE raised "UNIQUE constraint failed: asset_search_dirty.asset_id" and
// failed the scan with "扫描失败: <root> - constraint failed: ...".
func TestSearchDirtyTriggersSurviveUpsertWrites(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	iso := 100
	file := indexedFile{
		RelativePath: "a.jpg", PathKey: "a.jpg", FolderPath: "",
		FileName: "a.jpg", Extension: ".jpg", Format: "jpeg", MimeType: "image/jpeg",
		MediaKind: "image", ByteSize: 10, ModifiedAtNS: 1, Orientation: 1, FrameCount: 1,
		PreviewStatus: "pending", MetadataStatus: "ready",
		EXIF: exifMetadata{CameraMake: "Hasselblad", CameraModel: "X2D 100C", ISO: &iso},
	}

	// The first pass inserts the asset and its exif row; every later pass takes
	// the UPDATE branch and then upserts the existing exif row, which is the
	// exact sequence a re-scan of an unchanged-but-stale asset performs.
	for pass := 1; pass <= 3; pass++ {
		if _, _, err := store.upsertAsset(ctx, file, "token"); err != nil {
			t.Fatalf("upsertAsset pass %d: %v", pass, err)
		}
	}

	// The batched writer the scan pipeline actually uses.
	if _, err := store.writeIndexedFiles(ctx, []indexedFile{file}, map[string]*string{"": nil}, "token"); err != nil {
		t.Fatalf("writeIndexedFiles: %v", err)
	}

	// Several queuing statements have now touched one asset; the queue holds one row.
	var queued int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM asset_search_dirty`).Scan(&queued); err != nil {
		t.Fatalf("count dirty rows: %v", err)
	}
	if queued != 1 {
		t.Errorf("asset_search_dirty holds %d rows, want 1: the queue must stay deduplicated", queued)
	}

	// The queued row is what the FTS flush reads, so the camera must be findable.
	if err := store.flushAssetSearch(ctx); err != nil {
		t.Fatalf("flushAssetSearch: %v", err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM asset_search_dirty`).Scan(&queued); err != nil {
		t.Fatalf("count dirty rows after flush: %v", err)
	}
	if queued != 0 {
		t.Errorf("asset_search_dirty holds %d rows after the flush, want 0", queued)
	}

	// The index row itself has to be rebuilt, not merely dequeued.
	var matches int
	if err := store.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM asset_search WHERE asset_search MATCH 'Hasselblad'`).Scan(&matches); err != nil {
		t.Fatalf("search the index: %v", err)
	}
	if matches != 1 {
		t.Errorf("search index holds %d rows for the camera, want 1", matches)
	}
}

// Removing exif metadata deletes the row, so the AFTER DELETE trigger has to
// queue the asset for re-indexing just as the insert and update triggers do.
func TestSearchDirtyTriggersQueueOnExifRemoval(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	iso := 400
	withExif := indexedFile{
		RelativePath: "a.jpg", PathKey: "a.jpg", FolderPath: "",
		FileName: "a.jpg", Extension: ".jpg", Format: "jpeg", MimeType: "image/jpeg",
		MediaKind: "image", ByteSize: 10, ModifiedAtNS: 1, Orientation: 1, FrameCount: 1,
		PreviewStatus: "pending", MetadataStatus: "ready",
		EXIF: exifMetadata{CameraMake: "Hasselblad", ISO: &iso},
	}
	if _, _, err := store.upsertAsset(ctx, withExif, "token"); err != nil {
		t.Fatalf("seed with exif: %v", err)
	}
	if err := store.flushAssetSearch(ctx); err != nil {
		t.Fatalf("initial flush: %v", err)
	}

	// Same asset, metadata now empty: upsertEXIF deletes the exif row.
	withoutExif := withExif
	withoutExif.EXIF = exifMetadata{}
	if _, _, err := store.upsertAsset(ctx, withoutExif, "token"); err != nil {
		t.Fatalf("upsert without exif: %v", err)
	}
	var queued int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM asset_search_dirty`).Scan(&queued); err != nil {
		t.Fatalf("count dirty rows: %v", err)
	}
	if queued != 1 {
		t.Errorf("asset_search_dirty holds %d rows after the exif row was deleted, want the asset queued", queued)
	}
}

// Renaming a tag or a collection takes the UPDATE branch of the tag/collection
// upsert, which is just as capable of overriding the body's conflict clause as
// the exif upsert is. The linked assets have to end up queued either way.
func TestSearchDirtyTriggersQueueOnRelatedRename(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	file := indexedFile{
		RelativePath: "a.jpg", PathKey: "a.jpg", FolderPath: "",
		FileName: "a.jpg", Extension: ".jpg", Format: "jpeg", MimeType: "image/jpeg",
		MediaKind: "image", ByteSize: 10, ModifiedAtNS: 1, Orientation: 1, FrameCount: 1,
		PreviewStatus: "pending", MetadataStatus: "ready",
	}
	assetID, _, err := store.upsertAsset(ctx, file, "token")
	if err != nil {
		t.Fatalf("upsertAsset: %v", err)
	}
	if _, err := store.db.ExecContext(ctx,
		`INSERT INTO tags(id,name,name_key,color,created_at) VALUES('t1','old','old','',1)`); err != nil {
		t.Fatalf("seed tag: %v", err)
	}
	if _, err := store.db.ExecContext(ctx,
		`INSERT INTO asset_tags(asset_id,tag_id) VALUES(?, 't1')`, assetID); err != nil {
		t.Fatalf("link tag: %v", err)
	}
	if err := store.flushAssetSearch(ctx); err != nil {
		t.Fatalf("initial flush: %v", err)
	}

	// UPDATE OF name ON tags fires only for a real update of the name column.
	if _, err := store.db.ExecContext(ctx, `UPDATE tags SET name='new',name_key='new' WHERE id='t1'`); err != nil {
		t.Fatalf("rename tag: %v", err)
	}
	var queued int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM asset_search_dirty`).Scan(&queued); err != nil {
		t.Fatalf("count dirty rows: %v", err)
	}
	if queued != 1 {
		t.Errorf("asset_search_dirty holds %d rows after the tag rename, want the linked asset queued", queued)
	}
}

// A library that already carries the old trigger bodies keeps them, because
// CREATE TRIGGER IF NOT EXISTS leaves an existing trigger alone. The migration
// is what swaps them out, so this asserts a trigger still holding the old
// definition is rewritten on the next open.
func TestMigrationRewritesStaleDirtyTriggers(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(internalPath(root), 0o700); err != nil {
		t.Fatalf("create internal dir: %v", err)
	}
	ctx := context.Background()

	store, err := openStoreWithMigration(root, nil, false)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	// The definition shipped before the fix.
	const staleBody = `CREATE TRIGGER asset_search_exif_update
		AFTER UPDATE OF camera_make,camera_model,lens_model ON exif BEGIN
			INSERT OR IGNORE INTO asset_search_dirty(asset_id) VALUES(NEW.asset_id);
		END`
	for _, statement := range []string{
		`DROP TRIGGER IF EXISTS asset_search_exif_update`,
		staleBody,
	} {
		if _, err := store.db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("install stale trigger: %v", err)
		}
	}
	store.Close()

	reopened, err := openStoreWithMigration(root, nil, false)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	defer reopened.Close()

	var definition string
	if err := reopened.db.QueryRowContext(ctx,
		`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='asset_search_exif_update'`).Scan(&definition); err != nil {
		t.Fatalf("read trigger definition: %v", err)
	}
	if !strings.Contains(definition, "NOT EXISTS") {
		t.Errorf("trigger body is not the guarded form:\n%s", definition)
	}

	// And the repaired trigger now survives the write sequence that used to
	// abort, so the migration is verified by behaviour and not just by text.
	iso := 200
	file := indexedFile{
		RelativePath: "a.jpg", PathKey: "a.jpg", FolderPath: "",
		FileName: "a.jpg", Extension: ".jpg", Format: "jpeg", MimeType: "image/jpeg",
		MediaKind: "image", ByteSize: 10, ModifiedAtNS: 1, Orientation: 1, FrameCount: 1,
		PreviewStatus: "pending", MetadataStatus: "ready",
		EXIF: exifMetadata{CameraMake: "Hasselblad", ISO: &iso},
	}
	for pass := 1; pass <= 2; pass++ {
		if _, _, err := reopened.upsertAsset(ctx, file, "token"); err != nil {
			t.Fatalf("upsertAsset after migration pass %d: %v", pass, err)
		}
	}
}

// Every trigger the search index installs must be replaced on open, so a
// library carrying an older body can never keep it. This asserts the shipped
// definitions rather than trusting the migration to have run: no body may state
// a conflict clause for the firing statement to override, and every body that
// queues an asset must guard its insert.
func TestSearchIndexTriggersUseGuardedBodies(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	if len(assetSearchTriggerNames) == 0 {
		t.Fatal("assetSearchTriggerNames is empty: nothing would be replaced on open")
	}
	queuing := 0
	for _, name := range assetSearchTriggerNames {
		var definition string
		err := store.db.QueryRowContext(ctx,
			`SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?`, name).Scan(&definition)
		if err != nil {
			t.Errorf("trigger %s is missing: %v", name, err)
			continue
		}
		if strings.Contains(strings.ToUpper(definition), "OR IGNORE") ||
			strings.Contains(strings.ToUpper(definition), "OR REPLACE") {
			t.Errorf("%s states a conflict clause the firing statement would override:\n%s", name, definition)
		}
		// asset_search_assets_delete removes index rows instead of queueing one,
		// so only the inserting bodies have an insert to guard.
		if !strings.Contains(definition, "INSERT INTO asset_search_dirty") {
			continue
		}
		queuing++
		if !strings.Contains(definition, "NOT EXISTS") {
			t.Errorf("%s queues without a guard, so an UPSERT would override it:\n%s", name, definition)
		}
	}
	if queuing < 11 {
		t.Errorf("only %d trigger(s) queue into asset_search_dirty, want the full set", queuing)
	}
}

// The DROP list that replaces superseded bodies must cover every trigger the
// schema installs. Without that, a body written by an earlier build survives
// CREATE TRIGGER IF NOT EXISTS forever — the exact failure being fixed. The two
// checks below catch a name that no longer exists and a schema trigger missing
// from the list, which are the two ways the sets can drift apart.
func TestEveryInstalledTriggerIsAlsoReplaced(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()

	created := 0
	for _, statement := range assetSearchSchema {
		if strings.HasPrefix(statement, "CREATE TRIGGER") {
			created++
		}
	}
	if created < 12 {
		t.Fatalf("schema defines only %d trigger(s), want the full set", created)
	}
	if len(assetSearchTriggerNames) != created {
		t.Errorf("schema defines %d trigger(s) but %d would be replaced on open",
			created, len(assetSearchTriggerNames))
	}
	// Each listed name must resolve, so a rename cannot leave a stale entry that
	// silently drops nothing.
	for _, name := range assetSearchTriggerNames {
		var found int
		if err := store.db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name=?`, name).Scan(&found); err != nil {
			t.Fatalf("look up trigger %s: %v", name, err)
		}
		if found != 1 {
			t.Errorf("%s would be dropped on open but no such trigger is installed", name)
		}
	}
}
