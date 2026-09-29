//go:build !linux

// SPDX-License-Identifier: Apache-2.0
package executionguard

import (
	"context"
	"errors"
)

func ReadBootClock() (string, int64, error) {
	return "", 0, errors.New("execution_boot_clock_unavailable")
}
func WaitDeadline(ctx context.Context, expiresBootNs int64) error {
	_, _ = ctx, expiresBootNs
	return errors.New("execution_boot_clock_unavailable")
}
