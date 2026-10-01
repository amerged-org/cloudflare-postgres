# Node runtime observer

A bounded, one-shot platform tool collects direct container-runtime observations. It reuses the maintained Kubernetes CRI client `v0.36.3` over an explicit local Unix endpoint. It lists every sandbox/container state and queries exact container status; a non-ready sandbox never makes a running container disappear. Missing sandboxes, unknown states, inconsistent identities, failed RPCs, reboot, deadline, entry limits or changed bracket inventories produce an incomplete result with exit code 1 and no snapshot.

Successful JSON contains the caller-supplied installation/region/Node scope, independently expected and locally read boot ID, collection interval, exact sandbox/container identities and decimal nanosecond timestamps. It excludes arbitrary annotations, images, environment, log paths and upstream error bodies. Kubernetes Pod UID is a bounded opaque identity, including static-pod hashes; Node UID and boot ID use UUID shape. Created containers and exited containers remain visible. Zero runtime timestamps retain their runtime meaning; they never establish zero consumption.

Two unfiltered list passes bracket the status calls and reject detected changes. They are **non-atomic runtime observations**, not a linearizable snapshot, authenticated Node enrollment, stopped-compute proof, complete lifetime history or final usage. The observer has no budget, suspend, resume, settlement, API credential or usage-journal integration. Existing suspend observations still prove only Kubernetes convergence; node-backed durable stop qualification remains required.

Build from the repository root with the pinned official Go 1.27.1 image:

```sh
docker build --platform linux/amd64 -f apps/node-runtime-observer/Dockerfile -t node-runtime-observer .
```

For local development, `pnpm check:node-runtime` checks formatting, vet and the three concrete cases. Put Go on PATH. During iteration, run only the named cases in `observer/snapshot_test.go`; the task's canonical workspace gate runs once on its frozen candidate, with this focused Go check once as the additional language gate.

Run inside a trusted platform context with explicit flags `--endpoint`, `--installation-id`, `--region-id`, `--node-name`, `--node-uid` and `--expected-boot-id`. The whole command is bounded by `--timeout` (default 10s, maximum 30s); combined sandbox/container inventory is limited by `--max-entries` (default/maximum 4096). Output is bounded to 8 MiB. Keep resulting inventory private: it identifies workloads across tenants.

## Trust boundary

The containerd socket grants node-administration capability. A read-only mount does not restrict gRPC mutation methods. This tool exposes and invokes only observation operations; the upstream constructor also invokes Version. Suppressed upstream logging avoids raw error/identity disclosure. Unix transport relies on host isolation, not TLS or remote authentication.

A temporary qualification Pod requires a dedicated trusted namespace rather than relaxing tenant or existing platform namespace policy. Mount the exact socket only; grant no ServiceAccount token, host network/PID, provider/API credentials or broad host directory. Use a digest-pinned image, dropped capabilities, read-only root filesystem, explicit resources, one attempt and a bounded active deadline. Socket access may require root UID despite dropped capabilities; it remains a privileged trust boundary.

Independently verify the observer Pod's actual Node placement, UID, image ID and immutable specification against fresh Kubernetes Node UID/boot ID before/after use. Caller-supplied scope alone proves none of these. A replaced/unreachable node or missing history remains unproven. Qualifying this reader does not enable it on customer nodes or prove all scheduling nodes were observed.

Dependencies and distribution limits are recorded in [THIRD_PARTY.md](THIRD_PARTY.md). Physical stop requires sealed workload/node cohorts, durable evidence and ownership rechecks. Final accounting additionally requires retained allocation/rate/lifetime history and clock bounds; those remain implementation work.

## Protected Kubernetes execution

The `agent` command keeps a resident process available for bounded Kubernetes Exec calls. Its default lifetime is 24 hours, and SIGINT/SIGTERM terminate cleanly. It exposes no listener and performs no runtime reads while idle. The [agent recipe](deploy/agent.example.yaml) mounts only the exact CRI socket in a protected namespace, denies network traffic and supplies no ServiceAccount token. Socket access remains node-administration authority even though the program's observation behavior uses reads.

`observe` requires a request UUID and server-owned Pod UID/namespace/node name from Downward API variables, plus configured installation/region values. The requested scope must match those actual values before CRI is contacted. Its envelope wraps the existing snapshot with the request ID and observed self identity. Ordinary one-shot output remains available for legacy tooling; it supplies no Kubernetes transport receipt.

