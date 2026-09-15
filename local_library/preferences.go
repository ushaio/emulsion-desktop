package local_library

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

type ImportMode string

const (
	ImportModeCopy ImportMode = "copy"
	ImportModeMove ImportMode = "move"
)

// DefaultImportMode applies when the "每次询问" switch is off and the user has
// never confirmed a mode in the import dialog.
const DefaultImportMode ImportMode = ImportModeCopy

// LocalLibraryPreferences is the persisted local-library import preference.
//
// AskEveryTime backs the "每次询问" switch. It is a pointer so that a config
// written before the switch existed (mode only, no field) can be told apart from
// an explicit choice: a stored mode used to mean "chosen once, never ask again",
// so legacy configs read back as ShouldAsk() == false.
type LocalLibraryPreferences struct {
	ImportMode   ImportMode `json:"importMode,omitempty"`
	AskEveryTime *bool      `json:"askEveryTime,omitempty"`
}

// ShouldAsk reports whether the import dialog must be shown before importing.
func (p LocalLibraryPreferences) ShouldAsk() bool {
	if p.AskEveryTime != nil {
		return *p.AskEveryTime
	}
	return !validImportMode(p.ImportMode)
}

// EffectiveImportMode is the mode actually used when ShouldAsk() is false.
func (p LocalLibraryPreferences) EffectiveImportMode() ImportMode {
	if validImportMode(p.ImportMode) {
		return p.ImportMode
	}
	return DefaultImportMode
}

type preferenceStore struct {
	mu   sync.Mutex
	path string
}

func newPreferenceStore(configDir string) *preferenceStore {
	return &preferenceStore{path: filepath.Join(configDir, "local-library-settings.json")}
}

func (s *preferenceStore) Get() (LocalLibraryPreferences, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readLocked()
}

// SetImportChoice records the mode picked in the import dialog. askEveryTime
// mirrors the switch, i.e. the inverse of the "不再询问" checkbox: remembering
// the choice is what turns the switch off.
func (s *preferenceStore) SetImportChoice(mode ImportMode, askEveryTime bool) (LocalLibraryPreferences, error) {
	if !validImportMode(mode) {
		return LocalLibraryPreferences{}, newError(ErrInvalidImportMode, "本地资源库导入方式必须是复制或移动", nil)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ask := askEveryTime
	preferences := LocalLibraryPreferences{ImportMode: mode, AskEveryTime: &ask}
	if err := s.writeLocked(preferences); err != nil {
		return LocalLibraryPreferences{}, err
	}
	return preferences, nil
}

// SetAskEveryTime flips the settings switch while keeping the stored mode.
func (s *preferenceStore) SetAskEveryTime(askEveryTime bool) (LocalLibraryPreferences, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	preferences, err := s.readLocked()
	if err != nil {
		return LocalLibraryPreferences{}, err
	}
	ask := askEveryTime
	preferences.AskEveryTime = &ask
	if err := s.writeLocked(preferences); err != nil {
		return LocalLibraryPreferences{}, err
	}
	return preferences, nil
}

func (s *preferenceStore) writeLocked(preferences LocalLibraryPreferences) error {
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	return writeJSONAtomic(s.path, preferences)
}

func (s *preferenceStore) readLocked() (LocalLibraryPreferences, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return LocalLibraryPreferences{}, nil
	}
	if err != nil {
		return LocalLibraryPreferences{}, err
	}
	var preferences LocalLibraryPreferences
	if err := json.Unmarshal(data, &preferences); err != nil {
		return LocalLibraryPreferences{}, err
	}
	if preferences.ImportMode != "" && !validImportMode(preferences.ImportMode) {
		return LocalLibraryPreferences{}, newError(ErrInvalidImportMode, "本地资源库导入设置无效，请重新选择", nil)
	}
	return preferences, nil
}

func validImportMode(mode ImportMode) bool {
	return mode == ImportModeCopy || mode == ImportModeMove
}
