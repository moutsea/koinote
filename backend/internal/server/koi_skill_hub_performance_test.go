package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestKoiHubCollectionBackfillAndPreviewUseBoundedParallelReads(t *testing.T) {
	files := map[string]string{"LICENSE": "MIT License"}
	for i := 0; i < 10; i++ {
		files[fmt.Sprintf("skills/writing-%d/SKILL.md", i)] = fmt.Sprintf("# Writing method %d", i)
		for j := 0; j < 19; j++ {
			content := fmt.Sprintf("Reference %d/%d", i, j)
			if j == 0 {
				content = "Shared writing reference"
			}
			files[fmt.Sprintf("skills/writing-%d/reference-%d.md", i, j)] = content
		}
	}
	app, owner, workspace, _ := koiHubSourceTestApp(t, true, files)
	unique := map[string]bool{}
	for _, content := range files {
		unique[koiDigest([]byte(content))] = true
	}
	store := app.agentObjectStore.(*workerAgentRepositoryObjects)
	client := *store.client
	base := client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	var active, peak, requests atomic.Int64
	client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Method == http.MethodGet {
			requests.Add(1)
			count := active.Add(1)
			defer active.Add(-1)
			for {
				previous := peak.Load()
				if count <= previous || peak.CompareAndSwap(previous, count) {
					break
				}
			}
			timer := time.NewTimer(160 * time.Millisecond)
			select {
			case <-r.Context().Done():
				timer.Stop()
				return nil, r.Context().Err()
			case <-timer.C:
			}
		}
		return base.RoundTrip(r)
	})
	store.client = &client
	work, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	started := time.Now()
	if count, err := app.backfillAgentRepositoryKoiInstallability(work, 8); err != nil || count != 1 {
		t.Fatalf("backfill: %d %v", count, err)
	}
	if value := repositoryKoiInstallability(t, app, workspace.WorkspaceID); value == nil || !*value {
		t.Fatal("a valid large collection did not finish validation")
	}
	if requests.Load() != int64(len(unique)) {
		t.Fatalf("backfill read %d objects, want %d unique contents", requests.Load(), len(unique))
	}
	analysis, err := app.koiAnalyzeSource(work, owner, map[string]any{"kind": "hub", "workspaceId": workspace.WorkspaceID})
	if err != nil || len(analysis.candidates) != 10 || len(analysis.rejected) != 0 {
		t.Fatalf("installation preview: candidates=%d rejected=%d err=%v", len(analysis.candidates), len(analysis.rejected), err)
	}
	if requests.Load() != 2*int64(len(unique)) || peak.Load() < 2 || peak.Load() > 8 || active.Load() != 0 {
		t.Fatalf("unbounded, serial or duplicate reads: requests=%d peak=%d active=%d", requests.Load(), peak.Load(), active.Load())
	}
	t.Logf("201-file collection: backfill and real installation analysis completed in %s, %d unique reads each, peak concurrency %d", time.Since(started).Round(time.Millisecond), len(unique), peak.Load())
}

func TestKoiHubReadFailureCancelsSiblingReads(t *testing.T) {
	files := map[string]string{"SKILL.md": "# Review"}
	for i := 0; i < 20; i++ {
		files[fmt.Sprintf("reference-%d.md", i)] = fmt.Sprintf("Reference %d", i)
	}
	app, _, workspace, _ := koiHubSourceTestApp(t, true, files)
	store := app.agentObjectStore.(*workerAgentRepositoryObjects)
	client := *store.client
	var active atomic.Int64
	client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		active.Add(1)
		defer active.Add(-1)
		if strings.HasSuffix(r.URL.Path, koiDigest([]byte("# Review"))) {
			return nil, errAgentRepositoryStorage
		}
		<-r.Context().Done()
		return nil, r.Context().Err()
	})
	store.client = &client
	work, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result, err := app.readKoiHubSource(work, koiHubSourceInput{WorkspaceID: workspace.WorkspaceID})
	if !errors.Is(err, errAgentRepositoryStorage) || work.Err() != nil || result.Publication != nil || active.Load() != 0 {
		t.Fatalf("failed reads were not canceled cleanly: result=%+v err=%v context=%v active=%d", result, err, work.Err(), active.Load())
	}
}
