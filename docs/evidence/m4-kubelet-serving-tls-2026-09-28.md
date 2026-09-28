# M4 verified kubelet serving TLS — 2026-09-28

Status: **single-node Dev approver deployment, native no-reboot application,
automatic initial issuance and verified kubelet scraping qualified**.
Runtime renewal and automated fleet enrollment remain pending. The working core/rules/exporter and all previous
operation ledgers are preserved. SDK/Barman stopped work is unchanged.

## Actual defect and native configuration

The [ordered telemetry observation](m4-telemetry-bootstrap-order-2026-09-28.md)
provides the meaningful RED: all three owned kubelet paths fail certificate
identity because IP SANs are missing, while Node-exporter and 220 selected Rules
are healthy. The existing TLS check remains enabled. These endpoints show one
underlying defect, not a test matrix.

An authenticated current Node read agrees with the canonical kubeconfig target.
Authenticated Talos machine configuration has 30 native documents; its
`KubeletConfig` uses `ghcr.io/siderolabs/kubelet:v1.36.3`, empty configuration and
default seccomp enabled. Legacy `machine.kubelet` is empty. No plaintext machine
configuration, addresses, UIDs or credentials are published.

The [native patch](../../infra/talos/kubelet-serving-tls.patch.yaml) changes only
`KubeletConfig.config.serverTLSBootstrap` to true. A local merge against that
actual configuration and strict Talos 1.14.1 validation pass; normalized
comparison preserves all other 30-document content, image and seccomp settings.
At the source qualification checkpoint, no live configuration change or approval
had occurred. The nonexistent legacy
`serverCertExtraSANs` alternative was rejected from pinned source.

A direct external certificate observation did not supply stronger evidence:
the macOS LibreSSL rejected a verification option before connecting, and the
available OpenSSL3 attempt ended at its eight-second network deadline without
capturing a leaf certificate. These setup/network outcomes are not the required
behavioral RED or a certificate/chain success. They do not justify another probe
or relaxing application TLS.

## Automatic renewal and source decision

The Talos-linked approver is pinned to Apache-2.0 v0.12.1/commit
`f72897c68e38185aeca848952d10a094054642ba`. Its maintained reconcile/SAR/CSR
machinery is selected; its stock SAN acceptance is insufficient because it does
not bind names/IPs to the enrolled node. The one alternative reviewed also lacks
the required Node-bound trust check. Neither is deployed unchanged.

A narrow attributed adaptation is implemented in an isolated checkout,
so stopped SDK candidates and their package files remain untouched. It uses an
operator-owned versioned enrollment record with Node name/UID and allowed DNS/IP
SANs, uncached get-only reads, exact request identity/serving usage and valid CSR
signature checks. Missing or stale trust does not approve. The service handles
future renewal as well as initial issuance; manual approval is not the intended
completed software. The [prepared deployment](../../infra/kubelet-serving-certificates/README.md)
has explicit minimal RBAC and an immutable adapted image pin. Its Dev overlay
is deployed through a separate source, preserving the platform/telemetry sources.

Exactly three focused new tests failed against actual upstream reconciliation:
foreign SANs, an unenrolled requester and a replaced Node UID receive approval
when rejection is required. The named RED run completed in 28.956 seconds;
these are behavior failures, not setup errors. The first correction passed in
5.736 seconds. Independent source review then found authority changes during
SubjectAccessReview and ambiguous JSON-member acceptance. The existing authority
lifecycle case reproduced that observed transition in 5.316 seconds; a second
combined correction passed all three cases in 4.787 seconds. There were no new
top-level cases, generated matrices or third correction.

The frozen 20-file module retains upstream attribution and adds uncached
CSR/Node/enrollment revalidation after SAR, exact UID/spec/authority snapshots,
signature/usage/subject checks and duplicate JSON rejection. Independent delta
review passes. The authority fence is optimistic: it is not an atomic
cross-resource transaction or instant revocation after the final read.

