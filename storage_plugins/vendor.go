package storage_plugins

import (
	"strings"
)

// Vendor identifiers are the cross-platform, human-readable names for the
// concrete storage product behind a source. They are deliberately separate
// from PluginID: "s3-compatible" is a protocol family shared by Cloudflare R2,
// Qiniu Kodo, Aliyun OSS and MinIO, so it can never distinguish them. The
// vendor field answers "where does this actually live?" while PluginID answers
// "which adapter speaks to it?".
//
// The value set is part of the wire contract with the cloud: the web server
// persists the same identifier on its StorageSource row. Keep them stable and
// lowercase-kebab, matching the existing "s3-compatible" / "desktop-plugin"
// style.
const (
	VendorCloudflareR2 = "cloudflare-r2"
	VendorQiniuKodo    = "qiniu-kodo"
	VendorAliyunOSS    = "aliyun-oss"
	VendorTencentCOS   = "tencent-cos"
	VendorAWSS3        = "aws-s3"
	VendorMinIO        = "minio"
	VendorGitHub       = "github"
	VendorLocal        = "local"
)

// vendorConfigKey lets a source override the inferred value. It is needed for
// self-hosted deployments whose endpoint looks like nothing recognizable —
// a private MinIO behind a company domain, for example — and for providers we
// do not fingerprint yet. An explicit choice always wins over inference.
const vendorConfigKey = "vendor"

// endpointHostSignatures maps an endpoint host suffix (or substring) to a
// vendor. Order matters: longer, more specific signatures must come first so
// that e.g. "r2.cloudflarestorage.com" is not shadowed by a broader rule.
var endpointHostSignatures = []struct {
	needle string
	vendor string
}{
	// Cloudflare R2: <account>.r2.cloudflarestorage.com
	{"r2.cloudflarestorage.com", VendorCloudflareR2},
	// Qiniu Kodo: s3.<region>.qiniucs.com (S3-compatible entry point)
	{"qiniucs.com", VendorQiniuKodo},
	{"qiniu.com", VendorQiniuKodo},
	// Aliyun OSS: s3.<region>.aliyuncs.com or <bucket>.<region>.aliyuncs.com
	{"aliyuncs.com", VendorAliyunOSS},
	// Tencent COS: cos.<region>.myqcloud.com
	{"myqcloud.com", VendorTencentCOS},
	{"tencentcos.cn", VendorTencentCOS},
	// MinIO: commonly served from a host carrying the product name; also the
	// default when the endpoint is a bare private address (see inferVendor).
	{"minio", VendorMinIO},
	// AWS S3: s3.<region>.amazonaws.com
	{"amazonaws.com", VendorAWSS3},
}

// InferVendor resolves the concrete storage product for a source. The explicit
// config override wins; otherwise the endpoint host is fingerprinted; finally
// the plugin family decides for non-S3 plugins.
//
// It never returns an empty string for a known plugin: callers display the
// result directly, and an empty label would read as a bug. Unknown S3-compatible
// endpoints fall back to MinIO because a self-hosted S3 gateway is by far the
// most common reason an endpoint is unrecognizable.
func InferVendor(pluginID string, config map[string]string) string {
	if override := strings.TrimSpace(config[vendorConfigKey]); override != "" {
		return normalizeVendor(override)
	}

	switch strings.TrimSpace(pluginID) {
	case PluginGitHub:
		return VendorGitHub
	case PluginS3Compatible:
		return inferS3Vendor(config)
	default:
		return VendorLocal
	}
}

// inferS3Vendor fingerprints the endpoint. An empty endpoint means the caller
// relies on the SDK's default AWS endpoint.
func inferS3Vendor(config map[string]string) string {
	host := strings.ToLower(strings.TrimSpace(config["endpoint"]))
	if host == "" {
		return VendorAWSS3
	}
	// Strip a scheme so the signatures below can match a bare host too.
	host = strings.TrimPrefix(strings.TrimPrefix(host, "https://"), "http://")

	for _, signature := range endpointHostSignatures {
		if strings.Contains(host, signature.needle) {
			return signature.vendor
		}
	}
	return VendorMinIO
}

// normalizeVendor keeps an explicit override honest. Unknown values are stored
// as given (lowercased, trimmed) rather than dropped: the user may be naming a
// provider we do not know yet, and the cloud column is free-form text.
func normalizeVendor(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}
