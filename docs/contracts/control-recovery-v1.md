# Control-state recovery artifacts v1

The operator command captures canonical Cloudflare D1 state, seals it with the
explicitly supplied role/allowance keyrings and verifies an exact offline rebuild.
Cloudflare remains the live control authority. The rebuilt SQLite database is a
quarantined recovery artifact, never an alternative management deployment.

## Consistent capture

The current committed migration files define the trusted schema and carry hashes.
One bounded read captures that schema, every canonical application table, the
known D1 migration table and application AUTOINCREMENT high-water marks. It
excludes Cloudflare/provider-internal tables. Schema drift, unknown application
tables, missing migration history or incompatible source versions fail capture.
The read is one ordered, read-only SQL statement returning multiple rows:
schema and sequence count packets, a count marker for every table including
empty ones, individually numbered data rows, and a terminal marker. Missing,
duplicate, reordered or truncated results fail before any archive is sealed.
Separate paged reads are not treated as one consistent snapshot.
The statement groups its `UNION ALL` arms in nested pairs because the live D1
engine rejects the equivalent flat compound SELECT.

Cells retain their SQLite storage class: integer decimal strings, real strings,
text, BLOB hex and null. No large integer passes through JavaScript number
rounding. Compact typed pairs are used only in the result transport; the
authenticated v1 archive retains the original typed-cell objects and digest.
Deterministic row ordering supports exact reconstruction checks.
The statement is limited to 99,000 bytes, retaining 1,000 bytes below the
[D1 SQL statement limit](https://developers.cloudflare.com/d1/platform/limits/).
The current 16-migration statement is 92,644 bytes. The D1 adapter bounds its
entire CLI output to 16 MiB; the decoder bounds every returned payload to
2,000,000 bytes and accepts no more than 32 columns per application table.
The offline snapshot envelope is limited to 8 MiB, 128 tables and 100,000
application rows. Exceeding any bound fails the operation; there is no
truncated or multi-request fallback claiming a consistent snapshot. An
individual very large source value may expand beyond D1's row/string limit
when encoded and must fail closed. The complete result, 30-second provider
query deadline and concurrent-writer behavior need provider qualification.
One isolated D1 test returned all rows for 10,000 synthetic projects within
the result and time bounds, and its captured state passed independent offline
restore. That does not establish behavior under concurrent writers, general
request throughput, denser snapshots or a working Wrangler operator session.

The D1 adapter uses the adopter's authenticated Wrangler session, an explicit
account, a private strict JSON configuration and an empty environment file. Its
selected binding must match the asserted source database ID. It makes no write,
restore or Worker-secret request. The source installation UUID is an
operator-assigned recovery identity, not a newly granted execution capability.

## Key custody and encryption

Supply only `ROLE_CREDENTIAL_KEYS` and `ALLOWANCE_FENCE_KEYS` from private operator
custody. Worker Secret name listing cannot recover their values. All referenced
historical key versions must remain present. The recovery verifier decrypts every
retained role credential and allowance fence using their exact source contexts;
fence plaintext must match its stored digest. Compatibility tests generate
ciphertext with the actual existing Worker code, not a separate fixture codec.

The complete snapshot and keyrings are sealed using a separate random 32-byte
AES-256-GCM recovery key, a random IV and authenticated domain/version/bundle/source
metadata. The recovery key must differ from every supplied credential key. Keep
its custody independent of the encrypted bundle. This slice does not sweep up
provider, bootstrap, Talos, Kubernetes or meter credentials; those require their
own explicit disaster-recovery custody procedures.

Config/key/archive files are owner-only regular files; output parents are private
directories. Private intermediate files and completed artifacts are mode 0600.
Publication preserves existing files. The invoking OS user, selected Wrangler
tooling and migration directory are trusted; this is not a sandbox against a
different process running as that same user.

## Offline rebuild and activation boundary

Authenticate the bundle and source identity before creating outputs. Reconstruct
tables/data/sequence state and then schema constraints from the independently
verified local migration set. Captured SQL is never execution authority. Verify
exact re-snapshot, foreign keys, integrity and all credential custody before
publishing the private directory with `control.sqlite`, `keyrings.json` and
`manifest.json`. Failed validation publishes no recovery directory.
Directory creation is exclusive. Its manifest is published last as the completion
marker. A crash or publication error can leave an incomplete private directory;
it remains unverified and subsequent invocations refuse to overwrite it. Preserve
and inspect that directory rather than treating it as completed recovery.

The manifest and public result state `activationSupported: false`; the manifest
also states `recoveryFencesImplemented: false`. Historical API tokens, leases,
allowances and pending operations remain historical forensic rows. They are not
renewed, settled, marked current or automatically replayed. Do not connect the
rebuilt copy to regional controllers.

Production control-service recovery still requires global fencing, new execution
authority, external-resource reconciliation, Worker/provider credential recovery,
fresh Cloudflare installation and independent off-node archive/key custody. This
artifact lane supplies exact reconstructability evidence; it does not complete
those requirements or PostgreSQL backup/PITR.

## Operator workflow

Run `node apps/regional-controller/dist/main.js recover-control --config
/absolute/private/config.json`. The configuration uses version 1 and one action:
`capture` writes a private snapshot, `seal` creates an encrypted bundle, and
`restore` creates a fresh quarantined verification directory. No action activates
or modifies the Cloudflare service. Results contain status/digest/counts; errors
contain only `control_recovery_failed`. Data, keys, source IDs and local paths do
not enter command output.

See the [operator examples](../../apps/regional-controller/README.md#control-recovery-artifacts).
Capture accepts the original exact Wrangler configuration or an explicit
`cloudflare-rest` backend with a separate owner-only token file. REST requests are
bound to the configured Cloudflare account and source D1 UUID at a fixed HTTPS
endpoint. Only one successful D1 query group explicitly reporting
`meta.served_by_primary: true` is accepted; transport, provider, timeout, and
shape errors collapse to the same public failure code. No token, provider body,
row payload, or local path enters command output.
