# M4 telemetry boundary qualification — 2026-09-28

Status: **prepared, not activated**. The current platform source stays pinned and Barman/SDK/R2 held tasks are not resumed. This checkpoint records independent prerequisites and one narrow declarative boundary; it does not establish operational telemetry or production tenant isolation.

## Authoritative admission proof

Root matched the canonical kubeconfig endpoint to the authenticated live Node before a Talos read. The running API-server Pod identifies its actual admission-control file. That file enables PodSecurity with baseline enforcement and restricted audit/warn; the actual CNPG manager principal and pilot namespace are not exempt, no users/runtimeClasses are exempt. The current database Pod has non-root UID/GID26, dropped capabilities, no privilege escalation, RuntimeDefault seccomp and no host networking/PID/IPC/mounts.

Using the actual CNPG manager identity by impersonation, one normal Pod with the current security context passed server dry-run; the same intended hostNetwork escape was specifically rejected by PodSecurity. Both checks completed in 0.494seconds with no persisted objects. Lack of an explicit namespace label had not proved lack of admission protection. The effective default already protects this prerequisite, so no namespace patch was needed. This proves the tested identity/path, not arbitrary externally configured exemptions or Kubernetes privilege grants. [Pod Security admission](https://kubernetes.io/docs/concepts/security/pod-security-admission/)

## Maintained KSM live read-only proof

A pinned KSM image ran locally for 10.4seconds with the canonical kubeconfig mounted read-only, operator non-root UID, read-only root, dropped capabilities, 128Mi/0.2CPU bound and a localhost-only ephemeral metrics port. Only selected core collectors and the four fixed Flux GVKs were configured; no Secrets/ConfigMaps were collected. One metric read matched actual API identities, generation/status/Ready-condition observations and scalar/boolean conversions, including four active Ready HelmReleases and suspended Barman. UID values and unfiltered logs/metrics are absent from public evidence. The temporary container was removed; no cluster mutation or new runtime test occurred.

This qualifies the prepared CRS configuration against current live objects. It does not qualify in-cluster KSM resources, storage, scrape TLS, alert evaluation or sustained workload behavior.

## Exact policy and ownership

The [boundary files](../../infra/telemetry/boundary/kustomization.yaml) add a CiliumClusterwideNetworkPolicy that denies ordinary managed-Pod egress to host/remote-node TCP9100. Two disjoint selectors cover every automatically labeled Pod except the owned pgcf-monitoring namespace with the chart's exact Prometheus service-account identity. Both global default-deny flags are false; no blanket allow, route/device/host-firewall setting or CNI rollout is introduced. Explicit deny takes precedence over other allows. [Pinned Cilium deny semantics](https://github.com/cilium/cilium/blob/v1.20.2/Documentation/security/policy/deny.rst), [default-deny controls](https://github.com/cilium/cilium/blob/v1.20.2/Documentation/security/policy/intro.rst)

A separate namespace-scoped CiliumNetworkPolicy restricts ingress to the trusted monitoring namespace and kube-apiserver TCP10250 for the Operator admission listener. It does not add egress default-deny. Host-originated/hostNetwork/unmanaged endpoints are outside the global Pod deny. Protected-namespace Pod/workload/SA creation privileges are trusted; PSA does not stop an authorized actor choosing an existing SA. The platform API does not grant Kubernetes access or accept a raw manifest/namespace/SA from its customer. This is a bounded operator telemetry boundary, not a complete cluster host firewall or escape-resistance claim.

The [stage bootstrap](../../infra/telemetry/bootstrap/flux-sync-stage.example.yaml) uses a separate commit-pinned GitRepository/Kustomization depending on the existing Ready platform. It stages namespaces/quota/policies/source/values and a suspended HelmRelease. The existing platform source/path and PostgreSQL/controller resources are unchanged. Flux is the ongoing policy owner; new-object absence guards and API dry-run precede any stage activation.

## Configuration and runtime baseline

The final held-stage Kustomization builds eight resources. Eight schema-validation dry-run objects (including the global deny and independent bootstrap) passed in 0.611seconds; the uncreated namespace quota and namespace-scoped CNP still require admission after namespace staging. Nothing was persisted by this check. Independent review found a lifecycle hazard in pruning protected policy/namespaces while retaining the HelmRelease; the candidate was corrected to non-pruning Orphan lifecycle and explicit prune protection before activation.

Current Cilium runtime reports audit mode Disabled globally and on the selected database/regional endpoints, with Ready health and matching desired/realized revision4. Their actual BPF maps have wildcard egress allows and no host TCP9100 deny: this is the concrete missing behavior before the policy change. The installed CLI lacks policy trace/import, so no trace/import success is invented. Supported observation uses endpoint get, bpf policy get, policy get and a bounded policy wait. Runtime maps are not packet/scrape evidence. Pre-activation readback also confirmed the original platform commit/path, Ready Node without pressure and both existing SQL markers, with new source/policy/namespace identities absent.

## Required live proof

Before opening the exporter listener, verify current non-audit enforcement, safe admission/protected-identity controls, exact policy import and selected endpoint realized revisions. Then use only bounded concrete acceptance: the owned scrape path succeeds, one non-exempt normal-Pod path produces an actual TCP9100 policy-deny verdict, and the existing Node/Cilium/database/SQL-marker health remains intact. Namespace metrics API access also needs effective proof before calling the operator UI isolated. No generated matrix, permission weakening, broad Pod-CIDR exception or automatic remediation loop is allowed. On an unresolved/failed check, stop at PLAN.md limits; remove any temporary listener before a guarded policy rollback.

Actual exporter/Prometheus deployment, API/CEL/PSA-generated Pods, TLS/PVC statistics, useful alerts and sustained headroom remain open. No workspace runtime suite/full gate was run for these declarations; the existing stopped candidate remains untouched.

The stage deliberately disables pruning and uses Orphan deletion policy; both namespace and protective network-policy objects additionally disable Flux pruning. Retiring or weakening protection requires an explicit reviewed operation after the listener/workloads are removed. Source removal cannot silently retire the protected resources while a retained HelmRelease remains.
