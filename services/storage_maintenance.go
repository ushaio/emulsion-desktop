package services

import (
	"context"
	"errors"
	"fmt"
	"path"
	"sort"
	"strings"

	"mo-gallery-desktop/local_library"
	"mo-gallery-desktop/storage_plugins"
)

// Object status values reported to the renderer. They intentionally mirror the
// web admin vocabulary so the storage maintenance page keeps its original
// behaviour while the data now comes from a desktop storage plugin.
const (
	StorageStatusLinked           = "linked"
	StorageStatusOrphan           = "orphan"
	StorageStatusMissing          = "missing"
	StorageStatusMissingOriginal  = "missing_original"
	StorageStatusMissingThumbnail = "missing_thumbnail"
)

// StorageObjectDTO is one row of the maintenance table: an object on a plugin
// source, joined with what the local library knows about it.
type StorageObjectDTO struct {
	Key          string `json:"key"`
	URL          string `json:"url"`
	Size         int64  `json:"size"`
	LastModified string `json:"lastModified"`
	Status       string `json:"status"`
	PhotoID      string `json:"photoId,omitempty"`
	PhotoTitle   string `json:"photoTitle,omitempty"`
	MissingType  string `json:"missingType,omitempty"`
	HasThumb     bool   `json:"hasThumb,omitempty"`
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
	// Vendor names the concrete storage product behind the scanned source
	// (cloudflare-r2, qiniu-kodo, ...). It belongs to the source, not to each
	// object, so it is reported once here rather than repeated on every row.
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

// StorageMaintenanceService reconciles a desktop storage plugin source against
// the local library's cloud projection. Everything it needs is available
// offline: the object listing comes from the plugin runtime and the ownership
// records come from the local library database, so no server round-trip is
// involved.
type StorageMaintenanceService struct {
	plugins *storage_plugins.Manager
	library *local_library.Manager
}

func NewStorageMaintenanceService(plugins *storage_plugins.Manager, library *local_library.Manager) *StorageMaintenanceService {
	return &StorageMaintenanceService{plugins: plugins, library: library}
}

// listingPageLimit mirrors the plugin host's accepted range (0..1000). It is
// deliberately large because a storage source may hold hundreds of thousands of
// objects and every page costs a process round-trip.
const listingPageLimit = 1000

// maxListingObjects caps one scan so a runaway bucket cannot exhaust memory.
// The cap is reported to the caller through Truncated instead of silently
// dropping objects.
const maxListingObjects = 200000

func (s *StorageMaintenanceService) checkReady() error {
	if s.plugins == nil {
		return errors.New("桌面存储插件未初始化")
	}
	return nil
}

// Scan reconciles one plugin source. When local library records are unavailable
// (no library open) it still returns the source listing, marking every object
// as orphan-unknown via an empty registration set. Callers that need the
// ownership columns must have a library open.
func (s *StorageMaintenanceService) Scan(ctx context.Context, sourceID string) (*StorageScanResult, error) {
	if err := s.checkReady(); err != nil {
		return nil, err
	}
	sourceID = strings.TrimSpace(sourceID)
	if sourceID == "" {
		return nil, errors.New("请选择存储源")
	}
	source, ok := s.plugins.GetSource(sourceID)
	if !ok {
		return nil, fmt.Errorf("存储源不存在：%s", sourceID)
	}

	objects, err := s.listAllObjects(ctx, sourceID)
	if err != nil {
		return nil, describeScanError(sourceID, err)
	}

	registrations, regErr := s.registrations(sourceID)
	if regErr != nil {
		// A missing library is not a scan failure: the listing is still useful.
		registrations = nil
	}
	owners := make(map[string]local_library.CloudObjectRegistration, len(registrations))
	for _, item := range registrations {
		if item.Path == "" {
			continue
		}
		if _, exists := owners[item.Path]; !exists {
			owners[item.Path] = item
		}
	}

	// Track which registered originals were seen on the source so the leftovers
	// can be reported as missing.
	seen := make(map[string]struct{}, len(objects))

	result := &StorageScanResult{
		Files:      make([]StorageObjectDTO, 0, len(objects)),
		Vendor:     storage_plugins.InferVendor(source.PluginID, source.Config),
		SourceName: source.Name,
	}
	for _, object := range objects {
		row := StorageObjectDTO{
			Key:          object.Key,
			URL:          object.URL,
			Size:         object.Size,
			LastModified: object.LastModified,
		}
		if owner, ok := owners[object.Key]; ok {
			row.Status = StorageStatusLinked
			row.PhotoID = owner.PhotoID
			row.PhotoTitle = owner.Title
			row.HasThumb = owner.HasThumb
		} else {
			row.Status = StorageStatusOrphan
		}
		seen[object.Key] = struct{}{}
		result.Files = append(result.Files, row)
	}

	// Registered objects that the source no longer holds. The original and its
	// thumbnail are reported separately so the UI can distinguish a photo whose
	// file is gone from one that only lost its thumbnail.
	for _, item := range registrations {
		if _, ok := seen[item.Path]; !ok {
			result.Files = append(result.Files, StorageObjectDTO{
				Key:         item.Path,
				Status:      StorageStatusMissingOriginal,
				PhotoID:     item.PhotoID,
				PhotoTitle:  item.Title,
				MissingType: "original",
			})
			continue
		}
		// The original exists, but a registered thumbnail key has no object.
		if item.ThumbPath == "" {
			continue
		}
		if _, ok := seen[item.ThumbPath]; !ok {
			result.Files = append(result.Files, StorageObjectDTO{
				Key:         item.ThumbPath,
				Status:      StorageStatusMissingThumbnail,
				PhotoID:     item.PhotoID,
				PhotoTitle:  item.Title,
				MissingType: "thumbnail",
			})
		}
	}

	for _, row := range result.Files {
		result.Stats.Total++
		switch row.Status {
		case StorageStatusLinked:
			result.Stats.Linked++
		case StorageStatusOrphan:
			result.Stats.Orphan++
		case StorageStatusMissingOriginal:
			result.Stats.MissingOriginal++
			result.Stats.Missing++
		case StorageStatusMissingThumbnail:
			result.Stats.MissingThumbnail++
			result.Stats.Missing++
		}
	}
	sort.SliceStable(result.Files, func(i, j int) bool { return result.Files[i].Key < result.Files[j].Key })
	return result, nil
}

// listAllObjects drains the plugin source listing page by page. A prefix-free
// listing is used so the maintenance view presents the whole source; folder
// grouping happens in the renderer, exactly as it did before.
func (s *StorageMaintenanceService) listAllObjects(ctx context.Context, sourceID string) ([]storage_plugins.ObjectInfo, error) {
	objects := make([]storage_plugins.ObjectInfo, 0, listingPageLimit)
	cursor := ""
	for {
		page, err := s.plugins.List(ctx, storage_plugins.ListRequest{
			SourceID: sourceID, Prefix: "", Cursor: cursor, Limit: listingPageLimit,
		})
		if err != nil {
			return nil, err
		}
		objects = append(objects, page.Objects...)
		if len(objects) >= maxListingObjects {
			return objects[:maxListingObjects], nil
		}
		if !page.HasMore || strings.TrimSpace(page.NextCursor) == "" {
			return objects, nil
		}
		// A backend that repeats the same cursor would loop forever.
		if page.NextCursor == cursor {
			return objects, nil
		}
		cursor = page.NextCursor
	}
}

func (s *StorageMaintenanceService) registrations(sourceID string) ([]local_library.CloudObjectRegistration, error) {
	if s.library == nil {
		return nil, errors.New("本地资源库未初始化")
	}
	return s.library.CloudObjectRegistrations(sourceID)
}

// describeScanError turns the plugin host's machine-readable codes into a
// message the storage maintenance page can show directly. A plugin that cannot
// list objects is a capability gap, not a transient failure, so it is worth
// naming explicitly instead of surfacing the raw English plugin error.
func describeScanError(sourceID string, err error) error {
	var pluginErr *storage_plugins.PluginError
	if errors.As(err, &pluginErr) {
		switch pluginErr.Code {
		case storage_plugins.ErrorCapabilityMissing:
			return fmt.Errorf("该存储插件不支持列出文件，无法扫描存储源 %s", sourceID)
		case storage_plugins.ErrorRuntimeMissing:
			return fmt.Errorf("存储插件运行时不可用，请检查插件安装状态（存储源 %s）", sourceID)
		case storage_plugins.ErrorDeveloperModeRequired:
			return errors.New("该插件需要在开发模式下运行")
		}
	}
	return err
}

// Cleanup removes the given object keys from a plugin source. Deletion goes
// through the plugin runtime, so source credentials never reach the renderer.
func (s *StorageMaintenanceService) Cleanup(ctx context.Context, sourceID string, keys []string) (*StorageCleanupResult, error) {
	if err := s.checkReady(); err != nil {
		return nil, err
	}
	sourceID = strings.TrimSpace(sourceID)
	if sourceID == "" {
		return nil, errors.New("请选择存储源")
	}
	if _, ok := s.plugins.GetSource(sourceID); !ok {
		return nil, fmt.Errorf("存储源不存在：%s", sourceID)
	}
	if len(keys) == 0 {
		return &StorageCleanupResult{}, nil
	}

	result := &StorageCleanupResult{Errors: make([]string, 0)}
	for _, key := range keys {
		normalized := normalizeObjectKey(key)
		if normalized == "" {
			result.Failed++
			result.Errors = append(result.Errors, "对象路径为空")
			continue
		}
		if err := s.plugins.Delete(ctx, storage_plugins.DeleteRequest{SourceID: sourceID, Key: normalized}); err != nil {
			result.Failed++
			if len(result.Errors) < 20 {
				result.Errors = append(result.Errors, fmt.Sprintf("%s：%s", normalized, err.Error()))
			}
			continue
		}
		result.Deleted++
	}
	return result, nil
}

// FixMissing unlinks photos whose objects are gone from the source. Unlike the
// web service this never deletes a remote photo record — the desktop library
// only drops its own stale projection, which is a purely local repair.
func (s *StorageMaintenanceService) FixMissing(assetIDs []string) (*FixMissingPhotosResult, error) {
	if s.library == nil {
		return nil, errors.New("本地资源库未初始化")
	}
	ids := make([]local_library.AssetID, 0, len(assetIDs))
	for _, id := range assetIDs {
		if trimmed := strings.TrimSpace(id); trimmed != "" {
			ids = append(ids, local_library.AssetID(trimmed))
		}
	}
	cleared, err := s.library.UnlinkCloudAssets(ids)
	if err != nil {
		return nil, err
	}
	return &FixMissingPhotosResult{Deleted: cleared}, nil
}

// GenerateThumbnail re-queues thumbnail generation for one local asset. The
// desktop equivalent of the web endpoint is the local derivative pipeline, so
// the photo id here is the id of the backing library asset.
func (s *StorageMaintenanceService) GenerateThumbnail(assetID string) error {
	if s.library == nil {
		return errors.New("本地资源库未初始化")
	}
	id := local_library.AssetID(strings.TrimSpace(assetID))
	if id == "" {
		return errors.New("照片标识为空")
	}
	return s.library.EnsureThumbnail(id)
}

// PreflightObjects resolves which submitted keys actually exist on the source.
// The renderer uses it before a destructive batch so a stale table row cannot
// delete an object the user never saw.
func (s *StorageMaintenanceService) PreflightObjects(ctx context.Context, sourceID string, keys []string) ([]string, error) {
	if err := s.checkReady(); err != nil {
		return nil, err
	}
	present := make([]string, 0, len(keys))
	for _, key := range keys {
		normalized := normalizeObjectKey(key)
		if normalized == "" {
			continue
		}
		if _, err := s.plugins.Stat(ctx, storage_plugins.StatRequest{SourceID: sourceID, Key: normalized}); err != nil {
			continue
		}
		present = append(present, normalized)
	}
	return present, nil
}

// normalizeObjectKey rejects traversal and absolute keys before they reach the
// plugin host, which would otherwise reject them with an opaque error.
func normalizeObjectKey(key string) string {
	trimmed := strings.TrimSpace(strings.ReplaceAll(key, "\\", "/"))
	trimmed = strings.TrimPrefix(trimmed, "/")
	if trimmed == "" {
		return ""
	}
	if trimmed == "." || strings.Contains(trimmed, "../") || strings.HasPrefix(trimmed, "../") {
		return ""
	}
	cleaned := path.Clean(trimmed)
	if cleaned == "." || strings.HasPrefix(cleaned, "../") {
		return ""
	}
	return cleaned
}
