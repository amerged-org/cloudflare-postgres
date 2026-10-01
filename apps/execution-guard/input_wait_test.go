// SPDX-License-Identifier: Apache-2.0
package executionguard

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestInputWaitKeepsOriginalBootAnchorForSignedWindow(t *testing.T) {
	data, err := os.ReadFile("testdata/signed-window-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		KeyID     string   `json:"keyId"`
		PublicKey string   `json:"publicKey"`
		Payload   string   `json:"payload"`
		Command   []string `json:"command"`
	}
	if json.Unmarshal(data, &fixture) != nil {
		t.Fatal("fixture")
	}
	var payload struct {
		Binding SignedBinding `json:"binding"`
	}
	if json.Unmarshal([]byte(fixture.Payload), &payload) != nil {
		t.Fatal("payload")
	}
	key, _ := base64.RawURLEncoding.DecodeString(fixture.PublicKey)
	seed, _ := hex.DecodeString("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60") // Public RFC8032 fixture seed.
	signer := ed25519.NewKeyFromSeed(seed)
	expected := SignedExpected{Version: 2, Binding: payload.Binding, Command: fixture.Command}
	current := &signedContinuingProcesses{fakeProcesses: fakeProcesses{self: 1, boot: payload.Binding.BootID, now: int64(6 * time.Second)}}
	original := &signedStartupAnchor{boot: payload.Binding.BootID, now: int64(time.Second)}
	permit, err := prepareSignedWindowAt(context.Background(), expected, fixture.KeyID, key, fixture.Command, time.Second, 15*time.Second,
		func(_ context.Context, challenge SignedChallenge, _ string, deadline int64) ([]byte, error) {
			if deadline != int64(16*time.Second) {
				t.Fatalf("waiting must not reset startup deadline: %d", deadline)
			}
			body, _ := json.Marshal(map[string]any{"version": 2, "nonce": challenge.Nonce, "binding": expected.Binding, "durationNs": "12000000000", "issuedAt": "2026-10-01T00:00:00.000Z", "validUntil": "2026-10-01T00:00:12.000Z"})
			var sorted map[string]any
			json.Unmarshal(body, &sorted)
			body, _ = json.Marshal(sorted)
			signature := ed25519.Sign(signer, append([]byte(signedDomain+fixture.KeyID+"\x00"), body...))
			return json.Marshal(map[string]any{"version": 2, "keyId": fixture.KeyID, "payload": base64.RawURLEncoding.EncodeToString(body), "signature": base64.RawURLEncoding.EncodeToString(signature)})
		}, current, original)
	if err != nil {
		t.Fatal(err)
	}
	if permit.NotBeforeBootNs != int64(time.Second) || permit.ExpiresAtBootNs != int64(13*time.Second) {
		t.Fatal("issuer duration must include the elapsed input wait")
	}
}
