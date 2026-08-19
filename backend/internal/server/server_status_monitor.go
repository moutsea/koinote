package server

import (
	"bufio"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"koinote/backend/internal/httpx"
)

// 前端正常情况下每 30 秒刷新一次；这层共享缓存用于吸收多人同时打开后台、
// 连续点击刷新或脚本误轮询，避免每个 HTTP 请求都重新读取宿主机指标文件。
const minimumServerSnapshotInterval = 5 * time.Second

type serverStatusMonitor struct {
	procPath       string
	filesystemPath string

	mu                    sync.Mutex
	previousSampleAt      time.Time
	previousCPU           hostCPUCounters
	previousNetwork       hostNetworkCounters
	lastCPUPercent        *float64
	lastReceiveBytesPerS  *float64
	lastTransmitBytesPerS *float64
	lastSnapshotAt        time.Time
	lastResponse          adminServerStatusResponse
}

type hostCPUCounters struct {
	Total       uint64
	Idle        uint64
	LogicalCPUs int
}

type hostMemoryCounters struct {
	TotalBytes     uint64
	AvailableBytes uint64
	SwapTotalBytes uint64
	SwapFreeBytes  uint64
}

type hostNetworkCounters struct {
	InterfaceName string
	ReceiveBytes  uint64
	TransmitBytes uint64
	Available     bool
}

type hostProcSample struct {
	CPU           hostCPUCounters
	Memory        hostMemoryCounters
	UptimeSeconds int64
	Load1         float64
	Load5         float64
	Load15        float64
	Network       hostNetworkCounters
}

type serverCPUStatus struct {
	UsagePercent *float64 `json:"usagePercent"`
	LogicalCPUs  int      `json:"logicalCPUs"`
	Load1        float64  `json:"load1"`
	Load5        float64  `json:"load5"`
	Load15       float64  `json:"load15"`
}

type serverMemoryStatus struct {
	TotalBytes     uint64 `json:"totalBytes"`
	UsedBytes      uint64 `json:"usedBytes"`
	AvailableBytes uint64 `json:"availableBytes"`
	SwapTotalBytes uint64 `json:"swapTotalBytes"`
	SwapUsedBytes  uint64 `json:"swapUsedBytes"`
}

type serverDiskStatus struct {
	Available      bool   `json:"available"`
	TotalBytes     uint64 `json:"totalBytes"`
	UsedBytes      uint64 `json:"usedBytes"`
	AvailableBytes uint64 `json:"availableBytes"`
}

type serverNetworkStatus struct {
	Available              bool     `json:"available"`
	InterfaceName          string   `json:"interfaceName"`
	ReceiveBytes           uint64   `json:"receiveBytes"`
	TransmitBytes          uint64   `json:"transmitBytes"`
	ReceiveBytesPerSecond  *float64 `json:"receiveBytesPerSecond"`
	TransmitBytesPerSecond *float64 `json:"transmitBytesPerSecond"`
}

type adminServerStatusResponse struct {
	Available     bool                `json:"available"`
	GeneratedAt   time.Time           `json:"generatedAt"`
	UptimeSeconds int64               `json:"uptimeSeconds"`
	CPU           serverCPUStatus     `json:"cpu"`
	Memory        serverMemoryStatus  `json:"memory"`
	Disk          serverDiskStatus    `json:"disk"`
	Network       serverNetworkStatus `json:"network"`
}

func newServerStatusMonitor(procPath string, filesystemPath string) *serverStatusMonitor {
	if strings.TrimSpace(procPath) == "" {
		procPath = "/proc"
	}
	if strings.TrimSpace(filesystemPath) == "" {
		filesystemPath = "/"
	}
	monitor := &serverStatusMonitor{
		procPath:       procPath,
		filesystemPath: filesystemPath,
	}
	return monitor
}

func (monitor *serverStatusMonitor) snapshot() adminServerStatusResponse {
	monitor.mu.Lock()
	defer monitor.mu.Unlock()

	now := time.Now()
	if !monitor.lastSnapshotAt.IsZero() && now.Sub(monitor.lastSnapshotAt) < minimumServerSnapshotInterval {
		return monitor.lastResponse
	}
	response := adminServerStatusResponse{GeneratedAt: now.UTC()}
	sample, err := readHostProcSample(monitor.procPath)
	if err != nil {
		monitor.rememberSnapshot(now, response)
		return response
	}

	response.Available = true
	response.UptimeSeconds = sample.UptimeSeconds
	response.CPU = serverCPUStatus{
		UsagePercent: monitor.cpuPercent(now, sample.CPU),
		LogicalCPUs:  sample.CPU.LogicalCPUs,
		Load1:        sample.Load1,
		Load5:        sample.Load5,
		Load15:       sample.Load15,
	}
	response.Memory = serverMemoryStatus{
		TotalBytes:     sample.Memory.TotalBytes,
		UsedBytes:      sample.Memory.TotalBytes - sample.Memory.AvailableBytes,
		AvailableBytes: sample.Memory.AvailableBytes,
		SwapTotalBytes: sample.Memory.SwapTotalBytes,
		SwapUsedBytes:  sample.Memory.SwapTotalBytes - sample.Memory.SwapFreeBytes,
	}
	response.Network = monitor.networkStatus(now, sample.Network)
	if disk, diskErr := readFilesystemUsage(monitor.filesystemPath); diskErr == nil {
		response.Disk = disk
	}

	if monitor.previousSampleAt.IsZero() || now.Sub(monitor.previousSampleAt) >= minimumServerSnapshotInterval {
		monitor.previousSampleAt = now
		monitor.previousCPU = sample.CPU
		monitor.previousNetwork = sample.Network
	}
	monitor.rememberSnapshot(now, response)
	return response
}

