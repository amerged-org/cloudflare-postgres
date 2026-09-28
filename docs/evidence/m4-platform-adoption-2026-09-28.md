# M4 platform adoption checkpoint — 2026-09-28

Status: **partial live adoption on the disposable single-node lab**. Flux now owns the existing Cilium/OpenEBS Helm releases and reconciles their public configuration. The manually installed cert-manager, CloudNativePG, and Barman components remain outside that adoption. This checkpoint does not prove a fresh full installation, unattended server provisioning, upgrades, recovery, or production isolation. It contains no provider credentials, account or instance IDs, network addresses, generated machine configurations, or customer material.

## Revision and ownership

The live Git source and Kustomization use exact reviewed revision `8dc14f8e9e9b65e9a7853ce9cd33ebede6a10bb2` through the [existing-Helm overlay](../../infra/platform/overlays/existing-helm/kustomization.yaml). Both resources reported Ready for their current generation at that revision. Their private installation configuration remains outside this repository.

Flux v2.9.5 was installed with four Ready controllers: source-controller, kustomize-controller, helm-controller, and notification-controller. Its ownership is limited to platform releases/configuration; it does not upgrade Talos or Kubernetes, create customer environments, or own PostgreSQL instance lifecycle.

| HelmRelease | Verified state | Ownership boundary |
| --- | --- | --- |
| Cilium | Ready; chart `1.20.2+a7c12d330dd9`, app `1.20.2` | Existing Helm release adopted through the pinned OCI chart source. |
| OpenEBS | Ready; chart/app `4.6.1` | Existing Helm release adopted with only LocalPV LVM enabled. |
| cert-manager | `suspend: true` | Existing manually installed component was not adopted. |
| CloudNativePG | `suspend: true` | Existing manually installed operator was not adopted. |
| Barman Cloud plugin | `suspend: true` | Existing manually installed plugin was not adopted. |

Parsed user-supplied Helm values read after adoption matched the public [Cilium values](../../infra/platform/base/values/cilium.yaml) and [OpenEBS values](../../infra/platform/base/values/openebs.yaml). The OpenEBS system namespace retained privileged Pod Security with enforcement version `v1.36` for its storage driver. That grant is not a tenant namespace policy or a production isolation guarantee.

## Preserved lab health and SQL

After adoption, the Talos/Kubernetes node reported Ready with no MemoryPressure, DiskPressure, or PIDPressure. The manually created CNPG Cluster had one current, owned Running/Ready PostgreSQL Pod. SQL readback preserved both existing markers:

- PostgreSQL-side marker `pgcf_m1_smoke`: `initial-sql`.
- Application database marker `pgcf_native_smoke`: `native-tls`.

These checks extend the [M1 lab evidence](m1-2026-09-28.md); they do not turn that manual Cluster into an API-managed environment, demonstrate database recovery, or establish failover. The control API's lab admission remains closed as recorded in the [M3 execution checkpoint](m3-environment-execution-2026-09-28.md).

## Bounded configuration drift probe

One nonsemantic comment was appended to the Flux-owned `pgcf-openebs-values` ConfigMap's `values.yaml`. A forced Kustomization reconciliation restored the exact original public file bytes, and the OpenEBS HelmRelease remained Ready.

No actual Helm setting changed. This proves restoration of that ConfigMap content under the pinned Git/Kustomization authority; it does not prove an upgrade, Helm rollback, recovery after node loss, or repair of arbitrary workload drift. No runtime test suite or broad gate was rerun for this documentation update.

## Remaining acceptance gates

1. Qualify a fresh full platform installation independently of the existing manually installed lab components. Any later cert-manager/CNPG/Barman adoption requires a separately reviewed ownership migration; merely unsuspending those releases is insufficient.
2. Prove staged platform, Talos/Kubernetes, and PostgreSQL maintenance with replication/quorum/capacity checks, bounded interruption, and distinct failure recovery procedures.
3. Prove R2 base backups, WAL continuity, independent restore/PITR, retention, and restore onto fresh infrastructure. SQL marker persistence is not backup evidence.
4. Qualify tenant isolation, disk-full containment, source-secret/admission boundaries, operational monitoring, and documented service/capacity limits before untrusted production use.

The [platform operator guide](../../infra/platform/README.md) describes the supported adoption path. [PLAN.md](../../PLAN.md) retains the complete v1 scope; M4 and M8 remain incomplete.
