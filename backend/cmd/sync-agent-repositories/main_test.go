package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"koinote/backend/internal/server"
)

func TestMaintenanceExitStatusPreservesFatalErrors(t *testing.T) {
	deferred := fmt.Errorf("%w: private upstream error", server.ErrKoiInstallabilityDeferred)
	fatal := errors.New("private database error")
	for _, test := range []struct {
		name         string
		operationErr error
		checkErr     error
		wantExit     int
		wantDeferred bool
	}{
		{name: "successful checks"},
		{name: "retryable checks allow deployment", checkErr: deferred, wantDeferred: true},
		{name: "manual review and deferred checks", operationErr: server.ErrSystemRepositoriesNeedAttention, checkErr: deferred, wantDeferred: true},
		{name: "prior sync failure remains fatal", operationErr: fatal, checkErr: deferred, wantExit: 1, wantDeferred: true},
		{name: "system check failure blocks deployment", checkErr: fatal, wantExit: 1},
		{name: "manual review cannot hide system failure", operationErr: server.ErrSystemRepositoriesNeedAttention, checkErr: fatal, wantExit: 1},
		{name: "interruption blocks deployment", checkErr: context.Canceled, wantExit: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			exit := finishMaintenance(&stdout, &stderr, nil, true, 3, test.operationErr, test.checkErr)
			var result struct {
				Applied               bool `json:"applied"`
				CompatibilityChecks   int  `json:"compatibilityChecks"`
				CompatibilityDeferred bool `json:"compatibilityDeferred"`
			}
			if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if exit != test.wantExit || result.CompatibilityDeferred != test.wantDeferred || result.CompatibilityChecks != 3 || !result.Applied {
				t.Fatalf("unexpected maintenance outcome: exit=%d result=%+v log=%s", exit, result, stderr.String())
			}
			if strings.Contains(stderr.String(), "private") || strings.Contains(stdout.String(), "private") {
				t.Fatal("maintenance output exposed a raw error")
			}
			if test.wantDeferred && !strings.Contains(stderr.String(), "later maintenance run") {
				t.Fatal("deferred checks were reported as a silent success")
			}
		})
	}
}