func (monitor *serverStatusMonitor) rememberSnapshot(now time.Time, response adminServerStatusResponse) {
	monitor.lastSnapshotAt = now
	monitor.lastResponse = response
}

func (monitor *serverStatusMonitor) cpuPercent(now time.Time, current hostCPUCounters) *float64 {
	if monitor.previousSampleAt.IsZero() || current.Total < monitor.previousCPU.Total || current.Idle < monitor.previousCPU.Idle {
		return nil
	}
	if now.Sub(monitor.previousSampleAt) < minimumServerSnapshotInterval {
		return cloneMetric(monitor.lastCPUPercent)
	}
	totalDelta := current.Total - monitor.previousCPU.Total
	idleDelta := current.Idle - monitor.previousCPU.Idle
	if totalDelta == 0 || idleDelta > totalDelta {
		return nil
	}
	percent := float64(totalDelta-idleDelta) / float64(totalDelta) * 100
	if percent < 0 {
		percent = 0
	} else if percent > 100 {
		percent = 100
	}
	monitor.lastCPUPercent = &percent
	return cloneMetric(monitor.lastCPUPercent)
}

func (monitor *serverStatusMonitor) networkStatus(now time.Time, current hostNetworkCounters) serverNetworkStatus {
	status := serverNetworkStatus{
		Available:     current.Available,
		InterfaceName: current.InterfaceName,
		ReceiveBytes:  current.ReceiveBytes,
		TransmitBytes: current.TransmitBytes,
	}
	if !current.Available || monitor.previousSampleAt.IsZero() ||
		!monitor.previousNetwork.Available || current.InterfaceName != monitor.previousNetwork.InterfaceName {
		return status
	}
	elapsed := now.Sub(monitor.previousSampleAt)
	if elapsed < minimumServerSnapshotInterval {
		status.ReceiveBytesPerSecond = cloneMetric(monitor.lastReceiveBytesPerS)
		status.TransmitBytesPerSecond = cloneMetric(monitor.lastTransmitBytesPerS)
		return status
	}
	if current.ReceiveBytes < monitor.previousNetwork.ReceiveBytes ||
		current.TransmitBytes < monitor.previousNetwork.TransmitBytes {
		return status
	}
	seconds := elapsed.Seconds()
	receiveRate := float64(current.ReceiveBytes-monitor.previousNetwork.ReceiveBytes) / seconds
	transmitRate := float64(current.TransmitBytes-monitor.previousNetwork.TransmitBytes) / seconds
	monitor.lastReceiveBytesPerS = &receiveRate
	monitor.lastTransmitBytesPerS = &transmitRate
	status.ReceiveBytesPerSecond = cloneMetric(monitor.lastReceiveBytesPerS)
	status.TransmitBytesPerSecond = cloneMetric(monitor.lastTransmitBytesPerS)
	return status
}

func cloneMetric(value *float64) *float64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func readHostProcSample(procPath string) (hostProcSample, error) {
	stat, err := os.ReadFile(filepath.Join(procPath, "stat"))
	if err != nil {
		return hostProcSample{}, err
	}
	cpu, err := parseHostCPUStat(string(stat))
	if err != nil {
		return hostProcSample{}, err
	}
	meminfo, err := os.ReadFile(filepath.Join(procPath, "meminfo"))
	if err != nil {
		return hostProcSample{}, err
	}
	memory, err := parseHostMeminfo(string(meminfo))
	if err != nil {
		return hostProcSample{}, err
	}
	uptime, err := os.ReadFile(filepath.Join(procPath, "uptime"))
	if err != nil {
		return hostProcSample{}, err
	}
	uptimeSeconds, err := parseHostUptime(string(uptime))
	if err != nil {
		return hostProcSample{}, err
	}

	sample := hostProcSample{
		CPU:           cpu,
		Memory:        memory,
		UptimeSeconds: uptimeSeconds,
	}
	loadavg, err := os.ReadFile(filepath.Join(procPath, "loadavg"))
	if err != nil {
		return hostProcSample{}, err
	}
	sample.Load1, sample.Load5, sample.Load15, err = parseHostLoadAverage(string(loadavg))
	if err != nil {
		return hostProcSample{}, err
	}
	if network, networkErr := os.ReadFile(filepath.Join(procPath, "net", "dev")); networkErr == nil {
		sample.Network, _ = parseHostNetwork(string(network))
	}
	return sample, nil
}

