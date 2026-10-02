# Regional platform releases

This directory contains the platform release baseline for a fresh Talos **1.14.1** / Kubernetes
**1.36.3** cluster. It supplies Cilium **1.20.2**, OpenEBS **4.6.1** with only LocalPV LVM
**1.10.1**, cert-manager **v1.21.2**, CloudNativePG chart **0.29.1** / operator **1.30.1**, and the
Barman Cloud plugin chart **0.8.0** / plugin **v0.15.0**. Flux **v2.9.5** reconciles these
components; it does not upgrade Talos or Kubernetes. Phase 1 of [PLAN.md](../../PLAN.md) adds
`cloudflared` and the regional agent/gateway image here.

[versions.lock.json](versions.lock.json) records the official sources, checked chart/app mappings,
OCI manifest digests, archive checksums and rendered image references. The four OCI chart sources
are pinned by digest. OpenEBS uses its
[documented HTTP Helm repository](https://openebs.io/docs/main/quickstart-guide/installation): its
version is fixed and its archive matched the recorded repository-index checksum, but Flux still
follows the current HTTP index. Images keep the exact references shipped by the pinned charts.

These versions ran together in the single-node Contabo lab. A fresh installation from this
directory is part of Phase 0.

## Ownership and prerequisites

Flux owns the component releases and their configuration. The regional agent owns per-database
namespaces and CNPG resources, and CNPG owns the database instances. This directory creates no
database, role, backup destination, provider credential or public endpoint.

Prepare the cluster before installation:

- Apply [the Talos 1.14 Cilium patch](../talos/cilium.patch.yaml) with
  `--config-patch-control-plane`. It deletes `KubeFlannelCNIConfig`, disables `KubeProxyConfig` and
  configures KubePrism on `localhost:7445`. The
  [upstream Cilium guidance](https://docs.cilium.io/en/stable/installation/k8s-install-helm/#talos-linux)
  explains the required capabilities. Existing Talos cgroup/BPF mounts are reused; `SYS_MODULE` is
  excluded.
- Provision the dedicated LVM volume group **`pgcf`** through Talos `RawVolumeConfig` and
  `LVMVolumeGroupConfig`. The [Talos storage patch](../talos/single-disk-lab-storage.patch.yaml)
  records the lab allocation; review its sizes for the target disk. The platform manifests never
  partition disks. The StorageClass matches only `vgpattern: "^pgcf$"`.
- Keep authenticated Talos and Kubernetes configurations outside Git.
- Install the pinned Flux CLI from its
  [official release](https://github.com/fluxcd/flux2/releases/tag/v2.9.5), verify its checksum and
  run `flux check --pre`.

All HelmRelease objects and value ConfigMaps live in `flux-system`:

| Release               | Target namespace | Helm storage namespace | Ready dependencies                                |
| --------------------- | ---------------- | ---------------------- | ------------------------------------------------- |
| `cilium`              | `kube-system`    | `kube-system`          | None; first installed by the CNI bootstrap below. |
| `openebs`             | `openebs`        | `openebs`              | `cilium`                                          |
| `cert-manager`        | `cert-manager`   | `cert-manager`         | `cilium`                                          |
| `cloudnative-pg`      | `cnpg-system`    | `cnpg-system`          | `cilium`                                          |
| `plugin-barman-cloud` | `cnpg-system`    | `cnpg-system`          | `cloudnative-pg`, `cert-manager`                  |

Only the `openebs` namespace gets privileged Pod Security, for the storage node driver. Platform
namespaces, HelmReleases and the StorageClass are protected from incidental Flux pruning.

`pgcf-lvm` uses thick LVM volumes, `WaitForFirstConsumer`, ext4, expansion and **`Retain`**. It is
not the default StorageClass; every database volume selects it explicitly. With `Retain`, deleting
a PVC does not erase its PV. The agent's delete flow must remove the PV explicitly. Local volumes do
not survive the loss of their node; recovery comes from R2.

## Fresh installation

Flux needs Pod networking before it can run the Helm controller that manages networking. Bootstrap
Cilium once with the pinned chart and the same release identity Flux uses. From the repository root,
with the intended private kubeconfig selected:

```sh
helm install cilium \
  oci://quay.io/cilium/charts/cilium@sha256:a7c12d330dd96bfcda3bf057b24be8f36566c34868265f930f776dff6f42d838 \
  --namespace kube-system \
  --values infra/platform/base/values/cilium.yaml \
  --wait --timeout 5m

flux install --version=v2.9.5 \
  --namespace=flux-system \
  --components=source-controller,kustomize-controller,helm-controller,notification-controller
```

Flux then installs the remaining components in dependency order. Barman requires a working
cert-manager, as its
[official chart](https://github.com/cloudnative-pg/charts/blob/plugin-barman-cloud-v0.8.0/charts/plugin-barman-cloud/README.md)
documents.

Copy [bootstrap/flux-sync.example.yaml](bootstrap/flux-sync.example.yaml) into private installation
configuration. Replace `REPLACE_WITH_REVIEWED_COMMIT_SHA` with the full SHA of the commit to deploy,
or point it at an adopter-owned fork. The example is excluded from the Kustomize build.

Check the offline output with `kubectl kustomize infra/platform`, then apply the edited sync file.
Verify with:

- `flux get sources all -n flux-system`
- `flux get helmreleases -n flux-system`
- `flux get kustomizations -n flux-system`

A release is usable when its current generation is Ready and its chart identity matches the lock.
Release actions time out after five minutes and do not retry automatically; diagnose a failure
before trying again.

## Changing versions

Update the lock and values together, render with `kubectl kustomize`, and roll out to the lab first.
Keep `releaseName`, `targetNamespace` and `storageNamespace` stable: changing them uninstalls and
reinstalls a release (see the
[Flux HelmRelease documentation](https://fluxcd.io/flux/components/helm/helmreleases/)). Reverting
Git does not roll back PostgreSQL data or the OS. Talos/Kubernetes upgrades and database restores
are separate procedures.
