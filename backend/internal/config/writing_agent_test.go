package config

import "testing"

func TestLoadWritingAgentModelTimeout(t *testing.T) {
	chdir(t, t.TempDir()) // Do not load the developer's .env during this test.
	for _, tc := range []struct {
		raw  string
		want int
	}{
		{"", 180000}, {"   ", 180000}, {" 240000 ", 240000},
		{"1000", 1000}, {"300000", 300000},
		{"0", 180000}, {"-1", 180000}, {"999", 180000}, {"300001", 180000},
		{"180s", 180000}, {"1.5", 180000}, {"999999999999999999999", 180000},
	} {
		t.Run(tc.raw, func(t *testing.T) {
			t.Setenv("AGENT_GPT_MODEL_TIMEOUT_MS", tc.raw)
			cfg := Load()
			if got := cfg.WritingAgentModelTimeoutMS(); got != tc.want {
				t.Fatalf("timeout for %q = %d, want %d", tc.raw, got, tc.want)
			}
		})
	}
}

func TestWritingAgentModelTimeoutDirectConfig(t *testing.T) {
	for _, value := range []int{0, -1, 999, 300001} {
		if got := (Config{AgentGPTModelTimeoutMS: value}).WritingAgentModelTimeoutMS(); got != 180000 {
			t.Fatalf("unsafe timeout %d escaped as %d", value, got)
		}
	}
}
