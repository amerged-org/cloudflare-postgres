//go:build linux

// SPDX-License-Identifier: Apache-2.0
package observer

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	guard "github.com/amerged-org/cloudflare-postgres/apps/execution-guard"
	"golang.org/x/sys/unix"
	runtime "k8s.io/cri-api/pkg/apis/runtime/v1"
)

func exchangeFixture(t *testing.T) (ExecutionExchangeConfiguration, *fakeReader, string, []byte) {
	t.Helper()
	if os.Getuid() != 0 {
		t.Skip("native exchange qualification requires isolated root with CHOWN and DAC_OVERRIDE")
	}
	root := filepath.Join(t.TempDir(), "kubelet")
	sandbox, container, status := fixture()
	sandbox.State = runtime.PodSandboxState_SANDBOX_READY
	pod := ExecutionMountProjection{PodUID: podUID, Namespace: "tenant-a", PodName: "database-1", ContainerName: "postgres", ContainerID: containerID, Attempt: 2,
		VolumeName: "pgcf-execution-ipc-postgres", ContainerPath: "/pgcf/ipc/postgres", EmptyDir: true}
	mount := filepath.Join(root, "pods", podUID, "volumes", "kubernetes.io~empty-dir", pod.VolumeName)
	status.Mounts = []*runtime.Mount{{ContainerPath: pod.ContainerPath, HostPath: mount}}
	reader := &fakeReader{sandboxes: []*runtime.PodSandbox{sandbox}, containers: []*runtime.Container{container}, status: status}
	nonce := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	config := ExecutionExchangeConfiguration{Resolver: ExecutionMountResolver{Reader: reader, BootID: func() (string, error) { return bootID, nil }, ExpectedBootID: bootID, Timeout: time.Second, MaxEntries: 64},
		Pod: pod, KubeletRoot: root, PrivateDirectory: "private", GuardUID: uint32(os.Getuid()), GuardGID: uint32(os.Getgid()), Nonce: nonce,
		Challenge: ExecutionChallengeProjection{InstallationID: podUID, NamespaceUID: bootID, PodUID: podUID, ContainerName: "postgres", NodeName: "node-a", NodeUID: bootID, BootID: bootID, ImageHash: strings.Repeat("c", 64), CommandHash: strings.Repeat("d", 64)}}
	// Root-owned qualification exercises delivery to a distinct guard principal.
	if os.Getuid() == 0 {
		config.GuardUID = 10001
		config.GuardGID = 10001
	}
	status.User = &runtime.ContainerUser{Linux: &runtime.LinuxContainerUser{Uid: int64(config.GuardUID), Gid: int64(config.GuardGID)}}
	attempt := filepath.Join(mount, config.PrivateDirectory, "attempt-"+nonce)
	if err := os.MkdirAll(attempt, 0700); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{filepath.Dir(attempt), attempt} {
		if err := os.Chown(dir, int(config.GuardUID), int(config.GuardGID)); err != nil {
			t.Fatal(err)
		}
	}
	request, err := guard.ProtocolJSON(guard.SignedChallenge{Version: 2, Nonce: nonce, Binding: guard.ChallengeBinding{
		InstallationID: config.Challenge.InstallationID, NamespaceUID: config.Challenge.NamespaceUID, PodUID: podUID, ContainerName: "postgres", NodeName: "node-a", NodeUID: bootID, BootID: bootID, ImageHash: config.Challenge.ImageHash, CommandHash: config.Challenge.CommandHash}})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(attempt, "request.json"), request, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chown(filepath.Join(attempt, "request.json"), int(config.GuardUID), int(config.GuardGID)); err != nil {
		t.Fatal(err)
	}
	return config, reader, attempt, request
}

