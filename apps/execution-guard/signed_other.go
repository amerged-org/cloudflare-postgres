//go:build !linux

// SPDX-License-Identifier: Apache-2.0
package executionguard

import "context"

func RunSigned(context.Context, SignedRunConfiguration) (Result, error) { return Result{}, failed }
