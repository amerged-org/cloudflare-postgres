# Native Pod retirement checkpoint

The optional operator lane now couples durable original Pod capture, guarded retention and native termination evidence to the existing Suspend executor. It removes no retention guard until the original receipt is persisted and current Pod/container facts still match. Environment completion, runtime enforcement and final accounting remain unimplemented gates.

## Bounded implementation evidence

The baseline is 63 automated cases. Exactly three new independently reported cases cover the change: two Node cases and one real Talos/CNPG lifecycle qualification. Both Node cases fail meaningfully first, then pass. Material review findings (cached contradictory state, stale evidence and later SDK status drift) each fail inside those same cases and pass one narrow correction. No matrix, permutation or new speculative cases are added.

The native case first demonstrates missing retention against an actual ready disposable Cluster with a durable original roster and no mutation. The first integrated acknowledgement remains pending because Kubernetes normally garbage-collected all stopped CRI objects while preserving the guarded API Pod. A read-only diagnosis verifies complete runtime absence, fresh identity and no unseen namespace UID. That concrete state fails in the existing case, then a narrow reviewed correction accepts only complete absence alongside the same complete API termination facts. Partial remnants retain full correlation. The second native candidate succeeds in 1.607 seconds; no third candidate or old held qualifier runs.

The frozen canonical gate runs once in 16.774 seconds: format, lint, typecheck, 26 Worker cases and 33 Node cases pass. Six unchanged Go cases retain prior evidence instead of being rerun. Automated coverage totals 65 cases plus this native qualification. A narrow pre-gate TypeScript closure-narrowing correction passes the subsequent build; no broad gate is repeated.

## Actual isolated lifecycle

The original Node UID/boot and immutable cohort are sealed before any test Cluster compute. A new isolated PG18.4/CNPG Cluster uses one 5Gi Retain volume and bounded resources, with no Barman/R2 dependency or customer API admission change. A SQL marker commits before the stop. The original Pod roster persists before any own finalizer/hibernation effect.

The quota closes new Pod admission; CNPG performs its normal ordered shutdown. The same Pod remains deleting/Succeeded with all regular and initialization containers Terminated. A complete authenticated node-runtime observation and the retained API facts produce a durable receipt before the guard is removed. Original namespace/Cluster/quota/cohort/spec and retained volume identity remain matched. API compute convergence follows; no completed environment result or final usage is published.

A separate explicit same-Cluster-UID restart of only this disposable fixture confirms the original SQL marker remains readable. This is data-persistence evidence, not qualified funded resume or run handoff. All 29 pre-existing active Pod UIDs and four original volume identities are preserved. One private count display initially reused the volume-loop variable; offline comparison corrects it to 29 without another resume or probe. Fixture cleanup removes only its exact owned Namespace; the new 5Gi Retain volume is kept, never treated as customer storage eligible for deletion.

The ignored environment and all 22 held SDK files remain protected. Production birth/admission completeness, original-node loss handling, independent funded expiry, public artifact distribution, actual customer API/SQL and final accounting remain open. See [the contract](../contracts/pod-retirement-v1.md).

## Dev delivery

Runtime source `a608f794c816752cd59ad9f0c2a4a2273b054107` is pushed, and matching source/contract/plan bytes are read back from GitHub. One regional image builds from exactly 61 public inputs in 41.891 seconds. It is imported once; its cached approved repository-index reference is verified before one UID/resourceVersion/old-image-guarded image-only replacement. All 53 compiled JavaScript modules match, with current deployment availability and zero Pod restarts.

The final rollout preserves 28 non-controller active Pods, all original four volumes plus the retained test PV, and both original lab SQL markers. No default controller RBAC, Cloudflare schema/Secret or operator configuration is changed. The new retirement lane stays explicitly disabled in the running default configuration. Production history/admission and funded enforcement gates remain open.
