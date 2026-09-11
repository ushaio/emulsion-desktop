package local_library

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"time"
)

// This file implements logical media segments (clips): mark-in / mark-out
// points on a playable asset. A clip is a database record only; playback
// plays the source file constrained to [StartMS, EndMS), and a real media
// file is only ever produced by an explicit export.

// minClipDurationMS guards against storing degenerate ranges produced by
// double clicks or shortcut mashing.
const minClipDurationMS = 200

// maxClipTitleBytes bounds clip titles the same way other bounded strings are
// capped, so a pathological title cannot bloat every list response.
const maxClipTitleBytes = 256

func boundedClipTitle(title string) string {
	return boundedString(strings.TrimSpace(title), maxClipTitleBytes)
}

// clipAssetRow carries the fields clip validation and export need from the
// source asset.
type clipAssetRow struct {
	ID          AssetID
	Relative    string
	Extension   string
	Format      string
	MediaKind   string
	MimeType    string
	DurationMS  int64
	ModifiedNS  int64
	ByteSize    int64
	Availability string
}

func (s *store) clipAssetRow(ctx context.Context, id AssetID) (clipAssetRow, error) {
	var row clipAssetRow
	err := s.db.QueryRowContext(ctx, `SELECT id,relative_path,extension,format,media_kind,mime_type,duration_ms,modified_at_ns,byte_size,availability FROM assets WHERE id=?`, id).
		Scan(&row.ID, &row.Relative, &row.Extension, &row.Format, &row.MediaKind, &row.MimeType, &row.DurationMS, &row.ModifiedNS, &row.ByteSize, &row.Availability)
	if errors.Is(err, sql.ErrNoRows) {
		return row, newError(ErrAssetNotFound, "资产不存在", map[string]any{"assetId": id})
	}
	return row, err
}

// validateClipRange enforces the invariants every clip must hold. durationMS
// of zero means the duration is unknown and the upper bound is not checked.
func validateClipRange(startMS, endMS, durationMS int64) error {
	if startMS < 0 || endMS <= startMS {
		return newError(ErrClipInvalid, "片段起止时间无效", map[string]any{"startMs": startMS, "endMs": endMS})
	}
	if endMS-startMS < minClipDurationMS {
		return newError(ErrClipInvalid, "片段时长过短", map[string]any{"durationMs": endMS - startMS})
	}
	if durationMS > 0 && (startMS > durationMS || endMS > durationMS) {
		return newError(ErrClipInvalid, "片段超出媒体时长", map[string]any{"startMs": startMS, "endMs": endMS, "durationMs": durationMS})
	}
	return nil
}

func (s *store) createAssetClip(ctx context.Context, input CreateAssetClipInput) (AssetClipDTO, error) {
	asset, err := s.clipAssetRow(ctx, input.AssetID)
	if err != nil {
		return AssetClipDTO{}, err
	}
	if !isTimedMediaKind(asset.MediaKind) {
		return AssetClipDTO{}, newError(ErrClipInvalid, "仅视频/音频资产支持标记片段", map[string]any{"assetId": input.AssetID, "mediaKind": asset.MediaKind})
	}
	if err := validateClipRange(input.StartMS, input.EndMS, asset.DurationMS); err != nil {
		return AssetClipDTO{}, err
	}
	id := newID()
	now := time.Now().UnixMilli()
	_, err = s.db.ExecContext(ctx, `INSERT INTO asset_clips(id,asset_id,title,notes,start_ms,end_ms,color_label,rating,created_at,updated_at)
		VALUES(?,?,?,?,?,?,?,?,?,?)`,
		id, input.AssetID, boundedClipTitle(input.Title), input.Notes, input.StartMS, input.EndMS, input.ColorLabel, 0, now, now)
	if err != nil {
		return AssetClipDTO{}, err
	}
	return s.assetClipByID(ctx, AssetID(id))
}

func (s *store) updateAssetClip(ctx context.Context, id AssetID, patch UpdateAssetClipPatch) (AssetClipDTO, error) {
	existing, err := s.assetClipByID(ctx, id)
	if err != nil {
		return AssetClipDTO{}, err
	}
	next := existing
	if patch.Title != nil {
		next.Title = boundedClipTitle(*patch.Title)
	}
	if patch.Notes != nil {
		next.Notes = *patch.Notes
	}
	if patch.StartMS != nil {
		next.StartMS = *patch.StartMS
	}
	if patch.EndMS != nil {
		next.EndMS = *patch.EndMS
	}
	if patch.ColorLabel != nil {
		next.ColorLabel = *patch.ColorLabel
	}
	if patch.Rating != nil {
		if *patch.Rating < 0 || *patch.Rating > 5 {
			return AssetClipDTO{}, newError(ErrClipInvalid, "片段评分无效", map[string]any{"rating": *patch.Rating})
		}
		next.Rating = *patch.Rating
	}
	if patch.StartMS != nil || patch.EndMS != nil {
		asset, assetErr := s.clipAssetRow(ctx, existing.AssetID)
		if assetErr != nil {
			return AssetClipDTO{}, assetErr
		}
		if err := validateClipRange(next.StartMS, next.EndMS, asset.DurationMS); err != nil {
			return AssetClipDTO{}, err
		}
	}
	_, err = s.db.ExecContext(ctx, `UPDATE asset_clips SET title=?,notes=?,start_ms=?,end_ms=?,color_label=?,rating=?,updated_at=? WHERE id=?`,
		next.Title, next.Notes, next.StartMS, next.EndMS, next.ColorLabel, next.Rating, time.Now().UnixMilli(), id)
	if err != nil {
		return AssetClipDTO{}, err
	}
	return s.assetClipByID(ctx, id)
}

