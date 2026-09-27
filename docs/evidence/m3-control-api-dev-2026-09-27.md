# M3 control API development checkpoint — 2026-09-27

Status: **one deployed control-plane slice, not PostgreSQL provisioning**. This record omits account IDs, database IDs, organization/project IDs, access tokens, and other credentials.

## Code and verification

- The first generic control API was published from commit `3323ba7`. Its focused Worker test file had five passing tests, including organization isolation, project idempotency, bounded request-body reading, and bootstrap credential recovery. No Node-only test existed yet; `test:node` completed with zero tests and was not counted as functional proof.
- The final candidate passed format, lint, typecheck, Vitest, and `test:node` in one full gate. A Git whitespace check passed with a path-scoped exception for Wrangler's unmodified generated runtime declarations. A check against the ignored local credential values found no match in the staged public files.
- The public GitHub commit and selected source, schema, contract, and M1 evidence files were read back and matched the local files. The remote file tree contained no `.env*` or `.dev.vars*` file.

## Cloudflare development readback

- A dedicated EU-jurisdiction D1 database received migration `0001_control.sql`. Wrangler reported no migration left to apply, and a primary database read returned the five expected application tables.
- A separate Dev Worker was deployed under a project-specific name. Wrangler readback returned its version and listed the dedicated `INSTALLATION_BOOTSTRAP_TOKEN` as `secret_text`. No Contabo credential or Cloudflare API token was supplied to the Worker.
- An ordinary HTTP client received `401 unauthorized` without credentials. With the installation secret, the API created and then listed one development organization. Its scoped organization token was stored only in an ignored, owner-readable local file.
- Project creation returned HTTP `202` with a `pending` project and `queued` operation. Repeating the identical idempotency key and body preserved both IDs; changing the body under that key returned `409 idempotency_conflict`. Authorized project and operation reads returned those same pending states.

## Still open

There is no regional reconciler, no CloudNativePG database behind this project, no native SQL endpoint, and no completion transition for the queued operation. A Python HTTP client was blocked upstream by a Cloudflare browser-signature rule while a standard `curl` request reached the Worker; client compatibility and edge policy need review before broader use. The Chrome extension also blocked direct navigation to the workers.dev API route; no browser security control was changed.

Next proof: an authenticated regional controller must consume the queued intent, provision one isolated PostgreSQL environment, record observed completion, and expose a native connection without introducing customer-specific branches. M1 Talos/Contabo, volume, backup, and restore gates remain open.
