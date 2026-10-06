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

The approved deployment retains the existing EU control/relay VPS, excludes it from new customer
database placement, and adds one EU customer worker and one US control-plane/customer VPS.
The two new customer servers require Cloud VPS 8 with 8 vCPU, 24 GB RAM and 150 GB NVMe.
Keep the old EU2 worker until replacement readiness and verified R2 recovery permit its removal.
System and platform resources remain reserved; node loss is recovered from R2.

The programmed bootstrap owns worker join and new-region platform installation. These recipes
also document the earlier manual installation and recovery path. Software checks do not establish
fresh-node acceptance; see [the operator installation runbook](../docs/operations/operator-installation.md)
and [PLAN.md](../PLAN.md) for the outstanding live installation and recovery checks.
