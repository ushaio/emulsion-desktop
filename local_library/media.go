package local_library

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"log"
	"math"
	"mime"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/evanoberholster/imagemeta"
	avifcodec "github.com/gen2brain/avif"
	heiccodec "github.com/gen2brain/heic"
	"github.com/rwcarlsen/goexif/exif"
	bmpcodec "golang.org/x/image/bmp"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
)

const (
	mediaHeaderBytes           = 64
	maxDecodeBytes             = 256 * 1024 * 1024
	maxRAWPreviewScanBytes     = 64 * 1024 * 1024
	maxEmbeddedPreviewBytes    = 64 * 1024 * 1024
	maxTIFFDirectories         = 32
	maxTIFFDirectoryEntries    = 512
	maxEmbeddedPreviewStrips   = 64
	maxImagePixels             = 180_000_000
	maxOriginalViewPixels      = 100_000_000
	maxOriginalViewMemoryBytes = 512 * 1024 * 1024
	maxGIFFrames               = 10_000
	maxEXIFStringBytes         = 4 * 1024
	maxEXIFJSONBytes           = 64 * 1024
	maxPreviewError            = 2 * 1024
)

var supportedExtensions = map[string]struct{}{
	".jpg": {}, ".jpeg": {}, ".png": {}, ".bmp": {}, ".webp": {}, ".gif": {}, ".avif": {},
	".heic": {}, ".heif": {}, ".tif": {}, ".tiff": {}, ".cr2": {}, ".cr3": {},
	".nef": {}, ".arw": {}, ".dng": {}, ".raf": {}, ".rw2": {}, ".3fr": {},
}

// videoExtensions and audioExtensions are the time-based media the library can
// play and clip. They are deliberately separate from supportedExtensions: Go
// never decodes them (playback is the frontend's job), and their grid
// thumbnails come from a frontend-captured poster frame instead of
// renderJPEGDerivative.
var videoExtensions = map[string]struct{}{".mp4": {}, ".mov": {}}
var audioExtensions = map[string]struct{}{
	".mp3": {}, ".m4a": {}, ".aac": {}, ".wav": {}, ".flac": {}, ".ogg": {},
}

func isVideoExtension(ext string) bool {
	_, ok := videoExtensions[strings.ToLower(ext)]
	return ok
}

func isAudioExtension(ext string) bool {
	_, ok := audioExtensions[strings.ToLower(ext)]
	return ok
}

// timedMediaKind reports the media_kind for playable video/audio extensions.
func timedMediaKind(ext string) (string, bool) {
	switch {
	case isVideoExtension(ext):
		return "video", true
	case isAudioExtension(ext):
		return "audio", true
	}
	return "", false
}

func isTimedMediaKind(kind string) bool {
	return kind == "video" || kind == "audio"
}

// ignoredFileNames are common OS-level junk files that are never indexed.
var ignoredFileNames = map[string]struct{}{
	"thumbs.db": {}, "ehthumbs.db": {}, "ehthumbs_vista.db": {},
	"desktop.ini": {}, ".ds_store": {},
}

// isIndexableFile reports whether a regular file should be indexed by the
// library. The library indexes every file so the local view can show all
// content; only hidden/system junk files are skipped.
func isIndexableFile(name string) bool {
	base := filepath.Base(filepath.Clean(name))
	if strings.HasPrefix(base, ".") || strings.HasPrefix(base, "._") {
		return false
	}
	_, ignored := ignoredFileNames[strings.ToLower(base)]
	return !ignored
}

var derivativeRenderer = renderJPEGDerivative

type exifMetadata struct {
	CameraMake     string
	CameraModel    string
	LensModel      string
	ISO            *int
	Aperture       *float64
	ShutterSeconds *float64
	FocalLengthMM  *float64
	Latitude       *float64
	Longitude      *float64
	RawJSON        string
}

func (m exifMetadata) empty() bool {
	return m.CameraMake == "" && m.CameraModel == "" && m.LensModel == "" && m.ISO == nil &&
		m.Aperture == nil && m.ShutterSeconds == nil && m.FocalLengthMM == nil &&
		m.Latitude == nil && m.Longitude == nil && m.RawJSON == ""
}

func isSupportedMedia(path string) bool {
	_, ok := supportedExtensions[strings.ToLower(filepath.Ext(path))]
	return ok
}

func formatForExtension(ext string) (string, string) {
	switch strings.ToLower(ext) {
	case ".jpg", ".jpeg":
		return "jpeg", "image/jpeg"
	case ".png":
		return "png", "image/png"
	case ".bmp":
		return "bmp", "image/bmp"
	case ".webp":
		return "webp", "image/webp"
	case ".gif":
		return "gif", "image/gif"
	case ".avif":
		return "avif", "image/avif"
	case ".heic", ".heif":
		return "heif", "image/heif"
	case ".tif", ".tiff":
		return "tiff", "image/tiff"
	case ".cr2":
		return "cr2", "image/x-canon-cr2"
	case ".cr3":
		return "cr3", "image/x-canon-cr3"
	case ".nef":
		return "nef", "image/x-nikon-nef"
	case ".arw":
		return "arw", "image/x-sony-arw"
	case ".dng":
		return "dng", "image/x-adobe-dng"
	case ".raf":
		return "raf", "image/x-fuji-raf"
	case ".rw2":
		return "rw2", "image/x-panasonic-rw2"
	case ".3fr":
		return "3fr", "image/x-hasselblad-3fr"
	case ".mp4":
		return "mp4", "video/mp4"
	case ".mov":
		return "mov", "video/quicktime"
	case ".mp3":
		return "mp3", "audio/mpeg"
	case ".m4a":
		return "m4a", "audio/mp4"
	case ".aac":
		return "aac", "audio/aac"
	case ".wav":
		return "wav", "audio/wav"
	case ".flac":
		return "flac", "audio/flac"
	case ".ogg":
		return "ogg", "audio/ogg"
	default:
		if detected := mime.TypeByExtension(ext); detected != "" {
			return strings.TrimPrefix(ext, "."), detected
		}
		return strings.TrimPrefix(ext, "."), "application/octet-stream"
	}
}

func formatAndMIME(format string) (string, string) {
	switch format {
	case "jpg", "jpeg":
		return "jpeg", "image/jpeg"
	case "png":
		return "png", "image/png"
	case "bmp":
		return "bmp", "image/bmp"
	case "webp":
		return "webp", "image/webp"
	case "gif":
		return "gif", "image/gif"
	case "tif", "tiff":
		return "tiff", "image/tiff"
	case "avif":
		return "avif", "image/avif"
	case "heic", "heif":
		return "heif", "image/heif"
	case "cr2":
		return "cr2", "image/x-canon-cr2"
	case "cr3":
		return "cr3", "image/x-canon-cr3"
	case "nef":
		return "nef", "image/x-nikon-nef"
	case "arw":
		return "arw", "image/x-sony-arw"
	case "dng":
		return "dng", "image/x-adobe-dng"
	case "raf":
		return "raf", "image/x-fuji-raf"
	case "rw2":
		return "rw2", "image/x-panasonic-rw2"
	case "3fr":
		return "3fr", "image/x-hasselblad-3fr"
	case "mp4":
		return "mp4", "video/mp4"
	case "mov":
		return "mov", "video/quicktime"
	case "mp3":
		return "mp3", "audio/mpeg"
	case "m4a":
		return "m4a", "audio/mp4"
	case "aac":
		return "aac", "audio/aac"
	case "wav":
		return "wav", "audio/wav"
	case "flac":
		return "flac", "audio/flac"
	case "ogg":
		return "ogg", "audio/ogg"
	default:
		return format, "application/octet-stream"
	}
}

