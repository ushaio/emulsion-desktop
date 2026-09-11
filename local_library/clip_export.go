package local_library

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Clip export runs ffmpeg with stream copy so a segment is cut losslessly in
// roughly the time it takes to read the source range. The binary is bundled
// next to the application executable by the installer; a system ffmpeg on the
// PATH or the MO_GALLERY_FFMPEG override are also accepted. When none is
// usable, export is disabled and the library keeps working (playback and
// logical clips never need it).

// ffmpegCandidates lists the ffmpeg binaries probed by ResolveFFmpeg, in
// priority order: the explicit MO_GALLERY_FFMPEG override (development and
// exotic setups), then the binary bundled next to the application executable
// by the installers. The sidecar is named emulsion-ffmpeg so it never
// collides with a system ffmpeg, which is looked up on the PATH afterwards.
func ffmpegCandidates() []string {
	candidates := make([]string, 0, 2)
	if override := strings.TrimSpace(os.Getenv("MO_GALLERY_FFMPEG")); override != "" {
		candidates = append(candidates, override)
	}
	if exe, err := os.Executable(); err == nil {
		name := "emulsion-ffmpeg"
		if runtime.GOOS == "windows" {
			name = "emulsion-ffmpeg.exe"
		}
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), name))
	}
	return candidates
}

func ffmpegAnswersVersion(binary string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, binary, "-hide_banner", "-version").Run() == nil
}

var (
	ffmpegResolveOnce sync.Once
	ffmpegResolved    string
)

// ResolveFFmpeg returns the absolute path of a usable ffmpeg binary, or an
// empty string when none is. The lookup runs once per process: candidates are
// probed in order (override, bundled sidecar, system PATH) and each must
// answer -version, so a broken or blocked binary falls through to the next.
func ResolveFFmpeg() string {
	ffmpegResolveOnce.Do(func() { ffmpegResolved = resolveFFmpeg() })
	return ffmpegResolved
}

func resolveFFmpeg() string {
	candidates := ffmpegCandidates()
	if path, err := exec.LookPath("ffmpeg"); err == nil && path != "" {
		candidates = append(candidates, path)
	}
	for _, candidate := range candidates {
		if !ffmpegAnswersVersion(candidate) {
			continue
		}
		if resolved, absErr := filepath.Abs(candidate); absErr == nil {
			return resolved
		}
		return candidate
	}
	return ""
}

// DetectFFmpeg returns the absolute path of a usable ffmpeg binary, or an
// empty string when none is available.
func DetectFFmpeg() string {
	return ResolveFFmpeg()
}

var unsafeFileNamePattern = regexp.MustCompile("[<>:\"/\\\\|?*\\x00-\\x1f]")

func sanitizeFileSegment(value string) string {
	cleaned := unsafeFileNamePattern.ReplaceAllString(strings.TrimSpace(value), "_")
	cleaned = strings.Join(strings.Fields(cleaned), " ")
	cleaned = strings.TrimLeft(cleaned, ".")
	if len(cleaned) > 120 {
		cleaned = cleaned[:120]
	}
	return strings.TrimSpace(cleaned)
}

func formatSeconds(ms int64) string {
	return strconv.FormatFloat(float64(ms)/1000, 'f', 3, 64)
}

// PrepareClipExport resolves a clip for export: it validates the source asset
// and returns a suggested destination file name. The app layer uses this
// before showing the save dialog.
func (m *Manager) PrepareClipExport(clipID AssetID) (ClipExportPlan, error) {
	session, err := m.requireAvailableSession()
	if err != nil {
		return ClipExportPlan{}, err
	}
	clip, err := session.store.assetClipByID(session.ctx, clipID)
	if err != nil {
		return ClipExportPlan{}, err
	}
	asset, err := session.store.clipAssetRow(session.ctx, clip.AssetID)
	if err != nil {
		return ClipExportPlan{}, err
	}
	if !isTimedMediaKind(asset.MediaKind) {
		return ClipExportPlan{}, newError(ErrClipInvalid, "仅视频/音频片段支持导出", map[string]any{"assetId": clip.AssetID, "mediaKind": asset.MediaKind})
	}
	if asset.Availability != "active" {
		return ClipExportPlan{}, newError(ErrAssetNotFound, "源资产当前不可用", map[string]any{"assetId": clip.AssetID})
	}
	if _, resolveErr := resolveWithinRoot(session.root, asset.Relative); resolveErr != nil {
		return ClipExportPlan{}, resolveErr
	}
	name := sanitizeFileSegment(clip.Title)
	if name == "" {
		base := strings.TrimSuffix(asset.Relative, filepath.Ext(asset.Relative))
		name = sanitizeFileSegment(filepath.Base(base))
		if name == "" {
			name = "clip"
		}
		name = fmt.Sprintf("%s_%s-%s", name, formatSeconds(clip.StartMS), formatSeconds(clip.EndMS))
	}
	return ClipExportPlan{
		ClipID:          clipID,
		AssetID:         clip.AssetID,
		SuggestedName:   name + asset.Extension,
		SourceExtension: asset.Extension,
		DurationMS:      clip.EndMS - clip.StartMS,
	}, nil
}

