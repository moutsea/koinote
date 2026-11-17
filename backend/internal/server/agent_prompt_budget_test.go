package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"unicode/utf16"
)

func TestAgentFinalPromptBudgetBothEntriesAndSkillPagination(t *testing.T) {
	a, user, doc := writingTestApp(t)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	enableRepositoryR2Fixture(t, a)
	t.Cleanup(func() {
		if _, err := a.db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, user.ID); err != nil {
			t.Error(err)
		}
	})
	for i := 0; i < 20; i++ {
		entry := fmt.Sprintf("---\nname: writing-method-%02d\ndescription: %s\n---\nReview prose using method %d.", i, strings.Repeat("写作😀改稿和标题建议。", 35), i)
		koiRuntimeInstall(t, a, user, map[string]string{"SKILL.md": entry})
	}
	for _, article := range []bool{false, true} {
		t.Run(fmt.Sprintf("article=%t", article), func(t *testing.T) {
			session := agentTestSession(t, a, user, "review")
			if article {
				session = koiArticleSession(t, a, user, doc)
			}
			task := agentTestTask(t, a, user, session, doc, "帮我起标题", http.Header{agentPublishingHeader: {"1"}, agentCoversHeader: {"1"}, agentCoverApplyHeader: {"1"}, agentGeoHeader: {"1"}})
			input := map[string]any{"policy": map[string]any{}}
			if err := a.prepareAgentConversationInput(context.Background(), &task, input, ""); err != nil {
				t.Fatal(err)
			}
			prompt := input["systemPrompt"].(string)
			length := len(utf16.Encode([]rune(prompt)))
			if length > agentSystemPromptLimit {
				t.Fatal("final prompt exceeds Agent API limit", length)
			}
			for _, rule := range []string{automaticAgentSkillInstructions, agentGeoInstructions, agentPublishingInstructions, agentCoverPrompt(task), agentProductKnowledgeInstructions, agentConversationContinuityInstructions} {
				if !strings.Contains(prompt, rule) {
					t.Fatal("budget removed core capability instructions")
				}
			}
			_, rest, found := strings.Cut(prompt, agentSkillCatalogMarker)
			catalog, _, _ := strings.Cut(rest, "\n")
			var page struct {
				Skills []struct {
					SkillID string `json:"skillId"`
				}
				NextCursor string `json:"nextCursor"`
			}
			if !found || json.Unmarshal([]byte(catalog), &page) != nil || page.NextCursor == "" {
				t.Fatal("missing catalog continuation")
			}
			seen := map[string]bool{}
			for _, skill := range page.Skills {
				seen[skill.SkillID] = true
			}
			cursor := page.NextCursor
			for cursor != "" {
				_, next, err := a.agentFindSkills(context.WithValue(context.Background(), writingMCPContext{}, task), nil, agentSearchInput{Cursor: cursor, Limit: 20})
				if err != nil {
					t.Fatal(err)
				}
				rows := next["skills"].([]map[string]any)
				for _, row := range rows {
					id := row["skillId"].(string)
					if seen[id] {
						t.Fatal("catalog pagination duplicated skill", id)
					}
					seen[id] = true
				}
				cursor = next["nextCursor"].(string)
			}
			if len(seen) != 20 {
				t.Fatal("budget hid installed skills", len(seen))
			}
			repaired := boundedAgentReceiptPrompt(prompt + agentReceiptMarker + strings.Repeat("📁", 12000))
			if len(utf16.Encode([]rune(repaired))) > agentSystemPromptLimit || !strings.Contains(repaired, agentReceiptLookup) || !strings.Contains(repaired, agentGeoInstructions) {
				t.Fatal("history repair lost budget/core rules")
			}
			t.Logf("final UTF-16=%d; catalog entries=%d; discoverable skills=%d", length, len(page.Skills), len(seen))
		})
	}
}

func TestAgentPromptBudgetPreservesCatalogTailAndEmptyPage(t *testing.T) {
	skills := make([]koiTaskSkill, 30)
	for i := range skills {
		skills[i] = koiTaskSkill{InstallationID: fmt.Sprintf("skill-%d", i), Name: "method", Description: strings.Repeat("写作😀", 100)}
	}
	tail := "\n\nEssential GEO approval and publication instructions."
	base := strings.Repeat("a", 19800-len(tail))
	prompt := boundedAgentReceiptPrompt(base + agentSkillCatalogMarker + agentSkillCatalog(skills) + tail)
	if len(utf16.Encode([]rune(prompt))) > agentSystemPromptLimit || !strings.HasPrefix(prompt, base) || !strings.HasSuffix(prompt, tail) {
		t.Fatal("core instructions truncated or over limit")
	}
	_, rest, _ := strings.Cut(prompt, agentSkillCatalogMarker)
	raw, _, _ := strings.Cut(rest, "\n")
	var page struct {
		Skills     []json.RawMessage
		NextCursor string
	}
	if err := json.Unmarshal([]byte(raw), &page); err != nil {
		t.Fatal(err)
	}
	offset, _, err := parseMCPPage(page.NextCursor, 20)
	if err != nil || offset != 0 || len(page.Skills) != 0 {
		t.Fatal("zero-entry catalog cannot start discovery", string(raw), err)
	}
}
