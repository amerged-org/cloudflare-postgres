//go:build !linux

// SPDX-License-Identifier: Apache-2.0
package executionguard

import "context"

func prepareSignedInputs(context.Context, SignedInputConfiguration) (SignedInputResult, error) {
	return SignedInputResult{}, failed
}
