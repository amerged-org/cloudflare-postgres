# Organization API-token lifecycle — 2026-09-30

Status: implemented, public and qualified in Dev.

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

## Actual transport correction and Dev delivery

Initial source `6bdbfe31f637a6728e86f7153d382cba26cf2588` is published and all
its eight changed files are read back byte-for-byte from public GitHub. Its first
Dev rollout is observed at the expected source. The first live qualification
creates two scoped probe credentials and one ordinary logical project, then
finds real empty DELETE bodies arrive as an existing, empty stream. The original
item guard rejects them; both targeted cleanup attempts also return 400. This
failure is retained and no original credential is revoked.

Only the existing selective-revocation story is expanded with the concrete wire
shape; no cases are added. It fails first in 2.140 seconds and passes the single
body-validation correction in 1.700 seconds. The corrected handler proves EOF
before token access, refuses supplied data and cancels/releases its reader.
A preparation invocation first uses a wrong relative fixture path and therefore
runs the unchanged green file; its log is explicitly excluded from red evidence.

The frozen wire correction runs one full canonical gate, passing all five stages
in 56.638 seconds: format 2.610, lint 4.366, typecheck 3.890, 49 Worker cases 36.602
and 60 Node cases 9.125 seconds. Source stays byte-identical through the gate;
six unchanged Go cases retain prior evidence. Runtime correction
`15355c5099edecce87718507c79a6ee118f74a54` and both changed files are publicly
read back. Its credential-free bundle contains zero matches among 82 private
credential variants. No second gate is claimed for the original candidate; this
separate live-transport correction retains all predecessor failures.

One same-config correction rollout completes in 10.354 seconds. Dev Worker
`27298f02-79c0-4e97-b0a6-6583ea88f10d` receives 100% traffic with the same D1/R2
bindings and nine original Secret names. No migration, new Secret, regional image
or Kubernetes/Talos mutation occurs.

The same-resource live continuation passes 23 HTTP observations in 8.350 seconds.
It reuses the two original caller UUIDs and the original project idempotency key;
it creates no further resource. Exact secret replay returns 200; read-only access
returns 200 and its attempted project write returns 403; scoped write replays the
same logical project; repeated revocation preserves its timestamp; revoked
credentials return 401; changed scopes return 409. Metadata exposes neither
plaintext nor hashes. The sibling reader and original credential continue serving
while the writer is revoked; the reader probe is then revoked too.

D1 now contains three API-token history rows (two revoked probes, original active)
and two logical projects. Exactly one project operation and idempotency row were
added; every other control-table count, all 18 migrations and zero managed
environments remain unchanged. Admission remains closed. Both private environment
files remain byte-identical and ignored/untracked. The retained logical project is
an ordinary generic API artifact, not a customer-specific runtime exception.

## Delivery limits

No native database access,
PostgreSQL backup/PITR, funding/capacity guard or SDK qualifier is resumed. The
existing control restorer retains the credential ring but does not establish
API replay-key completeness or safe control activation after disaster recovery.
