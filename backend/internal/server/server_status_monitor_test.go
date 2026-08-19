package server

import (
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestServerStatusMonitorReadsHostMetrics(t *testing.T) {
	procPath := t.TempDir()
	writeHostMetricFixture(t, procPath, "stat", `cpu  100 0 100 700 100 0 0 0 0 0
cpu0 50 0 50 350 50 0 0 0 0 0
cpu1 50 0 50 350 50 0 0 0 0 0
`)
	writeHostMetricFixture(t, procPath, "meminfo", `MemTotal:       1048576 kB
MemAvailable:    409600 kB
SwapTotal:       262144 kB
SwapFree:        196608 kB
`)
	writeHostMetricFixture(t, procPath, "uptime", "3600.75 1000.00\n")
	writeHostMetricFixture(t, procPath, "loadavg", "0.25 0.50 0.75 1/100 123\n")
	writeHostMetricFixture(t, procPath, "filesystem-probe", "host filesystem probe\n")
	writeHostMetricFixture(t, procPath, "net/dev", `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 999999 0 0 0 0 0 0 0 999999 0 0 0 0 0 0 0
  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0
docker0: 9999999 0 0 0 0 0 0 0 9999999 0 0 0 0 0 0 0
`)

	monitor := newServerStatusMonitor(procPath, filepath.Join(procPath, "filesystem-probe"))
	monitor.previousSampleAt = time.Now().Add(-minimumServerSnapshotInterval)
	monitor.previousCPU = hostCPUCounters{Total: 1000, Idle: 800, LogicalCPUs: 2}
	monitor.previousNetwork = hostNetworkCounters{
		InterfaceName: "eth0", ReceiveBytes: 1000, TransmitBytes: 2000, Available: true,
	}
	writeHostMetricFixture(t, procPath, "stat", `cpu  150 0 150 750 150 0 0 0 0 0
cpu0 75 0 75 375 75 0 0 0 0 0
cpu1 75 0 75 375 75 0 0 0 0 0
`)
	writeHostMetricFixture(t, procPath, "net/dev", `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  eth0: 3000 0 0 0 0 0 0 0 5000 0 0 0 0 0 0 0
`)

	status := monitor.snapshot()
	if !status.Available || status.UptimeSeconds != 3600 {
		t.Fatalf("服务器指标不可用: %+v", status)
	}
	if status.CPU.UsagePercent == nil || math.Abs(*status.CPU.UsagePercent-50) > 0.01 || status.CPU.LogicalCPUs != 2 {
		t.Fatalf("CPU 指标不符: %+v", status.CPU)
	}
	if status.CPU.Load1 != 0.25 || status.CPU.Load5 != 0.5 || status.CPU.Load15 != 0.75 {
		t.Fatalf("负载指标不符: %+v", status.CPU)
	}
	if status.Memory.TotalBytes != 1024*1024*1024 || status.Memory.UsedBytes != 624*1024*1024 {
		t.Fatalf("内存指标不符: %+v", status.Memory)
	}
	if !status.Disk.Available || status.Disk.TotalBytes == 0 {
		t.Fatalf("磁盘指标不可用: %+v", status.Disk)
	}
	if !status.Network.Available || status.Network.InterfaceName != "eth0" ||
		status.Network.ReceiveBytesPerSecond == nil || status.Network.TransmitBytesPerSecond == nil {
		t.Fatalf("网络指标不符: %+v", status.Network)
	}
}

func TestServerStatusMonitorReportsUnavailableWithoutProcFiles(t *testing.T) {
	monitor := newServerStatusMonitor(t.TempDir(), t.TempDir())
	status := monitor.snapshot()
	if status.Available || status.GeneratedAt.IsZero() {
		t.Fatalf("缺少宿主机指标时应明确降级: %+v", status)
	}
}

func TestServerStatusMonitorKeepsBaselineForRapidRefreshes(t *testing.T) {
	procPath := t.TempDir()
	writeHostMetricFixture(t, procPath, "stat", `cpu  102 0 102 715 101 0 0 0
cpu0 51 0 51 357 51 0 0 0
cpu1 51 0 51 358 50 0 0 0
`)
	writeHostMetricFixture(t, procPath, "meminfo", "MemTotal: 1000 kB\nMemAvailable: 500 kB\n")
	writeHostMetricFixture(t, procPath, "uptime", "10 5\n")
	writeHostMetricFixture(t, procPath, "loadavg", "0.1 0.2 0.3 1/1 1\n")
	baseline := time.Now()
	monitor := &serverStatusMonitor{
		procPath:         procPath,
		filesystemPath:   procPath,
		previousSampleAt: baseline,
		previousCPU:      hostCPUCounters{Total: 1000, Idle: 800},
	}
	monitor.lastCPUPercent = floatMetric(25)

	status := monitor.snapshot()
	if status.CPU.UsagePercent == nil || *status.CPU.UsagePercent != 25 {
		t.Fatalf("过密采样应复用上次 CPU 结果: %+v", status.CPU)
	}
	if !monitor.previousSampleAt.Equal(baseline) {
		t.Fatal("过密采样不应推进采样基线")
	}
}

func TestServerStatusMonitorCachesRapidSnapshots(t *testing.T) {
	procPath := t.TempDir()
	writeHostMetricFixture(t, procPath, "stat", "cpu  100 0 100 700 100 0 0 0\ncpu0 100 0 100 700 100 0 0 0\n")
	writeHostMetricFixture(t, procPath, "meminfo", "MemTotal: 1000 kB\nMemAvailable: 500 kB\n")
	writeHostMetricFixture(t, procPath, "uptime", "10 5\n")
	writeHostMetricFixture(t, procPath, "loadavg", "0.1 0.2 0.3 1/1 1\n")

	monitor := newServerStatusMonitor(procPath, procPath)
	first := monitor.snapshot()
	if first.CPU.UsagePercent != nil || monitor.previousSampleAt.IsZero() {
		t.Fatalf("首次快照应建立速率基线而不是伪造瞬时 CPU: %+v", first.CPU)
	}
	if err := os.Remove(filepath.Join(procPath, "stat")); err != nil {
		t.Fatal(err)
	}
	second := monitor.snapshot()
	if !second.Available || !second.GeneratedAt.Equal(first.GeneratedAt) {
		t.Fatalf("高频请求应复用同一份服务器快照: first=%+v second=%+v", first, second)
	}

	monitor.lastSnapshotAt = time.Now().Add(-minimumServerSnapshotInterval)
	third := monitor.snapshot()
	if third.Available {
		t.Fatalf("缓存过期后必须重新读取指标: %+v", third)
	}
}

func TestServerStatusMonitorDefendsNetworkChanges(t *testing.T) {
	monitor := &serverStatusMonitor{
		previousSampleAt: time.Now().Add(-minimumServerSnapshotInterval),
		previousNetwork: hostNetworkCounters{
			InterfaceName: "eth0", ReceiveBytes: 1000, TransmitBytes: 2000, Available: true,
		},
	}
	for name, current := range map[string]hostNetworkCounters{
		"interface switch": {InterfaceName: "eth1", ReceiveBytes: 3000, TransmitBytes: 4000, Available: true},
		"counter reset":    {InterfaceName: "eth0", ReceiveBytes: 100, TransmitBytes: 200, Available: true},
	} {
		status := monitor.networkStatus(time.Now(), current)
		if status.ReceiveBytesPerSecond != nil || status.TransmitBytesPerSecond != nil {
			t.Fatalf("%s 不应计算错误速率: %+v", name, status)
		}
	}
}

func TestIgnoredNetworkInterfaceIncludesContainerRuntimes(t *testing.T) {
	for _, name := range []string{"docker0", "veth123", "cni-podman0", "podman1", "flannel.1", "cali123"} {
		if !ignoredNetworkInterface(name) {
			t.Fatalf("容器虚拟网卡应被忽略: %s", name)
		}
	}
	if ignoredNetworkInterface("eth0") {
		t.Fatal("物理主网卡不能被忽略")
	}
}

func TestParseHostMeminfoFallsBackWithoutMemAvailable(t *testing.T) {
	memory, err := parseHostMeminfo(`MemTotal: 1000 kB
MemFree: 100 kB
Buffers: 50 kB
Cached: 200 kB
SwapTotal: 100 kB
SwapFree: 25 kB
`)
	if err != nil {
		t.Fatal(err)
	}
	if memory.AvailableBytes != 350*1024 || memory.SwapFreeBytes != 25*1024 {
		t.Fatalf("旧版 meminfo 回退计算不符: %+v", memory)
	}
}

func writeHostMetricFixture(t *testing.T, root string, relativePath string, content string) {
	t.Helper()
	path := filepath.Join(root, relativePath)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("创建指标目录: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("写入指标文件: %v", err)
	}
}

func floatMetric(value float64) *float64 {
	return &value
}
