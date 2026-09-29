# Archive and retrieve an encrypted control recovery bundle

This operator workflow adds remote custody of an already verified encrypted
[control recovery bundle](../contracts/control-recovery-v1.md). It reuses Wrangler
and an adopter's existing authenticated Cloudflare session. It creates no S3
credential, changes no Worker or D1 state, and supplies no permission to customer
Pods. Barman/PostgreSQL backup access remains a separate workflow.

## Prepare explicit private custody

Create a new mode-0700 operator directory and use `umask 077`. Keep the bundle,
configuration, checksum receipt, download, migration files and recovery key
private. The bundle contains encrypted snapshot/keyrings; upload neither the
plaintext snapshot nor a plaintext keyring or recovery key. Record its SHA-256,
byte length, source identity, trusted source revision and migration-file hashes
before upload. Preserve that receipt independently of the object store.

Use a private strict JSON Wrangler configuration with the intended `account_id`
and a separate zero-byte mode-0600 environment file. Put both in the private
operator directory, away from repository environment files. The CLI uses the
invoking operator's trusted existing session. Exclude ambient `CF_*` and
`CLOUDFLARE_*` credential variables when selecting that session; do not load an
application's `.env.local`. Provider/runtime credentials are not archive inputs.

Confirm the bucket's jurisdiction and private access configuration. An EU bucket
requires `--jurisdiction eu`; explicit `--remote` distinguishes remote objects
from local simulation. Inspect the bucket, its `r2.dev` status and custom domains
before upload. Keep public access disabled.

Use a fresh random object identity under a dedicated `control-recovery/` prefix,
with the bundle digest in its key. Never reuse a key for a new bundle. Wrangler's
`put` is not a conditional write-once guarantee: a prior missing-object check is
not atomic against another trusted writer. Coordinate operator ownership or use
separately qualified conditional/object-lock handling before promising immutable
archives. This workflow does not change bucket locks or retention.

## Upload and fetch the encrypted artifact

Replace every path/key/account placeholder with the selected private operator
configuration. Use the pinned Wrangler version from the trusted checkout. A
representative EU upload is:

```sh
/absolute/checkout/apps/control-api/node_modules/.bin/wrangler r2 object put \
  'BUCKET/control-recovery/RANDOM_ID/BUNDLE_SHA256.bundle' \
  --remote --jurisdiction eu --content-type application/octet-stream \
  --cache-control no-store --file /absolute/private/control.bundle \
  --config /absolute/private/wrangler.jsonc --env-file /absolute/private/empty.env
```

Download into a fresh private path:

```sh
/absolute/checkout/apps/control-api/node_modules/.bin/wrangler r2 object get \
  'BUCKET/control-recovery/RANDOM_ID/BUNDLE_SHA256.bundle' \
  --remote --jurisdiction eu --file /absolute/private/downloaded.bundle \
  --config /absolute/private/wrangler.jsonc --env-file /absolute/private/empty.env
```

Observe each invocation's actual completion. Stop on errors or the documented
execution bound; do not rerun an uncertain upload under a different identity.
Wrangler can create an empty output file before a failed `get`. File existence
alone proves nothing. Require a successful command, private mode, the exact
recorded byte length and SHA-256 before accepting the downloaded artifact. Keep
raw CLI/provider output private.

## Authenticate and reconstruct from the downloaded bundle

Use `recover-control` action `restore` with `archivePath` set to the newly
**downloaded** file, the expected source identity, the independently retained
recovery key, a fresh target directory and the matching trusted migration set.
The [operator configuration](../../apps/regional-controller/README.md#control-recovery-artifacts)
describes its exact fields. Preserve historical migration files across updates:
a 14-migration bundle cannot be restored against an unrelated 15-migration set.
Only independently trusted source SQL supplies reconstruction authority.

Require authenticated source/bundle, exact state reconstruction, foreign-key and
integrity checks, credential-key verification and the completed manifest. Keep
partial directories unverified; never overwrite them to force a retry. The result
remains `activationSupported: false`. No tokens, leases or operations are renewed
or replayed, and no rebuilt database is connected to regional controllers.

Remote ciphertext custody reduces dependence on one workstation's disk. Complete
disaster recovery still needs independent recoverable key/receipt/source custody,
fresh bootstrap, global fencing and external-state reconciliation. An upload or
local restore does not establish those requirements, a recovery-time objective,
retention safety or PostgreSQL physical backup/PITR.

Sources: [Wrangler R2 commands](https://developers.cloudflare.com/r2/reference/wrangler-commands/),
[R2 jurisdictions](https://developers.cloudflare.com/r2/reference/data-location/).
