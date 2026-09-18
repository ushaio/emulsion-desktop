package local_library

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func TestBackupMetadataLifecycle(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(backupDirectory(root), 0o700); err != nil {
		t.Fatalf("create backup dir: %v", err)
	}
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "source.db"))
	if err != nil {
		t.Fatalf("open source db: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE assets (id TEXT PRIMARY KEY NOT NULL)`); err != nil {
		t.Fatalf("create assets: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO assets (id) VALUES ('a1'), ('a2')`); err != nil {
		t.Fatalf("seed assets: %v", err)
	}

	previousAppVersion := backupAppVersion
	t.Cleanup(func() { backupAppVersion = previousAppVersion })
	SetBackupAppVersion("9.9.9-test")

	info, err := createBackupFile(context.Background(), root, BackupKindManual, db, backupParams{
		note:       "  修复前   快照  ",
		assetCount: countAssets(db),
	})
	if err != nil {
		t.Fatalf("createBackupFile: %v", err)
	}
	if info.Note != "修复前 快照" {
		t.Errorf("info.Note = %q, want %q", info.Note, "修复前 快照")
	}
	if info.AppVersion != "9.9.9-test" {
		t.Errorf("info.AppVersion = %q, want %q", info.AppVersion, "9.9.9-test")
	}
	if info.SchemaVersion != currentSchemaVersion {
		t.Errorf("info.SchemaVersion = %d, want %d", info.SchemaVersion, currentSchemaVersion)
	}
	if info.AssetCount != 2 {
		t.Errorf("info.AssetCount = %d, want 2", info.AssetCount)
	}
	if _, err := os.Stat(backupMetaPath(filepath.Join(backupDirectory(root), info.ID))); err != nil {
		t.Fatalf("sidecar meta file missing: %v", err)
	}

	items, err := listBackupFiles(root)
	if err != nil {
		t.Fatalf("listBackupFiles: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(items))
	}
	got := items[0]
	if got.ID != info.ID || got.Kind != BackupKindManual || got.AppVersion != info.AppVersion ||
		got.SchemaVersion != info.SchemaVersion || got.AssetCount != info.AssetCount || got.Note != info.Note {
		t.Errorf("listed backup %+v, want %+v", got, info)
	}
}

func TestUpgradeBackupKeepsSourceSchemaVersion(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(backupDirectory(root), 0o700); err != nil {
		t.Fatalf("create backup dir: %v", err)
	}
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "source.db"))
	if err != nil {
		t.Fatalf("open source db: %v", err)
	}
	defer db.Close()

	if err := createUpgradeBackup(context.Background(), root, db, 16); err != nil {
		t.Fatalf("createUpgradeBackup: %v", err)
	}
	items, err := listBackupFiles(root)
	if err != nil {
		t.Fatalf("listBackupFiles: %v", err)
	}
	if len(items) != 1 || items[0].Kind != BackupKindUpgrade {
		t.Fatalf("items = %+v, want one %q backup", items, BackupKindUpgrade)
	}
	if items[0].SchemaVersion != 16 {
		t.Errorf("SchemaVersion = %d, want 16 (pre-upgrade version)", items[0].SchemaVersion)
	}
}

func TestLegacyBackupWithoutMetaStillListed(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(backupDirectory(root), 0o700); err != nil {
		t.Fatalf("create backup dir: %v", err)
	}
	legacy := filepath.Join(backupDirectory(root), BackupKindDaily+"-20200101T000000.000Z-legacy.db")
	if err := os.WriteFile(legacy, []byte("not a real database"), 0o600); err != nil {
		t.Fatalf("write legacy backup: %v", err)
	}
	items, err := listBackupFiles(root)
	if err != nil {
		t.Fatalf("listBackupFiles: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("len(items) = %d, want 1", len(items))
	}
	if items[0].AppVersion != "" || items[0].SchemaVersion != 0 || items[0].AssetCount != 0 || items[0].Note != "" {
		t.Errorf("legacy backup should have empty metadata, got %+v", items[0])
	}
}

func TestDeleteBackupRemovesFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(backupDirectory(root), 0o700); err != nil {
		t.Fatalf("create backup dir: %v", err)
	}
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "source.db"))
	if err != nil {
		t.Fatalf("open source db: %v", err)
	}
	defer db.Close()

	info, err := createBackupFile(context.Background(), root, BackupKindManual, db, backupParams{})
	if err != nil {
		t.Fatalf("createBackupFile: %v", err)
	}
	backupPath := filepath.Join(backupDirectory(root), info.ID)
	if err := removeBackupFiles(root, info.ID); err != nil {
		t.Fatalf("removeBackupFiles: %v", err)
	}
	if _, err := os.Stat(backupPath); !os.IsNotExist(err) {
		t.Errorf("backup db still exists (stat err = %v)", err)
	}
	if _, err := os.Stat(backupMetaPath(backupPath)); !os.IsNotExist(err) {
		t.Errorf("backup sidecar still exists (stat err = %v)", err)
	}
	if err := removeBackupFiles(root, info.ID); err == nil {
		t.Errorf("removeBackupFiles should fail after deletion")
	}
	if err := removeBackupFiles(root, "../escape.db"); err == nil {
		t.Errorf("removeBackupFiles should reject invalid ids")
	}
}

func TestPruneRemovesBackupMetaSidecar(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(backupDirectory(root), 0o700); err != nil {
		t.Fatalf("create backup dir: %v", err)
	}
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "source.db"))
	if err != nil {
		t.Fatalf("open source db: %v", err)
	}
	defer db.Close()

	first, err := createBackupFile(context.Background(), root, BackupKindDaily, db, backupParams{})
	if err != nil {
		t.Fatalf("createBackupFile: %v", err)
	}
	if _, err := createBackupFile(context.Background(), root, BackupKindDaily, db, backupParams{}); err != nil {
		t.Fatalf("createBackupFile second: %v", err)
	}
	if err := pruneBackups(root, BackupKindDaily, 1); err != nil {
		t.Fatalf("pruneBackups: %v", err)
	}
	if _, err := os.Stat(filepath.Join(backupDirectory(root), first.ID)); !os.IsNotExist(err) {
		t.Errorf("pruned backup db still exists (stat err = %v)", err)
	}
	if _, err := os.Stat(backupMetaPath(filepath.Join(backupDirectory(root), first.ID))); !os.IsNotExist(err) {
		t.Errorf("pruned backup sidecar still exists (stat err = %v)", err)
	}
}
