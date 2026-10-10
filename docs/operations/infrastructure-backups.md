# Daily infrastructure backups and alerts

Daily infrastructure backups protect the Cloudflare control database and each
existing regional Kubernetes control plane. They complement CNPG/Barman database
base backups and WAL; they do not replace them. All storage uses the installation's
existing, region-bound R2 archive buckets. No Contabo API call, server purchase,
cluster credential rotation, or Kubernetes mutation occurs during capture.

## Installation configuration

Apply migration `0039_infrastructure_backups.sql`, deploy the `InfrastructureBackup`
Workflow binding shown in `apps/api/wrangler.example.jsonc`, and deploy the matching
NodeBootstrap image. The existing minute Cron dispatches at most one persisted run
per UTC calendar day. Fresh installations have backups disabled and no email
addresses configured.

Set the operator-configurable `containers[].max_instances` to at least two when
a backup must run alongside a node patch or installation. The example uses two.
These operations share the existing NodeBootstrap application; a limit of one
rejects the second container before native capture starts. Size this limit for
the maintenance concurrency your installation allows, and keep it in the saved
deployment configuration so a later publication does not restore an older limit.

Set the private Worker secret `INFRASTRUCTURE_BACKUP_CF_TOKEN` to an operator-owned
Cloudflare API token with D1 export permission for the actual control database.
The token stays in the management Worker. The container receives only the temporary
HTTPS export URL. Set `NODE_BOOTSTRAP_CALLBACK_URL` to the management API's public
HTTPS origin and retain the existing protected relay binding, signing keys and
sealed regional join material. Control nodes must report fresh signed fleet facts,
including their Kubernetes control-plane role and configured/runtime Cilium image
pins. Missing or changed authority fails the daily run rather than choosing an
unverified source. Backups use the existing administrator relay capability; this
change grants no new regional Kubernetes RBAC or Talos credentials to Pods.

Use the administrator API, replacing every placeholder with this installation's
actual values:

```http
PUT /v1/infrastructure-backups/config
Authorization: Bearer <ADMIN_API_KEY>
Content-Type: application/json

{
  "enabled": true,
  "d1_account_id": "<CLOUDFLARE_ACCOUNT_ID>",
  "d1_database_id": "<CONTROL_D1_DATABASE_UUID>",
  "d1_region_id": "<EXISTING_R2_REGION_ID>",
  "notification_recipient": null,
  "notification_sender": null
}
```

`GET /v1/infrastructure-backups/config` reads this configuration.
`GET /v1/infrastructure-backups` returns the latest run, per-artifact hashes/byte
counts, R2 object keys, error codes and current backup freshness. It returns no
private client configuration, signed export URL or encryption key. Changing the
configuration revision or disabling backups revokes an unfinished run's capability.
The existing operator Kubernetes API still requires administrator authorization.
The internal backup WebSocket instead accepts only an expiring capability bound to
one current run, artifact, node UID, cluster UID and custody revision. Both paths
recheck current Cloudflare authority and the operator checks actual Kubernetes,
Talos, boot and Cilium carrier identities before and after capture.

## Capture and acceptance

Cloudflare [documents query unavailability during D1 export](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/).
The exporter polls that same provider job within its authorized deadline without querying the
locked database, then rechecks current run/configuration authority before using the export URL.
Control-plane requests may wait during this export window; record its actual duration.

One Workflow captures D1 and one etcd snapshot per existing regional cluster in a
private NodeBootstrap container. Files are streamed and hashed; the complete run's
private payload workspace is bounded to 1 GiB. Encryption uses a purpose-derived
AES-256-GCM key from the existing active `CREDENTIAL_KEYS` version. No cluster key
or credential key is generated or rotated. Plaintext files are removed immediately
after encryption; the ephemeral workspace is removed when the run closes.

The Worker uploads ciphertext using bounded 8 MiB R2 multipart parts over private
container/R2 bindings, then reads the entire committed object back through the
container. Completion requires matching object ownership, encrypted byte count,
SHA-256, authenticated run/source identity, GCM tag, plaintext byte count and
SHA-256. The receipt is persisted in D1 only after this full readback. Unique keys
are `infrastructure/v1/<UTC-day>/<run-UUID>/<artifact-id>.pgcfenc`.

A lost multipart completion response is resolved by reading that exact object.
An existing unique object is verified, never overwritten. An uncertain Workflow
creation is resolved using its persisted run UUID. Failed capture, lost transient
container state, expired authority, or mismatching readback produces a durable
failed run; it does not repeat an uncertain write or regenerate a different archive
under the same object identity. The next UTC day creates a fresh run.

Backups become stale after 36 hours without a completed artifact. The first failed
run is failing even when no earlier backup exists. Deadline expiry records failure
at two hours. Backup failed/stale episodes and stale/lost node observations appear
in the existing operational infrastructure alerts independently of database
availability. Node alarms reuse the existing heartbeat freshness rule. Never-observed
new nodes do not trigger a stale-node alarm.

Before accepting customer data, enable this configuration and verify a real daily
run contains D1 and every expected regional etcd artifact with `status: complete`.
Record the real artifact byte counts, full readback results, duration and recovery
proof in the ULTRA plan; targeted tests alone are not live backup acceptance.

## Optional email or webhook delivery

Email is optional. Import `RESEND_API_KEY` as a private Worker secret and configure
`notification_recipient` plus `notification_sender` through the same API. The sender
must be an address on a domain verified in the operator's Resend account. No personal
recipient, sender or API key is included in the repository. Recipient and sender may
also be configured while daily backups are disabled; this enables delivery of node
and separately configured regional capacity alarms.

The existing authenticated infrastructure webhook remains supported and takes
precedence when configured. Without a webhook or both email addresses plus the
Resend secret, alarms remain visible through the API and no notification is sent.
Delivery uses the durable event UUID as the idempotency key, a five-second deadline,
and a minimum one-minute retry interval. A continuously active episode retains its
UUID and payload. Recovering clears the episode; a new failure creates a new UUID.
Webhook receivers must deduplicate this identifier durably. Email delivery follows
Resend's idempotency retention; an unresolved delivery must be investigated through
the API and the operator's mail account.

## Offline recovery custody

Keep all referenced `CREDENTIAL_KEYS.keys[kid]` versions in protected offline
custody, separate from R2 and D1. A D1 export contains encrypted cluster/role custody;
it cannot recover those credentials if the matching master key versions were lost.
Never upload a plaintext keyring alongside these objects. Disabling capture or
changing the active key does not retire keys needed by existing archives.

The `PGCFINF1` envelope contains: eight-byte magic, four-byte big-endian JSON AAD
length, UTF-8 authenticated JSON identity, 12-byte nonce, AES-GCM ciphertext, and a
16-byte authentication tag. Derive its 32-byte key with HKDF-SHA256 from the retained
master version: salt UTF-8 `pgcf-infrastructure-backup-v1`, info UTF-8 the `kid`.
AAD binds the run/artifact/source/day/region, node and cluster identities, custody
revision, `kid`, plaintext SHA-256 and byte count. Verify the complete encrypted
SHA-256/length from the API receipt and GCM/AAD/plaintext hash before writing or
restoring recovered SQL/snapshots. Never restore an unverified or partial object.
Use the existing [recovery runbook](recovery.md) for controlled D1 and etcd restoration;
restoration changes live state and requires explicit operator authorization.