func inspectMedia(path string, info os.FileInfo) (result indexedFile) {
	ext := strings.ToLower(filepath.Ext(path))
	candidateFormat, candidateMIME := formatForExtension(ext)
	result = indexedFile{FileName: filepath.Base(path), Extension: ext, Format: candidateFormat, MimeType: candidateMIME,
		ByteSize: info.Size(), ModifiedAtNS: info.ModTime().UnixNano(), Orientation: 1, FrameCount: 1,
		PreviewStatus: "unavailable", MetadataStatus: "partial"}
	if kind, ok := timedMediaKind(ext); ok {
		// Playable media is never decoded here: playback happens in the
		// frontend and the grid thumbnail comes from a frontend-captured
		// poster frame. Duration for mp4/mov comes from the moov box; audio
		// durations are reported by the frontend after loadedmetadata.
		result.MediaKind = kind
		result.PreviewStatus = "pending"
		result.MetadataStatus = "partial"
		if kind == "video" {
			if durationMS, durationErr := parseMP4Duration(path); durationErr == nil && durationMS > 0 {
				result.DurationMS = durationMS
			}
		}
		return result
	}
	if !isSupportedMedia(path) {
		// Non-photo files are indexed for browsing but never decoded: they
		// stay with a file-format placeholder preview.
		result.MediaKind = "file"
		result.MetadataStatus = "unavailable"
		result.PreviewError = "no decoder is available for this file type"
		return result
	}
	result.MediaKind = "image"
	defer func() {
		if recovered := recover(); recovered != nil {
			result.PreviewStatus = "unavailable"
			result.PreviewError = boundedError(fmt.Sprintf("media inspection panic: %v", recovered))
			result.MetadataStatus = "partial"
		}
	}()

	file, err := os.Open(path)
	if err != nil {
		result.PreviewError = boundedError("open media: " + err.Error())
		return result
	}
	defer file.Close()
	header := make([]byte, mediaHeaderBytes)
	headerLength, readErr := io.ReadFull(file, header)
	if readErr != nil && readErr != io.ErrUnexpectedEOF && readErr != io.EOF {
		result.PreviewError = boundedError("read media header: " + readErr.Error())
		return result
	}
	header = header[:headerLength]
	if detectedFormat, detectedMIME, ok := detectMediaHeader(header, ext); ok {
		result.Format, result.MimeType = detectedFormat, detectedMIME
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		result.PreviewError = boundedError("seek media: " + err.Error())
		return result
	}
	config, decodedFormat, decodeErr := decodeMediaConfig(path, result.Format)
	if decodeErr == nil {
		result.Format, result.MimeType = formatAndMIME(decodedFormat)
		result.Width, result.Height = config.Width, config.Height
		if err := validateDimensions(config.Width, config.Height); err != nil {
			result.PreviewError = boundedError(err.Error())
		} else {
			result.PreviewStatus, result.MetadataStatus = "pending", "ready"
		}
	} else {
		result.PreviewError = boundedError("decode metadata: " + decodeErr.Error())
	}
	if result.Format == "gif" {
		if _, err := file.Seek(0, io.SeekStart); err == nil {
			frameCount, gifErr := inspectGIFFrames(io.LimitReader(file, maxDecodeBytes))
			if gifErr != nil {
				result.PreviewStatus = "unavailable"
				result.PreviewError = boundedError("inspect GIF animation: " + gifErr.Error())
				result.MetadataStatus = "partial"
			} else {
				result.FrameCount, result.IsAnimated = frameCount, frameCount > 1
			}
		}
	}
	if supportsEXIFInspection(result.Format, ext) {
		if _, err := file.Seek(0, io.SeekStart); err == nil {
			metadata, orientation, capturedAt, exifErr := extractTypedEXIF(io.LimitReader(file, maxDecodeBytes))
			if exifErr == nil {
				result.EXIF = metadata
				if orientation >= 1 && orientation <= 8 {
					result.Orientation = orientation
				}
				result.CapturedAt = capturedAt
			}
		}
	}
	if result.PreviewStatus == "unavailable" && result.PreviewError == "" {
		result.PreviewError = "no decoder is available for this media"
	}
	return result
}

func detectMediaHeader(header []byte, ext string) (string, string, bool) {
	if len(header) >= 3 && header[0] == 0xff && header[1] == 0xd8 && header[2] == 0xff {
		return "jpeg", "image/jpeg", true
	}
	if len(header) >= 8 && string(header[:8]) == "\x89PNG\r\n\x1a\n" {
		return "png", "image/png", true
	}
	if len(header) >= 6 && (string(header[:6]) == "GIF87a" || string(header[:6]) == "GIF89a") {
		return "gif", "image/gif", true
	}
	if len(header) >= 12 && string(header[:4]) == "RIFF" && string(header[8:12]) == "WEBP" {
		return "webp", "image/webp", true
	}
	if isBMPHeader(header) {
		return "bmp", "image/bmp", true
	}
	if len(header) >= 16 && string(header[:16]) == "FUJIFILMCCD-RAW " {
		return "raf", "image/x-fuji-raf", true
	}
	if len(header) >= 4 && string(header[:4]) == "II\x55\x00" {
		return "rw2", "image/x-panasonic-rw2", true
	}
	if len(header) >= 12 && isTIFFHeader(header) {
		if string(header[8:12]) == "CR\x02\x00" {
			return "cr2", "image/x-canon-cr2", true
		}
		switch strings.ToLower(ext) {
		// 3FR is Hasselblad's TIFF-based RAW container: the header is an
		// ordinary TIFF one, so only the extension tells it apart from a
		// plain .tif.
		case ".dng", ".nef", ".arw", ".rw2", ".3fr":
			format, mimeType := formatForExtension(ext)
			return format, mimeType, true
		default:
			return "tiff", "image/tiff", true
		}
	}
	if len(header) >= 12 && string(header[4:8]) == "ftyp" {
		brands := []string{string(header[8:12])}
		for offset := 16; offset+4 <= len(header); offset += 4 {
			brands = append(brands, string(header[offset:offset+4]))
		}
		for _, brand := range brands {
			if brand == "avif" || brand == "avis" {
				return "avif", "image/avif", true
			}
		}
		for _, brand := range brands {
			if brand == "crx " || brand == "cr3 " {
				return "cr3", "image/x-canon-cr3", true
			}
		}
		for _, brand := range brands {
			switch brand {
			case "heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1":
				return "heif", "image/heif", true
			}
		}
	}
	return "", "", false
}

func isTIFFHeader(header []byte) bool {
	return len(header) >= 4 && (string(header[:4]) == "II\x2a\x00" || string(header[:4]) == "MM\x00\x2a")
}

// isBMPHeader reports whether header opens a BMP the decoder can actually read.
// The "BM" signature is only two bytes, so what keeps a random file from being
// claimed as a bitmap is the DIB header length: golang.org/x/image/bmp accepts
// BITMAPINFOHEADER (40), BITMAPV4HEADER (108) and BITMAPV5HEADER (124) only.
// This is deliberately looser than the magic image.Decode registers for BMP
// ("BM????\x00\x00\x00\x00"), which also demands a zeroed reserved field and so
// misses files that some encoders write — decodeImage calls the codec directly
// for exactly that reason.
func isBMPHeader(header []byte) bool {
	if len(header) < 18 || header[0] != 'B' || header[1] != 'M' {
		return false
	}
	dibHeaderLen := uint32(header[14]) | uint32(header[15])<<8 | uint32(header[16])<<16 | uint32(header[17])<<24
	switch dibHeaderLen {
	case 40, 108, 124:
		return true
	}
	return false
}

