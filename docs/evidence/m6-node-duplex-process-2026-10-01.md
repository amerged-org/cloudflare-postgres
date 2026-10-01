# Retained node execution-delivery process

Status: source and local artifact qualification. The regional WebSocket factory
and complete broker are not implemented by this checkpoint. No provider resource,
installation signing key, real node agent or CNPG guard is activated.

## Implementation and corrections

A separate delivery binary/image now holds one original filesystem exchange
across challenge emission, issuer wait, exact signed response validation and
publication receipt. The read-only observer binary/profile is unchanged.
The length-prefixed protocol has a 16 KiB frame limit, strict UTF-8/duplicate-key
parsing, closed typed frames, self/scope/request/hash binding, original boot
anchor and a ten-second command deadline. It reuses the existing execution-guard
parser, serializer, key-pin/expected-manifest parsing and signature verifier.

Integration reveals that the prior expected map encoding does not match the
actual guard's typed `SignedChallenge` output. The native fixture now uses that
actual producer; it fails first, then passes after the expectation uses the same
first-party serializer. No new relaxed JSON comparison is introduced.

The first protocol implementation also exposes the shared parser's missing
boolean transport tokens. Boolean tokens are now supported for `emptyDir`;
signed manifest/permit field schemas retain their existing explicit types and
closed fields. An independent source review identifies inherited blocking Exec
pipes as a distinct deadline problem. The actual child-process case fails with
unsupported inherited stdin, then passes after duplication, nonblocking setup
and owned pollable wrappers. Ordinary files/TTYs are refused.

The node verifies the signed key ID, nonce and complete execution binding before
publication. It checks the original boot anchor and shorter signed/ten-second
window without resetting it for a slow issuer. This bounded offline grant cannot
observe every later Cloudflare policy revocation. Receipt errors after visibility
remain uncertain and never prove that compute was stopped.

## Evidence and bounded test count

The task adds two Go stories: retained challenged custody with the independent
public signed fixture, and a real inherited-pipe child that expires with stdin
still open. One existing native publication story is materially expanded to use
the actual guard producer. All three fail first for their respective behavior.
The three-story budget is exhausted; no matrix or hidden additional case is added.

The current two Go stories pass on macOS and in one isolated Linux/AMD64
invocation; the latter completes in 0.556 seconds. The expanded native publication
passes in 0.319 seconds with actual private ownership, unchanged inode replay and
changed-request refusal. The Linux runs use a dependency runtime fixture, not
actual node CRI. Exact container-label checks verify cleanup absence.

The initial pipe harness timeout (5.481 seconds), removed unused import,
boolean-token stop and inherited-pipe semantic failure remain retained. A harness
stop is not the red-first proof. No result is silently reset or relabeled green.

Separate Linux/AMD64 image builds pass: observer in 121.465 seconds and the final
delivery image in 80.700 seconds. The earlier delivery build is retained, then
replaced after the final framing/cancellation changes. Both preserve pinned
dependency notices and the first-party Apache-2.0 license. Image build context
uses the explicit public-input allowlist; no local environment/cache/evidence
path is admitted.

The one frozen gate passes all eight stages: format, lint, typecheck, 52 Worker,
62 Node and eleven Go cases, plus Linux source vet. Stage time totals 63.452
seconds. The two delivery cases also have explicit Linux evidence above; the
expanded native publication is qualified separately. No gate repeats. Only this
checkpoint and PLAN.md change afterward to record results; runtime bytes remain
identical to the frozen candidate.

Readback of both built images confirms each contains only its intended binary,
preserves the exact first-party module license and contains the pinned dependency
notice inventory. Inspection containers are removed with exact label checks.
Before and after the gate, both local credential files remain byte-identical,
mode `0600`, ignored/untracked, with zero private-value matches across all 553
candidate files. Credentials and private evidence stay outside public delivery.

## Remaining work

Implement the regional authenticated full-duplex Kubernetes transport with the
separate delivery peer/recipe validator, current lease/funding/Pod checks, one
issuer call, matching receipt, final successful Exec/status/closure and unchanged
peer identity. Keep stdin open through receipt because the pinned v4 client
closes the WebSocket on stdin end. A disconnect after sending the permit remains
uncertain; it must not mint another permit or replay uncertain SQL.

Verify the actual mounted-filesystem layout, nonroot guard/capability recipe,
installation key provenance, all-container issuer recipes, renewal/admission and
native CNPG lifecycle. The example deployment is unapplied. Managed admission
remains closed and runtime-enforcement flags remain false/pending.
