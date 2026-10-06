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
database placement, and retains the already-admitted EU worker as customer EU1 (formerly EU2).
Exactly one new US1 control-plane/customer VPS uses the same V159 / Cloud VPS Plus 4 model:
4 vCPU, 8 GiB RAM and 150 GiB NVMe, purchased through the API for one month. Preserve EU1's
installation, Node identity, data and custody; no new EU worker or EU1 reinstallation is required.
Install and admit US1 before verifying an R2 restore with the EU source preserved. Earlier EU1
loss, deletion and decommissioning kits are withheld. System and platform resources remain
reserved; node loss is recovered from R2.

The programmed bootstrap owns worker join and new-region platform installation. These recipes
also document the earlier manual installation and recovery path. Software checks do not establish
fresh-node acceptance; see [the operator installation runbook](../docs/operations/operator-installation.md)
and [PLAN.md](../PLAN.md) for the outstanding live installation and recovery checks.
