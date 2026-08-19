//go:build !linux && !darwin

package server

import "errors"

func readFilesystemUsage(string) (serverDiskStatus, error) {
	return serverDiskStatus{}, errors.New("filesystem metrics unsupported")
}
