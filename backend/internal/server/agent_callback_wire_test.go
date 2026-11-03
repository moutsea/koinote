package server

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func startCallbackWireOrigin(t *testing.T, handler http.Handler) (*httptest.Server, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), DNSNames: []string{"koi-local.koinote.app"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
	server.StartTLS()
	t.Cleanup(server.Close)
	return server, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

func TestAgentWireAuthenticatedCallbackAndMCP(t *testing.T) {
	if os.Getenv("KOINOTE_TEST_CONTRACT_DIR") == "" {
		t.Skip("run npm run test:koi-agent-contract with the upstream checkout")
	}
	a, u, doc := writingTestApp(t)
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "联动回归"))
	origin, ca := startCallbackWireOrigin(t, a.Routes())
	var foreignCalls atomic.Int32
	foreign, _ := startCallbackWireOrigin(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { foreignCalls.Add(1); w.WriteHeader(200) }))
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	upstream := os.Getenv("AGENT_GPT_CHECKOUT")
	if upstream == "" {
		upstream = filepath.Join(root, "../tools/agent-gpt")
	}
	fixture, err := json.Marshal(map[string]string{"id": task.ID, "job": task.JobID, "workspace": task.WorkspaceID, "mcp": a.writingSecret(task.ID, "mcp"), "callback": a.writingSecret(task.ID, "callback"), "upstream": upstream, "temp": t.TempDir(), "ca": ca, "good": origin.URL, "foreign": foreign.URL})
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", filepath.Join(root, "scripts/fixtures/agent-callback-wire.mjs"))
	cmd.Stdin = bytes.NewReader(fixture)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("wire probe: %v: %s", err, out)
	}
	var deliveries int
	if err := a.db.QueryRow(context.Background(), `SELECT count(*) FROM writing_agent_deliveries WHERE task_id=$1`, task.ID).Scan(&deliveries); err != nil || deliveries != 1 || foreignCalls.Load() != 0 {
		t.Fatal(err, deliveries, foreignCalls.Load())
	}
}