func validateDimensions(width, height int) error {
	if width <= 0 || height <= 0 {
		return fmt.Errorf("invalid image dimensions")
	}
	if int64(width)*int64(height) > maxImagePixels {
		return fmt.Errorf("image exceeds pixel safety limit")
	}
	return nil
}

func validateOriginalViewDimensions(width, height int) error {
	if err := validateDimensions(width, height); err != nil {
		return err
	}
	pixels := int64(width) * int64(height)
	if pixels > maxOriginalViewPixels {
		return fmt.Errorf("original exceeds view pixel limit")
	}
	if pixels > maxOriginalViewMemoryBytes/4 {
		return fmt.Errorf("original exceeds estimated decode memory limit")
	}
	return nil
}

func inspectGIFFrames(reader io.Reader) (int, error) {
	buffered := bufio.NewReader(reader)
	header := make([]byte, 13)
	if _, err := io.ReadFull(buffered, header); err != nil {
		return 0, err
	}
	if string(header[:6]) != "GIF87a" && string(header[:6]) != "GIF89a" {
		return 0, fmt.Errorf("invalid GIF signature")
	}
	if header[10]&0x80 != 0 {
		if _, err := io.CopyN(io.Discard, buffered, int64(3*(1<<((header[10]&0x07)+1)))); err != nil {
			return 0, err
		}
	}
	frames := 0
	for {
		marker, err := buffered.ReadByte()
		if err != nil {
			return 0, err
		}
		switch marker {
		case 0x3b:
			if frames == 0 {
				return 0, fmt.Errorf("GIF has no image frames")
			}
			return frames, nil
		case 0x21:
			if _, err := buffered.ReadByte(); err != nil {
				return 0, err
			}
			if err := skipGIFSubBlocks(buffered); err != nil {
				return 0, err
			}
		case 0x2c:
			descriptor := make([]byte, 9)
			if _, err := io.ReadFull(buffered, descriptor); err != nil {
				return 0, err
			}
			if descriptor[8]&0x80 != 0 {
				if _, err := io.CopyN(io.Discard, buffered, int64(3*(1<<((descriptor[8]&0x07)+1)))); err != nil {
					return 0, err
				}
			}
			if _, err := buffered.ReadByte(); err != nil {
				return 0, err
			}
			if err := skipGIFSubBlocks(buffered); err != nil {
				return 0, err
			}
			frames++
			if frames > maxGIFFrames {
				return 0, fmt.Errorf("GIF exceeds frame safety limit")
			}
		default:
			return 0, fmt.Errorf("invalid GIF block marker 0x%02x", marker)
		}
	}
}

func skipGIFSubBlocks(reader *bufio.Reader) error {
	for {
		size, err := reader.ReadByte()
		if err != nil {
			return err
		}
		if size == 0 {
			return nil
		}
		if _, err := io.CopyN(io.Discard, reader, int64(size)); err != nil {
			return err
		}
	}
}

func supportsEXIFInspection(format, ext string) bool {
	switch format {
	case "jpeg", "tiff", "cr2", "dng", "nef", "arw", "rw2", "3fr":
		return true
	}
	switch strings.ToLower(ext) {
	case ".jpg", ".jpeg", ".tif", ".tiff", ".cr2", ".dng", ".nef", ".arw", ".rw2", ".3fr":
		return true
	}
	return false
}

func extractTypedEXIF(reader io.Reader) (exifMetadata, int, *time.Time, error) {
	x, err := exif.Decode(reader)
	if err != nil {
		return exifMetadata{}, 1, nil, err
	}
	metadata := exifMetadata{CameraMake: exifString(x, exif.Make), CameraModel: exifString(x, exif.Model), LensModel: exifString(x, exif.LensModel)}
	metadata.ISO, metadata.Aperture = exifInt(x, exif.ISOSpeedRatings), exifRational(x, exif.FNumber)
	metadata.ShutterSeconds, metadata.FocalLengthMM = exifRational(x, exif.ExposureTime), exifRational(x, exif.FocalLength)
	if latitude, longitude, gpsErr := x.LatLong(); gpsErr == nil {
		metadata.Latitude, metadata.Longitude = &latitude, &longitude
	}
	orientation := 1
	if value := exifInt(x, exif.Orientation); value != nil && *value >= 1 && *value <= 8 {
		orientation = *value
	}
	raw := map[string]string{}
	for _, field := range []exif.FieldName{exif.Make, exif.Model, exif.LensModel, exif.FocalLength, exif.FNumber, exif.ExposureTime, exif.ISOSpeedRatings, exif.DateTimeOriginal, exif.Orientation, exif.Software} {
		if tag, getErr := x.Get(field); getErr == nil {
			raw[string(field)] = boundedString(tag.String(), maxEXIFStringBytes)
		}
	}
	if payload, marshalErr := json.Marshal(raw); marshalErr == nil && len(payload) <= maxEXIFJSONBytes && len(raw) > 0 {
		metadata.RawJSON = string(payload)
	}
	return metadata, orientation, exifTime(x), nil
}

func exifString(x *exif.Exif, field exif.FieldName) string {
	tag, err := x.Get(field)
	if err != nil {
		return ""
	}
	value, err := tag.StringVal()
	if err != nil {
		return ""
	}
	return boundedString(strings.TrimSpace(value), maxEXIFStringBytes)
}
func exifInt(x *exif.Exif, field exif.FieldName) *int {
	tag, err := x.Get(field)
	if err != nil {
		return nil
	}
	value, err := tag.Int(0)
	if err != nil {
		return nil
	}
	return &value
}
func exifRational(x *exif.Exif, field exif.FieldName) *float64 {
	tag, err := x.Get(field)
	if err != nil {
		return nil
	}
	numerator, denominator, err := tag.Rat2(0)
	if err != nil || denominator == 0 {
		return nil
	}
	value := float64(numerator) / float64(denominator)
	return &value
}
func exifTime(x *exif.Exif) *time.Time {
	for _, field := range []exif.FieldName{exif.DateTimeOriginal, exif.DateTimeDigitized, exif.DateTime} {
		tag, err := x.Get(field)
		if err != nil {
			continue
		}
		value, err := tag.StringVal()
		if err != nil {
			continue
		}
		parsed, err := time.Parse("2006:01:02 15:04:05", strings.TrimSpace(value))
		if err == nil {
			parsed = parsed.UTC()
			return &parsed
		}
	}
	return nil
}
func boundedString(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	value = value[:limit]
	for !utf8.ValidString(value) && len(value) > 0 {
		value = value[:len(value)-1]
	}
	return value
}
func boundedError(value string) string { return boundedString(value, maxPreviewError) }

// dominantColorVersion records which revision of the extraction algorithm
// produced a stored palette. Rows written before versioning existed read as 0,
// so the first scan after an algorithm change re-extracts them instead of
// leaving a stale colour card in place. Bump it whenever
// extractDominantColors changes shape.
const dominantColorVersion = 1

const (
	// A pixel at the centre of the frame counts up to 2.6x one at a corner.
	// The subject is off-centre in plenty of photographs, so this stays a mild
	// prior rather than a hard crop: it breaks ties between two regions of
	// similar area instead of dictating the answer.
	dominantColorCenterBonus = 1.6
	// Two swatches closer than this in CIELAB are the same colour as far as the
	// eye is concerned, and collapsing them is what keeps a card from showing
	// five shades of the same background.
	dominantColorMinDeltaE = 12.0
)

