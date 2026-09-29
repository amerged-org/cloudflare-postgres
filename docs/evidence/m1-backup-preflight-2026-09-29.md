# Backup and recovery preflight — 2026-09-29

Status: **prepared, no database backup enabled**. This checkpoint advances the existing M1 backup gate and preserves the stopped Barman Flux handoff. It is not physical-backup, WAL, restore, retention or M1 completion evidence.

## Existing installation and capacity

Bounded read-only observations verify the current CNPG `1.30.1` and manual Barman `0.15.0` Deployments are Ready. The plugin Service has one Ready endpoint and discovery annotations; its server/client Certificates are current-generation Ready. The held Barman HelmRelease remains suspended, and no ownership/Deployment/image-reference repair was attempted.

The manual source database is Ready with one instance and a Bound 5-GiB volume. Both existing SQL marker counts remain one. No Cluster backup plugin/configuration, ObjectStore, Backup or database initialization/recovery Job is present. Plugin discovery metadata and Certificate readiness do not prove an actual CNPG-I mTLS handshake or working sidecar.

A separate read of the existing `SIDECAR_IMAGE` configuration retained only its public image reference, `ghcr.io/cloudnative-pg/plugin-barman-cloud-sidecar:v0.15.0`; no credential value or operator configuration was changed. Registry metadata confirms OCI index `sha256:06c78deca670525daa35fb1e5323159092785d11cf87b86217bdd5c679a41a84` and a Linux amd64 manifest `sha256:7b3069c61e5678a2fd05dd937ef47e0337bfbac1c05f1e1051901b9a7d54b391`. No image was pulled or run by this observation. The future database sidecar's actual runtime digest still requires readback; a matching tag alone is insufficient.

The LVM node inventory reports 83,452 MiB free from 98,300 MiB total, four logical volumes and no missing physical volume. Two additional 5-GiB restore targets fit this storage observation. Current scheduled requests are 1,555 millicores and 3,034 MiB against approximately 3,950 millicores and 7,312 MiB allocatable. Two 250-millicore/512-MiB restore requests plus three assumed 100-millicore/128-MiB sidecars fit those request totals.

Existing declared CPU/RAM limits are already oversubscribed. This observation does not qualify simultaneous peak load, backup memory use, growth, replica failure or autoscaling. Perform bounded sequential restores and recheck actual pressure before each operation.

## Prepared ordinary database configuration

The generic [backup/recovery examples](../../infra/backups/README.md) use normal CNPG/Barman database resources with private Secret references. They keep R2 region `auto`, the EU-jurisdiction endpoint, independent source/target archive prefixes and server identities, and the nonempty-WAL guard. Initial retention remains omitted; a same-day run cannot prove real expiration.

The existing unchanged manual plugin can support this database qualification independently of a Helm ownership migration. Enabling it on the source Cluster adds a sidecar and may replace the database Pod. That future operation requires fresh UID/resourceVersion guards and preservation of the source/volume/SQL identities. A plugin installation failure does not authorize a new attempt at the separately stopped handoff.

Private run-bound ObjectStore, Backup and full-restore configurations were generated from the public examples using the actual compatible image and StorageClass. All three were accepted by the installed API through server dry-run. No resource, Pod, Secret, backup object or restore data was created. These checks qualify API shape only; they do not establish sidecar authentication, upload, archive continuity or recovery.

## Dedicated R2 access — issued and qualified

The initial preflight prepared, but did not issue, a single-bucket credential.
The user subsequently confirmed issuance and then explicitly requested permanent
validity. Cloudflare now reports `pgcf-m1-eu-backups-20260929` as active without
an expiry, with Object Read & Write limited to `pgcf-m1-eu-backups` in the EU.
Its keys were privately captured and stored in the ignored mode-0600
`.env.local`; unrelated configuration lines were preserved. Other credentials
are not used for PostgreSQL backup access.

One bounded R2 access check passed list, put, head and exact get/readback in
3.426 seconds through the EU endpoint with region `auto`. It retained a unique
nonsecret test object under a qualification prefix. These are R2's
S3-compatible API operations; no Amazon storage was provisioned. This proves
object access, not a PostgreSQL backup, WAL continuity or PITR. The credential
is permanent at the user's request, so operator-managed rotation remains part
of the installation responsibilities.

## Fresh source checks and held activation

Twelve current read-only Kubernetes observations confirm CNPG 1.30.1 and the
unchanged manual Barman 0.15.0 current-generation Ready, ready plugin
certificates/discovery endpoint, one healthy source instance and no
Backup/ObjectStore/recovery Job. The source Cluster specification and
Cluster/PVC/PV identities match the prepared baseline; both SQL marker counts
are still one. Node pressure conditions are false. Requests are approximately
1,705 millicores and 3,162 MiB; declared limits remain oversubscribed.

Current OpenEBS CSI inventory reports 78,332 MiB free from 98,300 MiB and five
Ready LVMVolumes, with a current-generation Ready node agent. Its LVMNode
contains no explicit heartbeat timestamp; this is CSI inventory evidence, not
an independently fresh physical `vgs` read. The separate Talos observer stopped
after two preparation corrections and was not retried.

Private Secret/ObjectStore server previews pass. The source Cluster preview
was safely held twice because admission adds a field outside the original
exact expected plugin object. A bounded read-only diagnostic establishes the
sole difference as `spec.plugins[0].enabled = true`, the documented CNPG 1.30.1
default. The proposed correction explicitly includes that field without
loosening the full-spec/UID/resource-version guards. One additional activation
attempt awaits its specific bounded-test exception. No source patch, Secret,
ObjectStore, Backup or restore has been persisted by this workflow.

## Next operational evidence

After the held source activation is explicitly resumed, enable the guarded
source configuration and observe the same named Backup across uncertain
outcomes. Require completed backup metadata plus matching remote catalog/objects
and WAL covering separately committed markers. Validate a fresh full restore
and a distinct PITR target through TLS SQL, including exclusion of the
post-target marker and target archiving under its own identity. Keep source
data and archives until verified recovery.

Retention/deletion, recovery after original source removal, interruption/resumption, recovery onto fresh infrastructure and production topology remain separate gates. `.env.local` and private operator/credential state remain ignored and owner-readable; no private material accompanies these public examples.
