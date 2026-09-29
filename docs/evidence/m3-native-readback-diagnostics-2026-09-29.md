# Bounded native reference-deferral diagnostics

The stopped native operator case reaches policy creation and then withholds its
proof. The archive lacks the immediate before/after reference comparisons, so it
cannot identify the exact failed predicate. Later Cluster and base-policy revision
changes establish possible churn, not the cause of that earlier result.

A read-only audit of the existing manual database confirms the corrected SDK Pod
list/single-read type information and UID/resource-version parity. Namespace,
Cluster and Service reads also agree at that sample. No SQL, credentials, fresh
fixture or third physical attempt is invoked. This does not reconstruct missing
observations from the deleted fixture.

Production `null` is an intentional deferral: the controller loops on the same
authorized operation, reusing its owned resources. The one-pass private qualifier
treated deferral as a failed case. Its two failures remain valid qualification
failures, but they do not prove permanent production provisioning failure.

## Implemented diagnostic boundary

Source commit `c9091c8`, integrated as `3b3bd73`, supplies fixed operator diagnostics
for the first failed existing reference comparison. The categories are namespace,
Cluster, Service, primary, client, certificate, routing and policy reference change.
The production controller emits the fixed
`native_readback_deferred_<category>` event through its existing logger.

Each native reconciliation invocation emits at most one category when a covered
reference comparison fails. No UID, resource version, namespace, path, certificate,
configuration, credential, lease or arbitrary exception body is logged. There is
no customer response or persistent control-state schema change.

The diagnostic returns the original Boolean predicate. All reads still occur in
the same order; the final policy mismatch still short-circuits later reference
reads. UID/resource-version, ownership, specification, epoch and authorization
fences remain intact. `null` still withholds proof and preserves existing owned
retry behavior. Only a diagnostic sink exception is caught; logging failure cannot
change readiness or hide a backend/authorization failure.

## Bounded source checks

One existing convergence case is expanded with a changed owned-policy revision
and an unavailable diagnostic sink. One new case changes the Cluster revision
after policy creation. Both previously withheld proof but supplied no diagnostic,
giving meaningful red evidence in 0.298 seconds. They pass on implementation
attempt one in 0.250 seconds, together with the unchanged refusal case. Original
ownership/retry/legacy assertions remain; no matrix or extra suite is introduced.

Independent source review verifies identical acceptance predicates, comparison
ordering, bounded event values and production wiring. The frozen canonical gate
passes exactly once in 26.184 seconds: format, lint, typecheck, 28 Worker cases and
47 Node cases. Six unchanged Go cases retain their earlier evidence. The baseline
of 80 becomes 81 through exactly one new top-level case.

## Delivery status and limits

One nonroot AMD64 image builds in 30.743 seconds from 74 sealed public Git inputs,
without private environment files or artifacts. Its 66 compiled modules and fixed
production log prefix are checked. One authenticated, 120-second-bounded image
import succeeds in 11.245 seconds; exact cached tag/index readback precedes one
guarded image-only patch in 0.194 seconds and Ready rollout in 1.101 seconds.
The actual configuration digest and all 66 running module hashes match the image.
No native fixture is used to trigger the new event path.

Node identity/boot, 28 other Running Pod identities/restarts, four PVC/five PV
specs, source Cluster and both SQL markers are preserved. All 4,096 journal
entries and full/projection/identity fingerprints remain exact, with schema two
and zero accepted facts. The existing delivery diagnostic still binds the same
head. Configuration and all 16 RBAC rules remain unchanged; native client profiles
remain absent. Worker, Cloudflare, D1, Secret and compatibility configuration are
not changed. Known local credential values and encodings are scanned before
publication, and local environment files remain private, ignored and unchanged.

The diagnostic does not assert which comparison failed in the original case. It
does not loosen a fence, grant access, establish packet/TLS/SQL success or reopen
the stopped physical qualifier. Native profiles and customer admission remain
disabled, and the pending R2 and other held operations remain untouched.

The full requirements in [PLAN.md](../../PLAN.md), including a qualified native
pilot and backup/PITR, remain incomplete.
