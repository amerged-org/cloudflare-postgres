//go:build linux

// SPDX-License-Identifier: Apache-2.0
package executionguard

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

type pendingVolumePin struct {
	path     string
	fd       int
	stat     unix.Stat_t
	mountID  uint64
	readOnly bool
}

func pendingVolume(path string, readonly bool) (pendingVolumePin, error) {
	var result pendingVolumePin
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" || realParents(path) != nil {
		return result, failed
	}
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return result, failed
	}
	result = pendingVolumePin{path: path, fd: fd, readOnly: readonly}
	if unix.Fstat(fd, &result.stat) != nil || result.stat.Mode&unix.S_IFMT != unix.S_IFDIR || (result.stat.Uid != 0 && result.stat.Uid != uint32(os.Getuid())) {
		unix.Close(fd)
		return pendingVolumePin{}, failed
	}
	var extended unix.Statx_t
	if unix.Statx(fd, "", unix.AT_EMPTY_PATH|unix.AT_SYMLINK_NOFOLLOW, unix.STATX_MNT_ID, &extended) != nil || extended.Mask&unix.STATX_MNT_ID == 0 || extended.Mnt_id == 0 {
		unix.Close(fd)
		return pendingVolumePin{}, failed
	}
	result.mountID = extended.Mnt_id
	if result.check() != nil {
		unix.Close(fd)
		return pendingVolumePin{}, failed
	}
	return result, nil
}
func (p pendingVolumePin) check() error {
	if realParents(p.path) != nil {
		return failed
	}
	fd, err := unix.Open(p.path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return failed
	}
	defer unix.Close(fd)
	var current unix.Stat_t
	var fs unix.Statfs_t
	var extended unix.Statx_t
	if unix.Fstat(fd, &current) != nil || current.Dev != p.stat.Dev || current.Ino != p.stat.Ino || current.Mode != p.stat.Mode || current.Uid != p.stat.Uid || current.Gid != p.stat.Gid || unix.Fstatfs(fd, &fs) != nil || ((fs.Flags&unix.ST_RDONLY) != 0) != p.readOnly || unix.Statx(fd, "", unix.AT_EMPTY_PATH|unix.AT_SYMLINK_NOFOLLOW, unix.STATX_MNT_ID, &extended) != nil || extended.Mnt_id != p.mountID {
		return failed
	}
	return nil
}

func waitSignedInputs(ctx context.Context, config SignedRunConfiguration) (*signedStartupAnchor, error) {
	if ctx == nil || ctx.Err() != nil || config.InputWait <= 0 || config.InputWait > 15*time.Second || config.StartupTimeout <= 0 || config.StartupTimeout > 15*time.Second || config.ReadyWriter == nil || os.Getpid() != 1 || filepath.Dir(config.ExpectedFile) != filepath.Dir(config.PublicKeyFile) || os.Getenv("PGCF_EXECUTION_POD_UID") == "" || os.Getenv("PGCF_EXECUTION_NAMESPACE") == "" || os.Getenv("PGCF_EXECUTION_NODE_NAME") == "" {
		return nil, failed
	}
	inputRootPath := filepath.Dir(filepath.Dir(config.ExpectedFile))
	ipcRootPath := filepath.Dir(config.IPCDirectory)
	for _, path := range []string{config.ExpectedFile, config.PublicKeyFile, config.IPCDirectory} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return nil, failed
		}
	}
	if inputRootPath == ipcRootPath || strings.HasPrefix(inputRootPath, ipcRootPath+"/") || strings.HasPrefix(ipcRootPath, inputRootPath+"/") {
		return nil, failed
	}
	boot, start, err := ReadBootClock()
	if err != nil || start > math.MaxInt64-int64(15*time.Second) {
		return nil, failed
	}
	original := &signedStartupAnchor{boot: boot, now: start}
	wait := config.InputWait
	if config.StartupTimeout < wait {
		wait = config.StartupTimeout
	}
	deadline := start + int64(wait)
	inputRoot, err := pendingVolume(filepath.Dir(filepath.Dir(config.ExpectedFile)), true)
	if err != nil {
		return nil, failed
	}
	transferred := false
	defer func() {
		if !transferred {
			unix.Close(inputRoot.fd)
		}
	}()
	ipcRoot, err := pendingVolume(filepath.Dir(config.IPCDirectory), false)
	if err != nil {
		return nil, failed
	}
	defer func() {
		if !transferred {
			unix.Close(ipcRoot.fd)
		}
	}()
	if inputRoot.stat.Dev == ipcRoot.stat.Dev && inputRoot.stat.Ino == ipcRoot.stat.Ino {
		return nil, failed
	}
	if json.NewEncoder(config.ReadyWriter).Encode(map[string]string{"mode": "signed-window", "status": "waiting-inputs"}) != nil {
		return nil, failed
	}
	var inputsPin, ipcPin *directoryPin
	for {
		currentBoot, now, err := ReadBootClock()
		if err != nil || currentBoot != boot || now < start || now >= deadline || ctx.Err() != nil || inputRoot.check() != nil || ipcRoot.check() != nil {
			return nil, failed
		}
		ready := true
		for _, target := range []struct {
			path string
			pin  **directoryPin
		}{{filepath.Dir(config.ExpectedFile), &inputsPin}, {config.IPCDirectory, &ipcPin}} {
			if *target.pin != nil {
				if (*target.pin).check() != nil {
					return nil, failed
				}
				continue
			}
			if _, err := os.Lstat(target.path); errors.Is(err, os.ErrNotExist) {
				ready = false
				continue
			} else if err != nil {
				return nil, failed
			}
			pin, err := pinDirectory(target.path)
			if err != nil {
				return nil, failed
			}
			*target.pin = &pin
		}
		if ready {
			complete := true
			for _, path := range []string{config.ExpectedFile, config.PublicKeyFile} {
				if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
					complete = false
				} else if err != nil {
					return nil, failed
				}
			}
			if complete {
				if inputsPin.check() != nil || ipcPin.check() != nil || inputRoot.check() != nil || ipcRoot.check() != nil {
					return nil, failed
				}
				lastBoot, lastNow, err := ReadBootClock()
				if err != nil || lastBoot != boot || lastNow < now || lastNow >= deadline || ctx.Err() != nil {
					return nil, failed
				}
				original.check = func() error {
					if inputsPin.check() != nil || ipcPin.check() != nil || inputRoot.check() != nil || ipcRoot.check() != nil {
						return failed
					}
					return nil
				}
				original.close = func() { unix.Close(ipcRoot.fd); unix.Close(inputRoot.fd) }
				transferred = true
				return original, nil
			}
		}
		select {
		case <-ctx.Done():
			return nil, failed
		case <-time.After(20 * time.Millisecond):
		}
	}
}
