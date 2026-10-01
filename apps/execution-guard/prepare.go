// SPDX-License-Identifier: Apache-2.0
package executionguard

import "context"

type SignedInputConfiguration struct {
	InputDirectory string
	IPCDirectory   string
	Capsule        []byte
}
type SignedInputResult struct {
	ExpectedHash  string `json:"expectedHash"`
	PublicKeyHash string `json:"publicKeyHash"`
}

func PrepareSignedInputs(ctx context.Context, config SignedInputConfiguration) (SignedInputResult, error) {
	return prepareSignedInputs(ctx, config)
}
