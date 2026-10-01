// SPDX-License-Identifier: Apache-2.0
package delivery

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"regexp"
	"strconv"
	"time"

	guard "github.com/amerged-org/cloudflare-postgres/apps/execution-guard"
	"github.com/amerged-org/cloudflare-postgres/apps/node-runtime-observer/observer"
)

var requestIDPattern = regexp.MustCompile(`^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`)
var namespacePattern = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$`)

func decodeFrame(input io.Reader, value any) error {
	body, err := ReadFrame(input)
	if err != nil {
		return Incomplete
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil {
		return Incomplete
	}
	return nil
}
func frameHash(data []byte) string { value := sha256.Sum256(data); return hex.EncodeToString(value[:]) }

// Production callers supply a deadline-enabled pipe. One exchange stays open
// across the issuer wait; no path or challenge is reopened as new authority.
func runSession(parent context.Context, input io.Reader, output io.Writer, self Self, deps Dependencies) error {
	if parent == nil || parent.Err() != nil || deps.Open == nil || deps.Clock == nil {
		return Incomplete
	}
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	var init Initialization
	if decodeFrame(input, &init) != nil || init.Version != 1 || !requestIDPattern.MatchString(init.RequestID) ||
		!requestIDPattern.MatchString(self.PodUID) || !namespacePattern.MatchString(self.Namespace) ||
		self.InstallationID != init.Scope.InstallationID || self.RegionID != init.Scope.RegionID || self.NodeName != init.Scope.NodeName {
		return Incomplete
	}
	expected, err := guard.ParseSignedExpected(init.Expected)
	if err != nil {
		return Incomplete
	}
	if _, _, err := guard.ParseSignedKeyPin(init.PublicKeyPin); err != nil {
		return Incomplete
	}
	b := expected.Binding
	if b.InstallationID != init.Scope.InstallationID || b.RegionID != init.Scope.RegionID || b.NodeName != init.Scope.NodeName ||
		b.NodeUID != init.Scope.NodeUID || b.BootID != init.Scope.ExpectedBootID || b.PodUID != init.Pod.PodUID ||
		b.Namespace != init.Pod.Namespace || b.ContainerName != init.Pod.ContainerName {
		return Incomplete
	}
	boot, anchor, err := deps.Clock()
	if err != nil || boot != b.BootID || anchor < 0 || anchor > math.MaxInt64-int64(15*time.Second) || ctx.Err() != nil {
		return Incomplete
	}
	exchange, err := deps.Open(ctx, init)
	if err != nil || exchange == nil {
		return Incomplete
	}
	closed := false
	defer func() {
		if !closed {
			exchange.Close()
		}
	}()
	request := exchange.Request()
	exact, err := expectedChallenge(init)
	if err != nil || !bytes.Equal(request, exact) || ctx.Err() != nil {
		return Incomplete
	}
	challengeHash := frameHash(request)
	if WriteFrame(output, map[string]any{"version": 1, "type": "challenge", "requestId": init.RequestID, "self": self, "challenge": json.RawMessage(request), "challengeHash": challengeHash, "anchorBootNs": strconv.FormatInt(anchor, 10)}) != nil {
		return Incomplete
	}
	var authorization Authorization
	if decodeFrame(input, &authorization) != nil || authorization.Version != 1 || authorization.Type != "permit" ||
		authorization.RequestID != init.RequestID || authorization.ChallengeHash != challengeHash || ctx.Err() != nil {
		return Incomplete
	}
	duration, err := guard.VerifySignedResponseWindow(authorization.Permit, init.Nonce, init.Expected, init.PublicKeyPin)
	if err != nil {
		return Incomplete
	}
	if duration > 10*time.Second {
		duration = 10 * time.Second
	}
	deadline := anchor + int64(duration)
	authorized := func(ctx context.Context) error {
		currentBoot, now, err := deps.Clock()
		if err != nil || currentBoot != boot || now < anchor || now >= deadline || ctx.Err() != nil {
			return Incomplete
		}
		return nil
	}
	if authorized(ctx) != nil {
		return Incomplete
	}
	replayed, publishErr := exchange.Publish(ctx, authorization.Permit, authorized)
	closeErr := exchange.Close()
	closed = true
	if publishErr != nil && !errors.Is(publishErr, observer.ErrExecutionPublicationUncertain) {
		return Incomplete
	}
	state := "published"
	if replayed {
		state = "replayed"
	}
	if publishErr != nil || closeErr != nil {
		state = "uncertain"
	}
	if WriteFrame(output, map[string]any{"version": 1, "type": "receipt", "requestId": init.RequestID, "self": self, "challengeHash": challengeHash, "permitHash": frameHash(authorization.Permit), "state": state, "deadlineBootNs": strconv.FormatInt(deadline, 10)}) != nil {
		return observer.ErrExecutionPublicationUncertain
	}
	if state == "uncertain" {
		return observer.ErrExecutionPublicationUncertain
	}
	return nil
}