func (s *store) deleteAssetClip(ctx context.Context, id AssetID) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM asset_clips WHERE id=?`, id)
	if err != nil {
		return err
	}
	deleted, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if deleted == 0 {
		return newError(ErrClipNotFound, "片段不存在", map[string]any{"clipId": id})
	}
	return nil
}

const assetClipSelect = `SELECT c.id,c.asset_id,c.title,c.notes,c.start_ms,c.end_ms,c.color_label,c.rating,c.created_at,c.updated_at,
	a.file_name,a.relative_path,a.format,a.media_kind,a.duration_ms,a.modified_at_ns,a.byte_size
	FROM asset_clips c JOIN assets a ON a.id=c.asset_id `

func scanAssetClip(scan func(dest ...any) error, sessionID string) (AssetClipDTO, error) {
	var item AssetClipDTO
	var createdAt, updatedAt int64
	var notes string
	if err := scan(&item.ID, &item.AssetID, &item.Title, &notes, &item.StartMS, &item.EndMS, &item.ColorLabel, &item.Rating, &createdAt, &updatedAt,
		&item.AssetFileName, &item.AssetRelativePath, &item.AssetFormat, &item.AssetKind, &item.AssetDuration, &item.ModifiedNS, &item.ByteSize); err != nil {
		return item, err
	}
	item.Notes = notes
	item.CreatedAt = time.UnixMilli(createdAt).UTC()
	item.UpdatedAt = time.UnixMilli(updatedAt).UTC()
	if sessionID != "" {
		item.ThumbnailURL = clipThumbnailURL(item.AssetID, item.ModifiedNS, item.ByteSize, sessionID)
	}
	return item, nil
}

func clipThumbnailURL(id AssetID, modifiedAtNS, byteSize int64, sessionID string) string {
	key := derivativeCacheKey(id, modifiedAtNS, byteSize, derivativeThumbnail)
	return "/__local-library/thumbnail/" + string(id) + "?session=" + sessionID + "&v=" + key
}

func (s *store) assetClipByID(ctx context.Context, id AssetID) (AssetClipDTO, error) {
	row := s.db.QueryRowContext(ctx, assetClipSelect+`WHERE c.id=?`, id)
	item, err := scanAssetClip(row.Scan, "")
	if errors.Is(err, sql.ErrNoRows) {
		return AssetClipDTO{}, newError(ErrClipNotFound, "片段不存在", map[string]any{"clipId": id})
	}
	return item, err
}

func (s *store) listAssetClips(ctx context.Context, assetID AssetID, sessionID string) ([]AssetClipDTO, error) {
	rows, err := s.db.QueryContext(ctx, assetClipSelect+`WHERE c.asset_id=? ORDER BY c.start_ms, c.id`, assetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []AssetClipDTO{}
	for rows.Next() {
		item, scanErr := scanAssetClip(rows.Scan, sessionID)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// listLibraryClips pages through every clip in the library, newest first.
// Keyset pagination on (created_at, id) mirrors listAssets.
func (s *store) listLibraryClips(ctx context.Context, query ClipListQuery, sessionID string) (ClipPage, error) {
	limit := query.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 300 {
		limit = 300
	}
	where := "a.availability='active' "
	args := make([]any, 0, 4)
	if query.AssetID != "" {
		where += "AND c.asset_id=? "
		args = append(args, query.AssetID)
	}
	if query.Cursor != "" {
		cursor, err := decodeCursor(query.Cursor)
		if err != nil {
			return ClipPage{}, newError(ErrInvalidPath, "分页游标无效", nil)
		}
		createdAt, parseErr := strconv.ParseInt(cursor.Value, 10, 64)
		if parseErr != nil {
			return ClipPage{}, newError(ErrInvalidPath, "分页游标无效", nil)
		}
		where += "AND (c.created_at < ? OR (c.created_at = ? AND c.id < ?)) "
		args = append(args, createdAt, createdAt, cursor.ID)
	}
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM asset_clips c JOIN assets a ON a.id=c.asset_id WHERE `+where, args...).Scan(&total); err != nil {
		return ClipPage{}, err
	}
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, assetClipSelect+`WHERE `+where+`ORDER BY c.created_at DESC, c.id DESC LIMIT ?`, args...)
	if err != nil {
		return ClipPage{}, err
	}
	defer rows.Close()
	items := make([]AssetClipDTO, 0, limit)
	var lastCreatedAt int64
	var lastID string
	hasMore := false
	for rows.Next() {
		if len(items) >= limit {
			hasMore = true
			break
		}
		var item AssetClipDTO
		var notes string
		var createdAt, updatedAt int64
		if err := rows.Scan(&item.ID, &item.AssetID, &item.Title, &notes, &item.StartMS, &item.EndMS, &item.ColorLabel, &item.Rating, &createdAt, &updatedAt,
			&item.AssetFileName, &item.AssetRelativePath, &item.AssetFormat, &item.AssetKind, &item.AssetDuration, &item.ModifiedNS, &item.ByteSize); err != nil {
			return ClipPage{}, err
		}
		item.Notes = notes
		item.CreatedAt = time.UnixMilli(createdAt).UTC()
		item.UpdatedAt = time.UnixMilli(updatedAt).UTC()
		item.ThumbnailURL = clipThumbnailURL(item.AssetID, item.ModifiedNS, item.ByteSize, sessionID)
		items = append(items, item)
		lastCreatedAt = createdAt
		lastID = string(item.ID)
	}
	if err := rows.Err(); err != nil {
		return ClipPage{}, err
	}
	next := ""
	if hasMore {
		next = encodeCursor(strconv.FormatInt(lastCreatedAt, 10), lastID)
	}
	return ClipPage{Items: items, NextCursor: next, Total: total}, nil
}

