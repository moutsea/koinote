package server

import (
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestMapMCPFeishuError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{name: "not configured", err: errFeishuNotConfigured, want: "not configured"},
		{name: "not bound", err: errFeishuNotBound, want: "bind a Feishu account"},
		{name: "token invalid", err: errFeishuTokenInvalid, want: "authorization expired"},
		{name: "account busy", err: errFeishuBusy, want: "account is busy"},
		{name: "server busy", err: errFeishuServerBusy, want: "capacity is busy"},
		{name: "content limit", err: errFeishuContentLimit, want: "sync limits"},
		{name: "image", err: errFeishuImage, want: "images could not be uploaded"},
		{name: "source document", err: errDocumentNotFound, want: "document not found"},
		{name: "permission", err: &feishuAPIError{Status: http.StatusForbidden, Code: 0}, want: "denied document access"},
		{name: "joined permission", err: errors.Join(errors.New("provider failure"), &feishuAPIError{Status: http.StatusBadRequest, Code: 1770032}), want: "denied document access"},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			if got := mapMCPFeishuError(testCase.err).Error(); !strings.Contains(got, testCase.want) {
				t.Fatalf("mapMCPFeishuError() = %q, want substring %q", got, testCase.want)
			}
		})
	}
}
