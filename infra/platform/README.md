# Regional platform releases

This directory contains the generic platform release baseline for a fresh Talos **1.14.1** / Kubernetes **1.36.3** cluster. It supplies Cilium **1.20.2**, OpenEBS **4.6.1** with only LocalPV LVM **1.10.1**, cert-manager **v1.21.2**, CloudNativePG chart **0.29.1** / operator **1.30.1**, and Barman Cloud plugin chart **0.8.0** / plugin **v0.15.0**. Flux **v2.9.5** reconciles these components; it does not upgrade Talos or Kubernetes.

[versions.lock.json](versions.lock.json) records the official sources, checked chart/app mappings, OCI manifest digests, archive checksums, and rendered image references. The four OCI chart sources are pinned by digest. OpenEBS uses its [documented HTTP Helm repository](https://openebs.io/docs/main/quickstart-guide/installation): its version is fixed, and its downloaded archive matched the recorded repository-index checksum. Flux still follows the current HTTP index; the lock file is not a historical digest enforcement mechanism for that source. Images retain the exact references shipped by the pinned charts, including Cilium's digest defaults; full container signature verification and digest overrides for other images remain a release gate.

These are installation assets, not evidence that Flux or the complete stack has been installed. The values use a one-node feasibility profile. They do not establish production availability, tenant isolation, backup recovery, or a safe capacity envelope. See [PLAN.md](../../PLAN.md) and the [infrastructure evidence](../../docs/evidence/m1-2026-09-28.md) for the current delivery state.

## Ownership and prerequisites

Flux owns the component releases and their configuration. The regional controller owns customer namespaces and CNPG resources; CNPG owns database instances. This directory creates no customer database, role, backup destination, provider credential, certificate issuer, or public endpoint.

Prepare the cluster before installation:

- Apply [the Talos 1.14 Cilium patch](../talos/cilium.patch.yaml) with `--config-patch-control-plane`: it deletes `KubeFlannelCNIConfig`, disables `KubeProxyConfig`, and configures KubePrism on `localhost:7445`. The [upstream Cilium guidance](https://docs.cilium.io/en/stable/installation/k8s-install-helm/#talos-linux) explains the required capabilities and datapath settings; its older Talos configuration field names are not used by this 1.14 recipe. Existing Talos cgroup/BPF mounts are reused; `SYS_MODULE` is excluded.
- Verify the built-in Talos LVM utilities and `dm_snapshot` support, then provision the dedicated volume group named **`pgcf`** through declarative `RawVolumeConfig` and `LVMVolumeGroupConfig`. The [Talos storage patch](../talos/single-disk-lab-storage.patch.yaml) records the measured lab allocation; review its sizes for the target disk before applying it. No extra LVM system extension is required by this recipe. The platform manifests never partition disks or create that volume group. A similarly named group is deliberately not eligible: the StorageClass uses `vgpattern: "^pgcf$"`.
- Keep authenticated Talos and Kubernetes operator configurations outside Git. Select the intended cluster explicitly and ensure it has schedulable capacity for platform Pods. Do not apply this baseline to a running database fleet as an unattended upgrade.
- Install the pinned Flux CLI from its [official release](https://github.com/fluxcd/flux2/releases/tag/v2.9.5), verify its published checksum, and run `flux check --pre` before installation.

All HelmRelease objects and value ConfigMaps live in `flux-system`. Helm release identities are explicit:

| Release               | Target namespace | Helm storage namespace | Ready dependencies                                |
| --------------------- | ---------------- | ---------------------- | ------------------------------------------------- |
| `cilium`              | `kube-system`    | `kube-system`          | None; first installed by the CNI bootstrap below. |
| `openebs`             | `openebs`        | `openebs`              | `cilium`                                          |
| `cert-manager`        | `cert-manager`   | `cert-manager`         | `cilium`                                          |
| `cloudnative-pg`      | `cnpg-system`    | `cnpg-system`          | `cilium`                                          |
| `plugin-barman-cloud` | `cnpg-system`    | `cnpg-system`          | `cloudnative-pg`, `cert-manager`                  |

Only the `openebs` namespace is explicitly granted privileged Pod Security, for the storage node driver. Cilium uses the cluster's existing `kube-system` policy. No tenant namespace inherits a privileged policy from these files. Platform namespaces, HelmReleases, and the StorageClass are protected from incidental Flux pruning; an explicit deletion or Helm uninstall remains an operator action with separate consequences.

`pgcf-lvm` uses thick LVM volumes, `WaitForFirstConsumer`, ext4, expansion, and **`Retain`**. It is not a default StorageClass. Each customer volume must select it explicitly. Retention means that deleting a PVC does not free or erase its retained PV automatically; tenant deletion needs a separate authorized storage lifecycle. Local volumes do not survive loss of their node without replication or recovery.

## Fresh installation

Flux needs functioning Pod networking before it can run the Helm controller that manages networking. Bootstrap Cilium once with the pinned chart and the same release/target/storage identity used by Flux. From the repository root, with the intended private kubeconfig already selected:

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

Stop if either command fails. Do not retry by forcing Helm resource adoption or disabling health checks. The initial Cilium install is already a Helm release; Flux subsequently reconciles that known release instead of importing unrelated, manually applied Kubernetes resources. The remaining components are installed by Flux in dependency order. Barman requires a working cert-manager installation, as documented by its [official chart](https://github.com/cloudnative-pg/charts/blob/plugin-barman-cloud-v0.8.0/charts/plugin-barman-cloud/README.md).

Copy [bootstrap/flux-sync.example.yaml](bootstrap/flux-sync.example.yaml) into private installation configuration and replace `REPLACE_WITH_REVIEWED_COMMIT_SHA` with the full SHA of the reviewed repository commit. Use an adopter-owned repository URL if maintaining an installation fork. The examples are excluded from the platform Kustomize build; no placeholder source is activated automatically.

Review the offline output with `kubectl kustomize infra/platform`, then apply the edited private sync file to the selected cluster. Check `flux get sources all --namespace flux-system`, `flux get helmreleases --namespace flux-system`, and `flux get kustomizations --namespace flux-system`. A release is usable only when its current generation is Ready and its deployed chart identity agrees with the lock. The sync resource checks all five releases. Release actions are bounded by five-minute timeouts and have zero automatic remediation retries; failed installations or upgrades require diagnosis before another attempt.

## Existing Helm releases: explicit partial adoption

[overlays/existing-helm](overlays/existing-helm/kustomization.yaml) is a separate opt-in path for a cluster that already has Helm-managed **`cilium` in `kube-system`** and **`openebs` in `openebs`**, at the exact chart versions and user-supplied values in this baseline. It suspends cert-manager, CloudNativePG, and Barman HelmReleases. It does not import their manually applied resources, change their Helm ownership labels, or reinstall them.

Before enabling the overlay, read the existing release names, namespaces, versions, and user-supplied values with `helm list` and `helm get values`. Keep the captured values private and compare parsed YAML with the matching files under `base/values/`; comments and key order may differ, but the values must be equal. Also confirm that `pgcf-lvm` and the namespace policies match the baseline. Stop on any mismatch and prepare a separately reviewed migration. Do not use `--take-ownership` or relabel operator resources to silence a conflict.

Use [bootstrap/flux-sync-existing-helm.example.yaml](bootstrap/flux-sync-existing-helm.example.yaml), edited privately with a reviewed commit SHA, only after those checks. It points to the overlay and checks readiness of the two active releases. The three suspended releases remain intentionally uninstalled by Flux. Changing them to active requires their own ownership/migration procedure; simply switching this installation to the fresh base is not such a procedure.

## Verification and promotion

All five pinned charts were downloaded from their official sources, their chart/app mappings inspected, and their public values linted and rendered locally against Kubernetes 1.36.3. The OpenEBS render contains only the LVM controller/node workloads and its CSI dependencies; other storage engines and bundled telemetry are disabled. Rendered manifests stay private because upstream templates may generate certificates or keys. No rendered chart output is published here.

The base and partial-adoption overlay must build with `kubectl kustomize` before promotion. These offline checks do not prove runtime readiness, CRD upgrade compatibility, Pod Security admission, backup/PITR, drift behavior, or a successful Helm-to-Flux handoff. Prove those in staging before a production rollout. Chart digests establish artifact identity; signature verification, maintenance health gates, storage expansion, and recovery remain separate checks.

Promote a reviewed commit and its changed lock/values through staging. Keep the existing namespace, release, and storage identities stable. Changing `releaseName`, `targetNamespace`, or `storageNamespace` can uninstall/reinstall a release; the [Flux HelmRelease documentation](https://fluxcd.io/flux/components/helm/helmreleases/) defines that behavior. Reverting Git is not a PostgreSQL or OS rollback procedure. Talos/Kubernetes changes belong to explicit lifecycle jobs, and database restore belongs to the separately tested recovery workflow.
