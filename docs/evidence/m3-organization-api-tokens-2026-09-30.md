# Organization API-token lifecycle — 2026-09-30

Status: source qualified; public delivery and Dev qualification pending.

## Result

The [contract](../contracts/organization-api-tokens-v1.md) completes individual
installation-owned credential issuance/replay, redacted metadata discovery and
selective revocation using the existing organization/token schema. OpenAPI adds
four operations and four reusable response/scope schemas. Emergency bulk reissue
remains unchanged. There is no customer billing, schema/dependency change, secret
creation or runtime admission change.

Caller UUID and exact scope set identify stable issuance. Purpose/key-version
HKDF separation supplies an HMAC subkey from the existing retained credential
master; D1 stores only the credential digest. Unknown insert replies reconcile
the committed winning row. Historical replay matches at most eight retained
versions and rechecks active primary authority before disclosure. Missing history,
changed scopes, revoked rows and legacy random credentials fail closed without
rewriting authority. Metadata and revocation work without issuance keys.

## Bounded verification

Exactly three new top-level Worker stories fail meaningfully against a loadable
scaffold in 6.000 seconds, then pass their first implementation candidate in
2.940 seconds. They cover uncertain committed issuance and actual scope use;
metadata/cursor parent ownership and selective revocation before a streamed
project commit; and historical replay across key rotation with immutable refusal.
Independent source review finds no blocking implementation issue. A focused type
check initially reports two new Workers typing issues; explicit buffer ownership
and decoder configuration correct them. That initial failure is retained.

The one frozen canonical gate takes 56.314 seconds: format 3.178, lint 3.870,
typecheck 4.023 and all 49 Worker cases 36.218 seconds pass. Node verification
passes 57/60 cases and stops after 8.981 seconds because the three existing
platform-inspection cases cannot locate `dist/main.js` in the fresh worktree.
No runtime source changes. One existing controller build passes in 2.584 seconds;
only the same platform-inspection file passes its three cases in 1.799 seconds.
There is no repeated broad gate. Combined evidence covers 49 Worker/60 Node cases
and six unchanged Go cases (115), with only three cases added by this feature.
The initial gate remains a disclosed interrupted run, not a clean full-gate claim.

OpenAPI parses with 77 unique operation IDs and zero unresolved references.
The initial documentation-check invocation used an obsolete parser entry path;
normal package resolution corrects that harness mistake without source changes.
Public input scanning finds zero actual credential matches. AGENTS retains exactly
25 lines; private environment files remain mode 0600, ignored/untracked and byte
identical. The signed main draft and held scheduled-control-backup source are
unchanged. Runtime source is frozen separately from subsequent delivery prose.

## Delivery limits

Actual Dev issuance, HTTP replay/scope refusal, selective revocation and control
state preservation still require live observation. No native database access,
PostgreSQL backup/PITR, funding/capacity guard or SDK qualifier is resumed. The
existing control restorer retains the credential ring but does not establish
API replay-key completeness or safe control activation after disaster recovery.
