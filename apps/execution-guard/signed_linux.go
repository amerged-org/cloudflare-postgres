//go:build linux

// SPDX-License-Identifier: Apache-2.0
package executionguard

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

type directoryPin struct {
	path           string
	device, inode  uint64
	uid, gid, mode uint32
}
type filePin struct {
	path string
	stat unix.Stat_t
	hash [32]byte
}
type signedCustody struct {
	directories     []directoryPin
	files           []filePin
	additionalCheck func() error
}
type signedProcesses struct {
	linuxProcesses
	custody *signedCustody
	permit  Permit
	grace   time.Duration
}

func (system signedProcesses) start(command []string) (int, error) {
	if system.custody.check() != nil {
		return 0, failed
	}
	boot, now, err := ReadBootClock()
	if err != nil || system.permit.Validate(boot, system.permit.RunEpoch, now) != nil || system.permit.ExpiresAtBootNs-now <= int64(system.grace) {
		return 0, failed
	}
	return system.linuxProcesses.start(command)
}
func realParents(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return failed
	}
	current := string(filepath.Separator)
	for _, part := range strings.Split(strings.TrimPrefix(path, string(filepath.Separator)), string(filepath.Separator)) {
		if part == "" {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return failed
		}
	}
	return nil
}
func pinDirectory(path string) (directoryPin, error) {
	if realParents(path) != nil {
		return directoryPin{}, failed
	}
	var stat unix.Stat_t
	if unix.Lstat(path, &stat) != nil || stat.Mode&unix.S_IFMT != unix.S_IFDIR || stat.Mode&07777 != 0700 || stat.Uid != uint32(os.Getuid()) {
		return directoryPin{}, failed
	}
	return directoryPin{path: path, device: uint64(stat.Dev), inode: stat.Ino, uid: stat.Uid, gid: stat.Gid, mode: stat.Mode}, nil
}
func (pin directoryPin) check() error {
	current, err := pinDirectory(pin.path)
	if err != nil || current != pin {
		return failed
	}
	return nil
}
func privateFile(path string) ([]byte, filePin, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || realParents(filepath.Dir(path)) != nil {
		return nil, filePin{}, failed
	}
	descriptor, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, filePin{}, err
	}
	file := os.NewFile(uintptr(descriptor), path)
	defer file.Close()
	var before unix.Stat_t
	if unix.Fstat(descriptor, &before) != nil || before.Mode&unix.S_IFMT != unix.S_IFREG || before.Uid != uint32(os.Getuid()) || before.Nlink != 1 ||
		(before.Mode&07777 != 0400 && before.Mode&07777 != 0600) || before.Size <= 0 || before.Size > maxSignedBytes {
		return nil, filePin{}, failed
	}
	data, err := io.ReadAll(io.LimitReader(file, maxSignedBytes+1))
	if err != nil || len(data) != int(before.Size) {
		return nil, filePin{}, failed
	}
	var after unix.Stat_t
	if unix.Fstat(descriptor, &after) != nil || !sameFile(before, after) {
		return nil, filePin{}, failed
	}
	var named unix.Stat_t
	if unix.Lstat(path, &named) != nil || !sameFile(before, named) {
		return nil, filePin{}, failed
	}
	return data, filePin{path: path, stat: before, hash: sha256.Sum256(data)}, nil
}
func sameFile(left, right unix.Stat_t) bool {
	return left.Dev == right.Dev && left.Ino == right.Ino && left.Mode == right.Mode && left.Uid == right.Uid && left.Gid == right.Gid &&
		left.Nlink == right.Nlink && left.Size == right.Size && left.Mtim == right.Mtim && left.Ctim == right.Ctim
}
func (pin filePin) check() error {
	_, current, err := privateFile(pin.path)
	if err != nil || !sameFile(pin.stat, current.stat) || pin.hash != current.hash {
		return failed
	}
	return nil
}
func (custody *signedCustody) check() error {
	if custody.additionalCheck != nil && custody.additionalCheck() != nil {
		return failed
	}
	for _, pin := range custody.directories {
		if pin.check() != nil {
			return failed
		}
	}
	for _, pin := range custody.files {
		if pin.check() != nil {
			return failed
		}
	}
	return nil
}
func syncDirectory(path string) error {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return failed
	}
	defer unix.Close(fd)
	if unix.Fsync(fd) != nil {
		return failed
	}
	return nil
}
func writeChallenge(path string, data []byte) error {
	fd, err := unix.Open(path, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return failed
	}
	file := os.NewFile(uintptr(fd), path)
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		return failed
	}
	return syncDirectory(filepath.Dir(path))
}

