package services

import (
	"errors"
	"net/url"
)

// StorageWebService drives storage maintenance for the server's own sources
// (the builtin local / s3 / github providers, plus any server-side
// StorageSource rows) over the authenticated proxy.
//
// It exists alongside StorageMaintenanceService rather than replacing it: the
// page administers two different worlds. A plugin source's objects are listed
// by a local plugin process and owned by the local library; a web source's
// objects are listed and owned by the server. Routing a web source through the
// plugin runtime cannot work — the Desktop holds no credentials for it, by
// design — which is why the two paths stay separate and the renderer picks one
// per tab via StorageKind*.
type StorageWebService struct {
	proxy *ProxyClient
}

func NewStorageWebService(proxy *ProxyClient) *StorageWebService {
	return &StorageWebService{proxy: proxy}
}

// checkReady surfaces the missing server connection as an actionable message
// instead of a transport error: every operation here is a proxy round-trip.
func (s *StorageWebService) checkReady() error {
	if s.proxy == nil || !s.proxy.IsReady() {
		return errors.New("未连接到服务器。服务器存储源需要先连接站点后才能管理")
	}
	return nil
}

// Scan lists one server storage source and classifies each object against the
// server's own photo records.
func (s *StorageWebService) Scan(params StorageScanParams) (*StorageScanResult, error) {
	if err := s.checkReady(); err != nil {
		return nil, err
	}
	provider := params.Provider
	if provider == "" {
		provider = "local"
	}

	q := url.Values{}
	q.Set("provider", provider)
	if params.Status != "" {
		q.Set("status", params.Status)
	}
	if params.Search != "" {
		q.Set("search", params.Search)
	}

	var result StorageScanResult
	if err := s.proxy.GET("/admin/storage/scan?"+q.Encode(), &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// Cleanup deletes the given object keys from the server's storage. Deletion
// happens server-side, so the client never needs the source credentials.
func (s *StorageWebService) Cleanup(params StorageCleanupParams) (*StorageCleanupResult, error) {
	if err := s.checkReady(); err != nil {
		return nil, err
	}
	provider := params.Provider
	if provider == "" {
		provider = "local"
	}

	var result StorageCleanupResult
	if err := s.proxy.POST("/admin/storage/cleanup", map[string]interface{}{
		"keys":     params.Keys,
		"provider": provider,
	}, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// FixMissing removes the server's photo records whose files are gone. Unlike the
// plugin path this is not a local repair — it edits server state, which is why
// the two are dispatched rather than merged.
func (s *StorageWebService) FixMissing(photoIDs []string) (*FixMissingPhotosResult, error) {
	if err := s.checkReady(); err != nil {
		return nil, err
	}

	var result FixMissingPhotosResult
	if err := s.proxy.POST("/admin/storage/fix-missing", map[string]interface{}{
		"photoIds": photoIDs,
	}, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// GenerateThumbnail asks the server to regenerate a thumbnail. The server's
// response body (the updated photo) is not needed: the renderer re-scans after
// the call, so only transport success matters.
func (s *StorageWebService) GenerateThumbnail(photoID string) error {
	if err := s.checkReady(); err != nil {
		return err
	}
	if photoID == "" {
		return errors.New("照片标识为空")
	}

	var photo map[string]any
	return s.proxy.POST("/admin/photos/"+url.PathEscape(photoID)+"/generate-thumbnail", nil, &photo)
}