// dominantColorPass is one attempt at building a palette with a given set of
// "what counts as a real colour" thresholds.
type dominantColorPass struct {
	minL, maxL float64
	minChroma  float64
	// ignoreAlpha is the last-resort escape hatch: a fully transparent image
	// would otherwise yield no colour at all, and an empty card marks the asset
	// as unfinished so every later scan re-queues it.
	ignoreAlpha bool
}

// dominantColorPasses are tried in order until one yields a palette. The first
// pass is the one that matters: it drops near-black shadows, blown highlights
// and desaturated greys. Without it a large dark background outvotes a small
// subject, because the old pixel-count ranking rewarded area alone and the 4-bit
// RGB buckets split a noisy gradient into dozens of neighbouring entries that
// each looked like a distinct colour. The relaxed passes exist so genuinely
// dark or monochrome photographs still get a card.
// The ceilings above 100 are deliberate: pure white evaluates to
// L* = 100.0000039 rather than exactly 100, and a last-resort pass that
// rejected it would return an empty card for a blown-out or blank scan.
var dominantColorPasses = []dominantColorPass{
	{minL: 25, maxL: 95, minChroma: 8},
	{minL: 8, maxL: 98, minChroma: 3},
	{minL: 0, maxL: 101, minChroma: 0},
	{minL: 0, maxL: 101, minChroma: 0, ignoreAlpha: true},
}

type dominantColorBucket struct {
	weight  float64
	r, g, b float64
}

type labColor struct{ l, a, b float64 }

// srgbToLinearLUT replaces the per-pixel pow() in the sRGB -> linear leg. The
// palette samples up to ~40k pixels per asset, and this keeps the colour space
// conversion off the critical path.
var srgbToLinearLUT = func() (lut [256]float64) {
	for i := 0; i < 256; i++ {
		u := float64(i) / 255
		if u <= 0.04045 {
			lut[i] = u / 12.92
		} else {
			lut[i] = math.Pow((u+0.055)/1.055, 2.4)
		}
	}
	return lut
}()

func srgbToLab(r, g, b uint8) labColor {
	linearR := srgbToLinearLUT[r]
	linearG := srgbToLinearLUT[g]
	linearB := srgbToLinearLUT[b]
	x := (linearR*0.4124564 + linearG*0.3575761 + linearB*0.1804375) / 0.95047
	y := (linearR*0.2126729 + linearG*0.7151522 + linearB*0.0721750)
	z := (linearR*0.0193339 + linearG*0.1191920 + linearB*0.9503041) / 1.08883
	fx, fy, fz := labTransfer(x), labTransfer(y), labTransfer(z)
	return labColor{l: 116*fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz)}
}

// labTransferSteps sizes a nearest-neighbour table for the CIELAB transfer
// function. math.Cbrt is a software routine in Go and, at three calls per
// pixel, it dominated the cost of building a palette — roughly 2ms per asset
// before this table. With 8192 steps the worst-case error stays under 0.06 L*,
// two orders of magnitude below the 8-unit bucketing step, so no filter or
// bucket boundary moves.
const labTransferSteps = 8192

var labTransferLUT = func() (lut [labTransferSteps]float64) {
	for i := range lut {
		lut[i] = labTransferExact(float64(i) / (labTransferSteps - 1))
	}
	return lut
}()

func labTransferExact(t float64) float64 {
	if t > 0.008856 {
		return math.Cbrt(t)
	}
	return 7.787*t + 16.0/116.0
}

func labTransfer(t float64) float64 {
	index := int(t * (labTransferSteps - 1))
	if index < 0 {
		index = 0
	} else if index >= labTransferSteps {
		index = labTransferSteps - 1
	}
	return labTransferLUT[index]
}

func (c labColor) chroma() float64 { return math.Sqrt(c.a*c.a + c.b*c.b) }

func (c labColor) deltaE76(other labColor) float64 {
	dl, da, db := c.l-other.l, c.a-other.a, c.b-other.b
	return math.Sqrt(dl*dl + da*da + db*db)
}

// dominantColorKey quantises a colour in CIELAB rather than in raw RGB: an
// 8-unit step in L* and 12-unit steps in a*/b* are both below the
// just-noticeable difference, so one bucket holds one perceived colour instead
// of splitting a smooth gradient across many neighbouring RGB bins.
func dominantColorKey(c labColor) uint32 {
	lBin := clampInt(int(c.l/8), 0, 15)
	aBin := clampInt(int((c.a+128)/12), 0, 31)
	bBin := clampInt(int((c.b+128)/12), 0, 31)
	return uint32(lBin)<<10 | uint32(aBin)<<5 | uint32(bBin)
}

