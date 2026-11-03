package server

import (
	"context"
	_ "embed"
	"encoding/json"
	"strings"
	"unicode"
)

// The organizer menu and starter chip display these same localized prompts.
//
//go:embed agent_organize_prompts.json
var agentOrganizePromptsJSON []byte

var agentOrganizePrompts map[string]string

func init() {
	if err := json.Unmarshal(agentOrganizePromptsJSON, &agentOrganizePrompts); err != nil {
		panic(err)
	}
}

const agentLibraryScopeInstruction = "本次任务是按内容主题整理文档集合，只允许 folder 和 move 操作。请用 search_documents、list_folders 查找文档和文件夹，读取待分类文档，并携带 get_document 返回的 revision 作为 expectedRevision 提交移动方案。保持标题和正文不变；当前打开的文档以及助手之前的改写建议都不能把任务变成正文编辑。"

func agentScopeText(message string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || strings.ContainsRune("，。！？；：,.!?;:", r) {
			return -1
		}
		return unicode.ToLower(r)
	}, message)
}

// Recognize the explicit library starters conservatively. This is an extra
// operation constraint, not a general language classifier: unfamiliar requests
// keep the normal agent behavior, and a new user goal ends inherited scope.
func agentLibraryRequest(message string) bool {
	s := agentScopeText(message)
	for _, prompt := range agentOrganizePrompts {
		if s == agentScopeText(prompt) {
			return true
		}
	}
	for _, request := range []string{
		"整理我的文档", "请整理我的文档", "帮我整理我的文档", "整理一下我的文档", "整理文档库", "按内容整理我的文档", "按主题整理我的文档",
		"Organize my documents", "Organize my document collection by topic",
		"Organiser mes documents", "Organise mes documents", "文書を整理する",
		"请按内容主题整理我的文档：查看文档和现有文件夹，按主题分组并提交文件夹或移动文档的方案。保留各篇文档的标题和正文，不做润色，不删除文档。",
		"Organize my document collection by topic: inspect the documents and existing folders, then propose folders or document moves. Preserve every document title and body; leave polishing and deletion out of this task.",
		"Classe mes documents par thème : examine les documents et les dossiers existants, puis propose des dossiers ou des déplacements. Préserve les titres et le contenu ; aucune réécriture ni suppression.",
		"文書全体を内容のテーマ別に整理してください。文書と既存フォルダーを確認し、フォルダーの作成や文書の移動を提案してください。各文書のタイトルと本文を維持し、推敲や削除は行わないでください。",
	} {
		if s == agentScopeText(request) {
			return true
		}
	}
	return false
}

func agentLibraryFollowup(message string) bool {
	s := agentScopeText(message)
	for _, prefix := range []string{"我想要你", "我希望你", "我想要", "请你", "请", "帮我", "那就"} {
		s = strings.TrimPrefix(s, prefix)
	}
	s = strings.ReplaceAll(s, "按照", "按")
	switch s {
	case "按内容分组", "按内容分类", "按内容整理", "按主题分组", "按主题分类", "按主题整理", "继续", "好的", "可以", "开始", "按你说的做",
		"bytopic", "groupbycontent", "groupbytopic", "continue", "yes", "parthème", "parcontenu", "内容で分類", "テーマ別に整理":
		return true
	}
	return false
}

func agentLibraryScopeFromMessages(message string, history []string) bool {
	for _, text := range append([]string{message}, history...) {
		if agentLibraryRequest(text) {
			return true
		}
		if !agentLibraryFollowup(text) {
			return false
		}
	}
	return false
}

func agentLibraryTask(ctx context.Context, q imageUsageQuerier, task writingTask, session agentSession) (bool, error) {
	if !task.Conversation || session.WriteDocumentID != "" {
		return false, nil
	}
	if agentLibraryRequest(task.Message) {
		return true, nil
	}
	if !agentLibraryFollowup(task.Message) {
		return false, nil
	}
	// Match the model's bounded history window, using only user-authored messages.
	// Never infer authorization from assistant results or editor-focus metadata.
	var history []string
	err := q.QueryRow(ctx, `SELECT COALESCE(array_agg(message ORDER BY created_at DESC,id DESC),'{}'::text[]) FROM (SELECT id,created_at,message FROM writing_agent_tasks WHERE session_id=$1 AND user_id=$2 AND id<>$3 AND created_at<=$4 ORDER BY created_at DESC,id DESC LIMIT 6) prior`, task.SessionID, task.UserID, task.ID, task.CreatedAt).Scan(&history)
	return agentLibraryScopeFromMessages(task.Message, history), err
}
