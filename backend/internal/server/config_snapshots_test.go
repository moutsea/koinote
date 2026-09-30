package server

import (
	"encoding/base64"
	"encoding/json"
	"testing"
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
	if !validConfigSnapshotEnvelope(string(serialized)) {
		t.Fatal("expected a valid config snapshot envelope")
	}
}

func TestInvalidConfigSnapshotEnvelope(t *testing.T) {
	if validConfigSnapshotEnvelope(`{"version":1,"kdf":"PBKDF2-SHA-256","iterations":310000,"salt":"","iv":"","ciphertext":""}`) {
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
	if validConfigSnapshotEnvelope(string(serialized)) {
		t.Fatal("expected an AES-GCM ciphertext to include its authentication tag")
	}
}
