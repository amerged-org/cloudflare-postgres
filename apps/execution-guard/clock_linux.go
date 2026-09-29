//go:build linux

// SPDX-License-Identifier: Apache-2.0
package executionguard

import (
	"context"
	"errors"
	"math"
	"os"
	"strings"

	"golang.org/x/sys/unix"
)

var unavailableClock = errors.New("execution_boot_clock_unavailable")

func ReadBootClock() (string, int64, error) {
	data, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil || len(data) > 128 {
		return "", 0, unavailableClock
	}
	boot := strings.TrimSpace(string(data))
	if !permitUUID.MatchString(boot) {
		return "", 0, unavailableClock
	}
	var value unix.Timespec
	if unix.ClockGettime(unix.CLOCK_BOOTTIME, &value) != nil || value.Sec < 0 || value.Nsec < 0 || value.Nsec >= 1_000_000_000 || value.Sec > (math.MaxInt64-value.Nsec)/1_000_000_000 {
		return "", 0, unavailableClock
	}
	return boot, value.Sec*1_000_000_000 + value.Nsec, nil
}

func WaitDeadline(ctx context.Context, expiresBootNs int64) error {
	if ctx == nil || expiresBootNs <= 0 {
		return unavailableClock
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	descriptor, err := unix.TimerfdCreate(unix.CLOCK_BOOTTIME, unix.TFD_CLOEXEC|unix.TFD_NONBLOCK)
	if err != nil {
		return unavailableClock
	}
	defer unix.Close(descriptor)
	deadline := unix.ItimerSpec{Value: unix.NsecToTimespec(expiresBootNs)}
	if unix.TimerfdSettime(descriptor, unix.TFD_TIMER_ABSTIME, &deadline, nil) != nil {
		return unavailableClock
	}
	poll := []unix.PollFd{{Fd: int32(descriptor), Events: unix.POLLIN}}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		_, err := unix.Poll(poll, 50)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil || poll[0].Revents&(unix.POLLERR|unix.POLLHUP|unix.POLLNVAL) != 0 {
			return unavailableClock
		}
		if poll[0].Revents&unix.POLLIN == 0 {
			continue
		}
		var elapsed [8]byte
		count, err := unix.Read(descriptor, elapsed[:])
		if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil || count != len(elapsed) {
			return unavailableClock
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return nil
	}
}
