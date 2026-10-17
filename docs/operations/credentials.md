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
all key IDs referenced by database roles, deleted-source archives and older D1 exports. Back up
the complete keyring before changing it. Re-encryption and automatic rotation
are later work; removing a referenced key makes recovery impossible.

`API_KEY_PEPPER` binds existing API and agent key hashes. Changing it requires a coordinated
rehash of known retained keys and private custody; replacing the Worker secret alone is not a
supported rotation. There is no agent-key rotation API in v1. Keep the current imported agent
identity until that coordinated operation has been implemented and checked. A Worker isolate keeps
a region's agent key hash for 5 s (`AGENT_REGION_CACHE_MS`), so a change made in D1 itself stops
authenticating the old key everywhere within that time and accepts the new key at once.

## R2, Tunnel and provider credentials

Create a replacement with the same scoped authority, update the private Worker secret, then check
its real use before revoking the old value. R2 requires an actual base backup, WAL archive and
restore read. A Tunnel requires Ready connectors and a real database connection. Contabo requires
an authenticated inventory read; changing credentials must never issue a test order.

Kubernetes-era credentials (the Talos and Kubernetes authority, relay credentials, region agent
keys, bucket-wide R2 keys and old Tunnel tokens) are revoked under Stage 0 step 4 of the
[ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md). Keep every
`CREDENTIAL_KEYS` ID that older D1 exports reference.

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
established target database generations so the regional consumer receives the rotated
credential. Idempotent replay does not advance generations twice.
It preserves target backup credentials, archive paths, storage generations, source data and
temporary restore-administration derivation. Check the target's observed configuration and a
real source read before retiring the old key. Keep every credential encryption key still needed
to decrypt stored custody.

An explicit API map, including an empty map, never falls back to a local credential or to the
target's write key. Setup and rotation use the PGCF API.

Keep a source-read credential while any non-deleted restored target references its source.
Successful promoted targets retain recovery metadata and still verify the source archive.
SQL completion alone does not authorize retiring the source key. Preserve private custody and
the operator backup; never commit requests or credential values.
