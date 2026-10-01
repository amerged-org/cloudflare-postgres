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

type signedContinuingProcesses struct{ fakeProcesses }

func (system *signedContinuingProcesses) reap(int) (bool, error) {
	system.mu.Lock()
	defer system.mu.Unlock()
	return system.now >= int64(10*time.Second), nil
}

func TestSignedWindowVerifiesBeforeStartingAndKeepsOriginalBootAnchor(t *testing.T) {
	data, err := os.ReadFile("testdata/signed-window-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		KeyID     string   `json:"keyId"`
		PublicKey string   `json:"publicKey"`
		Payload   string   `json:"payload"`
		Signature string   `json:"signature"`
		Command   []string `json:"command"`
	}
	if json.Unmarshal(data, &fixture) != nil {
		t.Fatal("invalid independent public byte fixture")
	}
	var payload struct {
		Version    int           `json:"version"`
		Nonce      string        `json:"nonce"`
		Binding    SignedBinding `json:"binding"`
		DurationNs string        `json:"durationNs"`
		IssuedAt   string        `json:"issuedAt"`
		ValidUntil string        `json:"validUntil"`
	}
	if json.Unmarshal([]byte(fixture.Payload), &payload) != nil {
		t.Fatal("invalid payload fixture")
	}
	key, err := base64.RawURLEncoding.DecodeString(fixture.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := base64.RawURLEncoding.DecodeString(fixture.Signature)
	if err != nil || !ed25519.Verify(key, append([]byte("cloudflare-postgres/execution-permit/v2\x00"+fixture.KeyID+"\x00"), []byte(fixture.Payload)...), signature) {
		t.Fatal("independent signed bytes do not verify")
	}
	// Public RFC 8032 section 7.1 test seed; never an installation credential.
	seed, _ := hex.DecodeString("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
	signer := ed25519.NewKeyFromSeed(seed)
	expected := SignedExpected{Version: 2, Binding: payload.Binding, Command: fixture.Command}
	response := func(challenge SignedChallenge, binding SignedBinding) []byte {
		body, marshalErr := json.Marshal(map[string]any{"version": 2, "nonce": challenge.Nonce, "binding": binding, "durationNs": payload.DurationNs, "issuedAt": payload.IssuedAt, "validUntil": payload.ValidUntil})
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		// Binding is deliberately represented as a map to produce the agreed
		// ASCII-key-sorted bytes, separately from the verifier's implementation.
		var canonical map[string]any
		if json.Unmarshal(body, &canonical) != nil {
			t.Fatal("invalid test payload")
		}
		body, marshalErr = json.Marshal(canonical)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		sig := ed25519.Sign(signer, append([]byte("cloudflare-postgres/execution-permit/v2\x00"+fixture.KeyID+"\x00"), body...))
		outer, marshalErr := json.Marshal(map[string]any{"version": 2, "keyId": fixture.KeyID, "payload": base64.RawURLEncoding.EncodeToString(body), "signature": base64.RawURLEncoding.EncodeToString(sig)})
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		return outer
	}
	current := &signedContinuingProcesses{fakeProcesses{self: 1, boot: expected.Binding.BootID, now: int64(time.Second)}}
	var initialNonce string
	result, err := runSignedWindow(context.Background(), expected, fixture.KeyID, key, fixture.Command, 3*time.Second, 15*time.Second,
		func(_ context.Context, challenge SignedChallenge, boot string, deadline int64) ([]byte, error) {
			initialNonce = challenge.Nonce
			if boot != current.boot || deadline != int64(16*time.Second) || challenge.Binding.PodUID != expected.Binding.PodUID {
				t.Fatal("challenge must follow the local pre-transport clock and protected identity")
			}
			current.now += int64(2 * time.Second)
			return response(challenge, expected.Binding), nil
		}, current)
	if err != nil || !result.Started || !result.Quiescent || current.started != 1 || current.now != int64(13*time.Second) {
		t.Fatalf("valid signed window must reach the maintained supervisor without sliding its deadline: %+v %v clock=%d", result, err, current.now)
	}
	foreign := expected.Binding
	foreign.PodUID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	refused := &fakeProcesses{self: 1, boot: current.boot, now: int64(time.Second)}
	if _, err = runSignedWindow(context.Background(), expected, fixture.KeyID, key, fixture.Command, 3*time.Second, 15*time.Second,
		func(_ context.Context, challenge SignedChallenge, _ string, _ int64) ([]byte, error) {
			if challenge.Nonce == initialNonce {
				t.Fatal("new attempt adopted an old nonce")
			}
			return response(challenge, foreign), nil
		}, refused); err == nil || refused.started != 0 || len(refused.signals) != 0 {
		t.Fatal("a signed foreign Pod cannot start or signal any process")
	}
	unsigned := &fakeProcesses{self: 1, boot: current.boot, now: int64(time.Second)}
	if _, err = runSignedWindow(context.Background(), expected, fixture.KeyID, key, fixture.Command, 3*time.Second, 15*time.Second,
		func(context.Context, SignedChallenge, string, int64) ([]byte, error) {
			return []byte(`{"version":1,"bootId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","runEpoch":"1","notBeforeBootNs":"0","expiresAtBootNs":"12000000000"}`), nil
		}, unsigned); err == nil || unsigned.started != 0 {
		t.Fatal("signed startup cannot fall back to the unsigned operator lane")
	}
	expired := &fakeProcesses{self: 1, boot: current.boot, now: int64(time.Second)}
	if _, err = runSignedWindow(context.Background(), expected, fixture.KeyID, key, fixture.Command, 3*time.Second, 15*time.Second,
		func(_ context.Context, challenge SignedChallenge, _ string, _ int64) ([]byte, error) {
			expired.now = int64(13 * time.Second)
			return response(challenge, expected.Binding), nil
		}, expired); err == nil || expired.started != 0 {
		t.Fatal("response delivery cannot renew an elapsed native deadline")
	}
}
