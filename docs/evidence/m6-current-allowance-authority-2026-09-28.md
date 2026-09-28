# Current allowance authority and normal stop checkpoint — 2026-09-28

This checkpoint adds generic current-authority reads and an explicit regional normal-stop mode. It does not complete M6, enable region admission or claim an independent hard budget cap.

## Published implementation

Source commit [`9b47f289163d9169446856c0dfb7ee04a797c540`](https://github.com/amerged-org/cloudflare-postgres/commit/9b47f289163d9169446856c0dfb7ee04a797c540) contains the [protocol](../contracts/runtime-allowance-authority-v1.md), current control-API route, durable allowance journal, bounded supervisor, official Kubernetes client adapter and operator CLI/configuration example. All 15 changed/new public files were read back byte-for-byte from GitHub at this commit. First-party code remains Apache-2.0; no new upstream source or dependency was introduced.

Historical reservation receipts remain immutable accounting records. The separate current-authority route reads trusted project/environment/spec identity, policy/account/epoch bindings, all limited dimensions and funding through a consistent primary D1 snapshot with drift guards. An allow decision lasts at most 15 seconds and never exceeds receipt expiry or policy-period end. This is bounded revocation delay, not immediate revocation or a signed offline permit. Zero remaining balance does not invalidate already reserved, funded work.

The separate `supervise-allowance --config <absolute-path>` mode persists a stable request before transport, resolves a lost response through that same request and preserves original receipt expiry across restart. It includes all limited resource dimensions; missing RAM funding cannot authorize nonzero RAM allocation. The default five-second loop requires an operator-owned process supervisor. `--once` is an observation mode, not continuing expiry enforcement.

On authority loss, owned conditional patches close namespace Pod growth and request CNPG hibernation. A lost response is resolved by readback. Stopped requires absent owned database Pods and unchanged bound Retain volumes. The mode does not automatically resume, fabricate final usage, release reserved units or settle a receipt. It is separate from the default environment controller and is not automatically activated for new environments.

## Bounded verification

Exactly three new top-level tests cover:

- Current funded authority through pause, epoch change and expiry, including trusted project identity and a zero-valued limited RAM dimension.
- Durable lost reservation response/restart with the same request, receipt, sealed environment and original deadline.
- Unfunded limited RAM causing an owned normal stop that stays stopped through cache expiry and control outage, resolves a lost committed patch and preserves volume bindings.

Each case failed meaningfully before implementation. Review identified missing trusted project/limited-dimension fields; the same existing cases were expanded and failed again before the second bounded repair. Both source paths passed their second repair; no third repair, matrix or speculative suite was added. Targeted regional cases and package build passed. Independent read-only reviews passed the correction delta, documentation links, license markers and Docker build allowlist.

The frozen candidate passed one uninterrupted canonical gate: format, lint, typecheck, Vitest and Node tests, in 17.951 seconds. All 17 Worker and 14 Node cases passed, totaling 31 versus the previous 28. Frozen file hashes were unchanged. No second full gate was run. Local Node runtime evidence is distinct from qualification of the pinned production image and real journal/storage mount.

## Dev deployment and readback

The existing Dev Worker was updated from the published source in 11.760 seconds. No schema migration, new Cloudflare resource, region-admission change, database mutation or regional image rollout was performed. Read-only HTTP probes verified anonymous authority access returns 401, the region executor receives 404 for an absent receipt, and the same executor receives 404 for a foreign region.

Pre/post D1 reads agree: one organization, one project, zero API-managed environments, zero usage facts, zero allowance reservations, one budget target and zero open regions. Foreign-key checking returned no violations. The initial read-only preflight used an incorrect admission column and failed; the corrected schema-based query passed before deployment. No failed query is reported as successful evidence.

These probes qualify routing and credential boundaries only. There is no live positive allowance, receipt encryption/replay, settlement, normal PostgreSQL stop, workload-local expiry or overshoot evidence. The existing Dev collector remains on its separately qualified previous image. Private credentials/configuration/evidence are excluded from Git and container contexts.

## Remaining acceptance gates

`runtimeEnforced: false` and `enforcementStatus: pending_runtime` remain authoritative. Complete/final accounting, accepted usage references and settlement; gateway admission/draining; independent workload-local expiry when the supervisor, Kubernetes or CNPG fails; restart/node-loss recovery; retained storage accounting; bounded overshoot; and API-managed installation qualification remain required. Budgets preserve customer data. Automatic resume, sleep/wake and scaling still need their own authorization and lifecycle contracts.
