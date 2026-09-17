package services

// StorageScanParams is the renderer-facing request for a storage maintenance
// scan. Provider carries the desktop storage source id, not the legacy web
// provider enum: maintenance is scoped to one plugin source at a time.
type StorageScanParams struct {
	Provider string `json:"provider"`
	Status   string `json:"status,omitempty"`
	Search   string `json:"search,omitempty"`
}
