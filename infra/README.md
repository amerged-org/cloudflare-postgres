# Regional infrastructure

Recipes for the Contabo side of a region. They contain no provider credentials, node addresses,
generated machine configurations, kubeconfigs, database passwords or backup keys. Keep those in
ignored local state or a private deployment repository.

| Directory | Contents |
| --- | --- |
| [talos/](talos/README.md) | Talos patches and the Contabo rescue install path for a node |
| [platform/](platform/README.md) | Pinned Flux baseline: Cilium, OpenEBS LocalPV LVM, cert-manager, CloudNativePG, Barman Cloud plugin |
| [backups/](backups/README.md) | Reference CNPG/Barman resources for R2 backups, full restore and PITR |

Ownership:

- **Flux** owns platform releases.
- **The regional agent** (see [PLAN.md](../PLAN.md)) owns per-database namespaces and CNPG
  resources.
- **CNPG** owns PostgreSQL instances.
- **Talos** owns host and Kubernetes upgrades.

These recipes ran on a single-node lab. The agreed initial deployment is two EU VPS (one
control-plane/worker and one worker) and one US control-plane/worker VPS, with customer databases
on every node after reserving system and platform resources. Node loss is recovered from R2.
Unattended worker join and new-region control-plane/worker bootstrap arrive in Phase 3;
production recovery, upgrades and tenant-isolation acceptance arrive in Phase 4.
