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

Manage source-read relationships through the authenticated PGCF API before requesting a
cross-region restore. The target region's ordinary backup write credential remains separate.
Supply a bucket-scoped R2 **Object Read Only** credential for the source region; the API checks
registered bucket/endpoint identity and encrypted custody. It cannot infer R2 IAM permissions
from an S3 key. Live acceptance must prove reads succeed and writes are denied before the
credential is used for customer recovery.

Use `GET /v1/regions/{target}/archive-sources/{source}` to read the current revision and source
configuration match status. A missing relationship returns404. Create it with revision0, or
rotate it against the revision returned by GET:

```http
PUT /v1/regions/{target}/archive-sources/{source}
Authorization: Bearer <admin-key>
Idempotency-Key: <stable-key-for-this-creation-or-rotation>
Content-Type: application/json

{
  "expected_revision": 0,
  "bucket": "<registered-source-archive-bucket>",
  "endpoint_url": "https://<registered-source-r2-endpoint-host>",
  "credentials": {
    "access_key_id": "<source-object-read-only-access-key-id>",
    "secret_access_key": "<source-object-read-only-secret-access-key>"
  }
}
```

Keep the request body in private custody; never put it in Git, logs or shell history. GET and
PUT responses contain relationship metadata and revisions, never credentials. Cloudflare
stores the credential under the existing rotating encryption keyring with authenticated
binding to both region IDs and the relationship revision. Only the authenticated target
region receives its configured source-read map in desired state. A drifted source is omitted
from an explicit authoritative map; the regional consumer fails closed for that source.

Rotation waits until all referencing restore operations have succeeded. It atomically advances
established target database generations so the existing reconciler updates their separate
`recovery-source-credentials` Secrets. Idempotent replay does not advance generations twice.
It preserves target backup credentials, archive paths, storage generations, source data and
temporary restore-administration derivation. Check the target's observed configuration and a
real source read before retiring the old key. Keep every credential encryption key still needed
to decrypt stored custody.

For consumer-first deployment, install the D1 migration and compatible regional consumer before
enabling the API producer. The earlier local `pgcf-system/pgcf-restore-source-s3` map is a legacy
compatibility input only when desired state omits `recovery_sources`. An explicit API map,
including an empty map, never falls back to that Secret or to the target's write key. Normal
setup and rotation use the PGCF API; no direct Kubernetes Secret installation is required.

Keep a source-read credential while any non-deleted restored target references its source.
Successful promoted targets retain recovery metadata and still verify the source ObjectStore.
SQL completion alone does not authorize retiring the source key. Preserve private custody and
the operator backup; never commit requests, encoded Secrets or credential values.

## Talos and Kubernetes material

Treat the complete Talos machine configuration as a secret. In Talos 1.14, the resource's `spec`
is a YAML multi-document string. Parse it with strict type checks and inspect every document;
the Kubernetes API/aggregator CAs, service-account signer, discovery secret and Secret-at-rest
encryption key may live outside the legacy `machine`/`cluster` document. Emit field names and
validation booleans only. A missing legacy field does not establish absence of the credential.

