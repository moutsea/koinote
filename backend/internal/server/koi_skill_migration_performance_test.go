package server

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type koiMigrationReadProbe struct {
	agentRepositoryObjectStore
	mu      sync.Mutex
	reads   int
	active  int
	peak    int
	gate    chan struct{}
	entered chan struct{}
}

func (s *koiMigrationReadProbe) Read(ctx context.Context, key string, offset, length int64, hash string) ([]byte, error) {
	s.mu.Lock()
	s.reads++
	s.active++
	s.peak = max(s.peak, s.active)
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.active--; s.mu.Unlock() }()
	if s.gate != nil {
		select {
		case s.entered <- struct{}{}:
		default:
		}
		select {
		case <-s.gate:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return s.agentRepositoryObjectStore.Read(ctx, key, offset, length, hash)
}

func TestKoiMigrationLargeLibraryDeduplicatesAndConfirmsSelection(t *testing.T) {
	a, user, _ := writingTestApp(t)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	enableRepositoryR2Fixture(t, a)
	t.Cleanup(func() {
		if _, err := a.db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, user.ID); err != nil {
			t.Error(err)
		}
	})
	ctx := context.Background()
	workspace, err := a.createAgentWorkspace(ctx, user.ID, "Migration performance", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	files := []agentWorkspaceFile{}
	for skill := range 41 {
		dir := fmt.Sprintf("skill-%02d/", skill)
		files = append(files, repositoryTestFile(dir+"SKILL.md", fmt.Sprintf("# Method %d", skill)))
		for file := range 23 {
			files = append(files, repositoryTestFile(fmt.Sprintf("%srefs/%02d.md", dir, file), fmt.Sprintf("Shared reference %d", file)))
		}
	}
	files = append(files, repositoryTestFile("oversized/SKILL.md", "# Oversized package"))
	for file := range 614 {
		files = append(files, repositoryTestFile(fmt.Sprintf("oversized/%03d.md", file), fmt.Sprintf("Unneeded content %d", file)))
	}
	if len(files) != 1599 {
		t.Fatal("large-library fixture changed")
	}
	if _, err = a.patchAgentWorkspace(ctx, user.ID, workspace.WorkspaceID, workspace.Revision, files, nil); err != nil {
		t.Fatal(err)
	}
	probe := &koiMigrationReadProbe{agentRepositoryObjectStore: a.agentObjectStore, gate: make(chan struct{}), entered: make(chan struct{}, 8)}
	a.agentObjectStore = probe
	work, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	defer func() {
		if probe.gate != nil {
			close(probe.gate)
		}
	}()
	var analysis koiAnalysis
	done := make(chan error, 1)
	go func() {
		var analyzeErr error
		analysis, analyzeErr = a.koiAnalyzeSource(work, user.ID, map[string]any{"kind": "migration"})
		done <- analyzeErr
	}()
	// All eight workers must enter before any object is released. This catches
	// accidental serial reads without relying on wall-clock performance assertions.
	for range 8 {
		select {
		case <-probe.entered:
		case <-work.Done():
			t.Fatal("migration did not start bounded parallel reads")
		}
	}
	close(probe.gate)
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	probe.gate = nil
	if len(analysis.candidates) != 41 || len(analysis.rejected) != 1 || analysis.rejected[0].Reason != "too_many_files" {
		t.Fatalf("candidate validation changed: %d candidates, %+v", len(analysis.candidates), analysis.rejected)
	}
	if probe.reads != 65 || probe.peak != 8 || probe.active != 0 {
		t.Fatalf("1599 files should require 65 unique reads, bounded to eight: reads=%d peak=%d active=%d", probe.reads, probe.peak, probe.active)
	}
	preview, _ := koiMigrationPreview(t, a, user)
	input := koiFolderConfirmation(preview)
	input.CandidateIDs = []string{preview.Candidates[0].ID}
	probe.reads = 0
	installed := koiFolderInstalled(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports/"+preview.ID+"/confirm", input, 200))
	if len(installed) != 1 || installed[0].FileCount != 24 || probe.reads != 24 {
		t.Fatalf("confirmation reread unselected Skills: installed=%+v reads=%d", installed, probe.reads)
	}
}

func TestKoiMigrationCancellationAndTimeoutKeepLegacyMode(t *testing.T) {
	a, user, _ := writingTestApp(t)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	enableRepositoryR2Fixture(t, a)
	t.Cleanup(func() {
		if _, err := a.db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, user.ID); err != nil {
			t.Error(err)
		}
	})
	ctx := context.Background()
	workspace, err := a.createAgentWorkspace(ctx, user.ID, "Cancel migration", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	if workspace, err = a.patchAgentWorkspace(ctx, user.ID, workspace.WorkspaceID, workspace.Revision, []agentWorkspaceFile{repositoryTestFile("SKILL.md", "# Review"), repositoryTestFile("guide.md", "Preserve facts.")}, nil); err != nil {
		t.Fatal(err)
	}
	probe := &koiMigrationReadProbe{agentRepositoryObjectStore: a.agentObjectStore, gate: make(chan struct{}), entered: make(chan struct{}, 8)}
	a.agentObjectStore = probe
	work, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := a.koiAnalyzeSource(work, user.ID, map[string]any{"kind": "migration"}); done <- err }()
	select {
	case <-probe.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("migration did not start reading")
	}
	cancel()
	select {
	case err = <-done:
		if !errors.Is(err, context.Canceled) || probe.active != 0 {
			t.Fatalf("cancel left reads running: %v active=%d", err, probe.active)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("migration kept running after cancellation")
	}
	deadline, stop := context.WithDeadline(ctx, time.Now().Add(-time.Second))
	defer stop()
	_, err = a.koiAnalyzeSource(deadline, user.ID, map[string]any{"kind": "migration"})
	response := httptest.NewRecorder()
	writeKoiError(response, err)
	if !errors.Is(err, errKoiMigrationTimeout) || response.Code != 504 {
		t.Fatalf("timeout not reported: %v %s", err, response.Body.String())
	}
	close(probe.gate)
	probe.gate = nil
	preview, _ := koiMigrationPreview(t, a, user)
	settings, err := a.koiSettingsForUser(ctx, user.ID)
	if err != nil || preview.Status != "ready" || settings.LibraryMode != "legacy" {
		t.Fatalf("retry or library mode changed: %s %+v %v", preview.Status, settings, err)
	}
	// A stored failed preview has an empty entries map. Retrying it must discover
	// newly repaired packages instead of treating it as an empty confirmation.
	if workspace, err = a.patchAgentWorkspace(ctx, user.ID, workspace.WorkspaceID, workspace.Revision, []agentWorkspaceFile{repositoryTestFile("SKILL.md", "")}, nil); err != nil {
		t.Fatal(err)
	}
	failed, request := koiMigrationPreview(t, a, user)
	if failed.Status != "failed" {
		t.Fatal("empty Skill should fail preview validation")
	}
	if _, err = a.patchAgentWorkspace(ctx, user.ID, workspace.WorkspaceID, workspace.Revision, []agentWorkspaceFile{repositoryTestFile("SKILL.md", "# Repaired")}, nil); err != nil {
		t.Fatal(err)
	}
	retry := koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: request, SourceKind: "migration"}, 202))
	if retry.ID != failed.ID || retry.Status != "ready" || len(retry.Candidates) != 1 {
		t.Fatalf("failed preview could not rescan repaired source: %+v", retry)
	}
}
