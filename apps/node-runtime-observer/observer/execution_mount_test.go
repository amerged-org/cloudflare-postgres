// SPDX-License-Identifier: Apache-2.0
package observer

import (
	"path/filepath"
	"testing"

	runtime "k8s.io/cri-api/pkg/apis/runtime/v1"
)

func TestExecutionMountBindsCurrentContainerAndRefusesForeignMount(t *testing.T) {
	sandbox, container, status := fixture()
	sandbox.State = runtime.PodSandboxState_SANDBOX_READY
	sandbox.Metadata.Name = "database.prod-1"
	root := "/var/lib/kubelet"
	projection := ExecutionMountProjection{PodUID: podUID, Namespace: "tenant-a", PodName: "database.prod-1", ContainerName: "postgres", ContainerID: containerID, Attempt: 2,
		VolumeName: "pgcf-execution-ipc-postgres", ContainerPath: "/pgcf/ipc/postgres", EmptyDir: true}
	path := filepath.Join(root, "pods", podUID, "volumes", "kubernetes.io~empty-dir", projection.VolumeName)
	status.Mounts = []*runtime.Mount{{ContainerPath: projection.ContainerPath, HostPath: path, Propagation: runtime.MountPropagation_PROPAGATION_PRIVATE}}
	location, err := SelectExecutionMount(sandbox, container, status, projection, root)
	if err != nil {
		t.Fatalf("actual current runtime mount must be selectable: %v", err)
	}
	if location.hostPath != path || location.podUID != podUID || location.containerID != containerID || location.attempt != 2 {
		t.Fatal("derived location lost original runtime custody")
	}
	status.Mounts[0].HostPath = filepath.Join(root, "pods", "33333333-3333-4333-8333-333333333333", "volumes", "kubernetes.io~empty-dir", projection.VolumeName)
	if _, err := SelectExecutionMount(sandbox, container, status, projection, root); err == nil {
		t.Fatal("foreign Pod volume cannot become a delivery location")
	}
}
