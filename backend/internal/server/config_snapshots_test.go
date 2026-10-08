package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func TestValidConfigSnapshotEnvelope(t *testing.T) {
	header := map[string]any{
		"version":    1,
		"kdf":        "PBKDF2-SHA-256",
		"iterations": 310000,
		"salt":       base64.StdEncoding.EncodeToString(make([]byte, 16)),
		"iv":         base64.StdEncoding.EncodeToString(make([]byte, 12)),
		"ciphertext": base64.StdEncoding.EncodeToString(make([]byte, 16)),
	}
	serialized, err := json.Marshal(header)
	if err != nil {
		t.Fatal(err)
	}
	if !validConfigSnapshotEnvelope(serialized) {
		t.Fatal("expected a valid config snapshot envelope")
	}
}

func TestInvalidConfigSnapshotEnvelope(t *testing.T) {
	if validConfigSnapshotEnvelope([]byte(`{"version":1,"kdf":"PBKDF2-SHA-256","iterations":310000,"salt":"","iv":"","ciphertext":""}`)) {
		t.Fatal("expected an invalid config snapshot envelope")
	}
	header := map[string]any{
		"version":    1,
		"kdf":        "PBKDF2-SHA-256",
		"iterations": 310000,
		"salt":       base64.StdEncoding.EncodeToString(make([]byte, 16)),
		"iv":         base64.StdEncoding.EncodeToString(make([]byte, 12)),
		"ciphertext": base64.StdEncoding.EncodeToString(make([]byte, 15)),
	}
	serialized, err := json.Marshal(header)
	if err != nil {
		t.Fatal(err)
	}
	if validConfigSnapshotEnvelope(serialized) {
		t.Fatal("expected an AES-GCM ciphertext to include its authentication tag")
	}
}

func TestConfigSnapshotCiphertextValidation(t *testing.T) {
	salt := base64.StdEncoding.EncodeToString(make([]byte, 16))
	iv := base64.StdEncoding.EncodeToString(make([]byte, 12))
	envelope := func(ciphertext string) []byte {
		return []byte(`{"version":1,"kdf":"PBKDF2-SHA-256","iterations":310000,"salt":"` + salt + `","iv":"` + iv + `","ciphertext":` + ciphertext + `}`)
	}
	// 16 字节 0xff 的 base64 含 "/"，转义写法也必须被接受。
	plain := base64.StdEncoding.EncodeToString([]byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff})
	escaped := strings.ReplaceAll(plain, "/", `\/`)
	if !validConfigSnapshotEnvelope(envelope(`"` + plain + `"`)) {
		t.Fatal("expected plain ciphertext to be valid")
	}
	if !validConfigSnapshotEnvelope(envelope(`"` + escaped + `"`)) {
		t.Fatal("expected JSON-escaped ciphertext to be valid")
	}
	for _, invalid := range []string{`""`, `123`, `null`, `"not base64!!"`, `"` + plain + `\u0021"`} {
		if validConfigSnapshotEnvelope(envelope(invalid)) {
			t.Fatalf("expected ciphertext %s to be rejected", invalid)
		}
	}
}

func TestConfigSnapshotUserWriteIsExclusive(t *testing.T) {
	if !acquireConfigSnapshotUserWrite(42) {
		t.Fatal("first write should acquire")
	}
	if acquireConfigSnapshotUserWrite(42) {
		t.Fatal("second concurrent write for the same user should be rejected")
	}
	if !acquireConfigSnapshotUserWrite(43) {
		t.Fatal("another user should not be blocked")
	}
	releaseConfigSnapshotUserWrite(42)
	releaseConfigSnapshotUserWrite(43)
	if !acquireConfigSnapshotUserWrite(42) {
		t.Fatal("released user should acquire again")
	}
	releaseConfigSnapshotUserWrite(42)
}

func TestConfigSnapshotWriteAndRevisionIntegration(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	ctx := context.Background()
	var authUserID string
	if err := pool.QueryRow(ctx, `SELECT auth_user_id FROM users WHERE id = $1`, userID).Scan(&authUserID); err != nil {
		t.Fatalf("load auth user: %v", err)
	}
	app := &App{db: pool, cfg: config.Config{SessionSecret: "config-snapshot-integration", AppURL: "https://koinote.example"}}
	cookie := sessionCookieFor(t, app, authUserID, 1)
	header := map[string]any{
		"version": 1, "kdf": "PBKDF2-SHA-256", "iterations": 310000,
		"salt":       base64.StdEncoding.EncodeToString(make([]byte, 16)),
		"iv":         base64.StdEncoding.EncodeToString(make([]byte, 12)),
		"ciphertext": base64.StdEncoding.EncodeToString(make([]byte, 16)),
	}
	envelope, err := json.Marshal(header)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(configSnapshotCreateInput{Name: "integration", FileCount: 1, EnvelopeVersion: 1, Envelope: string(envelope)})
	if err != nil {
		t.Fatal(err)
	}
	created := callLLMChannelAPI(t, app, cookie, http.MethodPost, "/api/config-snapshots", string(payload))
	if created.Code != http.StatusCreated {
		t.Fatalf("create snapshot status=%d body=%s", created.Code, created.Body.String())
	}
	var createdBody struct {
		Snapshot configSnapshotSummary `json:"snapshot"`
	}
	decodeJSONResponse(t, created, &createdBody)
	if createdBody.Snapshot.Revision != 1 || createdBody.Snapshot.Bytes != int64(len(envelope)) {
		t.Fatalf("created snapshot = %+v", createdBody.Snapshot)
	}
	updatePayload, err := json.Marshal(configSnapshotCreateInput{
		Name: "integration updated", FileCount: 1, EnvelopeVersion: 1,
		Envelope: string(envelope), Revision: createdBody.Snapshot.Revision,
	})
	if err != nil {
		t.Fatal(err)
	}
	updated := callLLMChannelAPI(t, app, cookie, http.MethodPut, "/api/config-snapshots/"+createdBody.Snapshot.SnapshotID, string(updatePayload))
	if updated.Code != http.StatusOK {
		t.Fatalf("update snapshot status=%d body=%s", updated.Code, updated.Body.String())
	}
	var updatedBody struct {
		Snapshot configSnapshotSummary `json:"snapshot"`
	}
	decodeJSONResponse(t, updated, &updatedBody)
	if updatedBody.Snapshot.Revision != 2 || updatedBody.Snapshot.Name != "integration updated" {
		t.Fatalf("updated snapshot = %+v", updatedBody.Snapshot)
	}
}
