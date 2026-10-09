package server

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

var (
	errAgentWorkspaceCommentSensitive = errors.New("change description contains sensitive data; remove secrets from the comment")
	errAgentWorkspaceCommentInvalid   = errors.New("comment must be valid text of at most 500 characters without control characters")
)

func validateAgentWorkspaceComment(raw string) (string, error) {
	if !utf8.ValidString(raw) {
		return "", errAgentWorkspaceCommentInvalid
	}
	comment := strings.TrimSpace(raw)
	if utf8.RuneCountInString(comment) > 500 {
		return "", errAgentWorkspaceCommentInvalid
	}
	for _, ch := range comment {
		if unicode.IsControl(ch) && ch != '\n' && ch != '\t' {
			return "", errAgentWorkspaceCommentInvalid
		}
	}
	if agentWorkspaceSensitiveContent([]byte(comment)) {
		return "", errAgentWorkspaceCommentSensitive
	}
	return comment, nil
}
