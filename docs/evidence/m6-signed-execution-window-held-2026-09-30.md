# Signed finite execution window candidate — 2026-09-30

Historical status at this checkpoint: **held; not published or deployed**.
The user later removed the retry cap. The [native continuation](m6-signed-window-native-2026-10-01.md)
and [current source integration](m6-signed-window-integration-2026-10-01.md) supersede
that hold; the original failures and gate below remain unchanged.

 The candidate adds a generic private
Ed25519 issuer over existing provisioning funding and an explicit signed Linux
PID1 lane. The [contract](../contracts/signed-execution-window-v2.md) distinguishes
implemented checks from installation evidence. No signing key was generated,
no Worker Secret or schema changed, no CNPG guard activated and no held backup,
birth, native-access or maintenance qualification resumed. Admission remains
closed; `runtimeEnforced` remains false.

## Bounded source evidence

Exactly two new automated top-level stories were added: one Worker and one Go.
The one separate real Linux lifecycle story is the third counted case. No matrix,
permutation, speculative suite or Node testcase was added.

The Worker story failed meaningfully on the missing real route (`404` versus
`201`, 1.50 seconds). Its first implementation passed in 1.81 seconds; a selected
typecheck stopped on a fixture TextDecoder option. The same story passed the
combined correction in 1.68 seconds. It checks independent public RFC 8032 bytes,
authoritative funding bindings and revocation during signing without renewing
or changing the reservation. The issuer derives duration from guarded D1 clock
samples, retains its original deadline and refuses changed authority or work
exceeding its one-second issuance reserve.

The Go story failed meaningfully in 5.149 seconds because valid signed evidence
did not enter the maintained supervisor. Its first implementation check remained
red in 1.073 seconds: the inherited fake manager exited immediately, so the
supervisor correctly stopped early. A fixture-only lifetime correction preserves
the intended original-anchor assertion; attempt two passes in 0.690 seconds.
The production supervisor is unchanged. A source review correction checks native
boot/expiry/grace after custody reads, immediately before launch. Explicit signed
context refuses the unsigned operator lane. These are mocked process-system
checks, not proof of the actual protected Linux startup path.

The frozen canonical gate ran exactly once and passed in **59.679 seconds**:
format, lint, typecheck, 41 Worker cases, 59 Node cases, and the additional
execution-guard check with three Go cases. Four unchanged observer cases retain
prior evidence. The checked public candidate stayed unchanged during the gate.
No broad gate was rerun after the runtime stop.

## Real Linux qualification stop

The original Linux RED uses the previous qualified immutable AMD64 guard: its
native clock command succeeds, but the new signed CLI does not emit a challenge
(0.793 seconds). This proves the protocol is absent from that older artifact;
it does not qualify the new implementation.

The new static Linux/AMD64 binary was built once from the frozen public Go inputs
in 1.383 seconds, with no credential-bearing build environment. Its SHA-256 is
`9415ff7a8fe1f4bc4524d0f98307a069be8a90f9fcc8338fe3ba22f9d955db88`.
The isolated fixture reuses the previously verified public regional image
manifest `07084dd6959043b3f1b2c1455f53cb6e911b464b4488391eadd7b3ff97262910`;
the binary and synthetic manifest/key are mounted separately. Network is disabled,
the root filesystem is read-only, capabilities are dropped and no existing
Contabo workload is involved.

Candidate one stops before a challenge in **0.699 seconds**. One fixture correction
sets an accessible root working directory because the reused image's `/app` is
private to UID1000 while the fixture runs as UID501. It also preserves both Docker
log streams; the original checker and first failure remain retained. This fixes
an observed Node fixture problem, without establishing the cause of guard refusal.
Candidate two still stops before a challenge in **0.917 seconds**, reporting only
`execution_guard_failed`. No attempt directory or manager process is observed.

The mandatory two-attempt limit is reached. **No third qualifier, source fix,
publication or deployment follows.** Delayed receipt, namespace cleanup and old
nonce restart refusal are still unqualified for this signed candidate. No Linux
GREEN, funded customer run, physical stop or full budget-enforcement claim is made.

Read-only diagnostic observations confirm input parsing, owner/private modes,
regular single-link files, stable sampled file metadata, a native boot read and
PID1 in a separate diagnostic container. They do not prove every check inside
the failed guard execution. The smallest next diagnostic is to identify its
exact pre-exchange refusal under a separately bounded scope; an additional
qualification attempt is not implied.

## Custody and retained scope

Local `.env.local` and `apps/control-api/.dev.vars` remain ignored, untracked and
mode0600. Before publication review, 22 sensitive assignments and 65 distinct
variants have no matches in 472 candidate public files. Their bytes are preserved;
no credentials, test installation key or provider data are published.

Synthetic RFC 8032 fixtures cannot authorize a real installation. Pod/Node and
command claims remain protected operator assertions, not hardware attestation.
Immutable manifest/public-key delivery, CNPG injection, reliable external
transport, workload admission, continuous renewal/run handoff, scheduler/storage
stopping, finalized usage and recovery remain required.

Private evidence is retained under `.local/evidence/signed-execution-window/`
and `.local/evidence/runtime-permit/api/`, including original RED, both Go checks,
the one gate, binary build, original/corrected Linux checkers and both runtime
stops. This checkpoint records a local candidate; the public repository and Dev
Worker still use the previous delivered revision.
