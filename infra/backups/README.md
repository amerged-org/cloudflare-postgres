# PostgreSQL archive and recovery qualification

Use the already installed, verified CloudNativePG and Barman Cloud plugin. These examples configure database resources; they do not install, upgrade or transfer ownership of either operator. A stopped platform handoff remains stopped. An existing plugin discovery, certificate, permission or network failure must be reported before further database changes.

The current development versions are CNPG `1.30.1`, Barman plugin `0.15.0` and PostgreSQL `18.4`. Select the actual compatible pinned image and verified StorageClass for your installation. Database readiness, a completed Backup resource and remote archive evidence are separate checks.

## Private access and archive identities

Provide a dedicated `backup-s3` Secret privately in the database namespace, with `ACCESS_KEY_ID`, `ACCESS_SECRET_KEY` and `REGION`. R2 uses region `auto`. For an EU-jurisdiction bucket, the S3 endpoint is `https://<account-id>.eu.r2.cloudflarestorage.com`; the general account endpoint is insufficient. Limit credentials to the intended backup bucket and record their expiry/rotation responsibility. Never commit a Secret, environment file, token response or operator kubeconfig.

Fill [source-archive.example.yaml](source-archive.example.yaml) with the selected namespace, bucket, endpoint and a unique qualification run ID. Keep retention omitted during the first backup/restore run. The ObjectStore contains no `configuration.serverName`: the plugin receives the server identity through the Cluster configuration instead.

Add the following to the **existing source Cluster**, preserving every other specification field and testing its current UID/resourceVersion before changing it:

```yaml
plugins:
  - name: barman-cloud.cloudnative-pg.io
    isWALArchiver: true
    parameters:
      barmanObjectName: source-archive
      serverName: source-REPLACE_WITH_RUN_ID
```

This can replace the database Pod because the plugin adds a sidecar. Record the original Cluster/PVC/PV identity, known SQL markers and current primary first. Use bounded sidecar resources through `ObjectStore.spec.instanceSidecarConfiguration`; verify the installation's spare requests and actual pressure. Preserve existing isolation and TLS. Stop on failed rollout or lost data identity; never delete/recreate the source to force readiness.

## Base backup and WAL evidence

Apply a named [Backup example](base-backup.example.yaml) only after the source is healthy and the plugin path is observed working. Observe the same resource across timeouts; do not create another Backup merely because an observation ended.

A pass requires `status.phase: completed`, a nonempty **`status.backupId`**, recorded begin/end WAL and LSN, start/stop times, and matching source/plugin metadata. Confirm that the corresponding catalog and objects exist remotely. `ContinuousArchiving=True` alone does not prove a newly committed marker is recoverable. Record a marker, force a WAL switch through the trusted operator path if needed, and verify that the required WAL is archived. Do not grant that administrative privilege to customer roles.

## Full restore and point-in-time recovery

Create a fresh target with new PVCs and the compatible PostgreSQL image. Use [restore.example.yaml](restore.example.yaml) and a recovery-source ObjectStore that reads the original archive. The target's **own** ObjectStore/server identity must differ from the source and from other restore targets. Validate the complete source/target mapping before creation. Keep the nonempty-WAL check enabled; an `Expected empty archive` failure means stop and investigate the mapping.

For full recovery, omit `recoveryTarget`. For PITR, use the same target shape with a separately named target/prefix/server and add:

```yaml
recoveryTarget:
  backupID: REPLACE_WITH_RECORDED_BARMAN_BACKUP_ID
  targetTime: REPLACE_WITH_RECORDED_UTC_RFC3339_TIME
```

The restore request uses **`backupID`**, unlike the Backup status field. Choose a time after the selected base backup and between two separately committed markers; archive the WAL covering both. Verify over TLS that full recovery contains the expected marker set and that PITR contains the earlier marker and excludes the later one. Confirm the target is writable and subsequent WAL uses only its own archive identity. Pod/Cluster Ready conditions do not replace SQL evidence.

Run restoration sequentially when capacity for simultaneous loads is unqualified. Keep source archives/credentials and the original source until each recovery is validated. Restoring after the disposable source is removed requires a separately scoped operation; do not treat deletion as implicit cleanup. StorageClass Retain behavior and orphan-volume reclamation are distinct responsibilities.

## Remaining reliability gates

Record observed RPO/RTO and archive growth from the actual run. Add interruption/resumption, recovery after original source removal, recovery onto fresh infrastructure, expired/revoked credentials, and retention/deletion qualification as separately bounded operations. The same minimal happy path cannot establish those behaviors.

Retention windows accept days/weeks/months, not a fabricated minutes/hours window. A same-day run cannot prove real one-day expiration. Later evidence must show obsolete remote objects disappear, the required boundary base backup/WAL remain, a recovery within the retained window works, and a sibling archive stays unchanged. Deleting a Backup CR is not remote-object deletion evidence. Never disable safety checks, alter archived timestamps or broaden credentials to make a gate pass.

These examples are preparation, not verified backup availability. Follow [PLAN.md](../../PLAN.md) and keep installation observations in ignored `.local/` or a private deployment repository.

Sources: [Barman plugin 0.15.0 usage](https://github.com/cloudnative-pg/plugin-barman-cloud/blob/v0.15.0/web/versioned_docs/version-0.15.0/usage.md), [retention](https://github.com/cloudnative-pg/plugin-barman-cloud/blob/v0.15.0/web/versioned_docs/version-0.15.0/retention.md), [CNPG 1.30.1 recovery](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/docs/src/recovery.md), [R2 S3 authentication and jurisdiction](https://developers.cloudflare.com/r2/api/tokens/).
