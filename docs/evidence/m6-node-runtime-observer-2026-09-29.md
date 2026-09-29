# Direct runtime observer checkpoint — 2026-09-29

Status: **bounded reader implemented and locally qualified; live runtime read held**. Source [`3312e1e71300c77fa59f765887d088754f0b0c7b`](https://github.com/amerged-org/cloudflare-postgres/commit/3312e1e71300c77fa59f765887d088754f0b0c7b) adds an independent [Go observation tool](../../apps/node-runtime-observer/README.md). It does not enable runtime enforcement, finalize consumption or strengthen the existing suspend receipt into a physical-stop proof.

## Why this is required

Kubernetes API Pod removal does not establish node process termination, particularly after force deletion. Talos 1.14.1's normal CRI listing filters ready sandboxes and omits containers outside that set; its containerd inspection can return partial results. These interfaces cannot certify complete physical absence. Reuse the pinned maintained Kubernetes CRI client rather than implement a runtime protocol. [Kubernetes termination behavior](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#forced-pod-termination), [pinned Talos CRI implementation](https://github.com/siderolabs/talos/blob/v1.14.1/internal/pkg/containers/cri/cri.go), [CRI client v0.36.3](https://github.com/kubernetes/cri-client/blob/v0.36.3/pkg/remote_runtime.go).

## Implemented behavior and limits

The narrow adapter permits unfiltered sandbox/container lists and exact non-verbose container status. Its upstream constructor also performs Version. Non-ready sandboxes retain their containers; missing sandboxes, unknown states, inconsistent scope/identity/timestamps, failures, limits, detected inventory changes or boot changes refuse the entire result. Exact runtime timestamps remain decimal strings. Static-pod UID hashes are valid opaque Pod identities. Optional Kubernetes scope labels must agree across sandbox, list and status observations.

The command has an overall deadline including connection setup, a combined 4096-entry maximum and an 8 MiB sanitized output limit. Upstream logs are suppressed. Caller-provided installation/region/Node identity and expected boot ID are explicit provenance; they are not cryptographically authenticated by CRI. Two list passes bracket non-atomic observations. Success is neither a linearizable inventory nor history of process lifetime.

Socket mounting grants trusted node-administration authority even when the mount is read-only. The opt-in qualification recipe uses a separate namespace, denied network paths, no ServiceAccount token, no host PID/network, no API/provider credentials, dropped capabilities, read-only root filesystem and bounded Pod lifetime. Existing tenant/platform namespace policy is not relaxed. The root-owned Talos socket requires an explicitly trusted root UID override. [Pinned socket constants](https://github.com/siderolabs/talos/blob/v1.14.1/pkg/machinery/constants/constants.go), [Pod security hostPath restrictions](https://kubernetes.io/docs/concepts/security/pod-security-standards/).

## Bounded TDD and publication

Baseline: 52 workspace cases. Exactly three new Go cases demonstrate maintained Unix transport/non-ready/orphan behavior, incomplete or changing inventory, and exact time/Node boot scope. An initial long Unix-socket test path was corrected as harness preparation; then all three failed meaningfully against inert implementation seams. Candidate one retained one transport failure because its fake status lacked the upstream-required image fields. After correcting that fixture and restoring the exact client/API pins removed by the initial stub-only tidy, candidate two passed. Independent review found static-pod UID and conflicting scope-label conditions; those were corrected before freezing and the same three named cases passed.

One uninterrupted frozen workspace gate plus its focused Go language check passed in 19.575 seconds: format, lint, typecheck, 25 Worker cases, 27 Node cases and three Go cases. No second full gate or additional suites ran. The regional build artifacts were prepared first. Source privacy checks covered 307 public files with zero credential matches; the actual `.env.local` remained byte-identical, owner-readable and ignored.

The public main branch was read back at the exact source commit. One image build took 74.109 seconds using eight sealed public Git inputs. Its static Linux amd64 entrypoint, source labels and manifest/config identities are verified. The official Go build image is pinned; dependency inventory and upstream root license/notice files accompany the runtime. Complete release notice auditing remains required.

## Live qualification stop and preservation

One authenticated Talos import/readback confirms the exact image. The image index is `sha256:dd98383778a4c2d2a60de4cf34fc88efc657077541110c186643e66a0a607b3e`; its amd64 manifest is `sha256:dbecf5ca265724f925437640e5b5e3cedd2797c41a3d027e23f52f8499cbee42`. No registry push was performed.

The one-shot installation qualifier needed two preparation corrections: interpreting the importer’s actual `image_imported_and_present` status and obtaining the regional scope from its ConfigMap-backed process environment rather than assuming an inline Deployment value. Import was not repeated. One dedicated namespace/policy and one Pod were created after server dry-run. The Pod remained Pending with `ErrImageNeverPull`: the imported name was present, while Kubernetes could not resolve the requested digest-addressed image locally. **The observer process never started; no actual CRI snapshot was collected.** The 45-second completion failure is retained and this qualifier is held after its two corrections. No replacement Pod, reference substitution, third repair or broad test rerun was performed.

The smallest proposed next step is to qualify local image-name/digest resolution separately, then explicitly resume this held installation path. A confirmed imported digest alone does not prove kubelet can resolve every equivalent reference.

The temporary namespace was deleted with an exact UID precondition after verifying no PVC and no started container. Readback proves the original Node UID/boot, all 28 active Pod identities/restart counts, four PV/PVC identities/specifications, manual CNPG database/Pooler identities/specifications and both SQL markers are preserved. `.env.local` remains unchanged. The running regional image, Worker, D1 and Worker Secrets were not changed. This is cleanup/preservation evidence, not positive runtime-reader qualification.

## Remaining product work

Durably seal workload/container identities and the hosting-node cohort against environment/spec/run epoch before stop effects. Require fresh independently bound observations for every involved node, durable evidence and ownership rechecks before physical-stop acknowledgement. Replaced, unreachable or ambiguously scoped nodes remain unproven. Final request-time usage also needs retained allocation/rate/lifetime preimages, clock bounds, correction rules and node-loss recovery. Retained PV allocation continues after compute stops.

No automatic wake/resume, independent expiry guard, final usage producer, settlement or hard budget guarantee is introduced. API-managed admission stays closed; all M3/M5/M6 production gates remain required. Previously held SDK, SQL verifier, R2 and Barman workflows are unchanged.
