// SPDX-License-Identifier: Apache-2.0
package executionguard

import "time"

// ProtocolObject and ProtocolJSON reuse the guard's bounded duplicate-refusing
// parser and canonical encoder for the private node transport.
func ProtocolObject(data []byte) (map[string]any, error) { return strictJSON(data) }
func ProtocolJSON(value any) ([]byte, error)             { return canonicalJSON(value) }

// VerifySignedResponseWindow authenticates the exact nonce/full execution
// binding. Its duration must be anchored to a pre-transport local boot sample;
// it grants no authority to extend that sample after a slow response.
func VerifySignedResponseWindow(data []byte, nonce string, expectedBytes, pinBytes []byte) (time.Duration, error) {
	if _, err := decodeURL(nonce, 32); err != nil {
		return 0, err
	}
	expected, err := ParseSignedExpected(expectedBytes)
	if err != nil {
		return 0, err
	}
	pin, key, err := ParseSignedKeyPin(pinBytes)
	if err != nil {
		return 0, err
	}
	duration, err := signedDuration(data, nonce, expected.Binding, pin.KeyID, key)
	return time.Duration(duration), err
}
