// SPDX-License-Identifier: Apache-2.0
package observer

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-logr/logr"
	runtime "k8s.io/cri-api/pkg/apis/runtime/v1"
	cri "k8s.io/cri-client/pkg"
	"k8s.io/klog/v2"
)

type Reader interface {
	ListPodSandbox(context.Context, *runtime.PodSandboxFilter) ([]*runtime.PodSandbox, error)
	ListContainers(context.Context, *runtime.ContainerFilter) ([]*runtime.Container, error)
	ContainerStatus(context.Context, string, bool) (*runtime.ContainerStatusResponse, error)
}
type Scope struct {
	InstallationID string `json:"installationId"`
	RegionID       string `json:"regionId"`
	NodeName       string `json:"nodeName"`
	NodeUID        string `json:"nodeUid"`
	ExpectedBootID string `json:"expectedBootId"`
}
type Sandbox struct {
	ID        string `json:"id"`
	PodUID    string `json:"podUid"`
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	State     string `json:"state"`
	CreatedAt string `json:"createdAtUnixNs"`
}
type Container struct {
	ID         string `json:"id"`
	SandboxID  string `json:"sandboxId"`
	PodUID     string `json:"podUid"`
	Namespace  string `json:"namespace"`
	Name       string `json:"name"`
	Attempt    uint32 `json:"attempt"`
	State      string `json:"state"`
	CreatedAt  string `json:"createdAtUnixNs"`
	StartedAt  string `json:"startedAtUnixNs"`
	FinishedAt string `json:"finishedAtUnixNs"`
}
type Snapshot struct {
	Version    int         `json:"version"`
	Scope      Scope       `json:"scope"`
	BootID     string      `json:"bootId"`
	StartedAt  string      `json:"startedAt"`
	FinishedAt string      `json:"finishedAt"`
	Sandboxes  []Sandbox   `json:"sandboxes"`
	Containers []Container `json:"containers"`
}
type Collector struct {
	Reader     Reader
	Scope      Scope
	BootID     func() (string, error)
	Now        func() time.Time
	Timeout    time.Duration
	MaxEntries int
}

