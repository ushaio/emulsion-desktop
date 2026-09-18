package services

// Storage maintenance runs against two different worlds, and the renderer picks
// between them per source:
//
//   - StorageKindWeb    — the source lives on the server (local / s3 / github).
//     Objects and photo records both belong to the server, so every operation
//     is a proxy call. See storage_web.go.
//   - StorageKindPlugin — the source is a Desktop storage plugin. Objects are
//     listed through the plugin runtime and ownership is resolved against the
//     local library. See storage_maintenance.go.
//
// The DTOs below are shared: both backends must speak one vocabulary, otherwise
// the same status label would mean different things depending on which tab is
// selected.
const (
	StorageKindWeb    = "web"
	StorageKindPlugin = "plugin"
)

// Object statuses. These mirror the server's storage maintenance API exactly —
// including the distinct "missing" status for a photo whose original *and*
// thumbnail are both gone. Stats are counted per status rather than folded into
// an aggregate, so a status filter means the same thing on both backends.
const (
	StorageStatusLinked           = "linked"
	StorageStatusOrphan           = "orphan"
	StorageStatusMissing          = "missing"
	StorageStatusMissingOriginal  = "missing_original"
	StorageStatusMissingThumbnail = "missing_thumbnail"
)

// StorageScanParams is the renderer-facing request for a storage maintenance
// scan. Provider carries either a web provider enum (local / s3 / github) or a
// Desktop storage source id, depending on Kind.
type StorageScanParams struct {
	Provider string `json:"provider"`
	Kind     string `json:"kind,omitempty"`
	Status   string `json:"status,omitempty"`
	Search   string `json:"search,omitempty"`
}

type StorageCleanupParams struct {
	Provider string   `json:"provider"`
	Kind     string   `json:"kind,omitempty"`
	Keys     []string `json:"keys"`
}

type StorageMissingParams struct {
	Kind     string   `json:"kind,omitempty"`
	PhotoIDs []string `json:"photoIds"`
}

type StorageThumbnailParams struct {
	Kind    string `json:"kind,omitempty"`
	PhotoID string `json:"photoId"`
}

// StorageObjectDTO is one row of the maintenance table. The same shape is
// produced for both backends.
type StorageObjectDTO struct {
	Key          string `json:"key"`
	URL          string `json:"url"`
	Size         int64  `json:"size"`
	LastModified string `json:"lastModified"`
	Status       string `json:"status"`
	// PhotoID is the identifier the owning backend needs to act on this row:
	// the server's photo id for web sources, the local library asset id for
	// plugin sources. The renderer passes it straight back to the cleanup /
	// thumbnail calls, which route by the same Kind, so one field is enough —
	// but it must never be filled with an id from the other backend.
	PhotoID     string `json:"photoId,omitempty"`
	PhotoTitle  string `json:"photoTitle,omitempty"`
	MissingType string `json:"missingType,omitempty"`
	HasThumb    bool   `json:"hasThumb,omitempty"`
}

type StorageScanStats struct {
	Total            int `json:"total"`
	Linked           int `json:"linked"`
	Orphan           int `json:"orphan"`
	Missing          int `json:"missing"`
	MissingOriginal  int `json:"missingOriginal"`
	MissingThumbnail int `json:"missingThumbnail"`
}

type StorageScanResult struct {
	Files []StorageObjectDTO `json:"files"`
	Stats StorageScanStats   `json:"stats"`
	// Vendor names the concrete storage product behind a scanned Desktop plugin
	// source (cloudflare-r2, qiniu-kodo, ...). It belongs to the source, not to
	// each object, so it is reported once here. Web sources leave it empty: the
	// builtin local/s3/github providers are protocol families, and the server
	// does not expose a product identity for them.
	Vendor string `json:"vendor,omitempty"`
	// SourceName echoes the user-facing label of the scanned source so the page
	// can render the header without a second lookup.
	SourceName string `json:"sourceName,omitempty"`
}

type StorageCleanupResult struct {
	Deleted int      `json:"deleted"`
	Failed  int      `json:"failed"`
	Errors  []string `json:"errors"`
}

type FixMissingPhotosResult struct {
	Deleted int `json:"deleted"`
}
