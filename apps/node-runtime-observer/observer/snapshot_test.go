// SPDX-License-Identifier: Apache-2.0
package observer

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	runtime "k8s.io/cri-api/pkg/apis/runtime/v1"
)

const podUID = "11111111-1111-4111-8111-111111111111"
const bootID = "22222222-2222-4222-8222-222222222222"

var sandboxID = strings.Repeat("a", 64)
var containerID = strings.Repeat("b", 64)

const created int64 = 1790639999000000001
const started int64 = 1790640000000000002

func fixture() (*runtime.PodSandbox, *runtime.Container, *runtime.ContainerStatus) {
	s := &runtime.PodSandbox{Id: sandboxID, Metadata: &runtime.PodSandboxMetadata{Uid: podUID, Namespace: "tenant-a", Name: "database-1"}, State: runtime.PodSandboxState_SANDBOX_NOTREADY, CreatedAt: created}
	c := &runtime.Container{Id: containerID, PodSandboxId: sandboxID, Metadata: &runtime.ContainerMetadata{Name: "postgres", Attempt: 2}, State: runtime.ContainerState_CONTAINER_RUNNING, CreatedAt: created}
	status := &runtime.ContainerStatus{Image: &runtime.ImageSpec{Image: "postgres:test"}, ImageRef: "sha256:" + strings.Repeat("c", 64), Id: containerID, Metadata: &runtime.ContainerMetadata{Name: "postgres", Attempt: 2}, State: runtime.ContainerState_CONTAINER_RUNNING, CreatedAt: created, StartedAt: started, Labels: map[string]string{"io.kubernetes.pod.uid": podUID, "io.kubernetes.pod.namespace": "tenant-a"}}
	return s, c, status
}
func collector(reader Reader) Collector {
	n := 0
	return Collector{Reader: reader, Scope: Scope{InstallationID: podUID, RegionID: "region-a", NodeName: "node-a", NodeUID: bootID, ExpectedBootID: bootID}, BootID: func() (string, error) { return bootID, nil }, Now: func() time.Time { n++; return time.Date(2026, 9, 29, 0, 0, n, 0, time.UTC) }, Timeout: 5 * time.Second, MaxEntries: 64}
}

type fakeReader struct {
	sandboxes  []*runtime.PodSandbox
	containers []*runtime.Container
	status     *runtime.ContainerStatus
	failStatus bool
	failList   bool
	changeList bool
	lists      int
}

func (f *fakeReader) ListPodSandbox(_ context.Context, filter *runtime.PodSandboxFilter) ([]*runtime.PodSandbox, error) {
	if filter != nil {
		return nil, errors.New("filtered")
	}
	return f.sandboxes, nil
}
func (f *fakeReader) ListContainers(_ context.Context, filter *runtime.ContainerFilter) ([]*runtime.Container, error) {
	if filter != nil {
		return nil, errors.New("filtered")
	}
	f.lists++
	if f.failList {
		return nil, errors.New("unavailable")
	}
	if f.changeList && f.lists > 1 {
		return nil, nil
	}
	return f.containers, nil
}
func (f *fakeReader) ContainerStatus(_ context.Context, id string, verbose bool) (*runtime.ContainerStatusResponse, error) {
	if f.failStatus || id != containerID || verbose {
		return nil, errors.New("status unavailable")
	}
	return &runtime.ContainerStatusResponse{Status: f.status}, nil
}

type wireServer struct {
	runtime.UnimplementedRuntimeServiceServer
	reader *fakeReader
}

func (s *wireServer) Version(context.Context, *runtime.VersionRequest) (*runtime.VersionResponse, error) {
	return &runtime.VersionResponse{Version: "0.1.0", RuntimeName: "test", RuntimeVersion: "1", RuntimeApiVersion: "v1"}, nil
}
func (s *wireServer) ListPodSandbox(ctx context.Context, r *runtime.ListPodSandboxRequest) (*runtime.ListPodSandboxResponse, error) {
	v, e := s.reader.ListPodSandbox(ctx, r.Filter)
	return &runtime.ListPodSandboxResponse{Items: v}, e
}
func (s *wireServer) ListContainers(ctx context.Context, r *runtime.ListContainersRequest) (*runtime.ListContainersResponse, error) {
	v, e := s.reader.ListContainers(ctx, r.Filter)
	return &runtime.ListContainersResponse{Containers: v}, e
}
func (s *wireServer) ContainerStatus(ctx context.Context, r *runtime.ContainerStatusRequest) (*runtime.ContainerStatusResponse, error) {
	return s.reader.ContainerStatus(ctx, r.ContainerId, r.Verbose)
}

