// SPDX-License-Identifier: Apache-2.0
package observer

import (
	"path/filepath"
	"strings"

	runtime "k8s.io/cri-api/pkg/apis/runtime/v1"
)

// These identities come from the authenticated Kubernetes/installation lookup,
// not from a container's delivery request. Host paths remain node-local.
type ExecutionMountProjection struct {
	PodUID        string
	Namespace     string
	PodName       string
	ContainerName string
	ContainerID   string
	Attempt       uint32
	VolumeName    string
	ContainerPath string
	EmptyDir      bool
	SubPath       string
	SubPathExpr   string
}
type ExecutionMountLocation struct {
	hostPath    string
	containerID string
	podUID      string
	attempt     uint32
}

// SelectExecutionMount performs node-local recipe/CRI correlation only. The
// delivery agent must separately pin no-follow filesystem and current peer
// identities before and after access; this function grants no write authority.
func SelectExecutionMount(sandbox *runtime.PodSandbox, container *runtime.Container, status *runtime.ContainerStatus, pod ExecutionMountProjection, root string) (ExecutionMountLocation, error) {
	if sandbox == nil || sandbox.Metadata == nil || container == nil || container.Metadata == nil || status == nil || status.Metadata == nil ||
		!uuid.MatchString(pod.PodUID) || !runtimeID.MatchString(pod.ContainerID) ||
		len(pod.Namespace) > 63 || !dnsLabel.MatchString(pod.Namespace) || len(pod.PodName) > 253 || !dnsName.MatchString(pod.PodName) ||
		len(pod.ContainerName) > 63 || !dnsLabel.MatchString(pod.ContainerName) || len(pod.VolumeName) > 63 ||
		!dnsLabel.MatchString(pod.VolumeName) || !pod.EmptyDir || pod.SubPath != "" || pod.SubPathExpr != "" ||
		!filepath.IsAbs(root) || filepath.Clean(root) != root || root == "/" ||
		!filepath.IsAbs(pod.ContainerPath) || filepath.Clean(pod.ContainerPath) != pod.ContainerPath || pod.ContainerPath == "/" ||
		sandbox.Metadata.Uid != pod.PodUID || sandbox.Metadata.Namespace != pod.Namespace || sandbox.Metadata.Name != pod.PodName ||
		sandbox.State != runtime.PodSandboxState_SANDBOX_READY || sandbox.CreatedAt <= 0 ||
		!runtimeID.MatchString(sandbox.Id) || container.PodSandboxId != sandbox.Id || container.Id != pod.ContainerID ||
		container.Metadata.Name != pod.ContainerName || container.Metadata.Attempt != pod.Attempt || container.State != runtime.ContainerState_CONTAINER_RUNNING ||
		container.CreatedAt != status.CreatedAt || container.State != status.State ||
		status.Id != pod.ContainerID || status.Metadata.Name != pod.ContainerName || status.Metadata.Attempt != pod.Attempt ||
		status.State != runtime.ContainerState_CONTAINER_RUNNING || !validTimes(status) || len(status.Mounts) > 64 {
		return ExecutionMountLocation{}, fail()
	}
	for key, expected := range map[string]string{"io.kubernetes.pod.uid": pod.PodUID, "io.kubernetes.pod.namespace": pod.Namespace, "io.kubernetes.pod.name": pod.PodName} {
		if value := sandbox.Labels[key]; value != "" && value != expected {
			return ExecutionMountLocation{}, fail()
		}
		if value := container.Labels[key]; value != "" && value != expected {
			return ExecutionMountLocation{}, fail()
		}
		if value := status.Labels[key]; value != "" && value != expected {
			return ExecutionMountLocation{}, fail()
		}
	}
	expectedHost := filepath.Join(root, "pods", pod.PodUID, "volumes", "kubernetes.io~empty-dir", pod.VolumeName)
	var selected *runtime.Mount
	for _, mount := range status.Mounts {
		if mount == nil || !filepath.IsAbs(mount.ContainerPath) || filepath.Clean(mount.ContainerPath) != mount.ContainerPath {
			return ExecutionMountLocation{}, fail()
		}
		if mount.ContainerPath != pod.ContainerPath {
			if mount.ContainerPath == "/" || strings.HasPrefix(pod.ContainerPath, mount.ContainerPath+"/") || strings.HasPrefix(mount.ContainerPath, pod.ContainerPath+"/") {
				return ExecutionMountLocation{}, fail()
			}
			continue
		}
		if selected != nil || mount.HostPath != expectedHost || filepath.Clean(mount.HostPath) != mount.HostPath || mount.Readonly ||
			mount.RecursiveReadOnly || mount.SelinuxRelabel || mount.Propagation != runtime.MountPropagation_PROPAGATION_PRIVATE ||
			len(mount.UidMappings) != 0 || len(mount.GidMappings) != 0 || mount.Image != nil || mount.ImageSubPath != "" {
			return ExecutionMountLocation{}, fail()
		}
		selected = mount
	}
	if selected == nil {
		return ExecutionMountLocation{}, fail()
	}
	return ExecutionMountLocation{hostPath: selected.HostPath, containerID: pod.ContainerID, podUID: pod.PodUID, attempt: pod.Attempt}, nil
}
