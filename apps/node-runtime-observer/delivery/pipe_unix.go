//go:build linux || darwin

// SPDX-License-Identifier: Apache-2.0
package delivery

import (
	"golang.org/x/sys/unix"
	"os"
)

// Convert inherited blocking pipe/socket descriptors into owned pollable files
// before applying deadlines. Non-TTY Exec cannot substitute ordinary files.
func OwnedPipe(original *os.File) (*os.File, error) {
	if original == nil {
		return nil, Incomplete
	}
	fd, err := unix.FcntlInt(original.Fd(), unix.F_DUPFD_CLOEXEC, 3)
	if err != nil {
		return nil, Incomplete
	}
	var stat unix.Stat_t
	if unix.Fstat(fd, &stat) != nil || (stat.Mode&unix.S_IFMT != unix.S_IFIFO && stat.Mode&unix.S_IFMT != unix.S_IFSOCK) || unix.SetNonblock(fd, true) != nil {
		unix.Close(fd)
		return nil, Incomplete
	}
	file := os.NewFile(uintptr(fd), "node-execution-pipe")
	if file == nil {
		unix.Close(fd)
		return nil, Incomplete
	}
	return file, nil
}
