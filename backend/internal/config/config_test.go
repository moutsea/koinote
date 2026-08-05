package config

import (
	"os"
	"path/filepath"
	"testing"
)

// chdir 切到临时目录并在测试结束后自动切回。
func chdir(t *testing.T, dir string) {
	t.Helper()
	original, err := os.Getwd()
	if err != nil {
		t.Fatalf("获取工作目录失败: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("切换工作目录失败: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(original) })
}

func TestLoadDotEnvReadsCurrentDir(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("KOINOTE_TEST_KEY=from_dotenv\n"), 0o600); err != nil {
		t.Fatalf("写入 .env 失败: %v", err)
	}
	chdir(t, dir)
	t.Setenv("KOINOTE_TEST_KEY", "")
	_ = os.Unsetenv("KOINOTE_TEST_KEY")

	path := loadDotEnv()
	if path == "" {
		t.Fatal("期望找到 .env，实际返回空路径")
	}
	if got := os.Getenv("KOINOTE_TEST_KEY"); got != "from_dotenv" {
		t.Fatalf("期望 KOINOTE_TEST_KEY=from_dotenv，实际 %q", got)
	}
}

// 裸跑 `go run ./cmd/server` 时 cwd 是 backend/，.env 在上一级，必须能向上找到。
func TestLoadDotEnvReadsParentDir(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("KOINOTE_TEST_PARENT=parent_value\n"), 0o600); err != nil {
		t.Fatalf("写入 .env 失败: %v", err)
	}
	sub := filepath.Join(root, "backend")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatalf("创建子目录失败: %v", err)
	}
	chdir(t, sub)
	_ = os.Unsetenv("KOINOTE_TEST_PARENT")

	if path := loadDotEnv(); path == "" {
		t.Fatal("期望在上一级找到 .env，实际返回空路径")
	}
	if got := os.Getenv("KOINOTE_TEST_PARENT"); got != "parent_value" {
		t.Fatalf("期望 KOINOTE_TEST_PARENT=parent_value，实际 %q", got)
	}
}

// 真实环境变量优先级必须高于 .env 文件，否则 compose 注入的值会被文件里的旧值覆盖。
func TestRealEnvWinsOverDotEnv(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("KOINOTE_TEST_PRIORITY=from_file\n"), 0o600); err != nil {
		t.Fatalf("写入 .env 失败: %v", err)
	}
	chdir(t, dir)
	t.Setenv("KOINOTE_TEST_PRIORITY", "from_real_env")

	loadDotEnv()
	if got := os.Getenv("KOINOTE_TEST_PRIORITY"); got != "from_real_env" {
		t.Fatalf("真实环境变量应当胜出，期望 from_real_env，实际 %q", got)
	}
}

// 容器内没有 .env，缺失不能报错或 panic。
func TestLoadDotEnvMissingIsNotFatal(t *testing.T) {
	chdir(t, t.TempDir())
	if path := loadDotEnv(); path != "" {
		t.Fatalf("期望没找到 .env 时返回空路径，实际 %q", path)
	}
}