The operator transport must independently verify Namespace/DaemonSet/Pod/Node identity, current recipe and image before and after Exec, require successful bounded completion and reject drift. Exec names a Pod rather than atomically pinning its UID; the self envelope and fresh readbacks are conservative checks, not a cross-object transaction. This still establishes neither durable cohort coverage nor physical stop/final accounting.

## Node-local execution mount selection

The library can correlate an installation-authorized emptyDir IPC recipe with the original Pod UID and the current running container ID/name/attempt. Host paths are derived locally from the operator's kubelet root; they are not accepted from a container request or exposed by the result. Exactly one private writable mount must match the approved path. Subpaths, overlapping mounts, image mounts, ID mappings and contradictory runtime identities are refused. Legal dotted Pod names use the same validator as ordinary observations.

`ExecutionMountResolver` brackets two fresh runtime inventories and statuses with the original boot identity and a bounded deadline. Changed or missing attempts cannot retain a location. This is a conservative read-only correlation, not an atomic lifetime or filesystem guarantee. A future delivery agent must independently verify the authenticated Pod/Node projection, pin filesystem descriptors without following symlinks, and recheck original peer and file identities around publication. The existing observer command and deployment gain no listener, host-volume mount or write capability from this library.

## Protected IPC publication library

The Linux-only `OpenExecutionExchange` library retains the current runtime location and the original named filesystem chain, including device, inode, mount identity, ownership and mode. It accepts only an exact canonical challenge generated from installation-owned identity and nonce. The root-owned kubelet/volume ancestry must have no group/world write access; the private IPC child and attempt directory must be `0700` and owned by the expected guard. Regular challenge/permit files are private, single-link and bounded to 16 KiB. Initial CRI credentials must match the configured nonroot guard UID/GID.

`Publish` stages the response under a root-private directory outside the guard-owned IPC child, synchronizes and verifies bytes/metadata, rechecks current runtime/custody and calls the supplied current-authority check immediately before a descriptor-relative, no-overwrite rename to `permit.json`. Matching replay preserves the original permit inode and synchronizes its file and destination directory. Changed challenge custody or a lost peer is refused. Failed preparation artifacts remain private; the library never unlinks guard-owned files.

Publication is not process admission: the actual guard still verifies the signature and finite boot deadline. A failure after the response becomes visible is `execution_publication_uncertain`; the guard may already have accepted it. A failed replay does not prove earlier execution was stopped. The authenticated broker must retain these outcomes and resolve them without blindly replaying writes.

This boundary trusts node administrators and requires an independently verified guard image/Pod recipe without DAC-bypass capabilities or later privilege escalation. CRI initial credentials alone do not prove that recipe. The write-capable node agent needs its own root/host-volume/CHOWN/DAC_OVERRIDE deployment and authorized transport; the existing read-only command/profile remains unchanged. Linux qualification uses three explicitly named cases in an isolated container with a distinct guard UID; ordinary nonroot Go runs skip these capability-dependent cases rather than claiming native evidence.

## Separate delivery process

`Dockerfile.delivery` builds only `/node-execution-delivery`; the observation image continues to contain only `/node-runtime-observer`. Both reuse the first-party execution-guard module and its existing parser, serializer and signature verifier. The private framing/parser supports the boolean mount projection while signed field schemas stay closed. The deployment example is separate and unapplied.

The delivery command exchanges two bounded, length-prefixed input frames over non-TTY Kubernetes Exec. It opens one original filesystem exchange, emits the exact challenge, retains descriptors during the issuer wait, validates the complete signed permit binding, publishes under a finite original boot anchor, then emits a receipt. Inherited stdin/stdout are duplicated into nonblocking pollable wrappers; waits require no EOF, and cancellation/deadlines bound both directions. See the [private protocol contract](../../docs/contracts/node-execution-delivery-v1.md).

The prior map-based challenge expectation differed from the actual guard's typed serialization. The expectation and native fixture now use the exact existing guard producer. The regional Kubernetes WebSocket transport, server-owned peer/Pod recipe validation, installation key provenance and complete broker wiring remain required. Receiving a valid signed response supports a bounded offline grant, not immediate observation of subsequent Cloudflare revocation.
