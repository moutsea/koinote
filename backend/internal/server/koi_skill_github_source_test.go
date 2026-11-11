package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func koiGitHubSourceTestClient(t *testing.T, token string) *http.Client {
	t.Helper()
	archive := githubArchive(t,
		githubArchiveEntry{"root/LICENSE", "MIT License", 0},
		githubArchiveEntry{"root/SKILL.md", "# Root", 0},
		githubArchiveEntry{"root/review/SKILL.md", "---\nname: review\ndescription: Review a document.\n---\n# Review", 0},
		githubArchiveEntry{"root/review/guide.md", "Guide", 0},
		githubArchiveEntry{"root/review/nested/SKILL.md", "# Nested", 0},
		githubArchiveEntry{"root/other/SKILL.md", "# Other", 0})
	client := githubImportClient(t, archive, token, token != "")
	base := client.Transport
	client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "/branches") || strings.HasSuffix(r.URL.Path, "/tags") {
			if r.URL.Host != "api.github.com" || !strings.HasPrefix(r.URL.Path, "/repos/Octo/demo/") || r.URL.Query().Get("per_page") != "100" || r.URL.Query().Get("page") != "1" {
				t.Errorf("invalid canonical ref lookup: %s", r.URL)
			}
			body := `[]`
			if strings.HasSuffix(r.URL.Path, "/branches") {
				body = `[{"name":"main"},{"name":"feature/review"}]`
			}
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
		}
		if strings.HasPrefix(r.URL.Path, "/repos/Octo/demo/commits/") {
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(githubTestSHA)), Request: r}, nil
		}
		return base.RoundTrip(r)
	})
	return client
}

func TestKoiGitHubSourceResolvesAndPinsSelectedFiles(t *testing.T) {
	for _, tc := range []struct {
		name, suffix, ref, dir string
		input                  koiGitHubSourceInput
		exact                  bool
		count, candidateCount  int
	}{
		{name: "default branch", ref: "main", count: 6, candidateCount: 4},
		{name: "tree directory", suffix: "/tree/main/review", ref: "main", dir: "review", count: 4, candidateCount: 2},
		{name: "file entry", suffix: "/blob/main/review/SKILL.md", ref: "main", dir: "review", exact: true, count: 3, candidateCount: 1},
		{name: "slash branch", suffix: "/blob/feature/review/review/SKILL.md", ref: "feature/review", dir: "review", exact: true, count: 3, candidateCount: 1},
		{name: "commit permalink", suffix: "/blob/" + githubTestSHA + "/review/SKILL.md", ref: githubTestSHA, dir: "review", exact: true, count: 3, candidateCount: 1},
		{name: "advanced overrides blob", suffix: "/blob/main/other/SKILL.md", input: koiGitHubSourceInput{Ref: "feature/review", Path: " /review/ "}, ref: "feature/review", dir: "review", count: 4, candidateCount: 2},
		{name: "advanced root", suffix: "/blob/main/other/SKILL.md", input: koiGitHubSourceInput{Ref: "main"}, ref: "main", count: 6, candidateCount: 4},
		{name: "explicit exact directory", input: koiGitHubSourceInput{Path: "review", ExactSkill: true}, ref: "main", dir: "review", exact: true, count: 3, candidateCount: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := koiGitHubSourceTestClient(t, "")
			base := client.Transport
			commits, downloads, listings := 0, 0, 0
			client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if strings.Contains(r.URL.Path, "/commits/") {
					commits++
					if r.URL.Path != "/repos/Octo/demo/commits/"+tc.ref {
						t.Errorf("wrong ref: %s", r.URL.Path)
					}
				}
				if r.URL.Host == githubCodeLoadHost {
					downloads++
					if r.URL.Path != "/Octo/demo/zip/"+githubTestSHA {
						t.Errorf("download not pinned: %s", r.URL.Path)
					}
				}
				if strings.HasSuffix(r.URL.Path, "/branches") || strings.HasSuffix(r.URL.Path, "/tags") {
					listings++
				}
				return base.RoundTrip(r)
			})
			input := tc.input
			input.RepositoryURL = "https://github.com/octo/demo" + tc.suffix
			result, err := (&App{githubHTTPClient: client}).readKoiGitHubSource(context.Background(), input, "")
			if err != nil {
				t.Fatal(err)
			}
			want := koiGitHubTarget{Owner: "Octo", Repo: "demo", Ref: tc.ref, Path: tc.dir, FileEntry: tc.exact}
			if result.Target != want || len(result.Files) != tc.count || commits != 1 || downloads != 1 {
				t.Fatalf("source = %+v, files=%d, commits=%d, downloads=%d", result.Target, len(result.Files), commits, downloads)
			}
			if tc.ref == githubTestSHA || input.Ref != "" || tc.suffix == "" {
				if listings != 0 {
					t.Fatal("unambiguous input should not enumerate branches or tags")
				}
			}
			if result.Source.RepositoryID != 123 || result.Source.CommitSHA != githubTestSHA || result.Source.Ref != tc.ref || result.Source.Author != "Octo" || result.Source.License != "MPL-2.0" {
				t.Fatalf("canonical provenance lost: %+v", result.Source)
			}
			for _, file := range result.Files {
				if file.SHA256 != koiDigest(file.Content) {
					t.Fatalf("unverified source bytes: %s", file.Path)
				}
			}
			candidates, rejected := koiSkillCandidates(result.Files, koiSkillSourceContext{
				Directory: result.Target.Path, RootName: result.Target.Repo, License: result.Source.License,
			})
			if len(candidates) != tc.candidateCount || len(rejected) != 0 {
				t.Fatalf("source did not produce the selected packages: candidates=%d, rejected=%+v", len(candidates), rejected)
			}
			for _, candidate := range candidates {
				if candidate.EntryPath != "SKILL.md" || candidate.License != "MIT License" {
					t.Fatalf("source entry or license lost during analysis: %+v", candidate)
				}
			}
		})
	}
}

