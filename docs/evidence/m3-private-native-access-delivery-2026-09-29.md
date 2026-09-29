# Protected private native access: source and Dev delivery

The platform previously supplied roles without ordinary application SQL ingress
or connection discovery. Optional private native access now supplies an owned
TCP5432 admission rule and scoped connection metadata using CNPG's existing RW
Service. Source commit `d77fbab` is integrated and published as `811153c`.
The Dev Worker and regional controller run that source. No private client profile
is enabled and no customer endpoint is qualified by this delivery.

## Product boundary

The installation selects approved application identities through a versioned
catalog policy and protected regional client profiles. The controller verifies
Namespace/ServiceAccount identities and the real CNPG Service, primary,
EndpointSlice and public certificates before publishing its provisioning proof.
It creates or recovers one exact owned Cilium ingress policy. Clients cannot
supply arbitrary destinations, selectors or administrative credentials.

Organization-scoped connection discovery checks current ownership, actor, runtime
and budget state. It returns the private direct hostname, public CA and explicit
provisioning provenance; passwords remain on the existing credential routes.
Legacy profiles retain their serialization and behavior. No billing service,
custom adopter integration or second pooler is introduced.

The [contract](../contracts/private-native-access-v1.md) retains the important
limits: protected Namespace labeling, operator-controlled ServiceAccount reuse,
regional X509 validation, historical leaf evidence and fresh client `verify-full`.
This is an internal path; a `.svc` hostname alone cannot connect a Cloudflare
Worker or a public native client. Packet, SQL and API-to-CNPG qualification remain
separate gates.

## Original stop and exact fixture repair

The [original preflight](m3-private-native-access-preflight-2026-09-29.md) remains
the record of three meaningful red-first cases, first-attempt targeted green and
one canonical gate that stopped on typecheck after format/lint passed.
That 9.896-second failure is not relabeled as a clean gate.

After reporting the stop, the prepared correction changes only two locations in
the new Worker test: the unchanged assertion message moves from `toBe` to
`expect`, and the known fixture profile ID receives its explicit type. Installed
Vitest declarations and the existing fixture confirm those changes preserve
runtime values and assertion semantics. No application source, test count,
configuration or dependency changes accompany the repair.

The one-file checks pass on repair attempt one: format 0.700 seconds, lint 1.485,
Worker typecheck 2.432 and the named Worker case 3.028. Only the previously unrun
canonical stages follow: 28 Worker cases in 6.479 seconds and 45 Node cases in
4.480, with zero Node failures, cancellations or skips. The broad gate is not
restarted. Six unchanged Go cases retain their earlier evidence. The original
baseline of 76 becomes 79 through exactly three new top-level cases.

## Cloudflare delivery and independent D1 readback

Selected account and D1 binding match the last successful deployment. Existing
Aixyte OAuth lists the account and `d1:write`, but its SQL query returns Cloudflare
7403. A separate inventory read confirms the exact database exists; that does not
establish query permission. The refusal remains recorded and is not retried or
hidden by switching tokens, accounts, credentials or permissions.

The existing signed-in dashboard session executes the fixed aggregate SELECT
successfully before delivery, then once afterward. Both visible result tables
contain 14 migrations, one organization, one project and zero environments,
roles, databases, accepted facts, reservations or open admissions. Response/query
times are 448/2.79 milliseconds before and 459/0.32 afterward. This authorized
read-only surface establishes preservation independently; it does not prove the
CLI query failure has been repaired.

One Worker dry run completes in 0.758 seconds and one `--keep-vars` deployment in
11.703. Version `a6133135-a553-4cc0-835f-7ee371a0dee4` is observed at 100%.
All eight Secret names remain exact. Bindings, compatibility flags, migrations
and credentials are unchanged. Four fixed read-only checks pass: the existing
owned project returns 200, anonymous and executor-token discovery return 401,
and the actual owner receives 404 for an absent environment. No positive endpoint
or fabricated customer is claimed.

## Regional image and least required reads

One nonroot Linux/AMD64 image builds in 30.290 seconds from 74 sealed public Git
inputs. GitHub blobs, archive and OCI identities are verified; no environment file
or private artifact enters the build. The existing authenticated Talos importer
imports the same archive once in 7.591 seconds under a 120-second bound. Exact tag
and index readback precede any image change. No registry push is used.

The controller needs four additional reads: Pod GET, Service GET, ServiceAccount
GET and EndpointSlice LIST. A UID/resource-version/old-rules guarded patch applies
that exact delta once in 0.149 seconds, changing 14 rules to 16. It adds no writer
privilege or broader Secret permission. Namespace, ServiceAccount and ConfigMap
configuration remain untouched; there is no automatic client labeling or adoption.

One guarded image-only Deployment patch completes in 0.179 seconds; Ready rollout
completes in 1.037. Runtime configuration digest and all 66 compiled module hashes
match the verified image. A fixed compiled-helper observation confirms a legacy
profile has native access disabled and performs zero backend/authority calls.
It is not a packet or SQL test.

## Preserved state and remaining qualification

The Node UID/boot stays Ready. All 28 other Running Pod identities/restarts, four
PVC and five PV specs, source Cluster UID/spec/readiness and both SQL markers are
preserved. The existing retained fixture PV is included, not discarded.

The same sealed read-only journal script captures before and after. All 4,096
ordered sequence/payload/evidence entries and reproducible full-row fingerprints
remain exact, with schema two, unchanged identity/private modes and zero accepted
facts. The existing 383-byte `404/not_found` diagnostic still binds the same head
and evidence. Its ordinary observation time may advance. No fact is acknowledged,
reassigned, rewritten or billed.

Native client profiles remain absent. Closed admission, false runtime budget
enforcement and the other held qualifications remain unchanged. No customer
Namespace, role, database, allowance, credential or provider resource is created.
Local environment files remain private, unchanged and excluded from Git; known
secret values and encodings are scanned before publication.

Actual application traffic, denied-client behavior, CA rotation/proof refresh,
public routing, backup/PITR and full production readiness remain open in
[PLAN.md](../../PLAN.md). The pending R2 credential action and stopped verifier,
Pooler, Barman, SDK and other candidates are not resumed by this delivery.
