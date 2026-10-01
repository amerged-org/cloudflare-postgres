// SPDX-License-Identifier: Apache-2.0
package delivery

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"

	guard "github.com/amerged-org/cloudflare-postgres/apps/execution-guard"
	"github.com/amerged-org/cloudflare-postgres/apps/node-runtime-observer/observer"
)

type retainedExchange struct {
	request   []byte
	publishes int
	closed    bool
}

func (e *retainedExchange) Request() []byte { return e.request }
func (e *retainedExchange) Close() error    { e.closed = true; return nil }
func (e *retainedExchange) Publish(ctx context.Context, _ []byte, authorized func(context.Context) error) (bool, error) {
	if e.closed || authorized(ctx) != nil {
		return false, Incomplete
	}
	e.publishes++
	return false, nil
}

func TestDuplexRetainsCustodyForAuthenticatedPermit(t *testing.T) {
	data, err := os.ReadFile("../../execution-guard/testdata/signed-window-v2.json")
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
		t.Fatal("fixture")
	}
	var payload struct {
		Nonce   string              `json:"nonce"`
		Binding guard.SignedBinding `json:"binding"`
	}
	if json.Unmarshal([]byte(fixture.Payload), &payload) != nil {
		t.Fatal("payload")
	}
	expected, _ := json.Marshal(guard.SignedExpected{Version: 2, Binding: payload.Binding, Command: fixture.Command})
	pin, _ := json.Marshal(guard.SignedKeyPin{Version: 2, KeyID: fixture.KeyID, PublicKey: fixture.PublicKey})
	b := payload.Binding
	init := Initialization{Version: 1, RequestID: "55555555-5555-4555-8555-555555555555", Scope: observer.Scope{InstallationID: b.InstallationID, RegionID: b.RegionID, NodeName: b.NodeName, NodeUID: b.NodeUID, ExpectedBootID: b.BootID}, Pod: observer.ExecutionMountProjection{PodUID: b.PodUID, Namespace: b.Namespace, ContainerName: b.ContainerName}, Nonce: payload.Nonce, Expected: expected, PublicKeyPin: pin}
	self := Self{PodUID: "66666666-6666-4666-8666-666666666666", Namespace: "delivery-platform", NodeName: b.NodeName, InstallationID: b.InstallationID, RegionID: b.RegionID}
	request, _ := expectedChallenge(init)
	exchange := &retainedExchange{request: request}
	input, client := io.Pipe()
	output, agent := io.Pipe()
	defer input.Close()
	defer client.Close()
	defer output.Close()
	defer agent.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		err := Session(ctx, input, agent, self, Dependencies{Open: func(context.Context, Initialization) (Exchange, error) { return exchange, nil }, Clock: func() (string, int64, error) { return b.BootID, int64(time.Second), nil }})
		done <- err
		input.CloseWithError(err)
		agent.CloseWithError(err)
	}()
	if err := WriteFrame(client, init); err != nil {
		t.Fatal(err)
	}
	challengeBytes, err := ReadFrame(output)
	if err != nil {
		select {
		case e := <-done:
			t.Fatalf("missing challenged session: %v", e)
		default:
			t.Fatal(err)
		}
	}
	var challenge struct {
		Type          string `json:"type"`
		ChallengeHash string `json:"challengeHash"`
	}
	if json.Unmarshal(challengeBytes, &challenge) != nil || challenge.Type != "challenge" {
		t.Fatal("missing exact challenge frame")
	}
	hash := sha256.Sum256(request)
	if challenge.ChallengeHash != hex.EncodeToString(hash[:]) || exchange.closed {
		t.Fatal("original custody must survive issuer wait")
	}
	permit, _ := json.Marshal(map[string]any{"version": 2, "keyId": fixture.KeyID, "payload": base64.RawURLEncoding.EncodeToString([]byte(fixture.Payload)), "signature": fixture.Signature})
	if err := WriteFrame(client, Authorization{Version: 1, Type: "permit", RequestID: init.RequestID, ChallengeHash: challenge.ChallengeHash, Permit: permit}); err != nil {
		t.Fatal(err)
	}
	receiptBytes, err := ReadFrame(output)
	if err != nil {
		t.Fatal(err)
	}
	var receipt struct {
		Type       string `json:"type"`
		State      string `json:"state"`
		PermitHash string `json:"permitHash"`
	}
	if json.Unmarshal(receiptBytes, &receipt) != nil || receipt.Type != "receipt" || receipt.State != "published" {
		t.Fatal("no bound receipt")
	}
	if err := <-done; err != nil || exchange.publishes != 1 || !exchange.closed {
		t.Fatalf("one retained exchange must close after publication: %v", err)
	}
}

func init() {
	if os.Getenv("PGCF_DELIVERY_PIPE_TEST_CHILD") != "1" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	input, err := OwnedPipe(os.Stdin)
	if err != nil {
		os.Exit(5)
	}
	defer input.Close()
	output, err := OwnedPipe(os.Stdout)
	if err != nil {
		os.Exit(6)
	}
	defer output.Close()
	stop, err := PipeDeadline(ctx, input)
	if err != nil {
		os.Stderr.WriteString("inherited stdin deadline unavailable\n")
		os.Exit(2)
	}
	defer stop()
	if output.SetWriteDeadline(time.Now().Add(time.Second)) != nil {
		os.Stderr.WriteString("inherited stdout deadline unavailable\n")
		os.Exit(3)
	}
	_, err = ReadFrame(input)
	if err == nil {
		os.Exit(4)
	}
	os.Exit(0)
}

func TestPipeDeadlineDoesNotWaitForExecStdinEOF(t *testing.T) {
	input, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	defer writer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.CommandContext(ctx, executable, "-test.run=^$")
	child.Env = append(os.Environ(), "PGCF_DELIVERY_PIPE_TEST_CHILD=1")
	child.Stdin = input
	var stdout, stderr bytes.Buffer
	child.Stdout = &stdout
	child.Stderr = &stderr
	start := time.Now()
	if err := child.Run(); err != nil || time.Since(start) > time.Second {
		t.Fatalf("inherited exec pipes must support deadline without EOF: %v %s", err, stderr.String())
	}
}