func TestKoiGitHubSourceCredentialFallback(t *testing.T) {
	const token = "test-source-token"
	for _, stage := range []string{"none", "metadata", "refs", "commit", "archive", "rate limit", "private unavailable"} {
		t.Run(stage, func(t *testing.T) {
			auth := koiGitHubSourceTestClient(t, token).Transport
			public := koiGitHubSourceTestClient(t, "").Transport
			publicMetadata := 0
			client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				metadata := strings.EqualFold(r.URL.Path, "/repos/octo/demo")
				if r.Header.Get("Authorization") == "" {
					if metadata {
						publicMetadata++
					}
					if stage == "private unavailable" {
						return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
					}
					return public.RoundTrip(r)
				}
				fail := stage == "metadata" && metadata || stage == "refs" && strings.HasSuffix(r.URL.Path, "/branches") || stage == "commit" && strings.Contains(r.URL.Path, "/commits/") || stage == "archive" && strings.Contains(r.URL.Path, "/zipball/") || stage == "rate limit" || stage == "private unavailable"
				if fail {
					status := 401
					header := make(http.Header)
					if stage == "rate limit" {
						status = 403
						header.Set("X-RateLimit-Remaining", "0")
					}
					return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
				}
				return auth.RoundTrip(r)
			})}
			result, err := (&App{githubHTTPClient: client}).readKoiGitHubSource(context.Background(), koiGitHubSourceInput{RepositoryURL: "https://github.com/octo/demo/blob/main/review/SKILL.md"}, token)
			if stage == "rate limit" {
				if !errors.Is(err, errAgentGitHubRateLimited) || publicMetadata != 0 {
					t.Fatalf("rate limit triggered anonymous retry: %v", err)
				}
				return
			}
			if stage == "private unavailable" {
				if !errors.Is(err, errAgentGitHubCredentialRequired) || publicMetadata != 1 {
					t.Fatalf("credential guidance lost: %v", err)
				}
				return
			}
			if err != nil || result.Source.Private != (stage == "none") || len(result.Files) != 3 || (stage != "none" && publicMetadata != 1) {
				t.Fatalf("fallback did not independently resolve the public source: %+v, %v", result.Source, err)
			}
			encoded, _ := json.Marshal(result)
			if strings.Contains(string(encoded), token) {
				t.Fatal("source result contains credentials")
			}
		})
	}
}

