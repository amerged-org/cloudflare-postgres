# Signed finite execution window v2

Status: current-baseline source integration with disclosed passing continuation
after the original gate’s D1 timing-assertion failure. The standalone native Linux lifecycle
case passes with the unchanged guard binary. No installation signing key or CNPG
guard activation is claimed. See the [integration checkpoint](../evidence/m6-signed-window-integration-2026-10-01.md)
and the retained [earlier held checkpoint](../evidence/m6-signed-execution-window-held-2026-09-30.md).

The Worker can sign a short initial-run authorization from existing provisioning
funding. The Linux guard verifies it against one protected public-key pin and
one protected workload manifest before entering the maintained PID1 supervisor.
This connects two finite-window components; it does not enable CNPG injection,
continuous renewal or installation-wide runtime enforcement. Responses retain
`runtimeEnforced:false` and `enforcementStatus:"pending_runtime"`; ordinary
regional admission remains closed.

### Private issuance API

`POST /v1/regions/{regionId}/operations/{operationId}/execution-permits` accepts
exactly the following body, without query parameters:

```json
{
  "leaseToken": "<current private provisioning lease>",
  "leaseEpoch": 1,
  "reservationId": "<existing provisioning reservation UUID>",
  "challenge": {
    "version": 2,
    "nonce": "<32 random bytes, unpadded base64url>",
    "binding": {
      "installationId": "<configured installation>",
      "namespaceUid": "<trusted regional namespace UUID>",
      "podUid": "<trusted regional Pod UUID>",
      "containerName": "postgres",
      "nodeName": "<trusted regional node name>",
      "nodeUid": "<trusted regional node UUID>",
      "bootId": "<guard-observed kernel boot UUID>",
      "imageHash": "<configured PostgreSQL image SHA-256>",
      "commandHash": "<exact framed argv SHA-256>"
    }
  }
}
```

The winning region actor must still possess `operations:claim`, the exact lease
token and epoch, and a current `environment.create` operation. Funding must be
the operation's existing server-derived reservation: immutable environment,
specification, resource-time units, original horizon, current receipt/fence,
budget authority and unexpired lease must agree. The endpoint supports only
`specRevision:1` and `runEpoch:"1"`. It does not reserve another hold, renew the
existing reservation, advance an epoch or implement resume.

The issuer derives organization, project, region, operation, environment,
specification revision/hash, initial run, reservation identity/revision/epoch,
deterministic namespace and resource-envelope hash from authoritative control
state. `imageHash` is the immutable profile's `postgresImage` digest; the
challenge must match it. Caller-supplied duration, envelope, rates and funded
identities are not accepted.

### Signing and verification wire

The successful `201` body contains `permit:{version:2,keyId,payload,signature}`
plus the explicit unenforced status above. The decoded payload has exactly
`version`, `nonce`, `binding`, `durationNs`, `issuedAt` and `validUntil`.
`binding` has these exact keys:

```text
installationId, organizationId, projectId, regionId,
reservationId, reservationRevision, reservationEpoch,
operationId, environmentId, specRevision, specHash, runEpoch,
namespace, namespaceUid, podUid, containerName,
nodeName, nodeUid, bootId, imageHash, commandHash, resourceEnvelopeHash
```

Payload bytes are UTF-8 JSON with recursively sorted object keys. Payload and
the 64-byte Ed25519 signature use canonical unpadded base64url. Sign exactly:

```text
UTF8("cloudflare-postgres/execution-permit/v2\0" + keyId + "\0") || payloadBytes
```

The issuer configuration is the private Worker secret
`RUNTIME_PERMIT_SIGNING_KEYS`, with `version:1`, `installationId`, `active` and
an explicit map of Ed25519 PKCS#8 private keys. No installation key is generated
or deployed by this source change. The guard trusts only its protected
`{version:2,keyId,publicKey}` pin, containing one 32-byte Ed25519 public key.
An envelope cannot select another trusted key. Unknown fields, duplicate JSON
keys, noncanonical bytes, a wrong nonce/key/signature/binding or an unsigned
operator permit are refused by the signed lane.

### D1 time and guard-owned expiry

The issuer samples `serverNow` with guarded D1 `strftime(...,'now')` reads;
neither regional wall time nor response-arrival time determines authority.
For the original D1 issue sample `T` and the current funded deadline `F`, it uses
`durationMs = min(15000, F - T) - 1000`, requiring a positive integer. Thus this
issuer's maximum window is 14 seconds; the guard's protocol ceiling is 15.
The one-second reserve is not an extra grace period.

