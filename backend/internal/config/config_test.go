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

// ---------- 图床配额 ----------

// IMAGE_QUOTA_MB 的解析。
//
// 这里的每一条坏输入都对应一种真实的手滑，而它们的后果是同一个：配额变成 0 或负数，
// 于是所有人都传不了图。所以解析失败必须回落到默认值，不能取零值。
func TestImageQuotaBytes(t *testing.T) {
	const mib int64 = 1024 * 1024
	fallback := DefaultImageQuotaMB * mib

	cases := []struct {
		name string
		set  bool
		raw  string
		want int64
	}{
		{name: "未设置时用默认", set: false, want: fallback},
		{name: "空串用默认", set: true, raw: "", want: fallback},
		{name: "只有空白用默认", set: true, raw: "   ", want: fallback},

		{name: "常规值", set: true, raw: "500", want: 500 * mib},
		{name: "较小的值", set: true, raw: "50", want: 50 * mib},
		{name: "1 MB", set: true, raw: "1", want: 1 * mib},
		{name: "两侧空白被裁掉", set: true, raw: "  250  ", want: 250 * mib},

		// 零和负数：语义上是"谁都不能传图"，几乎肯定不是本意
		{name: "0 回落", set: true, raw: "0", want: fallback},
		{name: "负数回落", set: true, raw: "-100", want: fallback},

		// 非数字
		{name: "非数字回落", set: true, raw: "五百", want: fallback},
		{name: "带单位后缀回落", set: true, raw: "500MB", want: fallback},
		{name: "小数回落", set: true, raw: "500.5", want: fallback},

		// 把字节数误填进 MB 字段。不设上界的话 parsed*mib 会溢出 int64 变成负数，
		// 而负配额同样意味着谁都传不了图 —— 这是最隐蔽的一种手滑
		{name: "疑似填了字节数，回落", set: true, raw: "524288000", want: fallback},
		{name: "int64 溢出边界，回落", set: true, raw: "9223372036854775807", want: fallback},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.set {
				t.Setenv("IMAGE_QUOTA_MB", tc.raw)
			} else {
				t.Setenv("IMAGE_QUOTA_MB", "")
				_ = os.Unsetenv("IMAGE_QUOTA_MB")
			}

			got := imageQuotaBytes()
			if got != tc.want {
				t.Fatalf("IMAGE_QUOTA_MB=%q → %d，期望 %d", tc.raw, got, tc.want)
			}
			// 无论输入多离谱，结果必须是正数
			if got <= 0 {
				t.Fatalf("IMAGE_QUOTA_MB=%q 得到非正配额 %d", tc.raw, got)
			}
		})
	}
}

// Load 要把配额填进 Config，而不是留零值。
func TestLoadPopulatesImageQuota(t *testing.T) {
	chdir(t, t.TempDir()) // 避免读到仓库里真实的 .env
	t.Setenv("IMAGE_QUOTA_MB", "128")

	cfg := Load()
	if want := int64(128 * 1024 * 1024); cfg.ImageQuotaBytes != want {
		t.Fatalf("cfg.ImageQuotaBytes = %d，期望 %d", cfg.ImageQuotaBytes, want)
	}
}

// 没配时 Load 也要给出正数，否则默认部署直接不能传图。
func TestLoadImageQuotaDefaultsWhenUnset(t *testing.T) {
	chdir(t, t.TempDir())
	t.Setenv("IMAGE_QUOTA_MB", "")
	_ = os.Unsetenv("IMAGE_QUOTA_MB")

	cfg := Load()
	if cfg.ImageQuotaBytes != DefaultImageQuotaMB*1024*1024 {
		t.Fatalf("未配置时 cfg.ImageQuotaBytes = %d，期望默认 %d MB 对应的字节数",
			cfg.ImageQuotaBytes, DefaultImageQuotaMB)
	}
}
