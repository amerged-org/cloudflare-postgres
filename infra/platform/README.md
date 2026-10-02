# Regional platform releases

This directory contains the platform release baseline for a fresh Talos **1.14.1** / Kubernetes
**1.36.3** cluster. It supplies Cilium **1.20.2**, OpenEBS **4.6.1** with only LocalPV LVM
**1.10.1**, cert-manager **v1.21.2**, CloudNativePG chart **0.29.1** / operator **1.30.1**, and the
Barman Cloud plugin chart **0.8.0** / plugin **v0.15.0**. Flux **v2.9.5** reconciles these
components; it does not upgrade Talos or Kubernetes. The regional components (`cloudflared`, gateway
and agent) are a separate Flux Kustomization in [regional](regional); see
[Regional components](#regional-components).

[versions.lock.json](versions.lock.json) records the official sources, checked chart/app mappings,
OCI manifest digests, archive checksums and rendered image references. The four OCI chart sources
are pinned by digest. OpenEBS uses its
[documented HTTP Helm repository](https://openebs.io/docs/main/quickstart-guide/installation): its
version is fixed and its archive matched the recorded repository-index checksum, but Flux still
follows the current HTTP index. Images keep the exact references shipped by the pinned charts. The
`regional` section lists the cloudflared digest and the regional image reference.

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
a PVC or namespace leaves its PV and the LVM logical volume behind, which leaks disk. The agent's
delete flow therefore patches the database's PV to `persistentVolumeReclaimPolicy: Delete` first,
then deletes the namespace, and reports the database deleted only after the PV and its `LVMVolume`
are gone. Local volumes do not survive the loss of their node; recovery comes from R2.

## Fresh installation

Flux needs Pod networking before it can run the Helm controller that manages networking. Bootstrap
Cilium once with the pinned chart and the same release identity Flux uses. From the repository root,
with the intended private kubeconfig selected:

```sh
helm install cilium \
  oci://quay.io/cilium/charts/cilium@sha256:a7c12d330dd96bfcda3bf057b24be8f36566c34868265f930f776dff6f42d838 \
  --namespace kube-system \
  --values infra/platform/base/values/cilium.yaml \
  --wait --timeout 10m

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
Release actions time out after 15 minutes (Cilium: 10 minutes). Install and upgrade remediation
retry three times except Cilium, whose retry count is zero. Diagnose a failure before trying again.

## Changing versions

Update the lock and values together, render with `kubectl kustomize`, and roll out to the lab first.
Keep `releaseName`, `targetNamespace` and `storageNamespace` stable: changing them uninstalls and
reinstalls a release (see the
[Flux HelmRelease documentation](https://fluxcd.io/flux/components/helm/helmreleases/)). Reverting
Git does not roll back PostgreSQL data or the OS. Talos/Kubernetes upgrades and database restores
are separate procedures.

## Regional components

[regional](regional) holds the workloads that connect a region to Cloudflare, all in namespace
`pgcf-system` (Pod Security `restricted`, created in [base/namespaces.yaml](base/namespaces.yaml)).
It is reconciled by its own Flux Kustomization, so a failure there cannot affect the five platform
releases. [regional/flux-sync.example.yaml](regional/flux-sync.example.yaml) is the template for
private installation configuration; it depends on the `pgcf-platform` Kustomization (CRDs, Cilium)
and is excluded from the build.

| Workload           | Replicas | Role                                                                                                                              |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `pgcf-cloudflared` | 2        | Remotely managed Cloudflare Tunnel. No inbound ports; metrics on localhost. Its public-hostname rule targets the gateway Service. |
| `pgcf-gateway`     | 2        | WebSocket-to-PostgreSQL bridge on port 8080 (`/healthz`, `/readyz`, 45 s termination grace). Service `pgcf-gateway`.              |
| `pgcf-agent`       | 1        | Reconciles desired state into Kubernetes. Strategy `Recreate`, so two agents never overlap.                                       |

Gateway and agent are two commands (`node /app/gateway.mjs`, `node /app/agent.mjs`) of one image
referenced as `pgcf-regional`. `regional/kustomization.yaml` maps it to the GHCR repository with an
`images:` entry; the release commit adds the `digest` once CI has published the image. `cloudflared`
is pinned by digest. No `imagePullPolicy` is set. For Dev, keep a private overlay that references
`regional` and sets a locally imported image and the pull policy, for example:

```yaml
resources:
  - ../../infra/platform/regional # path inside the private checkout
images:
  # The base already rewrote the name, so match the GHCR name, not `pgcf-regional`.
  - name: ghcr.io/amerged-org/pgcf-regional
    newName: pgcf-regional
    newTag: dev-local
patches:
  - target:
      kind: Deployment
      labelSelector: "app.kubernetes.io/name in (pgcf-gateway,pgcf-agent)"
    patch: |
      - op: add
        path: /spec/template/spec/containers/0/imagePullPolicy
        value: Never
```

The pinned `PGCF_POSTGRES_IMAGE` is supplied by ConfigMap `pgcf-regional` and recorded in the
version lock. The agent validates the image digest before reconciling a database. Node capacity
uses `pgcf.io/storage-gib-total`, published from the measured dedicated LVM volume group by the
bootstrap/operator path; Kubernetes ephemeral storage is not database capacity. Missing capacity
is reported as unavailable and cannot admit a placement.

Flux substitutes two variables from a private ConfigMap (`PGCF_REGION_ID` and `PGCF_API_HOST`, the
host name of the API Worker) into ConfigMap `pgcf-regional` and the agent's egress policy.

### Operator-created Secrets

Create these in `pgcf-system` before the Deployments start; they are never committed and
the keys of `pgcf-gateway` and `pgcf-agent` become environment variables of the same name.

| Secret             | Keys                                         | Used by                                                                                                |
| ------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pgcf-cloudflared` | `token`                                      | cloudflared tunnel token (`TUNNEL_TOKEN`).                                                             |
| `pgcf-gateway`     | `PGCF_ROUTE_KEY`                             | Gateway: the region's derived route keyring, JSON `{"active":"<kid>","keys":{"<kid>":"<base64url>"}}`. |
| `pgcf-agent`       | `PGCF_AGENT_KEY`                             | Agent: bearer key for the API Worker.                                                                  |
| `pgcf-backup-s3`   | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | R2 S3 credential; the agent copies it into each database namespace as `archive-credentials`.           |

### Network and access rules

- `default-deny` blocks all ingress and egress in `pgcf-system`; one CiliumNetworkPolicy per
  workload adds the allowed paths. cloudflared may reach the gateway on 8080 and the Cloudflare
  edge on 7844, the gateway accepts traffic from cloudflared only, and may reach the Kubernetes API
  and port 5432 of database Pods in namespaces labelled `pgcf.io/database-id`. The agent reaches the
  Kubernetes API, the API Worker host on 443 and CNPG Pods in labelled database namespaces on
  9187 for real WAL archive metrics; nothing accepts inbound traffic besides the
  gateway. Every policy also allows DNS.
- The agent ClusterRole covers namespaces, Secrets (no list or watch), ResourceQuotas, LimitRanges,
  NetworkPolicies, CiliumNetworkPolicies, CNPG `Cluster`, `ScheduledBackup` and Barman
  `ObjectStore` resources, PersistentVolumes (get, list, patch, delete), `LVMVolume` (read), and
  Nodes and Pods (read). It has no `pods/exec`, no RBAC or workload-controller rights. In
  `pgcf-system` it manages ConfigMaps and reads the Secret `pgcf-backup-s3`; the gateway reads
  ConfigMaps there. Database namespaces are dynamic, so the Secret rules cannot be
  narrowed by name.