// reportAssetMediaMetadata backfills duration/dimensions reported by the
// frontend's loadedmetadata event. Go cannot cheaply parse audio durations,
// so the player is the authoritative source for them. Values are only written
// when they differ from what is stored.
func (s *store) reportAssetMediaMetadata(ctx context.Context, id AssetID, durationMS int64, width, height int) error {
	var currentDuration int64
	var currentWidth, currentHeight int
	err := s.db.QueryRowContext(ctx, `SELECT duration_ms,width,height FROM assets WHERE id=?`, id).
		Scan(&currentDuration, &currentWidth, &currentHeight)
	if errors.Is(err, sql.ErrNoRows) {
		return newError(ErrAssetNotFound, "资产不存在", map[string]any{"assetId": id})
	}
	if err != nil {
		return err
	}
	nextDuration, nextWidth, nextHeight := currentDuration, currentWidth, currentHeight
	if durationMS > 0 && durationMS != currentDuration {
		nextDuration = durationMS
	}
	if width > 0 && width != currentWidth {
		nextWidth = width
	}
	if height > 0 && height != currentHeight {
		nextHeight = height
	}
	if nextDuration == currentDuration && nextWidth == currentWidth && nextHeight == currentHeight {
		return nil
	}
	_, err = s.db.ExecContext(ctx, `UPDATE assets SET duration_ms=?,width=?,height=?,technical_updated_at=? WHERE id=?`,
		nextDuration, nextWidth, nextHeight, time.Now().UnixMilli(), id)
	return err
}

// ─── Manager API ─────────────────────────────────────

func (m *Manager) ListAssetClips(id AssetID) ([]AssetClipDTO, error) {
	session, err := m.requireAvailableSession()
	if err != nil {
		return nil, err
	}
	return session.store.listAssetClips(session.ctx, id, session.sessionID)
}

func (m *Manager) CreateAssetClip(input CreateAssetClipInput) (AssetClipDTO, error) {
	session, err := m.requireAvailableSession()
	if err != nil {
		return AssetClipDTO{}, err
	}
	clip, err := session.store.createAssetClip(session.ctx, input)
	if err != nil {
		return AssetClipDTO{}, err
	}
	m.emitEvent("asset_clips_updated")
	return clip, nil
}

func (m *Manager) UpdateAssetClip(id AssetID, patch UpdateAssetClipPatch) (AssetClipDTO, error) {
	session, err := m.requireAvailableSession()
	if err != nil {
		return AssetClipDTO{}, err
	}
	clip, err := session.store.updateAssetClip(session.ctx, id, patch)
	if err != nil {
		return AssetClipDTO{}, err
	}
	m.emitEvent("asset_clips_updated")
	return clip, nil
}

func (m *Manager) DeleteAssetClip(id AssetID) error {
	session, err := m.requireAvailableSession()
	if err != nil {
		return err
	}
	if err := session.store.deleteAssetClip(session.ctx, id); err != nil {
		return err
	}
	m.emitEvent("asset_clips_updated")
	return nil
}

func (m *Manager) ListLibraryClips(query ClipListQuery) (ClipPage, error) {
	session, err := m.requireAvailableSession()
	if err != nil {
		return ClipPage{}, err
	}
	return session.store.listLibraryClips(session.ctx, query, session.sessionID)
}

// ReportAssetMediaMetadata backfills media duration/dimensions observed by
// the frontend player (see reportAssetMediaMetadata).
func (m *Manager) ReportAssetMediaMetadata(id AssetID, durationMS int64, width, height int) error {
	session, err := m.requireAvailableSession()
	if err != nil {
		return err
	}
	return session.store.reportAssetMediaMetadata(session.ctx, id, durationMS, width, height)
}
