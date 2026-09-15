package local_library

import (
	"os"
	"path/filepath"
	"testing"
)

// newTestPreferenceStore returns a store backed by a temp config dir.
// reopen simulates restarting the app so persistence can be checked.
func newTestPreferenceStore(t *testing.T) (*preferenceStore, func() *preferenceStore) {
	t.Helper()
	dir := t.TempDir()
	return newPreferenceStore(dir), func() *preferenceStore { return newPreferenceStore(dir) }
}

func mustGet(t *testing.T, store *preferenceStore) LocalLibraryPreferences {
	t.Helper()
	preferences, err := store.Get()
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	return preferences
}

// A brand-new install has no config file at all: the "每次询问" switch must be
// on, so the first import asks the user instead of silently copying files.
func TestFreshInstallAsksEveryTime(t *testing.T) {
	store, _ := newTestPreferenceStore(t)

	preferences := mustGet(t, store)
	if !preferences.ShouldAsk() {
		t.Fatalf("fresh install should ask, got ShouldAsk()=false")
	}
	// The stored mode is empty, so the fallback must be the built-in default.
	if mode := preferences.EffectiveImportMode(); mode != DefaultImportMode {
		t.Fatalf("fresh install effective mode = %q, want %q", mode, DefaultImportMode)
	}
	if DefaultImportMode != ImportModeCopy {
		t.Fatalf("DefaultImportMode = %q, want copy", DefaultImportMode)
	}
}

// Configs written before the switch existed only carry importMode, which used to
// mean "chosen once, never ask again". They must keep that behaviour: switch off,
// stored mode reused.
func TestLegacyConfigWithoutSwitchDoesNotAsk(t *testing.T) {
	store, reopen := newTestPreferenceStore(t)
	if err := os.WriteFile(store.path, []byte("{\n  \"importMode\": \"move\"\n}\n"), 0o600); err != nil {
		t.Fatalf("write legacy config: %v", err)
	}

	for label, s := range map[string]*preferenceStore{"same store": store, "reopened": reopen()} {
		preferences := mustGet(t, s)
		if preferences.ShouldAsk() {
			t.Fatalf("%s: legacy config should not ask", label)
		}
		if mode := preferences.EffectiveImportMode(); mode != ImportModeMove {
			t.Fatalf("%s: legacy config mode = %q, want move", label, mode)
		}
	}
}

// Confirming the dialog with "不再询问" checked passes askEveryTime=false and
// must turn the switch off while remembering the chosen mode.
func TestConfirmWithDontAskAgainTurnsSwitchOff(t *testing.T) {
	store, reopen := newTestPreferenceStore(t)

	saved, err := store.SetImportChoice(ImportModeMove, false)
	if err != nil {
		t.Fatalf("SetImportChoice: %v", err)
	}
	if saved.ShouldAsk() {
		t.Fatalf("saved preferences should have the switch off")
	}

	for label, s := range map[string]*preferenceStore{"same store": store, "reopened": reopen()} {
		preferences := mustGet(t, s)
		if preferences.ShouldAsk() {
			t.Fatalf("%s: switch should stay off after confirm", label)
		}
		if mode := preferences.EffectiveImportMode(); mode != ImportModeMove {
			t.Fatalf("%s: mode = %q, want move", label, mode)
		}
	}
}

// Confirming without "不再询问" keeps the switch on, but still records the mode
// so it can preselect the same option next time.
func TestConfirmWithoutDontAskAgainKeepsAsking(t *testing.T) {
	store, _ := newTestPreferenceStore(t)

	saved, err := store.SetImportChoice(ImportModeCopy, true)
	if err != nil {
		t.Fatalf("SetImportChoice: %v", err)
	}
	if !saved.ShouldAsk() {
		t.Fatalf("switch should stay on")
	}
	if mode := saved.EffectiveImportMode(); mode != ImportModeCopy {
		t.Fatalf("mode = %q, want copy", mode)
	}
}

// Turning the switch off from the settings page before any dialog choice leaves
// no stored mode; imports must fall back to the default instead of failing.
func TestSettingsSwitchOffWithoutStoredModeUsesDefault(t *testing.T) {
	store, reopen := newTestPreferenceStore(t)

	if _, err := store.SetAskEveryTime(false); err != nil {
		t.Fatalf("SetAskEveryTime(false): %v", err)
	}
	preferences := mustGet(t, reopen())
	if preferences.ShouldAsk() {
		t.Fatalf("switch should be off")
	}
	if mode := preferences.EffectiveImportMode(); mode != DefaultImportMode {
		t.Fatalf("mode = %q, want %q", mode, DefaultImportMode)
	}
}

// The switch round trip (dialog closes it -> settings reopens it -> closed again)
// must never lose the remembered mode.
func TestSwitchRoundTripPreservesMode(t *testing.T) {
	store, reopen := newTestPreferenceStore(t)

	if _, err := store.SetImportChoice(ImportModeMove, false); err != nil {
		t.Fatalf("SetImportChoice: %v", err)
	}
	reopened := reopen()
	if _, err := reopened.SetAskEveryTime(true); err != nil {
		t.Fatalf("SetAskEveryTime(true): %v", err)
	}
	if !mustGet(t, reopened).ShouldAsk() {
		t.Fatalf("switch should be on after re-enabling")
	}

	again := reopen()
	if _, err := again.SetAskEveryTime(false); err != nil {
		t.Fatalf("SetAskEveryTime(false): %v", err)
	}
	preferences := mustGet(t, reopen())
	if preferences.ShouldAsk() {
		t.Fatalf("switch should be off")
	}
	if mode := preferences.EffectiveImportMode(); mode != ImportModeMove {
		t.Fatalf("mode = %q, want move (must survive the round trip)", mode)
	}
}

// An unknown mode is rejected and must not overwrite the stored preference.
func TestSetImportChoiceRejectsInvalidMode(t *testing.T) {
	store, reopen := newTestPreferenceStore(t)
	if _, err := store.SetImportChoice(ImportModeMove, false); err != nil {
		t.Fatalf("SetImportChoice: %v", err)
	}

	if _, err := store.SetImportChoice(ImportMode("delete"), true); err == nil {
		t.Fatalf("expected an error for an unknown import mode")
	}
	preferences := mustGet(t, reopen())
	if mode := preferences.EffectiveImportMode(); mode != ImportModeMove {
		t.Fatalf("mode = %q, want move left untouched", mode)
	}
	if preferences.ShouldAsk() {
		t.Fatalf("failed write must not flip the switch")
	}
}

// A corrupt config must surface as an error rather than silently resetting.
func TestCorruptConfigReportsError(t *testing.T) {
	store, _ := newTestPreferenceStore(t)
	if err := os.WriteFile(store.path, []byte("{ not json"), 0o600); err != nil {
		t.Fatalf("write corrupt config: %v", err)
	}
	if _, err := store.Get(); err == nil {
		t.Fatalf("expected an error for a corrupt config")
	}

	bad := newPreferenceStore(t.TempDir())
	if err := os.WriteFile(filepath.Join(filepath.Dir(bad.path), "local-library-settings.json"), []byte("{\n  \"importMode\": \"delete\"\n}\n"), 0o600); err != nil {
		t.Fatalf("write invalid mode: %v", err)
	}
	if _, err := bad.Get(); err == nil {
		t.Fatalf("expected an error for an unknown stored mode")
	}
}
