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
