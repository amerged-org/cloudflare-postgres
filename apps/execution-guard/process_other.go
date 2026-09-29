//go:build !linux

// SPDX-License-Identifier: Apache-2.0
package executionguard

import (
	"context"
	"time"
)

func Run(context.Context, Permit, string, []string, time.Duration) (Result, error) {
	return Result{}, failed
}