The final clean-worktree gate ran exactly once and passed in 131.643 seconds:
regional build, canonical format/lint/typecheck/Vitest/Node checks, plus Go
format/vet/test. Exactly three new Go cases and the unchanged application cases
passed. Frozen source remained unchanged; stopped SDK candidates were excluded
by the isolated checkout, not edited or silently tested again.

One Linux/amd64 image build passed in 34.397 seconds. The read-only,
capability-dropped non-root runtime help check passes. OCI blob hashes establish
the pinned index, AMD64 child and config identities in
[image.lock.json](../../infra/kubelet-serving-certificates/image.lock.json).
One authenticated Talos image import returned the exact reference and matching
index digest. An observation predicate initially expected the list-mode status
instead of the actual import-mode status; offline readback corrected that
interpretation without another import. Public image distribution is unqualified.

Fresh provider inventory contains the two authorized VPS and matches the
canonical target to exactly one instance. Authenticated Talos kernel hostname
matches the live Node name/UID. The private enrollment uses that independently
verified provider address and hostname; mutable Node status and CSR SAN claims
were not used as address authority. Private trust data is not committed.

## Guarded Dev deployment and native application

The separate GitRepository/Kustomization `pgcf-kubelet-certificates` pins
public source commit `2fc69d7e7739ca74aeff95a46d98117de632cab1` and the explicit
local-image overlay. One staged create followed by one guarded resume becomes
Ready in 11.605 seconds. The actual single Ready Pod has zero restarts, runs on
the enrolled node and reports the verified image identity. Private enrollment
is operator-owned, outside the static Flux inventory. Original platform and
telemetry source pins remain unchanged and Ready.

Five ordinary service-account permission checks pass. The CLI check for the
virtual signer resource initially reports false; an explicit Kubernetes
SubjectAccessReview with the exact group/resource/name/verb reports allowed.
No RBAC broadening is performed. This observation does not establish that a
simple health probe checks permissions or that the CLI false result is a real
authorization denial.

Fresh authenticated configuration, hostname, Node UID, exact enrollment,
approver readiness, database/SQL markers, four bound PVCs and zero pre-existing
CSRs pass. Strict native validation and one CLI dry-run show only
`KubeletConfig.config.serverTLSBootstrap: true`, with no reboot. Two private
observer assumptions are corrected from actual outputs: the dry-run preview is
on stderr, and the application database name comes from CNPG's bootstrap
configuration. Neither failure was a behavioral RED or a live machine write.

A one-use operation ledger precedes the single actual patch with explicit
`--mode no-reboot`; Talos confirms no reboot in 1.093 seconds. Its immediate
observer stops on two JSON MachineConfig objects. The patch is not repeated and
the failed observer record is retained. Offline decoding and explicit read-only
resource selection then verify both `persistent` and `v1alpha1`: all 30 documents
match the prior configuration except the intended bit. The effective kubelet
configuration enables bootstrap and has no conflicting false rotation flag.
These readbacks and the already automatically approved/signed authentic node
CSR complete in 1.223 seconds. There is no manual approval or security bypass.

## Verified certificate, scraping and preserved state

One bounded read-only qualification completes in 1.678 seconds. OpenSSL verifies
the leaf's Kubernetes CA chain, server purpose, enrolled DNS name and IP. Its
SANs exactly match enrollment, and its public key matches the authentic CSR.
One Prometheus targets response supplies all three owned HTTPS paths
(`/metrics`, `/metrics/cadvisor`, `/metrics/probes`) as UP without errors; all
scrapes occur after the operation. TLS verification remains enabled.

The Node UID and boot ID are unchanged and Ready without pressure. Seven
selected database/monitoring/approver Pod identities and restart counts,
four PVC identities and volume bindings, ready PostgreSQL and both SQL markers
are preserved. This establishes the observed warm-node correction; it does not
prove uninterrupted availability, a later certificate renewal, fresh cold
bootstrap, public image pulling or automated fleet enrollment maintenance.

No new runtime tests or broad gate reruns accompany infrastructure readbacks.
The original three-case/two-correction limit, frozen source, prior consumed
operation ledgers and all 22 stopped SDK candidate hashes remain unchanged.
SDK/Barman/R2 stopped work is not resumed.
