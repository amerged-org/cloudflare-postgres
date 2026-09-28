# Regional platform releases

This directory contains the generic platform release baseline for a fresh Talos **1.14.1** / Kubernetes **1.36.3** cluster. It supplies Cilium **1.20.2**, OpenEBS **4.6.1** with only LocalPV LVM **1.10.1**, cert-manager **v1.21.2**, CloudNativePG chart **0.29.1** / operator **1.30.1**, and Barman Cloud plugin chart **0.8.0** / plugin **v0.15.0**. Flux **v2.9.5** reconciles these components; it does not upgrade Talos or Kubernetes.

[versions.lock.json](versions.lock.json) records the official sources, checked chart/app mappings, OCI manifest digests, archive checksums, and rendered image references. The four OCI chart sources are pinned by digest. OpenEBS uses its [documented HTTP Helm repository](https://openebs.io/docs/main/quickstart-guide/installation): its version is fixed, and its downloaded archive matched the recorded repository-index checksum. Flux still follows the current HTTP index; the lock file is not a historical digest enforcement mechanism for that source. Images retain the exact references shipped by the pinned charts, including Cilium's digest defaults; full container signature verification and digest overrides for other images remain a release gate.

The [last recorded partial-adoption checkpoint](../../docs/evidence/m4-platform-adoption-2026-09-28.md) verifies Flux v2.9.5 with four Ready controllers, a Ready source/Kustomization pinned to the reviewed commit, and Ready Cilium/OpenEBS HelmReleases matching these values. At that checkpoint, cert-manager, CloudNativePG, and Barman remained suspended and outside Helm ownership. The [subsequent cert-manager checkpoint](../../docs/evidence/m4-cert-manager-adoption-2026-09-28.md) verifies the enumerated same-version handoff, all three current Deployments, the startup check, and preserved CA content/ownership and SQL markers. One nonsemantic values-ConfigMap drift was restored, and the existing SQL markers remained readable. This is a one-node feasibility profile, not evidence of a fresh complete installation, tested upgrades/recovery, production availability, tenant isolation, or safe capacity. See [PLAN.md](../../PLAN.md) and the [infrastructure evidence](../../docs/evidence/m1-2026-09-28.md) for the remaining gates.

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

## Existing installation: enumerated cert-manager handoff

[overlays/existing-helm](overlays/existing-helm/kustomization.yaml) is a separate opt-in path for a cluster that already has Helm-managed **`cilium` in `kube-system`** and **`openebs` in `openebs`**, at the exact chart versions and user-supplied values in this baseline. The overlay makes cert-manager active; promote that revision only after the ownership gate below. CloudNativePG and Barman remain suspended; their manual Deployment names, selectors, service accounts, and certificate-issuer references require separate migration procedures.

Before promotion, read the Cilium/OpenEBS release identities and user-supplied values with `helm list` and `helm get values`. Keep the captured values private and compare parsed YAML with the matching files under `base/values/`; comments and key order may differ, but the values must be equal. Also confirm that `pgcf-lvm` and the namespace policies match the baseline.

For the pinned cert-manager **v1.21.2** handoff, prepare and review an exact private inventory from the locked chart and unchanged [cert-manager values](base/values/cert-manager.yaml). The lab comparison identified **46 existing non-Secret objects** with matching declared specifications, except two chart-added labels on each of three Deployment PodTemplates. Four startup API-check hook objects are new: ServiceAccount, Role, RoleBinding, and Job. Refresh that comparison, existing ownership, metadata-only Helm release-record checks in `cert-manager`, current webhook CA ownership, node capacity, and database health before any transfer. Stop on a conflicting release owner, changed specification, unexpected release record, or failed health check; do not bypass the gate with blanket adoption or replacement.

The reviewed transfer may add only `app.kubernetes.io/managed-by: Helm`, `meta.helm.sh/release-name: cert-manager`, and `meta.helm.sh/release-namespace: cert-manager` to the enumerated objects, using their current resource versions as concurrency guards. It does not change PodTemplates, CRD schemas, issued Secrets, or injected CA bundles. Keep the HelmRelease suspended until these exact ownership changes have been verified. The [release manifest](base/releases/cert-manager.yaml) then uses explicit SSA and `disableTakeOwnership: true` for install and upgrade, so Helm requires correct ownership rather than importing an unrelated existing resource. The upgrade API expresses SSA as the string `enabled`, while install uses a boolean. These fields are supported by the pinned controller's [install path](https://github.com/fluxcd/helm-controller/blob/v1.6.4/internal/action/install.go#L68-L88) and [upgrade path](https://github.com/fluxcd/helm-controller/blob/v1.6.4/internal/action/upgrade.go#L93-L105).

The subsequent same-version chart reconciliation is expected to roll **all three cert-manager Deployments** because it adds `app.kubernetes.io/managed-by` and `helm.sh/chart` to their PodTemplates, and to create the four startup-check hook objects. Verify spare capacity before those rollouts. Do not treat the handoff as a metadata-only operation or infer production availability from this single-node profile.

The actual helm-controller **v1.6.4** embeds [Helm SDK v4.2.4](https://github.com/fluxcd/helm-controller/blob/v1.6.4/go.mod#L41-L46). Its SSA requests use the `helm-controller` field manager and force conflicts on declared fields; replacement remains disabled. The locked chart omits webhook `caBundle`, which the lab's managed fields identify as owned separately by `cert-manager-cainjector`. Helm [copies its adoption Infos](https://github.com/helm/helm/blob/v4.2.4/pkg/action/validate.go#L37-L96), preserving the rendered target, and its [CSA-manager migration](https://github.com/helm/helm/blob/v4.2.4/pkg/kube/client.go#L1094-L1118) selects only its own manager. The [SSA update path](https://github.com/helm/helm/blob/v4.2.4/pkg/kube/client.go#L793-L828) therefore retains that omitted, independently owned CA field. This conclusion follows the pinned source and [Kubernetes field-management semantics](https://kubernetes.io/docs/reference/using-api/server-side-apply/#field-management); confirm preserved CA content/ownership and successful webhook readiness after the actual handoff without publishing certificate bytes.

Use [bootstrap/flux-sync-existing-helm.example.yaml](bootstrap/flux-sync-existing-helm.example.yaml), edited privately with a reviewed commit SHA, only after these gates. The example checks Cilium/OpenEBS/cert-manager; mirror those three health checks in the private sync resource and verify cert-manager's current-generation Ready state and locked chart/app identity explicitly. Keep CNPG/Barman suspended. Simply switching a manually installed fleet to the fresh base is not an ownership migration.

## Existing official CNPG installation

[overlays/existing-manual-cnpg](overlays/existing-manual-cnpg/kustomization.yaml) extends the cert-manager handoff above and activates only CloudNativePG. Barman remains suspended. This is an opt-in migration for the verified **official CNPG 1.30.1 manual layout**, using the unchanged locked chart **0.29.1**. It is not a general importer for arbitrary operators or a replacement for the fresh-installation baseline.

The [compatibility values](overlays/existing-manual-cnpg/values-compatibility.yaml) retain `cnpg-controller-manager`, `cnpg-manager`, both legacy configuration lookups, the existing image/pull policy and upstream monitoring queries. The queries are attributed to the pinned official Apache-2.0 manifest; they must match the existing configuration before promotion. The operator reads ConfigMap then Secret, with Secret keys taking precedence. Both legacy objects were absent in the prepared lab inventory; refresh their metadata-only existence checks and stop for effective-configuration review if either appears.

The [targeted post-renderer](overlays/existing-manual-cnpg/release-compatibility.yaml) preserves the immutable Deployment selector, webhook Service selector and numeric ports, principal ClusterRole/Binding names and role reference. It deletes only the chart's two new generic view/edit roles from the rendered output. Six existing database/publication/subscription editor/viewer roles remain outside Helm ownership. The prepared comparison contains **19 existing non-Secret objects**, including 11 CRDs, and no new identities; literal RBAC permissions are unchanged. Refresh that exact inventory and declared-specification comparison rather than assuming another installation has the same layout.

Before transfer, verify current SQL markers, node health/spare capacity, dependency readiness, metadata-only Helm release-record absence, configuration presence, PKI routing and webhook CA field ownership. Run a server-side dry-run with the actual `helm-controller` manager and confirm omitted, independently owned CA bundles remain intact. Add only the three Helm ownership metadata keys to the enumerated objects, using fresh resource-version guards, and read them back while the HelmRelease is still suspended. The base release requires explicit install/upgrade SSA and disables implicit ownership taking; do not use force replacement or blanket adoption.

Promote [bootstrap/flux-sync-existing-manual-cnpg.example.yaml](bootstrap/flux-sync-existing-manual-cnpg.example.yaml), privately pinned to the reviewed commit, only after those gates pass. Chart Pod metadata and equivalent flag ordering cause **one same-version operator rollout**. Verify the current-generation release and Deployment, endpoint routing, a real admission dry-run, preserved CA content/ownership, PostgreSQL Pod identities/restart counts and SQL markers afterward. The example checks all four active releases. This does not qualify backups, upgrades, customer provisioning or availability of a production fleet.

Do not uninstall the imported release as a generic rollback: it owns operator resources and templated CRDs, whose deletion can remove database custom resources. A Git revert does not undo ownership or restore data. An ownership-only failure before release creation can reverse only the reviewed metadata under new guards; after release creation, stop and inspect release/storage state before a recovery action.

## Verification and promotion

The [CNPG adoption checkpoint](../../docs/evidence/m4-cnpg-adoption-2026-09-28.md) now verifies the compatibility overlay in the existing Dev lab: 19 guarded ownership patches, one same-version activation, current-generation release/Deployment readiness, preserved CA ownership and SQL/Pod state, and successful webhook admission. Four releases are active; Barman remains suspended. This checkpoint supplements the earlier Cilium/OpenEBS and cert-manager evidence; it does not prove a fresh installation or production upgrade/recovery.

All five pinned charts were downloaded from their official sources, their chart/app mappings inspected, and their public values linted and rendered locally against Kubernetes 1.36.3. The OpenEBS render contains only the LVM controller/node workloads and its CSI dependencies; other storage engines and bundled telemetry are disabled. Rendered manifests stay private because upstream templates may generate certificates or keys. No rendered chart output is published here.

The base and selected adoption overlay must build with `kubectl kustomize` before promotion. Compare the parsed compatibility values and post-renderer with the reviewed chart candidate. These offline checks do not prove runtime readiness, CRD upgrade compatibility, Pod Security admission, backup/PITR, drift behavior, or a successful Helm-to-Flux handoff. Prove those in staging before a production rollout. Chart digests establish artifact identity; signature verification, maintenance health gates, storage expansion, and recovery remain separate checks.

Promote a reviewed commit and its changed lock/values through staging. Keep the existing namespace, release, and storage identities stable. Changing `releaseName`, `targetNamespace`, or `storageNamespace` can uninstall/reinstall a release; the [Flux HelmRelease documentation](https://fluxcd.io/flux/components/helm/helmreleases/) defines that behavior. Reverting Git is not a PostgreSQL or OS rollback procedure. Talos/Kubernetes changes belong to explicit lifecycle jobs, and database restore belongs to the separately tested recovery workflow.
