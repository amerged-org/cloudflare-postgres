// SPDX-License-Identifier: Apache-2.0
package observer

import (
	"context"
	"time"

	"github.com/go-logr/logr"
	"google.golang.org/protobuf/proto"
	runtime "k8s.io/cri-api/pkg/apis/runtime/v1"
	"k8s.io/klog/v2"
)

// ExecutionMountResolver uses only node-local runtime reads. The caller owns
// authenticated Pod/Node projection and installation recipe verification.
type ExecutionMountResolver struct {
	Reader         Reader
	BootID         func() (string, error)
	ExpectedBootID string
	Timeout        time.Duration
	MaxEntries     int
}

func (r ExecutionMountResolver) Resolve(ctx context.Context, pod ExecutionMountProjection, root string) (ExecutionMountLocation, error) {
	if ctx == nil || ctx.Err() != nil || r.Reader == nil || r.BootID == nil || !uuid.MatchString(r.ExpectedBootID) ||
		r.Timeout <= 0 || r.Timeout > 30*time.Second || r.MaxEntries < 1 || r.MaxEntries > 4096 {
		return ExecutionMountLocation{}, fail()
	}
	ctx, cancel := context.WithTimeout(klog.NewContext(ctx, logr.Discard()), r.Timeout)
	defer cancel()
	start := time.Now()
	boot, err := r.BootID()
	if err != nil || boot != r.ExpectedBootID || ctx.Err() != nil {
		return ExecutionMountLocation{}, fail()
	}
	sandbox, container, status, err := r.readTarget(ctx, pod)
	if err != nil {
		return ExecutionMountLocation{}, fail()
	}
	location, err := SelectExecutionMount(sandbox, container, status, pod, root)
	if err != nil {
		return ExecutionMountLocation{}, fail()
	}
	// Bracket the non-atomic RPCs. This is no lifetime or filesystem proof;
	// any delivery still needs its own before/after identity and custody checks.
	nextSandbox, nextContainer, nextStatus, err := r.readTarget(ctx, pod)
	if err != nil || !proto.Equal(sandbox, nextSandbox) || !proto.Equal(container, nextContainer) || !proto.Equal(status, nextStatus) {
		return ExecutionMountLocation{}, fail()
	}
	afterBoot, err := r.BootID()
	if err != nil || afterBoot != boot || ctx.Err() != nil || time.Since(start) > r.Timeout {
		return ExecutionMountLocation{}, fail()
	}
	return location, nil
}

func (r ExecutionMountResolver) readTarget(ctx context.Context, pod ExecutionMountProjection) (*runtime.PodSandbox, *runtime.Container, *runtime.ContainerStatus, error) {
	if ctx.Err() != nil {
		return nil, nil, nil, fail()
	}
	sandboxes, err := r.Reader.ListPodSandbox(ctx, nil)
	if err != nil || len(sandboxes) > r.MaxEntries || ctx.Err() != nil {
		return nil, nil, nil, fail()
	}
	var sandbox *runtime.PodSandbox
	for _, current := range sandboxes {
		if current == nil || current.Metadata == nil {
			return nil, nil, nil, fail()
		}
		if current.Metadata.Uid == pod.PodUID && current.State == runtime.PodSandboxState_SANDBOX_READY {
			if sandbox != nil {
				return nil, nil, nil, fail()
			}
			sandbox = proto.Clone(current).(*runtime.PodSandbox)
		}
	}
	if sandbox == nil {
		return nil, nil, nil, fail()
	}
	containers, err := r.Reader.ListContainers(ctx, nil)
	if err != nil || len(sandboxes)+len(containers) > r.MaxEntries || ctx.Err() != nil {
		return nil, nil, nil, fail()
	}
	var container *runtime.Container
	for _, current := range containers {
		if current == nil || current.Metadata == nil {
			return nil, nil, nil, fail()
		}
		if current.PodSandboxId == sandbox.Id && current.Metadata.Name == pod.ContainerName && current.State == runtime.ContainerState_CONTAINER_RUNNING {
			if container != nil || current.Id != pod.ContainerID || current.Metadata.Attempt != pod.Attempt {
				return nil, nil, nil, fail()
			}
			container = proto.Clone(current).(*runtime.Container)
		}
	}
	if container == nil || ctx.Err() != nil {
		return nil, nil, nil, fail()
	}
	response, err := r.Reader.ContainerStatus(ctx, container.Id, false)
	if err != nil || response == nil || response.Status == nil || ctx.Err() != nil {
		return nil, nil, nil, fail()
	}
	return sandbox, container, proto.Clone(response.Status).(*runtime.ContainerStatus), nil
}
