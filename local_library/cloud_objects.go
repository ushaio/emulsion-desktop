package local_library

import (
	"errors"
	"time"
)

// CloudObjectRegistration is the local-library view of one object the cloud has
// registered against a storage source. Storage maintenance pairs these records
// with an actual plugin-source listing to classify every object.
type CloudObjectRegistration struct {
	AssetID    AssetID
	PhotoID    string
	Title      string
	Path       string
	ThumbPath  string
	HasThumb   bool
	UploadedAt string
}

// CloudObjectRegistrations returns every active, cloud-linked asset registered
// for one storage source. This is a local projection only — it never contacts
// the server, so maintenance keeps working while offline.
func (m *Manager) CloudObjectRegistrations(sourceID string) ([]CloudObjectRegistration, error) {
	session, err := m.requireAvailableSession()
	if err != nil {
		return nil, err
	}
	items, err := session.store.cloudObjectRegistrations(session.ctx, sourceID)
	if err != nil {
		return nil, err
	}
	result := make([]CloudObjectRegistration, 0, len(items))
	for _, item := range items {
		registration := CloudObjectRegistration{
			AssetID: item.AssetID, PhotoID: item.PhotoID, Title: item.Title,
			Path: item.Path, ThumbPath: item.ThumbPath, HasThumb: item.HasThumb,
		}
		if item.UploadedAt != nil {
			registration.UploadedAt = item.UploadedAt.UTC().Format(time.RFC3339)
		}
		result = append(result, registration)
	}
	return result, nil
}

// EnsureThumbnail generates a thumbnail for one asset and waits for it. Storage
// maintenance uses it to repair a photo whose cached preview is gone; the work
// runs in the local derivative pipeline and never contacts the server.
func (m *Manager) EnsureThumbnail(id AssetID) error {
	session, err := m.requireAvailableSession()
	if err != nil {
		return err
	}
	if !isOpaqueID(string(id)) {
		return newError(ErrAssetNotFound, "资产标识无效", nil)
	}
	_, err = m.ensureThumbnail(session, id)
	return err
}

// UnlinkCloudAssets clears the cloud projection for the given assets. Storage
// maintenance calls this after the user removes photos whose objects no longer
// exist on the source, so the local library stops advertising a dead link.
// Unknown assets are skipped rather than aborting the batch.
func (m *Manager) UnlinkCloudAssets(ids []AssetID) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	session, err := m.requireAvailableSession()
	if err != nil {
		return 0, err
	}
	cleared := 0
	for _, id := range ids {
		if err := session.store.clearAssetCloudLink(session.ctx, id); err != nil {
			var appErr *AppError
			if errors.As(err, &appErr) && appErr.Code == ErrAssetNotFound {
				continue
			}
			return cleared, err
		}
		cleared++
	}
	if cleared > 0 {
		m.emitEvent("asset_cloud_link_cleared")
	}
	return cleared, nil
}