Every issuance query uses the direct D1 binding, including post-sign checks and
the original proof’s required-until recheck. A reused first-primary session does
not provide this guarantee for its later reads.

After signing, the issuer rechecks current actor, lease, funding identity,
account/fence, receipt and budget-period bounds. A final guarded D1 sample must
not precede `T`, exceed `T + 1000ms` or reach the unchanged `validUntil`.
Current authority must cover that original deadline. Failure returns a refusal;
there is no signing retry loop or sliding issue timestamp. This samples current
authority; revocation after the last check can coexist with an already issued,
bounded window. It is not atomic continuous revocation.

Before creating or transporting its challenge, the guard samples the local
kernel boot ID and `CLOCK_BOOTTIME` anchor `A`, then generates the random nonce.
Its startup limit is positive and at most 15 seconds. The hard deadline is
`A + signedDuration`, not response-arrival time plus duration. Transport and
verification consume the window. Host suspend counts; clock rollback, changed
boot, elapsed startup or insufficient remaining shutdown grace refuse startup.
UTC timestamps are checked for exact duration consistency, not converted into
a local wall-clock deadline.

After private-file metadata and hash rechecks, the Linux start adapter reads
boot identity and BOOTTIME again and verifies the original permit and remaining
shutdown margin immediately before creating the manager process. Kernel
scheduling and process-spawn latency remain measured installation limits.

### Protected local handshake and argv

The explicit `--mode signed-window` CLI takes `--expected-file`,
`--public-key-file`, `--ipc-directory`, bounded `--startup-timeout` and `--grace`,
then the original absolute manager executable and exact arguments after `--`.
It rejects unsigned-mode `--permit-file`/`--run-epoch` arguments rather than
falling back. Both CLI modes must be explicitly selected. The separate
`operator-window` lane refuses signed-context environment variables and remains
unfunded. The expected manifest is exactly `{version:2,binding,command}`.

The guard must be PID1. Manifest/key/IPC directories must be real, owner-matched
`0700` directories; protected files are regular, single-link, owner-matched
`0400`/`0600` files bounded to 16 KiB. Directory identities and file identities,
metadata and hashes remain pinned. Observed symlinks or changed custody refuse startup. Expected and public-key
files must be delivered on protected read-only mounts, with operator-owned
ancestors. Ancestor checks observe paths; they do not provide atomic isolation
against a concurrently modifying administrator.

Each handshake creates a fresh `attempt-<nonce>` directory and exclusively
publishes `request.json` with private modes and durable synchronization. A
`{mode:"signed-window",status:"challenge",attempt:...}` message signals only
challenge availability. A trusted external transport writes only the returned
`permit` envelope into that attempt's `permit.json`; old attempts and responses
are never adopted. The guard does not perform HTTP or hold a bearer token.
CF credentials and the private signing key remain outside the customer
container; the container receives only the public pin, protected manifest and
short signed response.

`commandHash` is SHA-256 of the command-domain prefix
`cloudflare-postgres/execution-command/v2\0`, a big-endian 32-bit argv count,
then each argument's big-endian 32-bit UTF-8 byte length and exact bytes. There
is no shell normalization. The manifest and actual argv must agree; this hash
does not measure the executable's bytes.

### Trust boundary and remaining integration

The configured image digest and funding-derived identities are authoritative
control facts. Namespace/Pod/Node UIDs, container placement and command identity
are trusted regional/local assertions supplied through the challenge and
protected manifest. The guard compares them exactly, checks its actual kernel
boot ID and matches `PGCF_EXECUTION_POD_UID`, `PGCF_EXECUTION_NAMESPACE` and
`PGCF_EXECUTION_NODE_NAME`. Neither the signature nor these files constitute a
Kubernetes ownership lookup, measured-image proof or hardware attestation.
Adversarial modification of that trusted configuration remains an installation
admission/security responsibility.

After successful verification, the existing PID1 supervisor owns pre-expiry
shutdown and hard-deadline cleanup in its private process namespace. There is
one finite window, with no in-process renewal or unsigned downgrade. Local
quiescence does not release scheduler allocations, stop separately namespaced
Pooler/backup containers, settle final usage, remove storage or prove an exact
kernel scheduling deadline. A new container attempt requires a fresh nonce and
valid current funding; durable one-use admission is not supplied by this issuer.

Before enabling an installation, separately qualify CNPG lifecycle injection,
protected configuration delivery and external transport; current Pod/Node
ownership; server-enforced admission and stale-writer exclusion; renewal/run
handoff; scheduler and retained-volume stopping; final accounting and recovery.
The source feature changes none of those enforcement flags or admission gates.
