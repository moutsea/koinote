package server

import (
	"testing"

	"koinote/backend/internal/config"
)

// A task POST can reach the handler before StartWritingAgent runs; New must
// already own the channel so that first notify is kept, never dropped or blocked.
func TestWritingAgentNotifyBeforeWorkersStart(t *testing.T) {
	app := New(config.Config{}, nil)
	if app.writingWake == nil {
		t.Fatal("New did not create the writing agent wake channel")
	}
	app.notifyWritingAgent()
	app.notifyWritingAgent() // Full buffer: must return instead of blocking.
	if got := len(app.writingWake); got != 1 {
		t.Fatalf("buffered notifies = %d, want 1", got)
	}
	(&App{}).notifyWritingAgent() // App literals without New must not panic.
}