// RunSigned starts only from a fresh local handshake. Protected identity files
// are snapshots, not fresh machine attestations; no bearer credentials enter it.
func RunSigned(ctx context.Context, config SignedRunConfiguration) (Result, error) {
	if os.Getpid() != 1 || ctx == nil || ctx.Err() != nil || config.ReadyWriter == nil {
		return Result{}, failed
	}
	var original *signedStartupAnchor
	if config.InputWait != 0 {
		var err error
		original, err = waitSignedInputs(ctx, config)
		if err != nil {
			return Result{}, err
		}
		defer original.close()
	}
	custody := &signedCustody{}
	if original != nil {
		custody.additionalCheck = original.check
	}
	for _, directory := range []string{filepath.Dir(config.ExpectedFile), filepath.Dir(config.PublicKeyFile), config.IPCDirectory} {
		pin, err := pinDirectory(directory)
		if err != nil {
			return Result{}, failed
		}
		custody.directories = append(custody.directories, pin)
	}
	expectedBytes, expectedPin, err := privateFile(config.ExpectedFile)
	if err != nil {
		return Result{}, failed
	}
	expected, err := ParseSignedExpected(expectedBytes)
	if err != nil {
		return Result{}, failed
	}
	keyBytes, keyPin, err := privateFile(config.PublicKeyFile)
	if err != nil {
		return Result{}, failed
	}
	pin, key, err := ParseSignedKeyPin(keyBytes)
	if err != nil {
		return Result{}, failed
	}
	if os.Getenv("PGCF_EXECUTION_POD_UID") != expected.Binding.PodUID || os.Getenv("PGCF_EXECUTION_NAMESPACE") != expected.Binding.Namespace ||
		os.Getenv("PGCF_EXECUTION_NODE_NAME") != expected.Binding.NodeName {
		return Result{}, failed
	}
	custody.files = append(custody.files, expectedPin, keyPin)
	exchange := func(ctx context.Context, challenge SignedChallenge, boot string, deadline int64) ([]byte, error) {
		if custody.check() != nil {
			return nil, failed
		}
		attempt := "attempt-" + challenge.Nonce
		directory := filepath.Join(config.IPCDirectory, attempt)
		// Fresh random namespace: an existing directory or response is never adopted.
		if os.Mkdir(directory, 0700) != nil {
			return nil, failed
		}
		attemptPin, err := pinDirectory(directory)
		if err != nil {
			return nil, failed
		}
		custody.directories = append(custody.directories, attemptPin)
		requestBytes, err := canonicalJSON(challenge)
		if err != nil {
			return nil, failed
		}
		requestPath := filepath.Join(directory, "request.json")
		if custody.check() != nil || writeChallenge(requestPath, requestBytes) != nil {
			return nil, failed
		}
		_, requestPin, err := privateFile(requestPath)
		if err != nil {
			return nil, failed
		}
		custody.files = append(custody.files, requestPin)
		if custody.check() != nil || syncDirectory(config.IPCDirectory) != nil {
			return nil, failed
		}
		if json.NewEncoder(config.ReadyWriter).Encode(map[string]string{"mode": "signed-window", "status": "challenge", "attempt": attempt}) != nil {
			return nil, failed
		}
		responsePath := filepath.Join(directory, "permit.json")
		for {
			currentBoot, now, err := ReadBootClock()
			if err != nil || currentBoot != boot || now >= deadline || ctx.Err() != nil || custody.check() != nil {
				return nil, failed
			}
			response, responsePin, err := privateFile(responsePath)
			if err == nil {
				custody.files = append(custody.files, responsePin)
				if custody.check() != nil {
					return nil, failed
				}
				return response, nil
			}
			if !errors.Is(err, unix.ENOENT) {
				return nil, failed
			}
			select {
			case <-ctx.Done():
				return nil, failed
			case <-time.After(20 * time.Millisecond):
			}
		}
	}
	permit, err := prepareSignedWindowAt(ctx, expected, pin.KeyID, key, config.Command, config.Grace, config.StartupTimeout, exchange, linuxProcesses{}, original)
	if err != nil {
		return Result{}, err
	}
	return supervise(ctx, permit, expected.Binding.RunEpoch, config.Command, config.Grace, signedProcesses{custody: custody, permit: permit, grace: config.Grace})
}
