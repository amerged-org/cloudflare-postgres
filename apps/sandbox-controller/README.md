# Prepared sandbox controller

This native Rust service implements containerd 2.3.6's external gRPC sandbox-controller
interface. It prepares a bounded number of tenant-free Linux namespace holders and real
`containerd-shim-runc-v2` task services before any Pod request. `Create` assigns one holder
to the supplied CNI network-namespace FD exactly once. `Start` returns that same PID and
the already running version-3 runc task endpoint. The ordinary containerd/CRI child OCI
specification owns the PostgreSQL/Barman process, PGDATA mounts, credentials and cgroup limits.
The holder never receives those data or executable commands.

This is an implementation of the runtime boundary, not completed shared-pool acceptance.
Cloudflare live policy delivery, CRI/Cilium/CNPG integration and the subsecond authenticated
SQL first read remain unaccepted. The source consumes bounded Cloudflare policy, refills idle
slots and recovers recorded assignments; these features still require real Dev acceptance.
Sandbox readiness means actual namespace assignment and live holder/task service; it never
asserts PostgreSQL readiness. Unsupported sandbox metrics and resource updates return explicit
`Unimplemented`, rather than fabricated observations.

## containerd boundary

The supported proxy type is implemented in the pinned containerd server even though its
older PLUGINS guide omits it:

```toml
version = 3
[proxy_plugins.pgcf]
  type = "sandbox"
  address = "/run/pgcf-sandbox/controller.sock"
[plugins."io.containerd.cri.v1.runtime".containerd.runtimes.pgcf]
  runtime_type = "io.containerd.runc.v2"
  sandboxer = "pgcf"
```