func TestUnfilteredTransportPreservesNonReadySandboxAndOrphan(t *testing.T) {
	s, c, status := fixture()
	f := &fakeReader{sandboxes: []*runtime.PodSandbox{s}, containers: []*runtime.Container{c}, status: status}
	dir, err := os.MkdirTemp("/tmp", "pgcf-cri-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "runtime.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	runtime.RegisterRuntimeServiceServer(server, &wireServer{reader: f})
	go server.Serve(listener)
	t.Cleanup(server.Stop)
	reader, err := Connect(context.Background(), "unix://"+socket, 3*time.Second)
	if err != nil {
		t.Fatalf("maintained Unix transport required: %v", err)
	}
	got, err := collector(reader).Collect(context.Background())
	if err != nil {
		t.Fatalf("non-ready sandbox running container must be retained: %v", err)
	}
	if len(got.Containers) != 1 || got.Containers[0].State != "running" || got.Containers[0].PodUID != podUID || got.Sandboxes[0].State != "not_ready" {
		t.Fatal("running runtime disappeared")
	}
	f.sandboxes = nil
	got, err = collector(reader).Collect(context.Background())
	if err == nil || got != nil {
		t.Fatal("orphan running container must prevent successful snapshot")
	}
}
func TestIncompleteStatusAndConcurrentRuntimeChangeFailClosed(t *testing.T) {
	s, c, status := fixture()
	f := &fakeReader{sandboxes: []*runtime.PodSandbox{s}, containers: []*runtime.Container{c}, status: status, failStatus: true}
	got, err := collector(f).Collect(context.Background())
	if err == nil || got != nil {
		t.Fatal("failed status read returned successful partial evidence")
	}
	f.failStatus = false
	f.changeList = true
	f.lists = 0
	got, err = collector(f).Collect(context.Background())
	if err == nil || got != nil {
		t.Fatal("changed inventory returned a stable snapshot")
	}
	f.changeList = false
	f.lists = 0
	f.failList = true
	got, err = collector(f).Collect(context.Background())
	if err == nil || got != nil {
		t.Fatal("failed list returned evidence")
	}
	f.failList = false
	c.State = runtime.ContainerState(19)
	got, err = collector(f).Collect(context.Background())
	if err == nil || got != nil {
		t.Fatal("unknown state returned evidence")
	}
	c.State = runtime.ContainerState_CONTAINER_RUNNING
	got, err = collector(f).Collect(context.Background())
	if err != nil || got == nil {
		t.Fatalf("complete unchanged evidence should succeed: %v", err)
	}
}
func TestExactNanosecondsAndNodeBootScopeArePreserved(t *testing.T) {
	s, c, status := fixture()
	f := &fakeReader{sandboxes: []*runtime.PodSandbox{s}, containers: []*runtime.Container{c}, status: status}
	conf := collector(f)
	got, err := conf.Collect(context.Background())
	if err != nil {
		t.Fatalf("valid bounded scope must succeed: %v", err)
	}
	row := got.Containers[0]
	if got.Version != 1 || got.Scope != conf.Scope || got.BootID != bootID || got.StartedAt != "2026-09-29T00:00:01.000000000Z" || got.FinishedAt != "2026-09-29T00:00:02.000000000Z" || row.ID != containerID || row.SandboxID != sandboxID || row.CreatedAt != "1790639999000000001" || row.StartedAt != "1790640000000000002" || row.FinishedAt != "0" || row.Attempt != 2 {
		t.Fatal("identity, scope, interval or nanoseconds changed")
	}
	calls := 0
	conf = collector(f)
	conf.BootID = func() (string, error) {
		calls++
		if calls == 1 {
			return bootID, nil
		}
		return podUID, nil
	}
	got, err = conf.Collect(context.Background())
	if err == nil || got != nil {
		t.Fatal("node reboot during collection returned evidence")
	}
	conf = collector(f)
	conf.Scope.NodeUID = ""
	got, err = conf.Collect(context.Background())
	if err == nil || got != nil {
		t.Fatal("missing node provenance returned evidence")
	}
}
