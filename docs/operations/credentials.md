# Manual credential changes

Operational Cloudflare, R2 and PGCF credentials have no configured expiry in the current
operator installation. Keep their scopes limited to the account, buckets and services they use.
Routing capabilities, control messages, provider access tokens and certificates retain their
security deadlines.

## API keys

Using a working administrator key, call `POST /v1/api-keys` with an explicit `Idempotency-Key`.
For a replacement administrator use `{"scope":"admin","name":"operator replacement"}`;
integrator keys additionally require their existing `project_id`. Save the creation response
directly in private credential custody. The full key is returned once; replay does not reissue or
silently replace it. Verify the replacement's scoped access, update the consumer, then revoke the
old key with `DELETE /v1/api-keys/{id}`. Keep a working administrator throughout the change.

## Worker and routing secrets

Maintain the exact Worker binding names from the private deployment configuration. Write values
from a protected file through Wrangler secret import; keep command output private. Deploy to the
verified account and compare secret **names**, never print values.

For `ROUTE_MASTER_KEYS`, retain the old key ID while adding the replacement. Derive each region's
gateway keyring with the shared `deriveRegionKeyring` contract and update the gateway first;
activate the new master signing key only after the gateway accepts it. Existing routing tokens
expire within their configured short window. Verify a fresh connection before retiring the old
key. Do not change an agent key as a side effect of a redeploy.

For `CREDENTIAL_KEYS`, adding a new active key ID does not make old ciphertext disposable. Retain
all key IDs referenced by database roles, deleted-source archives and encrypted agent/Talos/join
custody. Back up the complete keyring before changing it. Re-encryption and automatic rotation
are later work; removing a referenced key makes recovery impossible.

`API_KEY_PEPPER` binds existing API and agent key hashes. Changing it requires a coordinated
rehash of known retained keys and private custody; replacing the Worker secret alone is not a
supported rotation. There is no agent-key rotation API in v1. Keep the current imported agent
identity until that coordinated operation has been implemented and checked.

## R2, Tunnel and provider credentials

Create a replacement with the same scoped authority, update the private Worker or Kubernetes
Secret, then check its real use before revoking the old value. R2 requires an actual base backup,
WAL archive and restore read. A regional Tunnel requires Ready connectors and a real database
connection. Contabo requires an authenticated inventory read; changing credentials must never
issue a test order. Restore administration is tied to the current regional R2 credential, so do
not change the target region's `pgcf-backup-s3` credential during an unfinished restore.

Record changed key IDs, dates and successful checks in private custody. Refresh the encrypted
operator backup and its independent offline copy. Do not record secret values in `PLAN.md`, Git,
logs or incident messages.

### Cross-region restore source credentials

After the target region's ordinary bootstrap, before its first cross-region restore, install
`pgcf-system/pgcf-restore-source-s3` in that regional Kubernetes cluster. Its `data.sources.json`
value is base64-encoded JSON keyed by source region ID. Each value binds a bucket-scoped read-only
credential to that source's exact archive bucket and HTTPS endpoint. The API Worker holds no
copy of this S3 map.

Prepare this JSON in owner-only private custody, replacing every placeholder:

```json
{
  "<source-region-id>": {
    "bucket": "<source-archive-bucket>",
    "endpoint_url": "https://<source-r2-endpoint-host>",
    "access_key_id": "<source-read-only-access-key-id>",
    "secret_access_key": "<source-read-only-secret-access-key>"
  }
}
```

Encode the private JSON without printing it and apply this Secret through the authenticated
target Kubernetes API:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: pgcf-restore-source-s3
  namespace: pgcf-system
type: Opaque
data:
  sources.json: <base64-of-private-source-map>
```

Verify privately that the installed entry matches the source region's actual bucket and endpoint,
then check a real restore read before retiring an old credential. The agent copies only the
selected source entry into the target database's separate `recovery-source-credentials` Secret.
Keep the target's ordinary `pgcf-backup-s3` write credentials unchanged; its own backups and
temporary restore administration use those target credentials. The namespace permits HTTPS
egress to the exact configured source and target R2 endpoint hosts. A same-region restore uses
the ordinary regional credential and needs no source-map entry.

Keep the source-read credential and map entry while any non-deleted restored target references
that source region. This includes successful, promoted targets: their recovery metadata persists
and the current reconciler still verifies the source ObjectStore on every running reconciliation.
SQL completion alone does not authorize removing the entry. Remove it only after all referencing
targets are deleted and it is no longer needed for planned archive recovery. Preserve private
custody and the operator backup; never commit the JSON, encoded Secret or credential values.

## Talos and Kubernetes material

Treat the complete Talos machine configuration as a secret. In Talos 1.14, the resource's `spec`
is a YAML multi-document string. Parse it with strict type checks and inspect every document;
the Kubernetes API/aggregator CAs, service-account signer, discovery secret and Secret-at-rest
encryption key may live outside the legacy `machine`/`cluster` document. Emit field names and
validation booleans only. A missing legacy field does not establish absence of the credential.

The pinned [Talos CA command](https://github.com/siderolabs/talos/blob/v1.14.1/cmd/talosctl/cmd/talos/rotate-ca.go)
supports separate Talos and Kubernetes API CA rotation. For Talos only, explicitly set
`--talos=true --kubernetes=false`; both default to true. Start with `--dry-run=true` and an explicit
current node topology. Capture **both** output streams directly to owner-only private files even
in dry-run: the [Talos rotator](https://github.com/siderolabs/talos/blob/v1.14.1/pkg/rotate/pki/talos/talos.go)
prints CA private keys and a new admin configuration. Dry-run skips configuration changes and
actual new-key connectivity checks, so it is not rotation acceptance. Use `--dry-run=false` only
for the planned live change, retaining the original configuration in encrypted offline custody.

API CA rotation does not rotate etcd, node bootstrap/trustd tokens, discovery, aggregator,
service-account or Secret-at-rest material. Plan these as separate targeted configuration changes.
Etcd CA replacement can interrupt the control plane; retain a verified etcd snapshot and rehearse
the exact change before applying it to an occupied node. Aggregator and service-account documents
support accepted trust during a transition. For Secret-at-rest encryption, retain the old decrypt
key until all stored Secrets have been rewritten with the new first key and verified readable;
old etcd snapshots still need their original decrypt key in offline custody. Follow the
[Kubernetes encryption procedure](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/).

Coordinate any Talos/Kubernetes change with the encrypted region seed and join bundle before
allowing another node to bootstrap. The current worker path selects join revision 1; replacing
live trust alone leaves its retained bundle stale. Revision selection and exact readback must be
implemented and checked before a coordinated rotation. Preserve the original ciphertext and all
referenced credential-encryption keys, the region's cluster identity, existing Node/storage UIDs
and the independent PGCF agent, R2 and Worker secrets.
