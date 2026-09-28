# M4 verified kubelet serving TLS — 2026-09-28

Status: **native patch and node-bound automatic approver qualified in source;
adapted image imported for Dev, runtime deployment still pending**. The working core/rules/exporter and all previous
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
No live configuration change or approval occurred. The nonexistent legacy
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
has explicit minimal RBAC and an image placeholder, and is outside active Flux
sources.

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

The approver is not deployed and the machine patch is not live. Runtime
automatic approval/renewal, supervised kubelet restart, verified scraping,
database preservation, public distribution and automated fleet enrollment
maintenance remain required evidence.
