//go:build linux

// SPDX-License-Identifier: Apache-2.0
package observer

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

type executionExchangePlatform struct {
	mu          sync.Mutex
	config      ExecutionExchangeConfiguration
	location    ExecutionMountLocation
	directories []exchangeDirectory
	volumeIndex int
	request     []byte
	requestPin  exchangeFile
	closed      bool
}

func openExecutionExchange(ctx context.Context, config ExecutionExchangeConfiguration) (*executionExchangePlatform, error) {
	if ctx == nil || ctx.Err() != nil || os.Getuid() != 0 {
		return nil, ErrExecutionDeliveryIncomplete
	}
	expected, err := expectedExchangeRequest(config)
	if err != nil {
		return nil, err
	}
	location, err := config.Resolver.Resolve(ctx, config.Pod, config.KubeletRoot)
	if err != nil || !location.userKnown || location.uid != int64(config.GuardUID) || location.gid != int64(config.GuardGID) {
		return nil, ErrExecutionDeliveryIncomplete
	}
	p := &executionExchangePlatform{config: config, location: location}
	complete := false
	defer func() {
		if !complete {
			p.close()
		}
	}()
	parts := strings.Split(strings.TrimPrefix(location.hostPath, "/"), "/")
	if len(parts) > 60 || filepath.Clean(location.hostPath) != location.hostPath {
		return nil, ErrExecutionDeliveryIncomplete
	}
	p.volumeIndex = len(parts)
	parts = append(parts, config.PrivateDirectory, "attempt-"+config.Nonce)
	root, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, ErrExecutionDeliveryIncomplete
	}
	stat, mountID, err := exchangeDirectoryStat(root)
	if err != nil {
		unix.Close(root)
		return nil, ErrExecutionDeliveryIncomplete
	}
	if stat.Uid != 0 || stat.Mode&0022 != 0 {
		unix.Close(root)
		return nil, ErrExecutionDeliveryIncomplete
	}
	p.directories = append(p.directories, exchangeDirectory{fd: root, parent: -1, name: "/", stat: stat, mountID: mountID})
	for index, name := range parts {
		if ctx.Err() != nil || name == "" || name == "." || name == ".." {
			return nil, ErrExecutionDeliveryIncomplete
		}
		fd, err := unix.Openat(p.directories[index].fd, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			return nil, ErrExecutionDeliveryIncomplete
		}
		stat, mountID, err := exchangeDirectoryStat(fd)
		if err != nil {
			unix.Close(fd)
			return nil, ErrExecutionDeliveryIncomplete
		}
		if index < len(parts)-2 {
			if stat.Uid != 0 || stat.Mode&0022 != 0 {
				unix.Close(fd)
				return nil, ErrExecutionDeliveryIncomplete
			}
		} else if stat.Uid != config.GuardUID || stat.Gid != config.GuardGID || stat.Mode&07777 != 0700 {
			unix.Close(fd)
			return nil, ErrExecutionDeliveryIncomplete
		}
		p.directories = append(p.directories, exchangeDirectory{fd: fd, parent: index, name: name, stat: stat, mountID: mountID})
	}
	request, pin, err := p.readFile("request.json")
	if err != nil || !bytes.Equal(request, expected) {
		return nil, ErrExecutionDeliveryIncomplete
	}
	p.request = request
	p.requestPin = pin
	if p.check(ctx, nil) != nil {
		return nil, ErrExecutionDeliveryIncomplete
	}
	complete = true
	return p, nil
}
func (p *executionExchangePlatform) requestBytes() []byte {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil
	}
	return append([]byte(nil), p.request...)
}
func (p *executionExchangePlatform) close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil
	}
	p.closed = true
	var result error
	for i := len(p.directories) - 1; i >= 0; i-- {
		if unix.Close(p.directories[i].fd) != nil {
			result = ErrExecutionDeliveryIncomplete
		}
	}
	return result
}
func (p *executionExchangePlatform) check(ctx context.Context, authorized func(context.Context) error) error {
	if p.closed || ctx.Err() != nil {
		return ErrExecutionDeliveryIncomplete
	}
	if authorized != nil && authorized(ctx) != nil {
		return ErrExecutionDeliveryIncomplete
	}
	location, err := p.config.Resolver.Resolve(ctx, p.config.Pod, p.config.KubeletRoot)
	if err != nil || location != p.location || ctx.Err() != nil {
		return ErrExecutionDeliveryIncomplete
	}
	for _, dir := range p.directories {
		stat, mountID, err := exchangeDirectoryStat(dir.fd)
		if err != nil || !sameExchangeDirectory(stat, dir.stat) || mountID != dir.mountID {
			return ErrExecutionDeliveryIncomplete
		}
		if dir.parent >= 0 {
			current, err := unix.Openat(p.directories[dir.parent].fd, dir.name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err != nil {
				return ErrExecutionDeliveryIncomplete
			}
			named, namedMount, statErr := exchangeDirectoryStat(current)
			closeErr := unix.Close(current)
			if statErr != nil || closeErr != nil || !sameExchangeDirectory(named, dir.stat) || namedMount != dir.mountID {
				return ErrExecutionDeliveryIncomplete
			}
		}
	}
	request, pin, err := p.readFile("request.json")
	if err != nil || !sameExchangeFile(pin.stat, p.requestPin.stat) || pin.hash != p.requestPin.hash || !bytes.Equal(request, p.request) || ctx.Err() != nil {
		return ErrExecutionDeliveryIncomplete
	}
	return nil
}

func (p *executionExchangePlatform) publish(ctx context.Context, response []byte, authorized func(context.Context) error) (replayed bool, result error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if ctx == nil || authorized == nil || len(response) == 0 || len(response) > exchangeMaxBytes {
		return false, ErrExecutionDeliveryIncomplete
	}
	ctx, cancel := context.WithTimeout(ctx, p.config.Resolver.Timeout)
	defer cancel()
	response = append([]byte(nil), response...)
	if p.check(ctx, authorized) != nil {
		return false, ErrExecutionDeliveryIncomplete
	}
	if existing, pin, err := p.readFile("permit.json"); err == nil {
		if !bytes.Equal(existing, response) || p.check(ctx, authorized) != nil {
			return false, ErrExecutionDeliveryIncomplete
		}
		if err := p.syncExistingPermit(pin); err != nil {
			return false, err
		}
		if p.check(ctx, nil) != nil {
			return false, ErrExecutionDeliveryIncomplete
		}
		after, afterPin, err := p.readFile("permit.json")
		if err != nil || !sameExchangeFile(pin.stat, afterPin.stat) || pin.hash != afterPin.hash || !bytes.Equal(after, response) {
			return false, ErrExecutionDeliveryIncomplete
		}
		if authorized(ctx) != nil || ctx.Err() != nil {
			return false, ErrExecutionDeliveryIncomplete
		}
		return true, nil
	} else if !errors.Is(err, unix.ENOENT) {
		return false, ErrExecutionDeliveryIncomplete
	}
	// A root-owned staging directory outside guard-owned IPC prevents early
	// disclosure and source-name replacement before the final authority check.
	var random [24]byte
	if _, err := rand.Read(random[:]); err != nil {
		return false, ErrExecutionDeliveryIncomplete
	}
	stageName := ".pgcf-delivery-" + hex.EncodeToString(random[:])
	volume := p.directories[p.volumeIndex].fd
	if unix.Mkdirat(volume, stageName, 0700) != nil {
		return false, ErrExecutionDeliveryIncomplete
	}
	stage, err := unix.Openat(volume, stageName, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return false, ErrExecutionDeliveryIncomplete
	}
	visible := false
	defer func() {
		if unix.Close(stage) != nil && result == nil {
			if visible {
				result = ErrExecutionPublicationUncertain
			} else {
				result = ErrExecutionDeliveryIncomplete
			}
		}
	}()
	stageStat, stageMount, err := exchangeDirectoryStat(stage)
	if err != nil || stageStat.Uid != 0 || stageStat.Mode&07777 != 0700 || unix.Fsync(volume) != nil {
		return false, ErrExecutionDeliveryIncomplete
	}
	fd, err := unix.Openat(stage, "permit", unix.O_RDWR|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0600)
	if err != nil {
		return false, ErrExecutionDeliveryIncomplete
	}
	defer func() {
		if unix.Close(fd) != nil && result == nil {
			if visible {
				result = ErrExecutionPublicationUncertain
			} else {
				result = ErrExecutionDeliveryIncomplete
			}
		}
	}()
	for offset := 0; offset < len(response); {
		if ctx.Err() != nil {
			return false, ErrExecutionDeliveryIncomplete
		}
		n, err := unix.Write(fd, response[offset:])
		if err != nil || n <= 0 {
			return false, ErrExecutionDeliveryIncomplete
		}
		offset += n
	}
	if unix.Fchmod(fd, 0600) != nil || unix.Fchown(fd, int(p.config.GuardUID), int(p.config.GuardGID)) != nil || unix.Fsync(fd) != nil || unix.Fsync(stage) != nil {
		return false, ErrExecutionDeliveryIncomplete
	}
	var prepared, named unix.Stat_t
	actual := make([]byte, len(response))
	n, err := unix.Pread(fd, actual, 0)
	if err != nil || n != len(actual) || !bytes.Equal(actual, response) || unix.Fstat(fd, &prepared) != nil ||
		prepared.Mode&unix.S_IFMT != unix.S_IFREG || prepared.Mode&07777 != 0600 || prepared.Nlink != 1 || prepared.Size != int64(len(response)) ||
		prepared.Uid != p.config.GuardUID || prepared.Gid != p.config.GuardGID ||
		unix.Fstatat(stage, "permit", &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !sameExchangeFile(prepared, named) || p.check(ctx, authorized) != nil {
		return false, ErrExecutionDeliveryIncomplete
	}
	currentStage, err := unix.Openat(volume, stageName, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return false, ErrExecutionDeliveryIncomplete
	}
	afterStage, afterMount, statErr := exchangeDirectoryStat(currentStage)
	closeErr := unix.Close(currentStage)
	if statErr != nil || closeErr != nil || !sameExchangeDirectory(stageStat, afterStage) || stageMount != afterMount || ctx.Err() != nil {
		return false, ErrExecutionDeliveryIncomplete
	}
	// Authorization follows the asynchronous runtime/filesystem work, not only
	// its entry. Check cancellation again before making the response visible.
	if authorized(ctx) != nil || ctx.Err() != nil {
		return false, ErrExecutionDeliveryIncomplete
	}
	// The guard may consume immediately. Errors after visibility are uncertain.
	if unix.Renameat2(stage, "permit", p.directories[len(p.directories)-1].fd, "permit.json", unix.RENAME_NOREPLACE) != nil {
		return false, ErrExecutionDeliveryIncomplete
	}
	visible = true
	if unix.Fsync(stage) != nil || unix.Fsync(p.directories[len(p.directories)-1].fd) != nil || p.check(ctx, authorized) != nil {
		return false, ErrExecutionPublicationUncertain
	}
	committed, committedPin, err := p.readFile("permit.json")
	if err != nil || !bytes.Equal(committed, response) || !sameExchangeDirectory(prepared, committedPin.stat) || prepared.Size != committedPin.stat.Size ||
		committedPin.stat.Nlink != 1 || committedPin.stat.Mtim != prepared.Mtim || ctx.Err() != nil {
		return false, ErrExecutionPublicationUncertain
	}
	// No guard-owned unlink. Failed preparation artifacts remain private.
	if unix.Unlinkat(volume, stageName, unix.AT_REMOVEDIR) != nil || unix.Fsync(volume) != nil {
		return false, ErrExecutionPublicationUncertain
	}
	return false, nil
}
