package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"koinote/backend/internal/httpx"
)

func TestWechatDraftStreamFlushesHeartbeatsAndPreservesErrors(t *testing.T) {
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stream, ctx := newWechatDraftResponseStream(w, r.Context(), 20*time.Millisecond)
		defer stream.Close()
		select {
		case <-release:
			httpx.ErrorCode(stream, http.StatusBadGateway, "wechat_provider_error", "Provider rejected draft")
		case <-ctx.Done():
		}
	}))
	defer server.Close()
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.Header.Get("Content-Type") != wechatDraftStreamContentType {
		t.Fatalf("stream content type=%q", response.Header.Get("Content-Type"))
	}
	decoder := json.NewDecoder(response.Body)
	for index := 0; index < 3; index++ {
		var frame wechatDraftStreamFrame
		if err := decoder.Decode(&frame); err != nil || frame.Type != "ping" {
			t.Fatalf("heartbeat %d type=%q error=%v", index, frame.Type, err)
		}
	}
	close(release)
	for {
		var frame wechatDraftStreamFrame
		if err := decoder.Decode(&frame); err != nil {
			t.Fatal(err)
		}
		if frame.Type == "ping" {
			continue
		}
		var body struct{ Code string }
		if err := json.Unmarshal(frame.Body, &body); err != nil || frame.Type != "result" || frame.Status != http.StatusBadGateway || body.Code != "wechat_provider_error" {
			t.Fatalf("result=%+v body=%+v error=%v", frame, body, err)
		}
		break
	}
	var trailing wechatDraftStreamFrame
	if err := decoder.Decode(&trailing); err != io.EOF {
		t.Fatalf("stream continued after final result: %v", err)
	}
}

func TestWechatDraftStreamDisconnectCancelsWork(t *testing.T) {
	stopped := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stream, ctx := newWechatDraftResponseStream(w, r.Context(), 20*time.Millisecond)
		defer stream.Close()
		<-ctx.Done()
		close(stopped)
	}))
	defer server.Close()
	response, err := http.Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("disconnected draft request continued running")
	}
}

type failedWechatStreamWriter struct{ httptest.ResponseRecorder }

func (writer *failedWechatStreamWriter) Write([]byte) (int, error) {
	return 0, io.ErrClosedPipe
}

func TestWechatDraftStreamWriteFailureCancelsWork(t *testing.T) {
	writer := &failedWechatStreamWriter{ResponseRecorder: *httptest.NewRecorder()}
	stream, ctx := newWechatDraftResponseStream(writer, context.Background(), time.Second)
	defer stream.Close()
	if ctx.Err() != context.Canceled {
		t.Fatal("failed heartbeat did not cancel draft work")
	}
}
