//go:build linux

// SPDX-License-Identifier: Apache-2.0
package observer

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"

	guard "github.com/amerged-org/cloudflare-postgres/apps/execution-guard"
	"golang.org/x/sys/unix"
)

const exchangeMaxBytes = 16 * 1024

type exchangeDirectory struct {
	fd, parent int
	name       string
	stat       unix.Stat_t
	mountID    uint64
}
type exchangeFile struct {
	stat unix.Stat_t
	hash [32]byte
}

func expectedExchangeRequest(config ExecutionExchangeConfiguration) ([]byte, error) {
	p := config.Challenge
	nonce, err := base64.RawURLEncoding.DecodeString(config.Nonce)
	if err != nil || len(nonce) != 32 || base64.RawURLEncoding.EncodeToString(nonce) != config.Nonce ||
		!scopeID.MatchString(p.InstallationID) || !uuid.MatchString(p.NamespaceUID) || p.PodUID != config.Pod.PodUID ||
		p.ContainerName != config.Pod.ContainerName || len(p.NodeName) > 253 || !dnsName.MatchString(p.NodeName) ||
		!uuid.MatchString(p.NodeUID) || p.BootID != config.Resolver.ExpectedBootID ||
		len(config.PrivateDirectory) > 63 || !dnsLabel.MatchString(config.PrivateDirectory) || config.GuardUID == 0 || config.GuardUID == ^uint32(0) || config.GuardGID == ^uint32(0) {
		return nil, ErrExecutionDeliveryIncomplete
	}
	for _, value := range []string{p.ImageHash, p.CommandHash} {
		decoded, err := hex.DecodeString(value)
		if err != nil || len(decoded) != 32 || hex.EncodeToString(decoded) != value {
			return nil, ErrExecutionDeliveryIncomplete
		}
	}
	// Exact canonical bytes reject duplicate/unknown fields and untrusted binding
	// changes without introducing another permissive JSON parser.
	return guard.ProtocolJSON(guard.SignedChallenge{Version: 2, Nonce: config.Nonce, Binding: guard.ChallengeBinding{
		InstallationID: p.InstallationID, NamespaceUID: p.NamespaceUID, PodUID: p.PodUID, ContainerName: p.ContainerName,
		NodeName: p.NodeName, NodeUID: p.NodeUID, BootID: p.BootID, ImageHash: p.ImageHash, CommandHash: p.CommandHash}})
}
func exchangeDirectoryStat(fd int) (unix.Stat_t, uint64, error) {
	var stat unix.Stat_t
	var extended unix.Statx_t
	if unix.Fstat(fd, &stat) != nil || stat.Mode&unix.S_IFMT != unix.S_IFDIR ||
		unix.Statx(fd, "", unix.AT_EMPTY_PATH|unix.AT_SYMLINK_NOFOLLOW, unix.STATX_MNT_ID, &extended) != nil ||
		extended.Mask&unix.STATX_MNT_ID == 0 || extended.Mnt_id == 0 {
		return stat, 0, ErrExecutionDeliveryIncomplete
	}
	return stat, extended.Mnt_id, nil
}
func sameExchangeDirectory(a, b unix.Stat_t) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Mode == b.Mode && a.Uid == b.Uid && a.Gid == b.Gid
}
func sameExchangeFile(a, b unix.Stat_t) bool {
	return sameExchangeDirectory(a, b) && a.Nlink == b.Nlink && a.Size == b.Size && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}
func (p *executionExchangePlatform) readFile(name string) ([]byte, exchangeFile, error) {
	var pin exchangeFile
	parent := p.directories[len(p.directories)-1].fd
	fd, err := unix.Openat(parent, name, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, pin, err
	}
	file := os.NewFile(uintptr(fd), "execution-exchange")
	defer file.Close()
	var before, after, named unix.Stat_t
	if unix.Fstat(fd, &before) != nil || before.Mode&unix.S_IFMT != unix.S_IFREG || before.Nlink != 1 ||
		before.Uid != p.config.GuardUID || before.Gid != p.config.GuardGID ||
		(before.Mode&07777 != 0400 && before.Mode&07777 != 0600) || before.Size <= 0 || before.Size > exchangeMaxBytes {
		return nil, pin, ErrExecutionDeliveryIncomplete
	}
	data := make([]byte, int(before.Size))
	count, err := file.ReadAt(data, 0)
	if err != nil || count != len(data) || unix.Fstat(fd, &after) != nil || !sameExchangeFile(before, after) ||
		unix.Fstatat(parent, name, &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !sameExchangeFile(before, named) || file.Close() != nil {
		return nil, pin, ErrExecutionDeliveryIncomplete
	}
	return data, exchangeFile{stat: before, hash: sha256.Sum256(data)}, nil
}

func (p *executionExchangePlatform) syncExistingPermit(pin exchangeFile) error {
	parent := p.directories[len(p.directories)-1].fd
	fd, err := unix.Openat(parent, "permit.json", unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return ErrExecutionPublicationUncertain
	}
	file := os.NewFile(uintptr(fd), "execution-permit-sync")
	defer file.Close()
	var actual, named unix.Stat_t
	if unix.Fstat(fd, &actual) != nil || !sameExchangeFile(actual, pin.stat) || unix.Fsync(fd) != nil ||
		unix.Fstatat(parent, "permit.json", &named, unix.AT_SYMLINK_NOFOLLOW) != nil || !sameExchangeFile(named, pin.stat) ||
		file.Close() != nil || unix.Fsync(parent) != nil {
		return ErrExecutionPublicationUncertain
	}
	return nil
}
