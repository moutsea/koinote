//go:build linux || darwin

package server

import "syscall"

func readFilesystemUsage(path string) (serverDiskStatus, error) {
	var stats syscall.Statfs_t
	if err := syscall.Statfs(path, &stats); err != nil {
		return serverDiskStatus{}, err
	}
	blockSize := uint64(stats.Bsize)
	total := stats.Blocks * blockSize
	free := stats.Bfree * blockSize
	available := stats.Bavail * blockSize
	if free > total {
		free = total
	}
	if available > total {
		available = total
	}
	return serverDiskStatus{
		Available:      total > 0,
		TotalBytes:     total,
		UsedBytes:      total - free,
		AvailableBytes: available,
	}, nil
}
