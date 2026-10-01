# Signed finite window — current source integration

Status: **source integration has combined passing evidence after a narrow
test-only continuation**. The original interrupted gate remains failed. No clean
uninterrupted gate or managed runtime activation is claimed. Managed admission remains
closed and `runtimeEnforced:false`. No installation signing key, CNPG injection,
new schema, provider write or regional rollout is part of this delivery.

## Current-authority correction

The private issuance endpoint and protected Linux signed startup are integrated
from the previously held candidate. The [standalone native lifecycle proof](m6-signed-window-native-2026-10-01.md)
uses the unchanged static guard binary. Original failed startup fixtures and the
[old-base gate](m6-signed-execution-window-held-2026-09-30.md) remain historical.
They are not relabeled as a current mainline gate.

One existing Worker story is materially expanded. It records actual D1 read
results by exact statements, bound values and method arguments, performs a real
Ed25519 signature and commits a real actor-scope revocation. A reused session can
then receive the captured pre-revocation results; direct database reads remain
real. A sampled caller wall time is held constant only to preserve identical
history-query bindings. D1's authoritative clock and all lease/funding checks
remain unmodified. No successful authority rows or grants are invented.

An initial harness run fails its primary-read assertion because the history
query's caller timestamp changes. That noncausal 3.037-second result is retained.
The corrected regression fails meaningfully in **2.865 seconds**: the old route
returns `201` after revocation when `409` is required. The correction replaces
only the route's reused first-primary session with the direct D1 binding. Every
helper, final proof and original-fence required-until recheck uses that binding.
The same regression now requires `409`, no permit, actual fresh reads, no stale
reads and byte-identical reservation/count. Named Worker/funding checks pass in
**34.471 seconds**; the named signed Go case also passes.

This is a faithful simulated stale-session routing proof, not a forced live
Cloudflare replica race. Final authority is sampled, not continuous atomic
revocation: a subsequent change can coexist with an already issued finite window.

## Test budget and integration gate

The original coherent feature retains three stories total: one Worker, one Go
and the existing native Linux lifecycle case. This continuation adds no fourth
story, matrix, permutations or speculative suite. The current public baseline
advanced since the original candidate; one frozen current-integration gate is
required. It does not repeat the gate of that different old-base candidate.

The frozen final gate runs once in **46.887 seconds**. Format, lint and typecheck
pass. Worker tests report **51 passed, one failed, 52 total**. The existing
`organization-tokens.test.ts` historical-credential story compares the complete
D1 query result; only its `meta.duration` differs (`1` versus `0`). Business rows
are identical. That is an observed nondeterministic fixture assertion, not a
failure in signed issuance. Nevertheless the full gate is failed, not green;
Node and whole-guard gate stages do not run. The named signed Go result above
remains targeted evidence only.

On goal resumption, only the existing no-mutation assertion is corrected: both
reads must succeed and all ordered `SELECT *` business rows/fields must remain
identical. Timing metadata is excluded. No product implementation, test story,
row predicate, credential assertion or refusal is changed. The named three-case
file passes in **2.405 seconds**; its named format/lint checks pass. The previously
unrun Node and whole-guard stages then pass once: **60 Node cases** and **three Go
cases**, within a **13.498-second** continuation including the named checks.

Combined evidence covers the **52 Worker, 60 Node and three Go cases** with the
original successful format/lint/typecheck stages. The sole post-freeze executable
diff is this existing test's metadata comparison. The original failed gate is
retained and no whole gate repeats. This is a disclosed interrupted qualification,
not a clean uninterrupted final gate. Source promotion does not activate the
runtime, generate signing keys or authorize customer admission.

Private results remain under `.local/evidence/signed-window-integration/`. Environment
files remain local, ignored, untracked and mode0600; publication scans compare
actual private values and encoded variants without printing them.

## Remaining activation requirements

The endpoint consumes existing funding, without extending it or granting physical
capacity. Its initial permit is at most 14 seconds; transport consumes the guard's
original local BOOTTIME window. Responses remain `pending_runtime`.

Before managed admission, qualify protected configuration/key delivery, trusted
actual Pod/Node/image bindings, external transport, CNPG/Pooler/Barman coverage,
physical compute/storage reservation, durable funded renewal/run handoff, final
usage and disposition of the saturated noncanonical usage queue. The local
signed primitive supplies none of those missing installation guarantees.
