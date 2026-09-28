# Database roles and credential rotation checkpoint — 2026-09-29

This checkpoint implements a generic login-role lifecycle through the Cloudflare management API and regional CloudNativePG controller. It does not complete M2/M3, enable regional admission or prove a usable public PostgreSQL endpoint.

## Published behavior

Source commit [`b3b8f856b524a4193e69e1cbe19b9f8964dd38d4`](https://github.com/amerged-org/cloudflare-postgres/commit/b3b8f856b524a4193e69e1cbe19b9f8964dd38d4) supplies the [contract](../contracts/database-role-credentials-v1.md), additive migration `0009`, customer create/read/reveal/rotate routes, independent fenced regional role tasks and CNPG/driver adapters. All 21 public files were read back byte-for-byte from GitHub. The existing environment-create protocol remains separate.

The API derives organization/project/environment/region/spec/accepted Cluster identity from existing ready state. It accepts restricted role names and connection limits, not backend URLs, administrative DSNs or arbitrary privilege settings. Metadata reads use organization read scope; creation, rotation and password disclosure require write scope. Reserved roles and privileged attributes are not customer inputs. One active role operation and expected credential revision prevent overlapping rotation.

Passwords are generated server-side and AES-256-GCM encrypted before D1 persistence. Authenticated encryption binds the exact trusted identity and credential revision. `ROLE_CREDENTIAL_KEYS` is a dedicated Worker Secret, separate from provider and allowance secrets. Only the latest verified, applied revision can be disclosed. Immutable intentions and historical result replay preserve operation identity without overwriting a newer role. Plaintext passwords exist transiently in authorized disclosure and trusted regional claims, and in the workload's immutable Kubernetes credential Secret; they are not persisted as plaintext control data.

The default controller adds a separate role lane. Operators must supply the new `roleVerifier` selection and mounted region-token file before upgrading; the [regional README](../../apps/regional-controller/README.md) documents this configuration migration. Each revision has its own immutable basic-auth Secret and a stable restricted DatabaseRole. Conditional UID/resource-version patches and monotonic revision checks prevent stale rollback. CNPG applied/current generation/exact Secret resourceVersion must agree before a fresh password-authenticated connection with verified CA/hostname, expected user/database, writable primary and restricted-role checks. Rotation additionally requires a separate old-password login to fail specifically with `28P01`. Network/TLS/unknown errors defer rather than becoming invalidation proof.

This creates a login role, not application-table privileges or database ownership. New database ownership/grant APIs and external direct/pooled endpoints remain required.

## Bounded verification and disclosed stops

Exactly three new top-level cases failed meaningfully first: one Worker create-to-encrypted-intent-to-reveal-to-rotation lifecycle and two regional cases for uncertain owned application/exact readiness and stale/lost-authority refusal. The same first regional case also follows a successful rotation through a lost committed patch; no matrix or extra top-level case was added. Named cases and initial regional build passed on the first candidate. Independent read-only reviews passed API replay/authentication, regional ownership, real CNPG field names, driver configuration/deadlines, license provenance and public build exclusions.

One canonical gate ran. Format and lint passed; typecheck stopped on the root-authored new test's Request generic. A focused test-helper type correction passed its affected checks; the previously unrun Worker stage passed all 18 cases. The previously unrun Node stage then passed 15 of 16 cases and stopped on a new client constructor's TypeScript parameter property during direct source startup. A mechanical constructor correction passed its named startup file and both existing new role cases, affected regional lint/typecheck and build. A formatting-only stop during the test-helper continuation is retained in private evidence. No second full gate ran; this is not an uninterrupted clean-gate claim. All 34 cases have passing evidence across the original stages and targeted continuation. Original stops remain recorded and no same-case third repair occurred.

The installed CNPG `1.30.1` admission accepted a server-side dry-run role with the exact restricted JSON fields. No role or password was persisted by that probe. Local cases use injected Kubernetes and connection-verifier fixtures; they do not establish live CNPG password application or fresh TLS login.

## Control-state safeguard and Dev deployment

Cloudflare rejected the standard D1 export endpoint with authentication code `10000` while ordinary authenticated D1 reads continued working. Before migration, one consistent read statement captured the complete application SQL state: 70 schema objects, 30 application tables and 41 rows. A private local SQLite reconstruction matched the captured schema/data exactly and passed integrity and foreign-key checks. Wrangler file execution initially returned summary counts rather than query rows; command execution returned the snapshot and completed verification. This is an application-state recovery sample, not restoration into a fresh Cloudflare account, backup scheduling, provider-internal metadata export or production key recovery. The standard export permission remains unresolved.

The dedicated role key was generated separately, transferred through stdin and recovered in an owner-private local record. Cloudflare name readback verified it alongside the seven existing platform/provider secret names. The earlier [provider-secret custody transfer](../operations/provider-secret-custody.md) preserved `.env.local`; secret values were never printed or published.

Migration `0009` applied in 1.506 seconds and the existing Dev Worker deployed the published source in 11.634 seconds. Readback confirms the migration record, no foreign-key violations, unchanged prior application counts and empty new role/credential/operation/request tables. There remain one organization, one project, zero API-managed environments/usage facts/allowances and zero open regions. The existing maintenance preparation is preserved.

Live probes verify anonymous/customer-purpose role writes return 401, the legitimate regional executor sees an empty role queue, and the same token receives 404 for another region. They qualify routing and credential boundaries only. No live password, role operation or customer database was issued; current credentials cannot be verified positively while no qualified API-managed environment exists.

## Regional runtime artifact

One Linux amd64 build from the exact published source completed in 41.071 seconds. The build context contained 37 sealed public Git inputs and no `.env.local`, `.dev.vars`, `.local` or private configuration. A network-disabled, read-only, nonroot container confirmed Node `24.21.0`, UID `1000`, `pg@8.23.0` and its retained MIT license. The six compiled role modules and entry point matched host build hashes and imported successfully. These are artifact/runtime-loading checks, not a live PostgreSQL login or application-startup result.

The image reference is `docker.io/library/pgcf-regional-dev:roles-b3be38367e73`, with OCI index `sha256:daca399b7a01ea644f3c72e5e54e68914a19f59fed22ae9bb9da2bed3d0f9ce4` and Linux amd64 manifest `sha256:f8fcffb935e37dfd65eaf4dbff77c5247f144b5cc6b19627d38070bc08d9d2d4`. The private 88,466,432-byte image archive has SHA-256 `09f1d1cf0fdd07519931956f9900fb5d725427b5933aed81587183130bbe1bc2`. Public registry distribution and positive SQL qualification remain distinct gates.

## Dev regional deployment and independent readback

One authenticated Talos image import completed in 10.113 seconds and exact-reference readback matched the sealed artifact. Three fresh UID/resource-version conditional patches added only the verifier configuration, appended two role/dynamic-secret-read RBAC rules while preserving the original nine rules, and replaced only the controller image. All reads matched intended changes; one Recreate rollout completed in 2.029 seconds. No patch or import was replayed and no Pod was deleted directly. The dynamic Secret reads belong to the trusted installation controller; production admission and operator isolation remain required.

Independent read-only qualification passed 22 bounded checks. The current-generation Deployment preserves its UID and intended configuration, and its new Pod runs with zero restarts and the expected image configuration digest. Node `24.21.0`, UID `1000` and all seven selected compiled file hashes match the build artifact. A compiled `RoleClient` from that actual Pod uses the installation origin/region and mounted executor token and returns `{claim: null}` from the new API lane.

The original journal identity, WAL mode, private directory/file permissions and empty outbox are preserved. A new session, advancing checkpoint and explicit restart gap are observed; managed allocation/retained scope remains empty. Node/boot health, 31 non-controller Pod identities with regular/init restart counts, four Bound PVC/PV identities/specifications, the manual database identity/spec/primary and both SQL markers remain unchanged. ConfigMap and RBAC readback matches the reviewed delta. Observer calls were bounded and no debug container, provider call, credential-payload API read or extra live mutation accompanied verification.

The Dev API and role executor are now deployed together. Empty-queue authentication does not establish a customer role's real PostgreSQL password acceptance, old-password rejection or tenant network path. Those positive pilot gates remain open.

## Main checkout and preserved work

The main project checkout was aligned to the published source after copying the previously stopped SDK candidate into a separate ignored local Git worktree based on its original commit. All 22 candidate hashes and modes match the original frozen files; no SDK commit, test retry or new SDK engineering occurred. The main checkout is clean. A duplicate empty-directory cleanup observation interrupted the local archival procedure after its verified copy; the continuation revalidated the archived bytes and clean original base before the fast-forward. Historical stop records are retained.

The earlier local-artifact migration moved 16 directories under ignored `.local/`, updated 30 active path references and preserved 19 historical reference records, 629 relative symlinks and the original `.env.local` file identity/mode. Neither archival nor runtime publication copied the environment file into Git or a container. A scan of all 234 committed source blobs found no matching local token/password/key values. The public `.local/` exclusion was read back from GitHub.

## Open operational gates

Qualify actual CNPG application/rotation, new-password success and old-password rejection, scoped data grants/ownership, real journal/runtime/image deployment, regional network policy, key rotation/recovery, independent restore and end-to-end public native access. Existing sessions can survive password rotation. Budget enforcement remains false and independent expiry, final accounting, settlement, sleep/wake and scaling remain separate v1 work. The stopped SDK and Barman work was not resumed; their original candidates remain preserved separately from this committed source checkout.
