package main

import (
	"net/url"

	"mo-gallery-desktop/services"
	"mo-gallery-desktop/storage_plugins"
)

// syncAllStorageSourcesToCloud repairs mirrors created before source syncing
// was enabled and makes sure pending Desktop registrations can resolve their
// public URLs immediately after login.
func (a *App) syncAllStorageSourcesToCloud() {
	if a.StoragePlugins == nil || a.Proxy == nil || !a.Proxy.IsReady() {
		return
	}
	for _, source := range a.StoragePlugins.ListSources() {
		a.syncStorageSourceToCloud(source, false)
	}
}

// syncStorageSourceToCloud mirrors the public config of a Desktop plugin source
// to the cloud StorageSource table under the same id. This lets the web server
// derive display URLs for photos the Desktop registered against that source.
// Secrets never leave the Desktop; the cloud record only carries the fields
// needed to build the base URL. Sync is best-effort: a disconnected cloud never
// blocks local source changes, and the next create/update retries it.
func (a *App) syncStorageSourceToCloud(source storage_plugins.SourceDTO, removing bool) {
	if a.Proxy == nil || !a.Proxy.IsReady() {
		return
	}

	if removing {
		// Deleting may be rejected when photos still reference the source — the
		// cloud record must survive so those photos keep resolving their URLs.
		_ = a.Proxy.DELETE("/admin/storage-sources/" + url.PathEscape(source.ID))
		return
	}

	payload := map[string]any{
		"id":           source.ID,
		"name":         source.Name,
		"type":         cloudSourceType(source.PluginID),
		// vendor is the cross-platform product label (cloudflare-r2, qiniu-kodo,
		// ...). The cloud stores it verbatim so both ends agree on where a photo
		// physically lives — something `type` cannot express, since every
		// S3-compatible provider collapses to "s3".
		"vendor":       sourceVendor(source),
		"bucket":       firstConfigValue(source.Config, "bucket"),
		"region":       firstConfigValue(source.Config, "region"),
		"endpoint":     firstConfigValue(source.Config, "endpoint"),
		"publicUrl":    firstConfigValue(source.Config, "publicURL", "publicUrl"),
		"basePath":     firstConfigValue(source.Config, "basePath"),
		"branch":       firstConfigValue(source.Config, "branch"),
		"accessMethod": firstConfigValue(source.Config, "accessMethod"),
	}
	if cloudSourceType(source.PluginID) == "" {
		return
	}

	var created struct{}
	if err := a.Proxy.POST("/admin/storage-sources", payload, &created); err == nil {
		return
	}

	// The record may already exist (re-sync, another device, or a previous run).
	// Update it in place; the PATCH route keys on the :id param and ignores the
	// body's id field.
	var updated struct{}
	if err := a.Proxy.PATCH("/admin/storage-sources/"+url.PathEscape(source.ID), payload, &updated); err != nil {
		a.Logger.Warn(services.LogCategoryStorage, "sync_source", "同步存储源到云端失败", err.Error())
	}
}

func cloudSourceType(pluginID string) string {
	switch pluginID {
	case storage_plugins.PluginGitHub:
		return "github"
	case storage_plugins.PluginS3Compatible:
		return "s3"
	default:
		return ""
	}
}

// sourceVendor prefers the value already resolved on the DTO and re-derives it
// only when a caller hand-built the DTO (DeleteDesktopStorageSource does this).
// Re-deriving keeps the payload correct without forcing every call site to
// remember to populate Vendor.
func sourceVendor(source storage_plugins.SourceDTO) string {
	if source.Vendor != "" {
		return source.Vendor
	}
	return storage_plugins.InferVendor(source.PluginID, source.Config)
}
