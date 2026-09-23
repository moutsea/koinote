package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"
)

const wechatDraftStreamContentType = "application/x-koinote-wechat-draft"

type wechatDraftStreamFrame struct {
	Type   string          `json:"type"`
	Status int             `json:"status,omitempty"`
	Body   json.RawMessage `json:"body,omitempty"`
}

type wechatDraftResponseStream struct {
	target   http.ResponseWriter
	headers  http.Header
	status   int
	cancel   context.CancelFunc
	done     chan struct{}
	mu       sync.Mutex
	finished bool
}

func newWechatDraftResponseStream(w http.ResponseWriter, ctx context.Context, interval time.Duration) (*wechatDraftResponseStream, context.Context) {
	streamContext, cancel := context.WithCancel(ctx)
	stream := &wechatDraftResponseStream{
		target: w, headers: make(http.Header), status: http.StatusOK, cancel: cancel, done: make(chan struct{}),
	}
	w.Header().Set("Content-Type", wechatDraftStreamContentType)
	w.Header().Set("Cache-Control", "no-store, no-transform")
	if err := stream.send(wechatDraftStreamFrame{Type: "ping"}); err != nil {
		cancel()
	}
	go func() {
		defer close(stream.done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-streamContext.Done():
				return
			case <-ticker.C:
				if err := stream.send(wechatDraftStreamFrame{Type: "ping"}); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	return stream, streamContext
}

func (stream *wechatDraftResponseStream) Header() http.Header {
	return stream.headers
}

func (stream *wechatDraftResponseStream) WriteHeader(status int) {
	stream.status = status
}

func (stream *wechatDraftResponseStream) Write(body []byte) (int, error) {
	if err := stream.send(wechatDraftStreamFrame{Type: "result", Status: stream.status, Body: json.RawMessage(body)}); err != nil {
		stream.cancel()
		return 0, err
	}
	return len(body), nil
}

func (stream *wechatDraftResponseStream) send(frame wechatDraftStreamFrame) error {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if stream.finished {
		return io.ErrClosedPipe
	}
	controller := http.NewResponseController(stream.target)
	_ = controller.SetWriteDeadline(time.Now().Add(15 * time.Second))
	if err := json.NewEncoder(stream.target).Encode(frame); err != nil {
		return err
	}
	if err := controller.Flush(); err != nil {
		return err
	}
	if frame.Type == "result" {
		stream.finished = true
	}
	return nil
}

func (stream *wechatDraftResponseStream) Close() {
	stream.cancel()
	<-stream.done
}
