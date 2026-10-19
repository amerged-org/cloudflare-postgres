# Manual credential changes

Operational Cloudflare, R2 and PGCF credentials have no configured expiry in the current operator
installation, except these: the Edge's Access service token below, a node's temporary R2
credentials (7 days, renewed by Cloudflare), the installer's enrollment token (30 minutes) and
the route tokens (30 seconds). Keep their scopes limited to the account, buckets and services they
use. Routing capabilities, control messages, provider access tokens and certificates retain their
security deadlines.

## API keys

Using a working administrator key, call `POST /v1/api-keys` with an explicit `Idempotency-Key`.
For a replacement administrator use `{"scope":"admin","name":"operator replacement"}`;
integrator keys additionally require their existing `project_id`. Save the creation response
directly in private credential custody. The full key is returned once; replay does not reissue or
silently replace it. Verify the replacement's scoped access, update the consumer, then revoke the
old key with `DELETE /v1/api-keys/{id}`. Keep a working administrator throughout the change.

`BOOTSTRAP_TOKEN` creates the first administrator key once and then answers `401`; it creates no
integrator key and no second administrator.

## Worker and routing secrets

Maintain the exact Worker binding names from the private deployment configuration. Write values
from a protected file through Wrangler secret import; keep command output private. Deploy to the
verified account and compare secret **names**, never print values.

For `ROUTE_MASTER_KEYS` (`{"active":"<kid>","keys":{"<kid>":"<base64url>"}}`), the API and the Edge
Worker hold the master keyring and sign with the active key. A node's gateway verifies with the
keys derived for that node from every master key. The agent reads them from Cloudflare when it
starts (and again when its desired page names a higher credentials revision, which no API route
raises today) and writes them to `gateway.env`; a running gateway reads that file only when it
starts. To rotate, add the new key beside the old one with the old one still active, deploy the API
and the Edge, let every node's agent start once (a release that changes the agent) and then its
gateway start afterwards (a reboot of the node, or a release that changes the gateway's binary),
and only then make the new key active and deploy both again. Existing routing tokens expire within
30 seconds. Verify a fresh connection before retiring the old key from the keyring, and never make
a key active that a node's gateway has not received.

For the Edge's Access service token (`ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET`), rotate the
token's secret in Zero Trust with a grace period; the Client ID stays the same
([operator installation](operator-installation.md#cloudflare-access-for-node-gateways-and-shells)).
Set the new `ACCESS_CLIENT_SECRET` on the Edge, check a fresh connection and an HTTP query, then let
the grace period end (or end it early on the rotate call). Never revoke or delete the token itself:
Access revokes by deleting the token, which removes the new secret too, and every public-gateway
connection and HTTP query then fails. The token expires after the duration chosen when it was
created (8760h in the operator installation), after which Access refuses the Edge in the same way.
Refresh it in Zero Trust (or with the Refresh endpoint, one more year) before then, and turn on the
Zero Trust "Expiring Access Service Token" notification, which warns a week ahead.

For `CREDENTIAL_KEYS`, adding a new active key ID does not make old ciphertext disposable. Retain
all key IDs referenced by database roles, deleted-source archives and older D1 exports. Back up
the complete keyring before changing it. Re-encryption and automatic rotation
are later work; removing a referenced key makes recovery impossible.

`API_KEY_PEPPER` binds the hashes of every API key and of the installer's enrollment and progress
tokens. Changing it requires a coordinated rehash of known retained keys and private custody;
replacing the Worker secret alone is not a supported rotation, and it would refuse every existing
key.

## Node credentials

A node holds no secret of the image. Its credentials come from the install and from the link:

- **The node key.** At its first start the agent generates an Ed25519 key that never leaves the
  node, enrolls with the installer's one-time token and its public key, and signs every later
  request with it. There is no rotation: a reinstall is a new install with a new token and a new
  key. Cloudflare restricts the key of a node declared lost to the fenced scope (see
  [recovery](recovery.md#lost-node)). An enrollment token that is presented again with another key,
  or after it expired, is refused and raises `node_enrollment_refused`: treat it as leaked and
  reinstall.
- **Tunnel token and route keyring.** The API makes the node's Tunnel with `CLOUDFLARE_API_TOKEN`
  when the node first reads its credentials and hands it the token and its derived route keyring;
  the node stores the token as an encrypted systemd credential. Declaring a node lost deletes its
  Tunnel, which ends the token.
- **R2 credentials.** The Worker signs each node's temporary credentials locally from the parent key
  (`R2_PARENT_ACCESS_KEY_ID` and `R2_PARENT_SECRET_ACCESS_KEY`): one archive prefix of one
  database generation, no delete right, 7 days, renewed after a third of that. Nodes never hold the
  parent key or a bucket-wide key. To replace the parent key, create the new R2 API token (object
  read and write on the archive buckets), set both Worker secrets and deploy; credentials delivered
  afterwards are signed with the new key. Delete the old token only after the credentials it signed
  have expired, 7 days after the deploy: deleting it earlier ends the credentials the nodes hold,
  and archiving fails until they read new ones (`database_archive_failing`).

## Provider and account credentials

Create a replacement with the same scoped authority, update the private Worker secret, then check
its real use before revoking the old value. R2 requires an actual base backup, WAL archive and
restore read. `CLOUDFLARE_API_TOKEN` requires a node's credentials read that finds its Tunnel.
`INFRASTRUCTURE_BACKUP_CF_TOKEN` requires the next daily D1 export to complete. Contabo requires an
authenticated inventory read; changing credentials must never issue a test order.

Credentials of the retired Kubernetes runtime (the Talos and Kubernetes authority, relay
credentials, region agent keys, bucket-wide R2 keys and old Tunnel tokens) are revoked under
Stage 0 step 4 of the [ULTRA plan](../architecture/cloudflare-convergence-and-serverless-plan.md).
Keep every `CREDENTIAL_KEYS` ID that older D1 exports reference.

Record changed key IDs, dates and successful checks in private custody. Refresh the encrypted
operator backup and its independent offline copy. Do not record secret values in `PLAN.md`, Git,
logs or incident messages.
