# Explicit compute suspension checkpoint — 2026-09-29

Source [`56764c288a521fc5531fa0cf33d6416429fbbdc4`](https://github.com/amerged-org/cloudflare-postgres/commit/56764c288a521fc5531fa0cf33d6416429fbbdc4) implements the [suspend contract](../contracts/environment-suspend-v1.md). Customers can persist a manual compute-stop intention, inspect separate runtime state and recover its task. This advances M6; automatic idleness, funded resume/wake and complete sleep/wake acceptance remain open.

## Durable control and execution

Migration `0012` adds runtime state and immutable suspend specification/request history, plus a subject-bound lease column on the existing operation store. Provisioning status and immutable environment specifications are unchanged. Customer suspend accepts an expected runtime revision under write scope and scoped idempotency. The same primary transaction rechecks actor/environment/state and excludes queued/running create, role and database work, including uncertain expired tasks.

Symmetric running-state guards close new database/role work, credentials and fresh allowance issuance. Current authority returns `environment_suspended` and rechecks runtime version/state around the snapshot. Historical task/result/receipt replay and metadata remain recoverable; no grant, settlement, hold release or synthetic final usage accompanies suspension.

The separate leased regional lane sends only immutable stop identities/hash and ordinary lease data. A private operation journal seals namespace/quota/Cluster/Pooler and retained-volume identities before effects. Reclaim permits a new lease while preserving that seal. One shared stop primitive prevents Pod growth, stops the bound Pooler, requests CNPG hibernation and waits for complete compute absence/current Pooler convergence with unchanged Retain volumes. Replacement identities, unknown compute and lost execution authority defer; no replacement or deletion is attempted.

The explicit `run-suspend` CLI claims at most one task and has a five-minute bound. It is not enabled by the default controller. Kubernetes dispatch checks the operation authority, including the internal ownership-read-to-patch boundary. The separately configured identity needs appropriate patch authority; the existing default deployment gains none. Completion and runtime acknowledgement commit together under the winning actor/lease/runtime/spec bindings. No public endpoint or transaction-draining guarantee is claimed.

## Bounded TDD and preserved gate stop

Exactly three new top-level cases cover API intention/interlocks/funding/history/acknowledgement, uncertain regional effects with journal restart, and lease/replacement/Pooler/unknown-compute refusal. Initial Node missing-module observations were preserved but not counted as behavioral RED: an inert feature seam produced the required missing-patch/Pooler-stop failures before implementation. The Worker case failed on its missing runtime route.

The first six named regional cases passed in 0.407 seconds. The API candidate exposed a real new-database enqueue hole; a shared runtime predicate in its preflight and atomic owner assertion repaired it on the first focused two-file check in 2.030 seconds. Independent review found the ownership-read-to-patch lease-loss window. A loopback-only SDK fixture inside the existing second Node case first rejected its HTTP setup; one fixture correction then reproduced the actual missing rejection. An optional per-dispatch authorization callback, wired through the suspend adapter/CLI, passed the same six regional cases on its first product repair in 0.529 seconds. Production TLS was unchanged and the top-level test count stayed three.

The one canonical gate passed formatting, then stopped at lint after 6.260 seconds on an unsafe return in cleanup and two empty catch blocks. A narrow cleanup/catch repair passed affected lint and the two Suspend cases, then its build found TypeScript closure narrowing on the journal variable. One typed cleanup boundary resolved that second repair. Affected lint/build and the previously unrun typecheck, Worker and Node stages all pass. There is passing evidence for 24 Worker plus 22 Node cases, totaling 46 versus 43 initially. This is not an uninterrupted clean full gate; no second broad gate or speculative test suite was run.

The migration applies offline to the prior control snapshot with intact schema/data integrity and foreign keys. OpenAPI parses and its 501 references, 44 unique operation identifiers and path parameters resolve. Dependencies are unchanged. Independent reviews identified the two substantive closure gaps before publication; their failures and corrections remain explicit.

## Control-state safeguard and Dev readback

The initial pre-migration snapshot read returned Cloudflare authorization code `7403`. Read-only existing-login/database-info checks passed; one repetition under a fresh evidence label captured 37 tables, 102 schema objects and 44 rows. Exact local reconstruction passed integrity and foreign-key checks. The first failure was retained, and no new login, scope or credential was introduced. This is local application-state restore evidence, not fresh-account recovery or scheduled backup.

Migration `0012` applied once in 2.259 seconds and the existing Dev Worker deployed once in 10.892 seconds. D1 readback confirms the migration, empty new runtime/suspend tables and queue, preserved managed database/role/usage/allowance counts, no foreign-key violations and closed regional admission. All eight Worker Secret names remain; no values were retrieved or changed.

Six live HTTP checks verify runtime/suspend routing, unauthorized customer/executor separation, missing owned-parent refusal and preserved project discovery. A compiled explicit CLI invocation authenticates and returns `no_work` in 0.633 seconds without creating a journal or reaching Kubernetes/provider effects. Its temporary private token copy is removed; the original local environment stays unchanged. These are empty-lane/routing observations, not an executed customer suspension.

## Artifact, runtime and preservation

One Linux amd64 image build from 50 sealed public Git inputs completes in 23.270 seconds. Fingerprint `ae64d051bb85885304b9ae2e1f4b450b293917681947c317a3661d6c7c772346` names local image `docker.io/library/pgcf-regional-dev:suspend-ae64d051bb85`. Verified OCI index is `sha256:901257f1ff5b6392592739244dc8d9cb0e693dee5d5ae3f96024a6ac8c759cc5`, amd64 manifest `sha256:87db73fea8cc3f1b3a228396fabfac8fc46f3cabd8c050b6a206294c903f7f5d` and configuration `sha256:050258e73e0ec9aeca5aeea8ebb898568f3726bb13da6ea554ce62423ba77ab3`. The 88,493,056-byte archive SHA-256 is `10ae525f52f825735c984d06e82b598c042a5558d79b0b9ae32ff023e2bab575`. No private environment/configuration enters the context or registry push occurs.

Network-disabled/read-only/nonroot inspection verifies Node `24.21.0`, UID `1000` and nine compiled module hashes against the candidate. One authenticated Talos import and exact-reference readback completes in 10.558 seconds. One fresh UID/resource-version/old-image conditional image-only patch rolls out in 1.450 seconds. Existing permission rules/configuration are unchanged; `run-suspend` is not activated automatically.

The new zero-restart Pod matches all nine compiled hashes and authenticates its SuspendClient with an empty claim. Its usage journal remains private/WAL-backed with an empty outbox, explicit restart gap and advancing checkpoint in the same new session. Node UID/boot, source database UID/spec/primary, manual Pooler UID/spec, 27 non-controller active Pod identities/restart counts and all four Bound PV/PVC identities/specifications remain intact. Both existing SQL marker counts remain one.

## Remaining scope

Qualify a real ordinary API-managed suspension, retained SQL/data after subsequent funded wake, active-session/disconnect policy, stale executor exclusion and node-loss journal recovery. Resume requires a new current-run fence and trustworthy final usage/settlement; resetting a stopped journal or replaying an old receipt is insufficient. Automatic idleness/coalesced wake, independent expiry, final accounting, public connectivity, scaling and backup/PITR remain required v1 work. Enforcement flags remain false and regional admission stays closed.

The pending R2 grant and held SDK/Barman/standalone-SQL/effective-parameter workflows were not resumed. The local environment is byte-identical, owner-readable and ignored; a scan of all 282 public candidate files finds no matching private token/password/key values. The archived SDK's 22 hashes are preserved.