func TestExecutionExchangePublishesOriginalPrivateChallenge(t *testing.T) {
	config, _, attempt, request := exchangeFixture(t)
	ctx := context.Background()
	exchange, err := OpenExecutionExchange(ctx, config)
	if err != nil {
		t.Fatalf("original challenge must open under runtime/file custody: %v", err)
	}
	defer exchange.Close()
	if !bytes.Equal(exchange.Request(), request) {
		t.Fatal("original request bytes changed")
	}
	response := []byte(`{"version":2,"keyId":"fixture-only","payload":"fixture","signature":"fixture"}`)
	replayed, err := exchange.Publish(ctx, response, func(context.Context) error { return nil })
	if err != nil || replayed {
		t.Fatalf("first synchronized publication failed: %v", err)
	}
	published, err := os.ReadFile(filepath.Join(attempt, "permit.json"))
	if err != nil || !bytes.Equal(published, response) {
		t.Fatal("exact response not visible")
	}
	var originalPermit unix.Stat_t
	if unix.Lstat(filepath.Join(attempt, "permit.json"), &originalPermit) != nil || originalPermit.Uid != config.GuardUID ||
		originalPermit.Gid != config.GuardGID || originalPermit.Mode&07777 != 0600 || originalPermit.Nlink != 1 {
		t.Fatal("published file lacks actual guard ownership/private single-link mode")
	}
	if err := exchange.Close(); err != nil {
		t.Fatal(err)
	}
	exchange, err = OpenExecutionExchange(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer exchange.Close()
	if replayed, err = exchange.Publish(ctx, response, func(context.Context) error { return nil }); err != nil || !replayed {
		t.Fatalf("unchanged lost-acknowledgement replay failed: %v", err)
	}
	var replayedPermit unix.Stat_t
	if unix.Lstat(filepath.Join(attempt, "permit.json"), &replayedPermit) != nil || replayedPermit.Ino != originalPermit.Ino || replayedPermit.Dev != originalPermit.Dev {
		t.Fatal("lost-acknowledgement replay replaced the original permit")
	}
	before, _ := os.ReadFile(filepath.Join(attempt, "permit.json"))
	if err = os.WriteFile(filepath.Join(attempt, "request.json"), append(request, ' '), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = exchange.Publish(ctx, response, func(context.Context) error { return nil }); err == nil {
		t.Fatal("changed original request cannot retain publication custody")
	}
	after, _ := os.ReadFile(filepath.Join(attempt, "permit.json"))
	if !bytes.Equal(before, after) {
		t.Fatal("failed replay changed existing permit")
	}
}

func TestExecutionExchangeRefusesPeerChangeBeforePublication(t *testing.T) {
	config, reader, attempt, _ := exchangeFixture(t)
	exchange, err := OpenExecutionExchange(context.Background(), config)
	if err != nil {
		t.Fatalf("stable peer must open: %v", err)
	}
	defer exchange.Close()
	checks := 0
	_, err = exchange.Publish(context.Background(), []byte(`{"fixture":"opaque-signed-response"}`), func(context.Context) error {
		checks++
		if checks == 2 {
			reader.containers = nil
		}
		return nil
	})
	if err == nil || errors.Is(err, ErrExecutionPublicationUncertain) {
		t.Fatalf("known prepublication peer loss must refuse visibility: %v", err)
	}
	if _, statErr := os.Lstat(filepath.Join(attempt, "permit.json")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatal("peer change must precede permit visibility")
	}
}

func TestExecutionExchangeChecksAuthorityImmediatelyBeforeVisibility(t *testing.T) {
	config, _, attempt, _ := exchangeFixture(t)
	exchange, err := OpenExecutionExchange(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer exchange.Close()
	checks := 0
	_, err = exchange.Publish(context.Background(), []byte(`{"fixture":"opaque-response"}`), func(context.Context) error {
		checks++
		if checks == 3 {
			return errors.New("current lease revoked")
		}
		return nil
	})
	if err == nil || errors.Is(err, ErrExecutionPublicationUncertain) {
		t.Fatalf("late authority must be checked before publication, got %v", err)
	}
	if _, err := os.Lstat(filepath.Join(attempt, "permit.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("revoked lease reached permit visibility")
	}
}
