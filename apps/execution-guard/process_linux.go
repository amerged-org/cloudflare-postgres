//go:build linux

// SPDX-License-Identifier: Apache-2.0
package executionguard

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

type linuxProcesses struct{}

func (linuxProcesses) pid() int                      { return os.Getpid() }
func (linuxProcesses) clock() (string, int64, error) { return ReadBootClock() }
func (linuxProcesses) start(arguments []string) (int, error) {
	command := exec.Command(arguments[0], arguments[1:]...)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		return 0, failed
	}
	pid := command.Process.Pid
	// The PID1 reaper owns wait4 for every adopted group, not Cmd.Wait.
	if err := command.Process.Release(); err != nil {
		return pid, failed
	}
	return pid, nil
}
func (linuxProcesses) reap(manager int) (bool, error) {
	exited := false
	for {
		var status unix.WaitStatus
		pid, err := unix.Wait4(-1, &status, unix.WNOHANG, nil)
		if err == unix.ECHILD {
			return exited, nil
		}
		if err == unix.EINTR {
			continue
		}
		if err != nil {
			return false, failed
		}
		if pid == 0 {
			return exited, nil
		}
		if pid == manager {
			exited = true
		}
	}
}
func (linuxProcesses) empty() (bool, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return false, failed
	}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err == nil && pid > 1 {
			return false, nil
		}
	}
	return true, nil
}
func (linuxProcesses) signal(pid, sig int) error {
	if os.Getpid() != 1 || (pid != -1 && pid <= 1) {
		return failed
	}
	err := unix.Kill(pid, unix.Signal(sig))
	if err == unix.ESRCH {
		return nil
	}
	if err != nil {
		return failed
	}
	return nil
}
func (linuxProcesses) wait(ctx context.Context, deadline int64) error {
	return WaitDeadline(ctx, deadline)
}

func Run(ctx context.Context, permit Permit, runEpoch string, command []string, grace time.Duration) (Result, error) {
	return supervise(ctx, permit, runEpoch, command, grace, linuxProcesses{})
}