This configuration is not installed on retained servers. The supported host-context target
is a Talos 1.14.2 system extension service with `runnerMode: host`, which executes the host
entrypoint directly. The pinned [service definition](https://github.com/siderolabs/talos/blob/v1.14.2/pkg/machinery/extensions/services/services.go)
and [runner implementation](https://github.com/siderolabs/talos/blob/v1.14.2/internal/app/machined/pkg/system/services/extension.go)
preserve the real host OCI bundle/PVC paths. Host mode forbids extension config-file mounts;
protected settings and agent-key files require the existing authorized host-file custody path.
The service starts the fixed `--cri-host-context` self-launcher before creating threads. It
finds the real CRI process by executable identity and socket argument, then starts only this
same controller in its PID/mount context. This supports the retained workload-isolation
configuration without changing it. The controller service parent forwards signals through a
pidfd; the assigned holders remain outside its lifetime. Its dedicated pool cgroup must be
outside the controller service cgroup. Its privileges remain separate from tenant tasks. The server checks explicit containerd namespace
metadata and local socket ownership. Holder setup retains the original one-shot descriptor
protocol, capability removal and `NoNewPrivs` behavior from `apps/node-runtime`.

Pod-level PID/user namespaces, host network/IPC, privileged sandboxes, SELinux and custom
sandbox sysctls are refused until implemented. Ordinary separate-container PID mode is
supported. A pool miss under a current lease takes the bounded ordinary preparation path and
is labeled `on_demand`; a prestarted hit is labeled `prestarted`. Preparation stays outside
the claim mutex. Used or uncertain slots never return to the
unassigned list. The controller preserves assigned holder processes across restart and checks retained owner
records against the real containerd sandbox store, process start ticks, pidfds and namespace
identities. Retained unused slots are destroyed, never reassigned. Incomplete preparations
are killed only inside their dedicated idle cgroups. A missing or conflicting containerd
owner stops recovery rather than inventing a replacement assignment.
Normal CRI removal retains an authenticated physical-volume scope in the existing private
owner record after child tasks and the owned shim/holder are gone. It never appears as an
assigned or ready runtime. The same expiry supervisor visits these scopes after removal
and restart until a newer signed scope for the same volume is durable, or an explicit
completed deletion and actual kernel UUID absence are confirmed. Task exit and positive
DM quiescence are separate facts. A fresh Cloudflare startup hold must resume the exact
old volume and confirm old-writer absence before a replacement may start.

The executable takes one private JSON settings file. Runtime fields are `socket`, `state`,
`shim_sockets`, `containerd_socket`, `containerd_binary`, `shim_binary`, `runc_binary`,
`holder_binary`, `namespace`, `slots` and `slot_lifetime_ms`. Production requires a `cloudflare`
object with `api_url`, `agent_key_file`, independently installed `node_id`, `node_uid`,
`region_id`, `material_revision`, the exact controller `image` and a dedicated delegated
`cgroup_root`. The executable never learns its physical Node UID from a policy response.
The shim socket directory must be short enough for upstream's hash-named Unix sockets.
After the final region version metadata update, the same process consumes a monotonic
material-revision change from the root-owned0600 settings file. Node/runtime paths, image
and public trust must remain identical. The controller clears the former pool lease and
waits for current Cloudflare authority while retaining the same storage guard, protective
volume bindings and monotonic expiry deadlines. This path does not restart the service.
`slots` and `slot_lifetime_ms` support the local boundary harness; production uses only the
Cloudflare desired target and age.

The authenticated administration API is `PUT /v1/nodes/{id}/compute-pool`, with an expected
revision, the current physical Node UID and an approved immutable fleet release. The native
service fetches `/agent/v1/nodes/{id}/compute-pool` through verified HTTPS every five seconds.
Each lease lasts at most 30 seconds and requires a fresh Ready observation of the same current
Node UID, region, fleet assignment and material revision. It also verifies actual holder and
controller hashes, architecture and host containerd/shim/runc versions against the profile.
The selected Talos 1.14.2 target uses containerd 2.3.6 and runc 1.5.2.

Idle CPU, RAM and process counts are enforced by real parent and per-slot cgroups. A claim
moves its holder and shim out of the idle budget; ordinary child OCI task limits remain owned
by CRI. Refilling runs outside the claim mutex. Policy expiry blocks new claims and retires
only unused slots; running tenant tasks remain. `max_age_seconds` never extends a used slot
into a reusable one. The service reports actual cgroup counters and observed holder/shim and
Pod ownership to the same authenticated agent endpoint. Unknown counters remain null, and
`GET /v1/nodes/{id}/compute-pool/observations` exposes freshness. A retained assignment keeps
its own runtime release identity when the controller policy later changes.

## Verification

`cargo test -p pgcf-sandbox-controller` exercises the real upstream protobuf encoding and
rejects unsupported namespace/runtime requests before assignment. The actual Linux proof is:

```text
cargo run -p pgcf-sandbox-controller --example containerd-proof
```

The proof starts a real containerd in a distinct PID/mount namespace and independently checks
namespace inodes before assigning runtime. Run it only in a disposable privileged Linux
container with its own cgroup namespace and
no host mounts, devices or Docker socket. It requires real containerd 2.3.6, runc 1.5.2,
iproute2, static BusyBox and the built namespace holder in `/usr/local/bin`. It creates its
own network namespaces, two prestarted holders/shims, tenant root filesystems, late
mounted data directories and bounded cgroups. It verifies expiry without stopping the tenant,
kills the actual controller child process, checks assigned-PID recovery and unused-slot discard,
then separately exercises one on-demand miss before destroying every task. It does not run
Cloudflare, CNI, CRI, CNPG or PostgreSQL and therefore cannot establish their acceptance.

The disposable example supplies generated test authority directly to the library; it is
not a Cloudflare HTTP acceptance test. Product main has no fixture authority or fallback
configuration route. The proof uses the actual daemon's sandbox proxy for Create/Start. The pinned public gRPC
Start/Status wrapper omits endpoint/version fields; the CRI in-memory client preserves them.
The proof reads them from the real controller, verifies the same daemon-returned PID, and
uses the ordinary daemon TaskService for tenant creation and destruction.

Vendored protobuf source versions and hashes are in `proto/sources.json`; their original
Apache-2.0 notices remain beside the files. The build requires `protoc`, with protobuf
31.1-r1 pinned in the isolated Alpine compiler image.