var runtimeID = regexp.MustCompile(`^[a-f0-9]{64}$`)
var uuid = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var dnsLabel = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)
var dnsName = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`)
var scopeID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func fail() error { return errors.New("node_runtime_observation_incomplete") }
func (c Collector) Collect(parent context.Context) (*Snapshot, error) {
	if c.Reader == nil || c.BootID == nil || c.Now == nil || c.Timeout <= 0 || c.Timeout > 30*time.Second || c.MaxEntries < 1 || c.MaxEntries > 4096 ||
		!scopeID.MatchString(c.Scope.InstallationID) || !scopeID.MatchString(c.Scope.RegionID) || len(c.Scope.NodeName) > 253 || !dnsName.MatchString(c.Scope.NodeName) || !uuid.MatchString(c.Scope.NodeUID) || !uuid.MatchString(c.Scope.ExpectedBootID) {
		return nil, fail()
	}
	// Silence upstream logs as well as project errors: RPC errors can contain IDs.
	ctx, cancel := context.WithTimeout(klog.NewContext(parent, logr.Discard()), c.Timeout)
	defer cancel()
	elapsedStart := time.Now()
	start := c.Now()
	boot, err := c.BootID()
	if err != nil || boot != c.Scope.ExpectedBootID || ctx.Err() != nil {
		return nil, fail()
	}
	sandboxes, containers, err := c.inventory(ctx)
	if err != nil {
		return nil, err
	}
	snapshot := &Snapshot{Version: 1, Scope: c.Scope, BootID: boot, StartedAt: start.UTC().Format("2006-01-02T15:04:05.000000000Z"), Sandboxes: sandboxes, Containers: make([]Container, 0, len(containers))}
	bySandbox := make(map[string]Sandbox, len(sandboxes))
	for _, s := range sandboxes {
		bySandbox[s.ID] = s
	}
	for _, v := range containers {
		if ctx.Err() != nil {
			return nil, fail()
		}
		sandbox, ok := bySandbox[v.PodSandboxId]
		if !ok {
			return nil, fail()
		}
		for key, expected := range map[string]string{"io.kubernetes.pod.uid": sandbox.PodUID, "io.kubernetes.pod.namespace": sandbox.Namespace, "io.kubernetes.pod.name": sandbox.Name} {
			if value := v.Labels[key]; value != "" && value != expected {
				return nil, fail()
			}
		}
		response, err := c.Reader.ContainerStatus(ctx, v.Id, false)
		if err != nil || response == nil || response.Status == nil {
			return nil, fail()
		}
		status := response.Status
		if status.Id != v.Id || status.Metadata == nil || status.Metadata.Name != v.Metadata.Name || status.Metadata.Attempt != v.Metadata.Attempt || status.CreatedAt != v.CreatedAt || status.State != v.State {
			return nil, fail()
		}
		if uid := status.Labels["io.kubernetes.pod.uid"]; uid != "" && uid != sandbox.PodUID {
			return nil, fail()
		}
		if namespace := status.Labels["io.kubernetes.pod.namespace"]; namespace != "" && namespace != sandbox.Namespace {
			return nil, fail()
		}
		if name := status.Labels["io.kubernetes.pod.name"]; name != "" && name != sandbox.Name {
			return nil, fail()
		}
		state, ok := containerState(status.State)
		if !ok || !validTimes(status) {
			return nil, fail()
		}
		snapshot.Containers = append(snapshot.Containers, Container{ID: v.Id, SandboxID: v.PodSandboxId, PodUID: sandbox.PodUID, Namespace: sandbox.Namespace, Name: status.Metadata.Name, Attempt: status.Metadata.Attempt, State: state, CreatedAt: strconv.FormatInt(status.CreatedAt, 10), StartedAt: strconv.FormatInt(status.StartedAt, 10), FinishedAt: strconv.FormatInt(status.FinishedAt, 10)})
	}
	// A second unfiltered inventory detects changes across the non-atomic RPCs.
	// Equality is a bracket check, never a linearizable snapshot or lifetime proof.
	nextSandboxes, nextContainers, err := c.inventory(ctx)
	if err != nil || !reflect.DeepEqual(sandboxes, nextSandboxes) || !sameContainers(containers, nextContainers) {
		return nil, fail()
	}
	afterBoot, err := c.BootID()
	end := c.Now()
	if err != nil || afterBoot != boot || ctx.Err() != nil || end.Before(start) || time.Since(elapsedStart) > c.Timeout {
		return nil, fail()
	}
	snapshot.FinishedAt = end.UTC().Format("2006-01-02T15:04:05.000000000Z")
	encoded, err := json.Marshal(snapshot)
	if err != nil || len(encoded) > 8*1024*1024 {
		return nil, fail()
	}
	return snapshot, nil
}
func (c Collector) inventory(ctx context.Context) ([]Sandbox, []*runtime.Container, error) {
	if ctx.Err() != nil {
		return nil, nil, fail()
	}
	rows, err := c.Reader.ListPodSandbox(ctx, nil)
	if err != nil || len(rows) > c.MaxEntries {
		return nil, nil, fail()
	}
	sandboxes := make([]Sandbox, 0, len(rows))
	seen := map[string]bool{}
	for _, s := range rows {
		if s == nil || !runtimeID.MatchString(s.Id) || seen[s.Id] || s.Metadata == nil || !scopeID.MatchString(s.Metadata.Uid) || len(s.Metadata.Namespace) > 63 || !dnsLabel.MatchString(s.Metadata.Namespace) || len(s.Metadata.Name) > 253 || !dnsName.MatchString(s.Metadata.Name) || s.CreatedAt <= 0 {
			return nil, nil, fail()
		}
		for key, expected := range map[string]string{"io.kubernetes.pod.uid": s.Metadata.Uid, "io.kubernetes.pod.namespace": s.Metadata.Namespace, "io.kubernetes.pod.name": s.Metadata.Name} {
			if value := s.Labels[key]; value != "" && value != expected {
				return nil, nil, fail()
			}
		}
		state := ""
		switch s.State {
		case runtime.PodSandboxState_SANDBOX_READY:
			state = "ready"
		case runtime.PodSandboxState_SANDBOX_NOTREADY:
			state = "not_ready"
		default:
			return nil, nil, fail()
		}
		seen[s.Id] = true
		sandboxes = append(sandboxes, Sandbox{ID: s.Id, PodUID: s.Metadata.Uid, Namespace: s.Metadata.Namespace, Name: s.Metadata.Name, State: state, CreatedAt: strconv.FormatInt(s.CreatedAt, 10)})
	}
	if ctx.Err() != nil {
		return nil, nil, fail()
	}
	containers, err := c.Reader.ListContainers(ctx, nil)
	if err != nil || len(containers) > c.MaxEntries || len(containers)+len(sandboxes) > c.MaxEntries {
		return nil, nil, fail()
	}
	seen = map[string]bool{}
	for _, v := range containers {
		if v == nil || !runtimeID.MatchString(v.Id) || !runtimeID.MatchString(v.PodSandboxId) || seen[v.Id] || v.Metadata == nil || len(v.Metadata.Name) > 63 || !dnsLabel.MatchString(v.Metadata.Name) || v.CreatedAt <= 0 {
			return nil, nil, fail()
		}
		if _, ok := containerState(v.State); !ok {
			return nil, nil, fail()
		}
		sandboxFound := false
		for _, sandbox := range sandboxes {
			if sandbox.ID != v.PodSandboxId {
				continue
			}
			sandboxFound = true
			for key, expected := range map[string]string{"io.kubernetes.pod.uid": sandbox.PodUID, "io.kubernetes.pod.namespace": sandbox.Namespace, "io.kubernetes.pod.name": sandbox.Name} {
				if value := v.Labels[key]; value != "" && value != expected {
					return nil, nil, fail()
				}
			}
			break
		}
		if !sandboxFound {
			return nil, nil, fail()
		}
		seen[v.Id] = true
	}
	sort.Slice(sandboxes, func(i, j int) bool { return sandboxes[i].ID < sandboxes[j].ID })
	sort.Slice(containers, func(i, j int) bool { return containers[i].Id < containers[j].Id })
	return sandboxes, containers, nil
}
func sameContainers(a, b []*runtime.Container) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		v, w := a[i], b[i]
		if v.Id != w.Id || v.PodSandboxId != w.PodSandboxId || v.State != w.State || v.CreatedAt != w.CreatedAt || v.Metadata.Name != w.Metadata.Name || v.Metadata.Attempt != w.Metadata.Attempt {
			return false
		}
		for _, key := range []string{"io.kubernetes.pod.uid", "io.kubernetes.pod.namespace", "io.kubernetes.pod.name"} {
			if v.Labels[key] != w.Labels[key] {
				return false
			}
		}
	}
	return true
}
func containerState(v runtime.ContainerState) (string, bool) {
	switch v {
	case runtime.ContainerState_CONTAINER_CREATED:
		return "created", true
	case runtime.ContainerState_CONTAINER_RUNNING:
		return "running", true
	case runtime.ContainerState_CONTAINER_EXITED:
		return "exited", true
	default:
		return "", false
	}
}
func validTimes(s *runtime.ContainerStatus) bool {
	if s.CreatedAt <= 0 || s.StartedAt < 0 || s.FinishedAt < 0 {
		return false
	}
	switch s.State {
	case runtime.ContainerState_CONTAINER_CREATED:
		return s.StartedAt == 0 && s.FinishedAt == 0
	case runtime.ContainerState_CONTAINER_RUNNING:
		return s.StartedAt >= s.CreatedAt && s.FinishedAt == 0
	case runtime.ContainerState_CONTAINER_EXITED:
		return s.FinishedAt >= s.CreatedAt && (s.StartedAt == 0 || s.StartedAt >= s.CreatedAt && s.FinishedAt >= s.StartedAt)
	default:
		return false
	}
}

// Connect permits only a local Unix endpoint. Mount access remains privileged:
// the upstream socket itself exposes mutation methods outside this interface.
func Connect(ctx context.Context, endpoint string, timeout time.Duration) (Reader, error) {
	if !strings.HasPrefix(endpoint, "unix://") || timeout <= 0 || timeout > 30*time.Second {
		return nil, errors.New("node_runtime_connection_failed")
	}
	path := strings.TrimPrefix(endpoint, "unix://")
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsAny(path, "?\\#\n\r") {
		return nil, errors.New("node_runtime_connection_failed")
	}
	service, err := cri.NewRemoteRuntimeService(klog.NewContext(ctx, logr.Discard()), endpoint, timeout, nil, false)
	if err != nil {
		return nil, errors.New("node_runtime_connection_failed")
	}
	return readAdapter{service}, nil
}

// Do not return the upstream RuntimeService dynamic type: it exposes mutations.
type readAdapter struct{ reader Reader }

func (r readAdapter) ListPodSandbox(ctx context.Context, f *runtime.PodSandboxFilter) ([]*runtime.PodSandbox, error) {
	return r.reader.ListPodSandbox(ctx, f)
}
func (r readAdapter) ListContainers(ctx context.Context, f *runtime.ContainerFilter) ([]*runtime.Container, error) {
	return r.reader.ListContainers(ctx, f)
}
func (r readAdapter) ContainerStatus(ctx context.Context, id string, v bool) (*runtime.ContainerStatusResponse, error) {
	return r.reader.ContainerStatus(ctx, id, v)
}
