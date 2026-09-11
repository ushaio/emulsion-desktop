package local_library

import (
	"encoding/binary"
	"errors"
	"io"
	"os"
)

var errInvalidMP4Box = errors.New("invalid mp4 box structure")

// parseMP4Duration reads the movie duration from an ISO-BMFF (mp4) or
// QuickTime (mov) file by walking top-level boxes to moov/mvhd. Only box
// headers and the mvhd payload are read, so the cost is a handful of reads
// regardless of file size. A missing or malformed moov yields an error.
func parseMP4Duration(path string) (int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return 0, err
	}
	return parseMP4DurationFromReader(file, info.Size())
}

func parseMP4DurationFromReader(reader io.ReaderAt, totalSize int64) (int64, error) {
	// moov is often at the end of the file, so boxes are skipped by offset
	// rather than read sequentially.
	const maxTopLevelBoxes = 64
	var offset int64
	header := make([]byte, 8)
	for i := 0; i < maxTopLevelBoxes && offset < totalSize; i++ {
		if _, err := reader.ReadAt(header, offset); err != nil {
			return 0, err
		}
		boxSize := int64(binary.BigEndian.Uint32(header[:4]))
		boxType := string(header[4:8])
		payloadOffset := offset + 8
		if boxSize == 1 {
			// 64-bit largesize box.
			extended := make([]byte, 8)
			if _, err := reader.ReadAt(extended, payloadOffset); err != nil {
				return 0, err
			}
			boxSize = int64(binary.BigEndian.Uint64(extended))
			payloadOffset += 8
		} else if boxSize == 0 {
			// Size 0 means "extends to end of file".
			boxSize = totalSize - offset
		}
		if boxSize < 8 || offset+boxSize > totalSize {
			return 0, errInvalidMP4Box
		}
		if boxType == "moov" {
			return parseMVHDDuration(reader, payloadOffset, offset+boxSize)
		}
		offset += boxSize
	}
	return 0, errInvalidMP4Box
}

// parseMVHDDuration scans the moov payload for the mvhd box and converts its
// timescale/duration pair into milliseconds.
func parseMVHDDuration(reader io.ReaderAt, start, end int64) (int64, error) {
	offset := start
	header := make([]byte, 8)
	for offset+8 <= end {
		if _, err := reader.ReadAt(header, offset); err != nil {
			return 0, err
		}
		boxSize := int64(binary.BigEndian.Uint32(header[:4]))
		boxType := string(header[4:8])
		if boxSize < 8 || offset+boxSize > end {
			return 0, errInvalidMP4Box
		}
		if boxType == "mvhd" {
			return readMVHDValues(reader, offset+8, boxSize-8)
		}
		offset += boxSize
	}
	return 0, errInvalidMP4Box
}

// readMVHDValues reads timescale/duration from an mvhd payload. Layout after
// version(1)+flags(3): version 0 uses 4-byte timestamps and duration; version
// 1 uses 8-byte timestamps and an 8-byte duration.
func readMVHDValues(reader io.ReaderAt, payloadOffset, payloadSize int64) (int64, error) {
	version := make([]byte, 1)
	if _, err := reader.ReadAt(version, payloadOffset); err != nil {
		return 0, err
	}
	var timescaleOffset, durationOffset int
	var durationWidth int
	switch version[0] {
	case 1:
		timescaleOffset, durationOffset, durationWidth = 4+8+8, 4+8+8+4, 8
	case 0:
		timescaleOffset, durationOffset, durationWidth = 4+4+4, 4+4+4+4, 4
	default:
		return 0, errInvalidMP4Box
	}
	if int64(timescaleOffset+4+durationWidth) > payloadSize {
		return 0, errInvalidMP4Box
	}
	timescaleBytes := make([]byte, 4)
	if _, err := reader.ReadAt(timescaleBytes, payloadOffset+int64(timescaleOffset)); err != nil {
		return 0, err
	}
	timescale := int64(binary.BigEndian.Uint32(timescaleBytes))
	if timescale <= 0 {
		return 0, errInvalidMP4Box
	}
	durationBytes := make([]byte, 8)
	if _, err := reader.ReadAt(durationBytes[:durationWidth], payloadOffset+int64(durationOffset)); err != nil {
		return 0, err
	}
	var duration int64
	if durationWidth == 8 {
		duration = int64(binary.BigEndian.Uint64(durationBytes))
	} else {
		duration = int64(binary.BigEndian.Uint32(durationBytes[:4]))
	}
	if duration <= 0 {
		return 0, errInvalidMP4Box
	}
	return duration * 1000 / timescale, nil
}
