# Node-bound kubelet serving certificates

Status: **single-node Dev deployment, automatic initial issuance and verified
kubelet scraping qualified**. Runtime renewal and automated fleet enrollment
remain open.
The [attributed component](../../components/kubelet-serving-approver/README.md)
passes its bounded three-case proof and the one final clean-worktree gate.
[image.lock.json](image.lock.json) pins the verified AMD64 build; public image
distribution remains unqualified. A private Dev overlay can select the exact
authenticated Talos-imported tag with `imagePullPolicy: Never`. This directory
is not included in the original platform or telemetry sources. A separate
commit-pinned `pgcf-kubelet-certificates` source deploys the Dev overlay. The
native patch is live on the enrolled Dev node; see the
[runtime evidence](../../docs/evidence/m4-kubelet-serving-tls-2026-09-28.md).

The previous Dev kubelet targets failed verified TLS because the serving
certificate lacked IP SANs. Talos 1.14 uses native `KubeletConfig` documents. The
[native patch](../talos/kubelet-serving-tls.patch.yaml) enables
`config.serverTLSBootstrap` while preserving the selected image, seccomp and all
other machine documents. Local merging against the authenticated 30-document
configuration and strict Talos validation pass. Do not use a nonexistent
`machine.kubelet.serverCertExtraSANs` field or disable certificate verification.

## Maintained controller and explicit trust

Reuse the Apache-2.0 Talos-linked
[kubelet-serving-cert-approver v0.12.1](https://github.com/alex1989hu/kubelet-serving-cert-approver/tree/f72897c68e38185aeca848952d10a094054642ba)
at immutable commit `f72897c68e38185aeca848952d10a094054642ba`. The selected
runtime retains upstream CSR reconciliation, SubjectAccessReview, X.509 parsing
and health/metrics. Its stock acceptance does not bind requested DNS/IP SANs to
the actual node; it is not selected unchanged. The adaptation adds a generic
operator-owned enrollment policy, CSR signature and mandatory serving-usage
checks. Automatic renewal uses the same policy as initial issuance.

The approver may read only the configured enrollment ConfigMap and individual
Nodes through an uncached API reader. It cannot write enrollment, read Secrets,
hold CA private keys or approve another signer. The CSR approval permission is
limited to `kubernetes.io/kubelet-serving`. CSR read/watch, SubjectAccessReview,
namespaced events and leader-election permissions are explicit in
[rbac.yaml](rbac.yaml). Untrusted SQL customers have no Kubernetes or enrollment
write privileges.

`ENROLLMENT_NAMESPACE` defaults to `NAMESPACE`; `ENROLLMENT_CONFIGMAP` defaults
to `pgcf-node-enrollment`. Their flag equivalents are `--enrollment-namespace`
and `--enrollment-configmap`. The ConfigMap data key is `enrollment.json`:

```json
{
  "apiVersion": "pgcf.io/kubelet-serving-enrollment/v1",
  "nodes": [
    {
      "name": "operator-verified-node-name",
      "uid": "operator-verified-node-uid",
      "dnsNames": ["operator-verified-node-name"],
      "ipAddresses": ["192.0.2.10"]
    }
  ]
}
```

Enrollment comes from authenticated provider/machine placement and node
registration. A CSR, DNS lookup or mutable Node status is not an enrollment
authority. Real addresses and UIDs belong in private adopter configuration, not
this repository. The [empty example](enrollment.example.yaml) admits no nodes
and is deliberately excluded from the workload Kustomization. Regional lifecycle
software must maintain the trusted records as machines are added/replaced;
automatic CSR renewal is not proof of that fleet integration.

Missing/malformed enrollment, unknown or replaced Node identity, invalid request
identity/signature/usages, and non-enrolled SANs must remain non-approvable. The
request must contain at least one approved IP SAN. Current Node UID must equal
the enrolled UID; name reuse alone is insufficient. Requests cannot add peer
addresses by changing their own Node status.

## Ordered operation and acceptance

1. Complete the bounded red-first policy tests and frozen final verification.
2. Pin the adapted runtime image and review namespace/RBAC/Pod admission.
3. Install the approver and privately populated enrollment before TLS bootstrap.
4. Confirm the approver can read its exact inventory, watch serving CSRs and
   perform the required authorization/approval API calls. A new authentic
   serving CSR appears after enabling bootstrap; do not wait for it beforehand.
5. Fence the fresh authenticated configuration and apply the single native
   change to the intended node with explicit `--mode no-reboot`. Require the
   returned no-reboot mode, then compare the active and persistent configuration
   and effective kubelet setting; no legacy flag may disable server rotation.
6. Observe its supervised kubelet restart, automatic validated approval/signing,
   certificate identity/chain and all three verified Prometheus kubelet targets.
7. Check Node/database readiness, existing SQL markers, PVCs and actual renewal.

Talos applies the setting without a machine reboot, but the initial change
restarts kubelet and removes its old self-signed serving files. The serving
endpoint waits for a signed certificate. Preserve authenticated Talos access,
machine configuration, node identity and the layer-specific recovery path.
Source inspection is not a zero-interruption or database-recovery guarantee.
Stop on failed probes, unexpected identity or PLAN.md's repeated-failure/time
limits; do not reset counters or use insecure TLS as a fallback.

The Dev deployment uses the verified local image. Initial automatic approval
and signing, exact enrolled SANs, certificate chain and all three HTTPS targets
pass. Node UID/boot ID, seven selected Pod identities/restart counts, four PVC
identities/bindings and both SQL markers are preserved. A later renewal,
public image distribution, cold bootstrap and automated enrollment maintenance
are not established by this operation. Existing platform/telemetry sources,
provider firewall, data volumes and unrelated credentials are preserved. See
[Talos certificate guidance](https://docs.siderolabs.com/kubernetes-guides/monitoring-and-observability/deploy-metrics-server)
and the pinned [kubelet configuration schema](https://github.com/siderolabs/talos/blob/v1.14.1/pkg/machinery/config/types/k8s/kubelet.go).
