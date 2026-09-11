package local_library

import (
	"encoding/binary"
	"testing"
)

func buildMVHDTestPayload(version byte, timescale, durationV0 uint32, durationV1 uint64) []byte {
	payload := make([]byte, 0, 32)
	payload = append(payload, version, 0, 0, 0)
	if version == 1 {
		payload = binary.BigEndian.AppendUint64(payload, 0)
		payload = binary.BigEndian.AppendUint64(payload, 0)
		payload = binary.BigEndian.AppendUint32(payload, timescale)
		payload = binary.BigEndian.AppendUint64(payload, durationV1)
	} else {
		payload = binary.BigEndian.AppendUint32(payload, 0)
		payload = binary.BigEndian.AppendUint32(payload, 0)
		payload = binary.BigEndian.AppendUint32(payload, timescale)
		payload = binary.BigEndian.AppendUint32(payload, durationV0)
	}
	box := make([]byte, 0, 8+len(payload))
	box = binary.BigEndian.AppendUint32(box, uint32(8+len(payload)))
	box = append(box, "mvhd"...)
	return append(box, payload...)
}

func buildTestMP4(timescale, duration uint32) []byte {
	mvhd := buildMVHDTestPayload(0, timescale, duration, 0)
	moov := make([]byte, 0, 8+len(mvhd))
	moov = binary.BigEndian.AppendUint32(moov, uint32(8+len(mvhd)))
	moov = append(moov, "moov"...)
	moov = append(moov, mvhd...)

	ftyp := make([]byte, 0, 16)
	ftyp = binary.BigEndian.AppendUint32(ftyp, 16)
	ftyp = append(ftyp, "ftypisom"...)
	ftyp = binary.BigEndian.AppendUint32(ftyp, 0)

	file := append(ftyp, moov...)
	free := make([]byte, 10)
	binary.BigEndian.PutUint32(free, uint32(10))
	copy(free[4:], "free")
	return append(file, free...)
}

func TestParseMP4DurationV0(t *testing.T) {
	// 10 seconds at a 1000 Hz timescale, with ftyp and free boxes around moov.
	data := buildTestMP4(1000, 10000)
	got, err := parseMP4DurationFromReader(newSliceReaderAt(data), int64(len(data)))
	if err != nil {
		t.Fatalf("parse duration: %v", err)
	}
	if got != 10000 {
		t.Fatalf("duration = %dms, want 10000ms", got)
	}
}

func TestParseMP4DurationV1(t *testing.T) {
	mvhd := buildMVHDTestPayload(1, 48000, 0, 48000*61)
	moov := make([]byte, 0, 8+len(mvhd))
	moov = binary.BigEndian.AppendUint32(moov, uint32(8+len(mvhd)))
	moov = append(moov, "moov"...)
	moov = append(moov, mvhd...)
	got, err := parseMP4DurationFromReader(newSliceReaderAt(moov), int64(len(moov)))
	if err != nil {
		t.Fatalf("parse duration: %v", err)
	}
	if got != 61000 {
		t.Fatalf("duration = %dms, want 61000ms", got)
	}
}

func TestParseMP4DurationMissingMoov(t *testing.T) {
	data := make([]byte, 64)
	binary.BigEndian.PutUint32(data, 64)
	copy(data[4:], "free")
	if _, err := parseMP4DurationFromReader(newSliceReaderAt(data), int64(len(data))); err == nil {
		t.Fatal("expected error for file without moov")
	}
}

type sliceReaderAt struct {
	data []byte
}

func newSliceReaderAt(data []byte) *sliceReaderAt { return &sliceReaderAt{data: data} }

func (r *sliceReaderAt) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 || off >= int64(len(r.data)) {
		return 0, errInvalidMP4Box
	}
	n := copy(p, r.data[off:])
	if n < len(p) {
		return n, errInvalidMP4Box
	}
	return n, nil
}

func TestValidateClipRange(t *testing.T) {
	cases := []struct {
		name      string
		start     int64
		end       int64
		duration  int64
		expectErr bool
	}{
		{"valid", 1000, 5000, 10000, false},
		{"unknown duration allowed", 1000, 999999, 0, false},
		{"reversed", 5000, 1000, 10000, true},
		{"negative start", -1, 1000, 10000, true},
		{"too short", 1000, 1100, 10000, true},
		{"beyond duration", 9000, 11000, 10000, true},
		{"end at duration", 9000, 10000, 10000, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateClipRange(tc.start, tc.end, tc.duration)
			if tc.expectErr && err == nil {
				t.Fatalf("expected error for %s", tc.name)
			}
			if !tc.expectErr && err != nil {
				t.Fatalf("unexpected error for %s: %v", tc.name, err)
			}
		})
	}
}