// ExportClipToPath cuts the clip into a real file next to nothing more than a
// save-dialog choice. progress is called from the export goroutine with
// started/progress/completed/failed states; it must be safe to call from any
// goroutine.
func (m *Manager) ExportClipToPath(clipID AssetID, destination string, progress func(ClipExportProgress)) error {
	ffmpeg := DetectFFmpeg()
	if ffmpeg == "" {
		return newError(ErrFFmpegUnavailable, "未检测到可用的 ffmpeg，无法导出片段", nil)
	}
	session, err := m.requireAvailableSession()
	if err != nil {
		return err
	}
	clip, err := session.store.assetClipByID(session.ctx, clipID)
	if err != nil {
		return err
	}
	asset, err := session.store.clipAssetRow(session.ctx, clip.AssetID)
	if err != nil {
		return err
	}
	if !isTimedMediaKind(asset.MediaKind) || asset.Availability != "active" {
		return newError(ErrAssetNotFound, "源资产当前不可用", map[string]any{"assetId": clip.AssetID})
	}
	source, err := resolveWithinRoot(session.root, asset.Relative)
	if err != nil {
		return err
	}
	if filepath.Ext(destination) == "" {
		destination += asset.Extension
	}
	if progress != nil {
		progress(ClipExportProgress{ClipID: clipID, State: "started"})
	}
	if err := runFFmpegClipExport(session.ctx, ffmpeg, source, destination, clip, progress); err != nil {
		_ = os.Remove(destination)
		if progress != nil {
			progress(ClipExportProgress{ClipID: clipID, State: "failed", Error: boundedError(err.Error())})
		}
		return err
	}
	if progress != nil {
		progress(ClipExportProgress{ClipID: clipID, State: "completed", OutputPath: destination})
	}
	m.emitEvent("asset_clips_updated")
	return nil
}

// runFFmpegClipExport streams the [start, end) range with stream copy. -ss
// before -input seeks by keyframe, which keeps the cut lossless and fast at
// the cost of snapping to the previous keyframe (typically under half a
// second). -progress pipe:1 emits machine-readable progress on stdout.
func runFFmpegClipExport(ctx context.Context, ffmpeg, source, destination string, clip AssetClipDTO, progress func(ClipExportProgress)) error {
	durationMS := clip.EndMS - clip.StartMS
	args := []string{
		"-y", "-hide_banner", "-loglevel", "error", "-nostats",
		"-progress", "pipe:1",
		"-ss", formatSeconds(clip.StartMS),
		"-i", source,
		"-t", formatSeconds(durationMS),
		"-c", "copy",
		destination,
	}
	cmd := exec.CommandContext(ctx, ffmpeg, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	// out_time_ms is microseconds despite its name (a long-standing ffmpeg
	// quirk); dividing by 1000 yields milliseconds.
	lastPercent := -1
	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		value, ok := strings.CutPrefix(line, "out_time_ms=")
		if !ok || progress == nil || durationMS <= 0 {
			continue
		}
		microseconds, parseErr := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		if parseErr != nil || microseconds < 0 {
			continue
		}
		percent := int(microseconds / 1000 * 100 / durationMS)
		if percent > 100 {
			percent = 100
		}
		if percent > lastPercent {
			lastPercent = percent
			progress(ClipExportProgress{ClipID: clip.ID, State: "progress", Percent: percent})
		}
	}
	return cmd.Wait()
}

// ErrExportCancelled reports a user-cancelled save dialog upstream.
var ErrExportCancelled = errors.New("clip export cancelled")
