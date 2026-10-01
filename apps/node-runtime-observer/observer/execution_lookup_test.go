// SPDX-License-Identifier: Apache-2.0
package observer

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	runtime "k8s.io/cri-api/pkg/apis/runtime/v1"
)

func TestExecutionMountLookupBracketsRunningAttempt(t *testing.T) {
	sandbox, container, status := fixture()
	sandbox.State = runtime.PodSandboxState_SANDBOX_READY
	projection := ExecutionMountProjection{PodUID: podUID, Namespace: "tenant-a", PodName: "database-1", ContainerName: "postgres", ContainerID: containerID, Attempt: 2,
		VolumeName: "pgcf-execution-ipc-postgres", ContainerPath: "/pgcf/ipc/postgres", EmptyDir: true}
	path := filepath.Join("/var/lib/kubelet", "pods", podUID, "volumes", "kubernetes.io~empty-dir", projection.VolumeName)
	status.Mounts = []*runtime.Mount{{ContainerPath: projection.ContainerPath, HostPath: path}}
	reader := &fakeReader{sandboxes: []*runtime.PodSandbox{sandbox}, containers: []*runtime.Container{container}, status: status}
	resolver := ExecutionMountResolver{Reader: reader, BootID: func() (string, error) { return bootID, nil }, ExpectedBootID: bootID, Timeout: time.Second, MaxEntries: 64}
	location, err := resolver.Resolve(context.Background(), projection, "/var/lib/kubelet")
	if err != nil || location.hostPath != path || reader.lists != 2 {
		t.Fatalf("stable actual attempt requires two fresh inventories: %v", err)
	}
	reader.changeList = true
	reader.lists = 0
	if _, err := resolver.Resolve(context.Background(), projection, "/var/lib/kubelet"); err == nil {
		t.Fatal("attempt disappearance between reads cannot retain a mount")
	}
}
