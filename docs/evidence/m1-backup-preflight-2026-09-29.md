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

## R2 access waiting for confirmation

The authenticated browser shows the dedicated `pgcf-m1-eu-backups` bucket in the EU jurisdiction. Its account-token form is prepared for `pgcf-m1-eu-backups-20260929`: Object Read & Write, that bucket only, and a 30-day lifetime. No credential was issued. Existing unrelated account tokens were left untouched and were not used for database backup access.

The Computer Use confirmation policy requires confirmation immediately before creating a new security-sensitive access credential. A specific request was presented at the prepared final action; an accepted question submission is not approval. Until the user confirms, creation and dependent S3 operations remain pending. This is a narrow credential gate, not authorization to widen account access or a claim that the whole platform is blocked.

## Next operational evidence

After an authorized scoped credential exists, verify exact-bucket S3 access through the EU endpoint, then enable the guarded source configuration and observe the same named Backup across uncertain outcomes. Require completed backup metadata plus matching remote catalog/objects and WAL covering separately committed markers. Validate a fresh full restore and a distinct PITR target through TLS SQL, including exclusion of the post-target marker and target archiving under its own identity. Keep source data and archives until verified recovery.

Retention/deletion, recovery after original source removal, interruption/resumption, recovery onto fresh infrastructure and production topology remain separate gates. `.env.local` and private operator/credential state remain ignored and owner-readable; no private material accompanies these public examples.