func clampInt(value, low, high int) int {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func extractDominantColors(source image.Image, count int) []string {
	if source == nil || count <= 0 {
		return nil
	}
	bounds := source.Bounds()
	if bounds.Dx() <= 0 || bounds.Dy() <= 0 {
		return nil
	}
	step := 1
	for bounds.Dx()/step > 200 || bounds.Dy()/step > 200 {
		step++
	}
	for _, pass := range dominantColorPasses {
		if colors := sampleDominantColors(source, bounds, step, count, pass); len(colors) > 0 {
			return colors
		}
	}
	return nil
}

func sampleDominantColors(source image.Image, bounds image.Rectangle, step, count int, pass dominantColorPass) []string {
	centerX := float64(bounds.Min.X+bounds.Max.X) / 2
	centerY := float64(bounds.Min.Y+bounds.Max.Y) / 2
	halfW, halfH := float64(bounds.Dx())/2, float64(bounds.Dy())/2
	maxDistance := math.Sqrt(halfW*halfW + halfH*halfH)
	if maxDistance <= 0 {
		maxDistance = 1
	}
	buckets := make(map[uint32]*dominantColorBucket, 64)
	for y := bounds.Min.Y; y < bounds.Max.Y; y += step {
		for x := bounds.Min.X; x < bounds.Max.X; x += step {
			// One interface call per pixel instead of two (At plus a model
			// conversion): At().RGBA() yields premultiplied 16-bit components,
			// which is all this needs. 125<<8 is the same 125/255 opacity
			// cut-off the previous version applied.
			r16, g16, b16, a16 := source.At(x, y).RGBA()
			if a16 < 125<<8 && !pass.ignoreAlpha {
				continue
			}
			// Color.RGBA reports premultiplied components, so undo that before
			// judging the colour: otherwise a partly transparent PNG reads as a
			// darker version of itself. Fully opaque pixels take the cheap path.
			var r, g, b uint8
			if a16 == 0xffff {
				r, g, b = uint8(r16>>8), uint8(g16>>8), uint8(b16>>8)
			} else if a16 > 0 {
				r = uint8(uint64(r16) * 0xffff / uint64(a16) >> 8)
				g = uint8(uint64(g16) * 0xffff / uint64(a16) >> 8)
				b = uint8(uint64(b16) * 0xffff / uint64(a16) >> 8)
			}
			lab := srgbToLab(r, g, b)
			if lab.l < pass.minL || lab.l > pass.maxL {
				continue
			}
			chroma := lab.chroma()
			if chroma < pass.minChroma {
				continue
			}
			dx, dy := float64(x)-centerX, float64(y)-centerY
			distance := math.Sqrt(dx*dx+dy*dy) / maxDistance
			// Area is implicit: every sampled pixel contributes, so a region
			// twice as large scores twice as high. The remaining two factors
			// push that score toward vivid colours near the centre.
			weight := (1 + dominantColorCenterBonus*(1-distance)) * (0.25 + chroma/60)
			key := dominantColorKey(lab)
			bucket := buckets[key]
			if bucket == nil {
				bucket = &dominantColorBucket{}
				buckets[key] = bucket
			}
			bucket.weight += weight
			bucket.r += float64(r) * weight
			bucket.g += float64(g) * weight
			bucket.b += float64(b) * weight
		}
	}
	values := make([]*dominantColorBucket, 0, len(buckets))
	for _, bucket := range buckets {
		values = append(values, bucket)
	}
	sort.Slice(values, func(i, j int) bool { return values[i].weight > values[j].weight })

	result := make([]string, 0, count)
	seen := make([]labColor, 0, count)
	for _, bucket := range values {
		r, g, b := roundToByte(bucket.r/bucket.weight), roundToByte(bucket.g/bucket.weight), roundToByte(bucket.b/bucket.weight)
		lab := srgbToLab(r, g, b)
		duplicate := false
		for _, other := range seen {
			if lab.deltaE76(other) < dominantColorMinDeltaE {
				duplicate = true
				break
			}
		}
		if duplicate {
			continue
		}
		seen = append(seen, lab)
		result = append(result, fmt.Sprintf("#%02x%02x%02x", r, g, b))
		if len(result) >= count {
			break
		}
	}
	return result
}

func roundToByte(value float64) uint8 {
	rounded := int(value + 0.5)
	return uint8(clampInt(rounded, 0, 255))
}

func decodeImage(path string) (image.Image, error) {
	ext := filepath.Ext(path)
	if isRAWExtension(ext) {
		preview, err := extractRAWPreview(path)
		if err != nil {
			return nil, err
		}
		return jpeg.Decode(bytes.NewReader(preview))
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	format, _ := formatForExtension(ext)
	header := make([]byte, mediaHeaderBytes)
	headerLength, readErr := io.ReadFull(file, header)
	if readErr != nil && readErr != io.ErrUnexpectedEOF && readErr != io.EOF {
		return nil, readErr
	}
	if detectedFormat, _, ok := detectMediaHeader(header[:headerLength], ext); ok {
		format = detectedFormat
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	switch strings.ToLower(format) {
	case "avif":
		return avifcodec.Decode(io.LimitReader(file, maxDecodeBytes))
	case "heic", "heif":
		return heiccodec.Decode(io.LimitReader(file, maxDecodeBytes))
	case "bmp":
		// Called directly rather than through image.Decode: the registered BMP
		// magic also requires a zeroed reserved field, and the format has
		// already been established above.
		return bmpcodec.Decode(io.LimitReader(file, maxDecodeBytes))
	}
	source, _, err := image.Decode(io.LimitReader(file, maxDecodeBytes))
	return source, err
}

func decodeMediaConfig(path, format string) (image.Config, string, error) {
	return decodeMediaConfigContext(context.Background(), path, format)
}

func decodeMediaConfigContext(ctx context.Context, path, format string) (image.Config, string, error) {
	if isRAWFormat(format) {
		preview, err := extractRAWPreviewContext(ctx, path)
		if err != nil {
			return image.Config{}, "", err
		}
		config, err := jpeg.DecodeConfig(contextBoundReader{ctx: ctx, reader: bytes.NewReader(preview)})
		return config, format, err
	}
	file, err := os.Open(path)
	if err != nil {
		return image.Config{}, "", err
	}
	defer file.Close()
	return decodeMediaConfigReaderContext(ctx, file, format)
}

func decodeMediaConfigReaderContext(ctx context.Context, source io.Reader, format string) (image.Config, string, error) {
	if err := ctx.Err(); err != nil {
		return image.Config{}, "", err
	}
	reader := contextBoundReader{ctx: ctx, reader: source}
	switch strings.ToLower(format) {
	case "avif":
		config, err := avifcodec.DecodeConfig(io.LimitReader(reader, maxDecodeBytes))
		return config, "avif", err
	case "heic", "heif":
		config, err := heiccodec.DecodeConfig(io.LimitReader(reader, maxDecodeBytes))
		return config, "heif", err
	case "bmp":
		config, err := bmpcodec.DecodeConfig(io.LimitReader(reader, maxDecodeBytes))
		return config, "bmp", err
	}
	return image.DecodeConfig(io.LimitReader(reader, maxDecodeBytes))
}

func decodeImageConfig(path string) (image.Config, error) {
	format, _ := formatForExtension(filepath.Ext(path))
	config, _, err := decodeMediaConfig(path, format)
	return config, err
}

func isRAWExtension(ext string) bool {
	switch strings.ToLower(ext) {
	case ".cr2", ".cr3", ".nef", ".arw", ".dng", ".raf", ".rw2", ".3fr":
		return true
	}
	return false
}

func isRAWFormat(format string) bool {
	switch strings.ToLower(format) {
	case "cr2", "cr3", "nef", "arw", "dng", "raf", "rw2", "3fr":
		return true
	}
	return false
}

func extractRAWPreview(path string) ([]byte, error) {
	return extractRAWPreviewContext(context.Background(), path)
}

func extractRAWPreviewContext(ctx context.Context, path string) ([]byte, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if strings.EqualFold(filepath.Ext(path), ".cr3") {
		if preview, previewErr := imagemeta.PreviewCR3(file); previewErr == nil {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			default:
			}
			if config, configErr := jpeg.DecodeConfig(bytes.NewReader(preview)); configErr == nil && validateDimensions(config.Width, config.Height) == nil {
				return preview, nil
			}
		}
		if _, err := file.Seek(0, io.SeekStart); err != nil {
			return nil, err
		}
	}
	return embeddedRAWPreview(ctx, file)
}

// embeddedRAWPreview returns the JPEG preview embedded in a RAW container,
// looking where the container says it is before falling back to a blind scan.
//
// The TIFF-based containers (DNG, NEF, ARW, RW2, 3FR, ...) record where their
// preview lives in an IFD, and that is the only reliable way to find it in a
// large file: Hasselblad's 3FR in particular parks its preview in the last
// couple of megabytes behind ~200 MB of uncompressed sensor data, which the
// fixed-size scan below can never reach.
//
// The scan is only merged in when it can read the whole file, because only then
// is it exhaustive. That preserves the old behaviour exactly for the files the
// old code handled — where "the largest JPEG in the first 64 MB" was the answer —
// while a file too large to scan falls back to the pointers, which is strictly
// better than the failure it used to produce.
func embeddedRAWPreview(ctx context.Context, file *os.File) ([]byte, error) {
	return embeddedRAWPreviewWithValidator(ctx, file, validateDimensions)
}

// embeddedRAWPreviewWithValidator is embeddedRAWPreview with a caller-supplied
// size policy: the inspector accepts anything decodable, while the
// full-resolution viewer applies its own stricter pixel and memory limits.
func embeddedRAWPreviewWithValidator(ctx context.Context, file *os.File, validate func(int, int) error) ([]byte, error) {
	fileSize, err := readableSize(file)
	if err != nil {
		return nil, err
	}
	candidates, err := tiffEmbeddedJPEGs(ctx, file)
	if err != nil {
		return nil, err
	}
	best, bestArea := largestUsableJPEG(ctx, candidates, validate)

	var scanErr error
	scanIsExhaustive := fileSize <= maxRAWPreviewScanBytes
	if scanIsExhaustive {
		if _, seekErr := file.Seek(0, io.SeekStart); seekErr != nil {
			return nil, seekErr
		}
		scanned, err := largestEmbeddedJPEGWithValidatorContext(ctx, file, maxRAWPreviewScanBytes, validate)
		scanErr = err
		if err == nil {
			if config, configErr := jpeg.DecodeConfig(contextBoundReader{ctx: ctx, reader: bytes.NewReader(scanned)}); configErr == nil {
				if area := int64(config.Width) * int64(config.Height); area > bestArea {
					best = scanned
				}
			}
		}
	}
	if best != nil {
		return best, nil
	}
	if len(candidates) > 0 {
		// The container pointed at a preview, but it did not decode; saying so
		// is more useful than the scan's size message, which would misdescribe
		// a file that was scanned in full.
		return nil, fmt.Errorf("RAW embedded preview is not decodable")
	}
	if scanErr != nil {
		return nil, scanErr
	}
	if scanIsExhaustive {
		return nil, fmt.Errorf("RAW contains no decodable embedded JPEG preview")
	}
	return nil, fmt.Errorf("RAW exceeds preview scan limit")
}

// tiffEmbeddedJPEGs follows the IFD chain and the sub-IFDs of a TIFF-based
// container and returns every byte range that is declared to hold a JPEG.
//
// Only the pointers are trusted, never the declared lengths: cameras are
// inconsistent about StripByteCounts/JPEGInterchangeFormatLength (and some
// write more than one IMAGE_LENGTH), so each range is re-parsed through the
// JPEG marker chain to find its real end. A range that does not begin with an
// SOI marker is skipped, which is what keeps the uncompressed sensor strips of
// a 3FR from being mistaken for a preview.
func tiffEmbeddedJPEGs(ctx context.Context, file *os.File) ([][]byte, error) {
	fileSize, err := readableSize(file)
	if err != nil {
		return nil, err
	}
	header := make([]byte, 8)
	if _, err := file.ReadAt(header, 0); err != nil {
		return nil, nil
	}
	var order binary.ByteOrder
	switch string(header[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return nil, nil
	}
	if order.Uint16(header[2:4]) != 0x002A {
		return nil, nil
	}
	visited := make(map[uint32]struct{})
	pending := []uint32{order.Uint32(header[4:8])}
	var previews [][]byte
	for len(pending) > 0 && len(visited) < maxTIFFDirectories {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		offset := pending[0]
		pending = pending[1:]
		if offset < 8 || int64(offset)+2 > fileSize {
			continue
		}
		if _, seen := visited[offset]; seen {
			continue
		}
		visited[offset] = struct{}{}
		fields, next, readErr := readTIFFDirectory(file, order, offset, fileSize)
		if readErr != nil {
			continue
		}
		if next > 0 {
			pending = append(pending, next)
		}
		for _, field := range fields {
			switch field.tag {
			case tiffTagSubIFDs, tiffTagExifIFD, tiffTagGPSIFD:
				// Sub-IFD pointers are SINGLE values, so a malformed count
				// cannot make this walk hundreds of bogus directories.
				pending = append(pending, numericValues(file, order, field, 1)...)
			case tiffTagStripOffsets, tiffTagTileOffsets, tiffTagJPEGOffset:
				previews = append(previews, readJPEGRanges(ctx, file, order, field, fields, fileSize)...)
			}
		}
	}
	return previews, nil
}

// readJPEGRanges resolves one offset field into the JPEG previews it points at.
//
// Strip/tile offsets are arrays, and a preview may be split across several
// consecutive strips. Runs of contiguous strips are therefore merged back into
// one range before being read, while a non-contiguous layout falls back to the
// first pointer alone. The SOI check in readJPEGAt is what makes this safe for
// the other arrays sharing the same two tags: uncompressed sensor strips do not
// start with 0xFFD8FF, so they are rejected before a single byte is buffered.
func readJPEGRanges(ctx context.Context, file *os.File, order binary.ByteOrder, offsets tiffField, fields []tiffField, fileSize int64) [][]byte {
	var lengthTag uint16 = tiffTagStripByteCounts
	switch offsets.tag {
	case tiffTagTileOffsets:
		lengthTag = tiffTagTileByteCounts
	case tiffTagJPEGOffset:
		lengthTag = tiffTagJPEGLength
	}
	declared := declaredLengthFor(file, order, fields, lengthTag)
	values := numericValues(file, order, offsets, maxEmbeddedPreviewStrips)
	if len(values) == 0 {
		return nil
	}
	start, total := int64(values[0]), int64(0)
	if len(declared) > 0 {
		total = declared[0]
	}
	var previews [][]byte
	flush := func() {
		if preview, readErr := readJPEGAt(ctx, file, start, total, fileSize); readErr == nil && preview != nil {
			previews = append(previews, preview)
		}
	}
	for index := 1; index < len(values); index++ {
		previousEnd := start + total
		next := int64(values[index])
		// Only a run that actually continues the range is merged; anything else
		// starts a fresh one, capped so a corrupt count cannot make this walk a
		// whole directory of strips.
		if total > 0 && next == previousEnd && len(previews) < maxEmbeddedPreviewStrips {
			nextLength := int64(0)
			if index < len(declared) {
				nextLength = declared[index]
			}
			total += nextLength
			continue
		}
		flush()
		start = next
		total = 0
		if index < len(declared) {
			total = declared[index]
		}
	}
	flush()
	return previews
}

func declaredLengthFor(file *os.File, order binary.ByteOrder, fields []tiffField, tag uint16) []int64 {
	for _, field := range fields {
		if field.tag != tag {
			continue
		}
		values := numericValues(file, order, field, maxTIFFDirectoryEntries)
		lengths := make([]int64, 0, len(values))
		for _, value := range values {
			lengths = append(lengths, int64(value))
		}
		return lengths
	}
	return nil
}

// largestUsableJPEG decodes the header of every candidate and returns the one
// with the largest area, matching the "biggest embedded preview" policy the
// blind scan has always applied.
func largestUsableJPEG(ctx context.Context, candidates [][]byte, validate func(int, int) error) ([]byte, int64) {
	var best []byte
	var bestArea int64
	for _, candidate := range candidates {
		if ctx.Err() != nil {
			return best, bestArea
		}
		config, configErr := jpeg.DecodeConfig(contextBoundReader{ctx: ctx, reader: bytes.NewReader(candidate)})
		if configErr != nil || validate(config.Width, config.Height) != nil {
			continue
		}
		area := int64(config.Width) * int64(config.Height)
		if area > bestArea {
			bestArea, best = area, candidate
		}
	}
	return best, bestArea
}

// readJPEGAt reads the JPEG that starts at offset. The declared length only
// bounds how much is read up front; the payload is trimmed to the real EOI so a
// camera that overstates its preview size cannot pull the following sensor data
// into the value handed to the decoder.
func readJPEGAt(ctx context.Context, file *os.File, offset, declaredLength, fileSize int64) ([]byte, error) {
	if offset < 0 || offset+3 > fileSize {
		return nil, nil
	}
	probe := make([]byte, 3)
	if _, err := file.ReadAt(probe, offset); err != nil {
		return nil, err
	}
	if !bytes.Equal(probe, []byte{0xFF, 0xD8, 0xFF}) {
		return nil, nil
	}
	available := fileSize - offset
	readSize := available
	if declaredLength > 0 && declaredLength < readSize {
		readSize = declaredLength
	}
	if readSize > maxEmbeddedPreviewBytes {
		readSize = maxEmbeddedPreviewBytes
	}
	payload := make([]byte, readSize)
	read, err := file.ReadAt(payload, offset)
	if err != nil && err != io.EOF {
		return nil, err
	}
	payload = payload[:read]
	end, err := jpegEndOffset(payload)
	if err != nil {
		return nil, err
	}
	if end <= 0 {
		return nil, nil
	}
	return payload[:end], nil
}

// jpegEndOffset walks the JPEG marker chain and returns the offset just past the
// EOI marker. Scanning for the raw 0xFFD9 pair instead would be wrong: those two
// bytes occur inside entropy-coded scan data, so the first match can cut a
// preview in half.
func jpegEndOffset(data []byte) (int, error) {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 0, nil
	}
	for index := 2; index+1 < len(data); {
		if data[index] != 0xFF {
			index++
			continue
		}
		marker := data[index+1]
		switch {
		case marker == 0xFF:
			index++
			continue
		case marker == 0x01 || (marker >= 0xD0 && marker <= 0xD8):
			index += 2
			continue
		case marker == 0xD9:
			return index + 2, nil
		case marker == 0xDA:
			// Start of scan: entropy-coded data runs until the next marker that
			// is not a stuffed 0xFF00 or a restart marker.
			index += 2
			for index+1 < len(data) {
				if data[index] != 0xFF {
					index++
					continue
				}
				next := data[index+1]
				if next == 0x00 || next == 0xFF || (next >= 0xD0 && next <= 0xD7) {
					index += 2
					continue
				}
				break
			}
		default:
			if index+3 >= len(data) {
				return 0, nil
			}
			segmentLength := int(binary.BigEndian.Uint16(data[index+2 : index+4]))
			if segmentLength < 2 {
				return 0, nil
			}
			index += 2 + segmentLength
		}
	}
	return 0, nil
}

func readableSize(file *os.File) (int64, error) {
	info, err := file.Stat()
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

// TIFF tags this build follows. Only the pointer-bearing ones are needed: the
// preview is located, not interpreted.
const (
	tiffTagStripOffsets     = 0x0111
	tiffTagStripByteCounts  = 0x0117
	tiffTagTileOffsets      = 0x0144
	tiffTagTileByteCounts   = 0x0145
	tiffTagJPEGOffset       = 0x0201
	tiffTagJPEGLength       = 0x0202
	tiffTagSubIFDs          = 0x014A
	tiffTagExifIFD          = 0x8769
	tiffTagGPSIFD           = 0x8825
	tiffInlineValueCapacity = 4
)

// TIFF field types, as numbered by the specification. The widths are what decides
// whether a value sits inline or behind a pointer, so every type the walk may
// encounter has to be classified even though only the integer ones are read.
const (
	tiffTypeByte      = 1
	tiffTypeASCII     = 2
	tiffTypeShort     = 3
	tiffTypeLong      = 4
	tiffTypeRational  = 5
	tiffTypeSByte     = 6
	tiffTypeUndefined = 7
	tiffTypeSShort    = 8
	tiffTypeSLong     = 9
	tiffTypeSRational = 10
	tiffTypeFloat     = 11
	tiffTypeDouble    = 12
)

// tiffField is one IFD entry. raw holds the four inline bytes or the offset of
// the out-of-line payload, depending on how much the declared type needs.
type tiffField struct {
	tag    uint16
	kind   uint16
	count  uint32
	raw    [4]byte
	inline bool
}

// tiffTypeSize returns the byte width of one value of the given TIFF type. Zero
// means the type is unknown to this build, which makes the field unusable.
func tiffTypeSize(kind uint16) int {
	switch kind {
	case tiffTypeByte, tiffTypeASCII, tiffTypeSByte, tiffTypeUndefined:
		return 1
	case tiffTypeShort, tiffTypeSShort:
		return 2
	case tiffTypeLong, tiffTypeSLong, tiffTypeFloat:
		return 4
	case tiffTypeRational, tiffTypeSRational, tiffTypeDouble:
		return 8
	}
	return 0
}

// numericValues resolves up to maxValues integers of the field, reading the
// out-of-line payload when the declared type is wider than the four inline
// bytes. Rationals and floats yield nothing: no pointer tag uses them, and
// reinterpreting their bytes as an offset would point at random data.
func numericValues(file *os.File, order binary.ByteOrder, field tiffField, maxValues int) []uint32 {
	size := tiffTypeSize(field.kind)
	if size == 0 || field.count == 0 {
		return nil
	}
	switch field.kind {
	case tiffTypeRational, tiffTypeSRational, tiffTypeFloat, tiffTypeDouble:
		return nil
	}
	count := int(field.count)
	if count > maxValues {
		count = maxValues
	}
	payload := field.raw[:]
	if !field.inline {
		payload = make([]byte, count*size)
		if _, err := file.ReadAt(payload, int64(field.payloadOffset(order))); err != nil {
			return nil
		}
	} else if count*size > len(payload) {
		count = len(payload) / size
	}
	values := make([]uint32, 0, count)
	for index := 0; index < count; index++ {
		chunk := payload[index*size : index*size+size]
		switch field.kind {
		case tiffTypeByte, tiffTypeASCII, tiffTypeSByte, tiffTypeUndefined:
			values = append(values, uint32(chunk[0]))
		case tiffTypeShort, tiffTypeSShort:
			values = append(values, uint32(order.Uint16(chunk)))
		default:
			values = append(values, order.Uint32(chunk))
		}
	}
	return values
}

// tiffFieldOffset returns where the field's payload lives when it does not fit
// in the four inline bytes.
func (field tiffField) payloadOffset(order binary.ByteOrder) uint32 {
	return order.Uint32(field.raw[0:4])
}

// readTIFFDirectory reads one IFD: the entry count, the entries, and the offset
// of the next directory. A container that lies about its entry count is cut off
// at maxTIFFDirectoryEntries instead of being allowed to allocate on demand.
func readTIFFDirectory(file *os.File, order binary.ByteOrder, offset uint32, fileSize int64) ([]tiffField, uint32, error) {
	countBytes := make([]byte, 2)
	if _, err := file.ReadAt(countBytes, int64(offset)); err != nil {
		return nil, 0, err
	}
	count := int(order.Uint16(countBytes))
	if count == 0 {
		return nil, 0, nil
	}
	if count > maxTIFFDirectoryEntries {
		count = maxTIFFDirectoryEntries
	}
	payload := make([]byte, count*12)
	if _, err := file.ReadAt(payload, int64(offset)+2); err != nil {
		return nil, 0, err
	}
	fields := make([]tiffField, 0, count)
	for index := 0; index < count; index++ {
		chunk := payload[index*12 : index*12+12]
		field := tiffField{
			tag:   order.Uint16(chunk[0:2]),
			kind:  order.Uint16(chunk[2:4]),
			count: order.Uint32(chunk[4:8]),
		}
		copy(field.raw[:], chunk[8:12])
		field.inline = int64(field.count)*int64(tiffTypeSize(field.kind)) <= tiffInlineValueCapacity
		fields = append(fields, field)
	}
	nextBytes := make([]byte, 4)
	if _, err := file.ReadAt(nextBytes, int64(offset)+2+int64(count)*12); err != nil {
		return fields, 0, nil
	}
	return fields, order.Uint32(nextBytes), nil
}

type contextBoundReader struct {
	ctx    context.Context
	reader io.Reader
}

func (reader contextBoundReader) Read(buffer []byte) (int, error) {
	select {
	case <-reader.ctx.Done():
		return 0, reader.ctx.Err()
	default:
		return reader.reader.Read(buffer)
	}
}

func largestEmbeddedJPEG(reader io.Reader, limit int64) ([]byte, error) {
	return largestEmbeddedJPEGWithValidatorContext(context.Background(), reader, limit, validateDimensions)
}

func largestEmbeddedJPEGWithValidator(reader io.Reader, limit int64, validate func(int, int) error) ([]byte, error) {
	return largestEmbeddedJPEGWithValidatorContext(context.Background(), reader, limit, validate)
}

func largestEmbeddedJPEGWithValidatorContext(ctx context.Context, reader io.Reader, limit int64, validate func(int, int) error) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(contextBoundReader{ctx: ctx, reader: reader}, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("RAW exceeds preview scan limit")
	}
	var best []byte
	var bestArea int64
	for offset := 0; offset+3 < len(data); {
		start, findErr := findBytesContext(ctx, data, offset, []byte{0xff, 0xd8, 0xff})
		if findErr != nil {
			return nil, findErr
		}
		if start < 0 {
			break
		}
		endMarker, findErr := findBytesContext(ctx, data, start+3, []byte{0xff, 0xd9})
		if findErr != nil {
			return nil, findErr
		}
		if endMarker < 0 {
			break
		}
		candidate := data[start : endMarker+2]
		config, configErr := jpeg.DecodeConfig(contextBoundReader{ctx: ctx, reader: bytes.NewReader(candidate)})
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		if configErr == nil && validate(config.Width, config.Height) == nil {
			area := int64(config.Width) * int64(config.Height)
			if area > bestArea {
				bestArea = area
				best = candidate
			}
		}
		offset = start + 3
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	if len(best) == 0 {
		return nil, fmt.Errorf("RAW contains no decodable embedded JPEG preview")
	}
	return best, nil
}

func findBytesContext(ctx context.Context, data []byte, offset int, needle []byte) (int, error) {
	const scanChunkBytes = 64 * 1024
	for offset+len(needle) <= len(data) {
		if err := ctx.Err(); err != nil {
			return -1, err
		}
		end := min(len(data), offset+scanChunkBytes+len(needle)-1)
		if index := bytes.Index(data[offset:end], needle); index >= 0 {
			return offset + index, nil
		}
		if end == len(data) {
			break
		}
		offset += scanChunkBytes
	}
	return -1, nil
}

func renderJPEGThumbnail(ctx context.Context, sourcePath, destination string, maxDimension int) error {
	_, err := renderJPEGDerivative(ctx, sourcePath, destination, maxDimension, 1)
	return err
}

// derivativeRender describes a generated derivative. Returning the geometry and
// the dominant colours avoids re-reading and re-decoding the file that was just
// written: the previous implementation decoded the destination twice (once for
// its dimensions, once in a goroutine for the colours) for every asset.
type derivativeRender struct {
	Width    int
	Height   int
	ByteSize int64
	Colors   []string
}

func renderJPEGDerivative(ctx context.Context, sourcePath, destination string, maxDimension, orientation int) (rendered derivativeRender, err error) {
	startedAt := time.Now()
	decodeStartedAt := startedAt
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("thumbnail decoder panic: %v", recovered)
		}
	}()
	source, err := decodeImage(sourcePath)
	if err != nil {
		return derivativeRender{}, err
	}
	decodeElapsed := time.Since(decodeStartedAt)
	bounds := source.Bounds()
	width, height := bounds.Dx(), bounds.Dy()
	if err := validateDimensions(width, height); err != nil {
		return derivativeRender{}, err
	}
	// Compute the post-orientation dimensions without materializing a rotated
	// full-size copy. EXIF orientations >= 5 transpose (swap) width and height;
	// the remaining orientations only mirror or rotate 180° and preserve the
	// aspect ratio.
	orientedWidth, orientedHeight := width, height
	if orientation >= 5 {
		orientedWidth, orientedHeight = height, width
	}
	targetWidth, targetHeight := orientedWidth, orientedHeight
	if orientedWidth > maxDimension || orientedHeight > maxDimension {
		if orientedWidth >= orientedHeight {
			targetWidth, targetHeight = maxDimension, max(1, orientedHeight*maxDimension/orientedWidth)
		} else {
			targetHeight, targetWidth = maxDimension, max(1, orientedWidth*maxDimension/orientedHeight)
		}
	}
	select {
	case <-ctx.Done():
		return derivativeRender{}, ctx.Err()
	default:
	}
	// Resize the unrotated source to the pre-orientation size first, then apply
	// the EXIF orientation to the small result. Orienting the full-resolution
	// source before scaling performs an O(width*height) per-pixel copy that is
	// as expensive as the decode itself for typical multi-megapixel photos, so
	// defer it until after the downscale. Bilinear filtering is also cheaper
	// than Catmull-Rom while staying suitable for a 512px browsing preview.
	resizeStartedAt := time.Now()
	preWidth, preHeight := targetWidth, targetHeight
	if orientation >= 5 {
		preWidth, preHeight = targetHeight, targetWidth
	}
	resized := image.NewRGBA(image.Rect(0, 0, preWidth, preHeight))
	// ApproxBiLinear is ~60x faster than BiLinear when downscaling a decoded
	// *image.YCbCr, because BiLinear re-runs chroma interpolation and color
	// conversion per sampled pixel while ApproxBiLinear uses an accelerated
	// path. The approximation is visually negligible for a 512px grid
	// thumbnail, so reserve exact BiLinear for the much larger preview variant.
	scaler := xdraw.Scaler(xdraw.BiLinear)
	if maxDimension <= thumbnailMaxDimension {
		scaler = xdraw.ApproxBiLinear
	}
	scaler.Scale(resized, resized.Bounds(), source, bounds, xdraw.Over, nil)
	resizeElapsed := time.Since(resizeStartedAt)
	orientStartedAt := time.Now()
	target := orientedImage(resized, orientation)
	orientElapsed := time.Since(orientStartedAt)
	// The dominant colours are sampled from the downscaled image that is already
	// in memory, so the palette costs a few hundred microseconds instead of a
	// second decode pass per asset.
	var colors []string
	if maxDimension <= thumbnailMaxDimension {
		colors = extractDominantColors(target, 5)
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return derivativeRender{}, err
	}
	temp := destination + ".tmp-" + newID()
	file, err := os.Create(temp)
	if err != nil {
		return derivativeRender{}, err
	}
	encodeStartedAt := time.Now()
	encodeErr := jpeg.Encode(file, target, &jpeg.Options{Quality: 88})
	encodeElapsed := time.Since(encodeStartedAt)
	closeErr := file.Close()
	if encodeErr != nil {
		_ = os.Remove(temp)
		return derivativeRender{}, encodeErr
	}
	if closeErr != nil {
		_ = os.Remove(temp)
		return derivativeRender{}, closeErr
	}
	written := int64(0)
	if info, statErr := os.Stat(temp); statErr == nil {
		written = info.Size()
	}
	if err := os.Rename(temp, destination); err != nil {
		_ = os.Remove(temp)
		return derivativeRender{}, err
	}
	if elapsed := time.Since(startedAt); elapsed >= 500*time.Millisecond {
		log.Printf("[local-library] derivative slow source=%s total=%s decode=%s orient=%s resize=%s encode=%s", filepath.Base(sourcePath), elapsed.Round(time.Millisecond), decodeElapsed.Round(time.Millisecond), orientElapsed.Round(time.Millisecond), resizeElapsed.Round(time.Millisecond), encodeElapsed.Round(time.Millisecond))
	}
	targetBounds := target.Bounds()
	return derivativeRender{Width: targetBounds.Dx(), Height: targetBounds.Dy(), ByteSize: written, Colors: colors}, nil
}

func writePlaceholderPNG(w io.Writer) error {
	return png.Encode(w, image.NewRGBA(image.Rect(0, 0, 2, 2)))
}