func parseHostCPUStat(raw string) (hostCPUCounters, error) {
	var result hostCPUCounters
	scanner := bufio.NewScanner(strings.NewReader(raw))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 0 {
			continue
		}
		if fields[0] == "cpu" {
			if len(fields) < 6 {
				return hostCPUCounters{}, errors.New("invalid aggregate CPU line")
			}
			lastField := len(fields)
			// guest/guest_nice 已经包含在 user/nice 中，不能再次累加。
			if lastField > 9 {
				lastField = 9
			}
			values := make([]uint64, 0, lastField-1)
			for _, field := range fields[1:lastField] {
				value, parseErr := strconv.ParseUint(field, 10, 64)
				if parseErr != nil {
					return hostCPUCounters{}, parseErr
				}
				values = append(values, value)
				result.Total += value
			}
			result.Idle = values[3]
			if len(values) > 4 {
				result.Idle += values[4]
			}
			continue
		}
		if strings.HasPrefix(fields[0], "cpu") {
			if _, parseErr := strconv.Atoi(strings.TrimPrefix(fields[0], "cpu")); parseErr == nil {
				result.LogicalCPUs++
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return hostCPUCounters{}, err
	}
	if result.Total == 0 || result.LogicalCPUs == 0 {
		return hostCPUCounters{}, errors.New("CPU counters unavailable")
	}
	return result, nil
}

func parseHostMeminfo(raw string) (hostMemoryCounters, error) {
	values := make(map[string]uint64)
	scanner := bufio.NewScanner(strings.NewReader(raw))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		key := strings.TrimSuffix(fields[0], ":")
		value, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			return hostMemoryCounters{}, err
		}
		values[key] = value * 1024
	}
	if err := scanner.Err(); err != nil {
		return hostMemoryCounters{}, err
	}
	total := values["MemTotal"]
	available := values["MemAvailable"]
	if available == 0 {
		available = values["MemFree"] + values["Buffers"] + values["Cached"]
	}
	if total == 0 || available > total {
		return hostMemoryCounters{}, errors.New("memory counters unavailable")
	}
	swapFree := values["SwapFree"]
	if swapFree > values["SwapTotal"] {
		swapFree = values["SwapTotal"]
	}
	return hostMemoryCounters{
		TotalBytes:     total,
		AvailableBytes: available,
		SwapTotalBytes: values["SwapTotal"],
		SwapFreeBytes:  swapFree,
	}, nil
}

func parseHostUptime(raw string) (int64, error) {
	fields := strings.Fields(raw)
	if len(fields) == 0 {
		return 0, errors.New("uptime unavailable")
	}
	seconds, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || seconds < 0 {
		return 0, errors.New("invalid uptime")
	}
	return int64(seconds), nil
}

func parseHostLoadAverage(raw string) (float64, float64, float64, error) {
	fields := strings.Fields(raw)
	if len(fields) < 3 {
		return 0, 0, 0, errors.New("load average unavailable")
	}
	values := make([]float64, 3)
	for index := range values {
		value, err := strconv.ParseFloat(fields[index], 64)
		if err != nil {
			return 0, 0, 0, err
		}
		values[index] = value
	}
	return values[0], values[1], values[2], nil
}

func parseHostNetwork(raw string) (hostNetworkCounters, error) {
	var selected hostNetworkCounters
	scanner := bufio.NewScanner(strings.NewReader(raw))
	for scanner.Scan() {
		line := scanner.Text()
		separator := strings.IndexByte(line, ':')
		if separator < 0 {
			continue
		}
		interfaceName := strings.TrimSpace(line[:separator])
		if ignoredNetworkInterface(interfaceName) {
			continue
		}
		fields := strings.Fields(line[separator+1:])
		if len(fields) < 9 {
			continue
		}
		receiveBytes, receiveErr := strconv.ParseUint(fields[0], 10, 64)
		transmitBytes, transmitErr := strconv.ParseUint(fields[8], 10, 64)
		if receiveErr != nil || transmitErr != nil {
			continue
		}
		if !selected.Available || receiveBytes+transmitBytes > selected.ReceiveBytes+selected.TransmitBytes {
			selected = hostNetworkCounters{
				InterfaceName: interfaceName,
				ReceiveBytes:  receiveBytes,
				TransmitBytes: transmitBytes,
				Available:     true,
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return hostNetworkCounters{}, err
	}
	if !selected.Available {
		return hostNetworkCounters{}, errors.New("network counters unavailable")
	}
	return selected, nil
}

func ignoredNetworkInterface(name string) bool {
	if name == "lo" {
		return true
	}
	for _, prefix := range []string{
		"docker", "veth", "br-", "virbr", "cni", "podman", "flannel", "cali", "tun", "tap",
	} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}

func (app *App) adminServerStatus(w http.ResponseWriter, request *http.Request) {
	if _, ok := app.requireAdmin(w, request); !ok {
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpx.JSON(w, http.StatusOK, app.serverStatusMonitor().snapshot())
}