After a boot that loads configuration only from STATE, Talos intentionally omits the separate
`machineconfig/persistent` runtime resource ([pinned acquisition controller](https://github.com/siderolabs/talos/blob/v1.14.2/internal/app/machined/pkg/controllers/config/acquire.go)).
List the resources and use the actual active configuration with the verified prior configuration
and changed-boot witness. Keep rejecting unproved absence or changed configuration. Do not
reapply configuration merely to recreate that runtime resource.

The October5 disclosure affected EU authority. A subsequent October9 diagnostic exposed the
US machine configuration as well; treat both prior authority sets as compromised. Earlier
fingerprint differences do not protect a later disclosure. Read the current accepted rotation
results in the [ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md#done). Disposable laboratory keys must never become fleet custody.

The latest October10 owner decision authorizes activation of the prepared EU replacement
authority during the automatic EU patch window, combining required restarts with the upgrade.
This supersedes the earlier rotation pause. Verify replacement access and rejection of retired
authority through the existing procedure; retain US custody revision2. The prior disclosure
record remains. Planning this change does not mean it has been activated.

The pinned [Talos CA command](https://github.com/siderolabs/talos/blob/v1.14.2/cmd/talosctl/cmd/talos/rotate-ca.go)
supports separate Talos and Kubernetes API CA rotation. For Talos only, explicitly set
`--talos=true --kubernetes=false`; both default to true. Start with `--dry-run=true` and an explicit
current node topology. Capture **both** output streams directly to owner-only private files even
in dry-run: the [Talos rotator](https://github.com/siderolabs/talos/blob/v1.14.2/pkg/rotate/pki/talos/talos.go)
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

Before rewriting Secrets, verify the API server's loaded encryption configuration, not just the
Talos acknowledgement or file on disk. Read the rendered configuration privately, compare its
SHA256 with `apiserver_encryption_config_controller_last_config_info` at value 1, and re-read the
file to exclude an intervening change. Use the expected key names and material. After the rewrite,
verify every current `/registry/secrets/` ciphertext uses the new key before retiring a decrypt
key or alias. Preserve Secret UIDs, data and types with resource-version preconditions; resolve
uncertain responses by reads. Repeat the loaded-hash check after final trust retirement.

After replacing the Kubernetes bootstrap token, inspect and explicitly retire any retained old
`bootstrap-token-<id>` Secret with its verified UID after the new token is ready; applying the new
manifest is not proof of old-token removal. For API CA rotation, observe each kubelet pass through
its supported restart and return healthy under the replacement authority, rather than accepting
configuration acknowledgement alone.

Coordinate any Talos/Kubernetes change with the encrypted region seed and join bundle before
allowing another node to bootstrap. Inspect each installation's active revision; replacing
live trust alone leaves retained bootstrap custody stale. The version-template synchronization
endpoint preserves keys and cannot rotate them. For a separately requested rotation, stage and
verify complete matching seed/join custody before allowing another bootstrap; do not overwrite
historical revision1. Preserve the original ciphertext and all
referenced credential-encryption keys, the region's cluster identity, existing Node/storage UIDs
and the independent PGCF agent, R2 and Worker secrets.

### Stage and activate replacement cluster custody

The administrator-only `POST /v1/regions/{id}/bootstrap-material/stage` accepts complete private
`seed`/`join` documents, exact old/new plaintext hashes, expected current revision and fresh
complete Node/Cluster topology. Use a protected JSON file and an `Idempotency-Key`; never paste
the body into logs or shell history. It stores an immutable encrypted revision N+1 and returns
only revisions and hashes. The active pointer remains N. Software versions, cluster name,
endpoint and Cluster UID must remain unchanged; use the separate patch path for upgrades.

After the separately rehearsed physical rotation, call `POST .../bootstrap-material/activate`
with the same hashes and a fresh `verified` readback plus its canonical `verification_sha256`.
The readback identifies its trusted administrator/Native source, exact private transcript hash,
unchanged complete topology and nine explicit old/new-authority check hashes: Talos/Kubernetes/
etcd/aggregator CAs, service-account signer, trustd/bootstrap tokens, discovery secret and
Secret-at-rest key. Network/client authorities require `rejected`; discovery and encryption
keys require `retired_from_live_configuration`. Old keys can still decrypt historical ciphertext
offline and must remain in protected custody. This is trusted-admin verified readback, not
cryptographic attestation derived from caller assertions. The API executes no
CA command, token rotation, encryption rewrite or credential test.

Activation checks120-second readback freshness,180-second Node observations, current envelopes
and idle installation/patch/uncertain thin-action boundaries in the pointer CAS. Ordinary finite
read leases do not block it. Read the active revision/hash to resolve a lost response; exact
replay never rotates keys again or overwrites historical ciphertext. A staged pair alone does
not reserve a maintenance window: keep other mutation admission closed through the physical
rotation. Refresh material-bound host/proof receipts before resuming bootstrap or new thin/warm
authority. Retain every old ciphertext/decryption key needed by historical custody and snapshots.

For an occupied cluster, coordinate an exclusive operator window and check pending database
operations before changing authority. Placement closure alone does not freeze every database
mutation; PGCF currently has no complete region-wide maintenance lock. Keep adopter/admin
mutation clients stopped during this window and measure retained database availability separately.

Pinned Talos1.14.1 and1.14.2 have identical relevant CA rotator/configuration source. Each stock
`rotate-ca` invocation generates fresh keys, so a dry run does not select the later live keys and
an interrupted run must be resolved from the actual issuing/accepted trust before continuing.
Reuse the same privately persisted planned material; do not blindly rerun the command.