func TestKoiGitHubRefsRequireCompleteCatalog(t *testing.T) {
	for _, mode := range []string{"pagination", "ambiguous", "bounded", "invalid", "null"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				refs := []map[string]string{}
				if strings.HasSuffix(r.URL.Path, "/branches") && (r.URL.Query().Get("page") == "1" || mode == "bounded") {
					for i := 0; i < 100; i++ {
						refs = append(refs, map[string]string{"name": fmt.Sprintf("branch-%03d", i)})
					}
					if mode == "ambiguous" {
						refs[0]["name"] = "feature"
					}
				} else if strings.HasSuffix(r.URL.Path, "/branches") {
					refs = append(refs, map[string]string{"name": "feature/review"})
				}
				body, _ := json.Marshal(refs)
				if mode == "invalid" {
					body = []byte(`[{"name":"../bad"}]`)
				}
				if mode == "null" {
					body = []byte(" null\n")
				}
				return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(body))), Request: r}, nil
			})}
			refs, err := (&App{githubHTTPClient: client}).koiGitHubRefs(context.Background(), "Octo", "demo", "main", "")
			switch mode {
			case "bounded":
				if !errors.Is(err, errKoiGitHubLink) || calls != 10 {
					t.Fatalf("unbounded or partial ref catalog: calls=%d, %v", calls, err)
				}
			case "invalid", "null":
				if !errors.Is(err, errAgentGitHubResponseInvalid) {
					t.Fatalf("malformed catalog accepted: %v", err)
				}
			default:
				if err != nil || calls != 3 {
					t.Fatalf("pagination failed: calls=%d, %v", calls, err)
				}
				ref, dir, err := koiResolveGitHubRefPath("feature/review/review", refs)
				if mode == "ambiguous" {
					if !errors.Is(err, errKoiGitHubLink) {
						t.Fatal("a second-page ambiguity was guessed")
					}
				} else if err != nil || ref != "feature/review" || dir != "review" {
					t.Fatalf("second-page ref lost: %q %q, %v", ref, dir, err)
				}
			}
		})
	}
}

func TestKoiGitHubSourceRejectsInvalidOrAmbiguousInput(t *testing.T) {
	for _, input := range []koiGitHubSourceInput{
		{RepositoryURL: "https://evil.example/octo/demo"},
		{RepositoryURL: "https://github.com/octo/demo", Ref: "main..old"},
		{RepositoryURL: "https://github.com/octo/demo", Path: "../review"},
	} {
		client := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			t.Errorf("invalid input issued a request: %s", r.URL)
			return nil, errors.New("unexpected request")
		})}
		if _, err := (&App{githubHTTPClient: client}).readKoiGitHubSource(context.Background(), input, ""); !errors.Is(err, errKoiGitHubLink) {
			t.Fatalf("invalid input accepted: %+v, %v", input, err)
		}
	}
	client := koiGitHubSourceTestClient(t, "")
	base := client.Transport
	client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "/branches") {
			return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`[{"name":"main"},{"name":"main/review"}]`)), Request: r}, nil
		}
		if strings.Contains(r.URL.Path, "/commits/") || githubArchiveTestRequest(r) {
			t.Error("an ambiguous source must stop before commit resolution or download")
		}
		return base.RoundTrip(r)
	})
	_, err := (&App{githubHTTPClient: client}).readKoiGitHubSource(context.Background(), koiGitHubSourceInput{RepositoryURL: "https://github.com/octo/demo/blob/main/review/SKILL.md"}, "")
	if !errors.Is(err, errKoiGitHubLink) {
		t.Fatalf("ambiguous source accepted: %v", err)
	}
}
