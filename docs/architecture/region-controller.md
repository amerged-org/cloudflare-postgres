# Region executor for customer-worker patches

Status: **proposal of 2026-10-11**, for the ULTRA row "Region controller" (Design). Not approved
and not implemented. It recommends option (a) in its push form; option (b) is not pursued.

Naming: this document calls the in-region component the **region executor**. It is not the regional
lifecycle controller (`pgcf-agent` today, `native-controller` with R2). That controller is replaced
by the patch's own `regional` stage and never receives region-admin material.

## 1. Context

Database work already follows the target model: the regional agent pulls `/agent/v1/desired` and
reports observations. Fleet patches run from outside. The `PatchNode` Workflow
([patch-node.ts](../../apps/api/src/workflows/patch-node.ts)) calls the `NodeBootstrap` Durable
Object ([bootstrap-container.ts](../../apps/api/src/bootstrap-container.ts)) once per turn. Its
Cloudflare container runs `runFleetPatch` ([fleet-patch.ts](../../apps/node-bootstrap/src/fleet-patch.ts))
with the complete `FleetPatchInput`, including the region's Talos admin configuration and kubeconfig.

Every `talosctl`/`kubectl` TCP connection passes the executor's local CONNECT proxy, which first
POSTs `{kind:"transport"}` to `/internal/v1/fleet-patches/{op}`. The API authenticates the operation,
rebuilds the complete private input (`authenticateFleetPatchContext` → `fleetPatchInput`), fetches
the relay identity, signs a single-use Ed25519 grant (30 s TTL) and fences it. The WebSocket route
then rebuilds the context again before the API Worker forwards the stream to the relay on EU control,
which dials Talos (50000) or Kubernetes (6443).

Measured on Dev: one EU1 Flux turn needed 194 transport requests for 141 commands at 2.0–6.6 s each
and exceeded the 600 s turn budget (`FLEET_PATCH_PROOF_MAX_AGE_MS`). Batched reads now bring that
turn to about 3 min, but every connection still pays one grant plus relay round trips, and a relay
session cut in the middle of a command remains a source of uncertain writes.

The outside path exists because the control server cannot upgrade or rescue itself from inside
(etcd CA write, reboot), a new server has no cluster yet (`AddNode`), long-lived region keys and
rotation material stay in Cloudflare custody, and no VPS opens a management port. For customer
workers only custody and the closed ports matter, and neither requires executing outside the region.

## 2. Decision

Run the **unchanged executor** (`runFleetPatch`, same NodeBootstrap image) as a **short-lived
Kubernetes Job on the region's control server** for each turn of a **customer member's** patch.
Cloudflare creates the Job and pushes the turn input into it over one Kubernetes attach session;
the executor then reaches the worker's Talos API and the Kubernetes API directly from the control
host. Desired state, release approval, member order, key custody and every checkpoint remain in
Cloudflare through the existing callback protocol.

| Concern | Owner after the change |
| --- | --- |
| Release approval, assignments, member order, maintenance acknowledgement | Cloudflare (unchanged) |
| Join bundle (Talos admin configuration, kubeconfig), rotation material | Cloudflare custody (unchanged) |
| Dispatch before write, CAS checkpoints, readback resolution | Cloudflare D1 through existing callbacks (unchanged) |
| Launch and input of a customer-member turn | NodeBootstrap container → relay → kube-apiserver, two sessions |
| Execution of a customer-member turn | Executor Job on the control server, direct API access |
| Control server's own patch and rescue, AddNode with its post-join patches, material rotation, infrastructure backups | NodeBootstrap container through the relay (unchanged) |

The relay leaves the execution path of worker patches but still carries each turn's launch. Removing
that too needs the pull variant in section 9, whose extra trust and versioning machinery is not
justified by an observed problem. If the owner accepts this, the ULTRA row should read: customer
worker turns execute on the control server against local Talos and Kubernetes APIs with checkpoints
in Cloudflare; the relay only launches them and remains the execution path for AddNode, the control
server and material rotation.

## 3. Turn protocol

1. `fleetPatchInput()` adds `region_executor: { image, node_name }` only when the member's role is
   `customer`, the patch has no `bootstrap_operation_id`, the input carries no `authority_rotation`,
   the target address differs from the cluster endpoint host, exactly one live `control_relay` member
   exists (its Kubernetes node name becomes `node_name`) and the API variable `FLEET_EXECUTOR_IMAGE`
   holds a digest-pinned reference. Without the variable nothing changes.
2. `PatchNode` is unchanged: one `patch-observed-turn` step per cycle calls `NodeBootstrap.patch(op)`.
   Because the executor keeps no state between turns, an operation in flight switches at its next turn.
3. The container's `/v1/patches` handler launches instead of executing when `region_executor` is
   present. Through the existing capability proxy, restricted to `kubernetes_api`, it:
   - creates Job `fleet-patch-<operation>` in namespace `pgcf-fleet-executor`, creating the namespace
     on first use. The fixed name admits one executor per operation: a running Job answers `busy`;
     a finished one is deleted with a UID precondition before the next create;
   - attaches to the Job's Pod (`kubectl attach --stdin`, waiting for Running) and writes the turn
     ID and input. The executor reads to EOF within a size and time bound, validates, prints a
     non-secret acknowledgement (turn ID, status revision) and the launcher closes the session.
4. The executor runs `runFleetPatch(input, { dial })`. The capability proxy, its allowlist (node:50000;
   control:50000 only in the `kubernetes` stage; control:6443) and the expected-target checks stay;
   `dial` opens a direct TCP connection instead of requesting a grant. The `status`, `checkpoint` and
   `postgres_rollout` callbacks are unchanged and keep the per-operation bearer and D1 revision CAS.
5. On exit the executor posts `{kind:"turn_end", turn_id, error_code}` with the same bearer. It is
   accepted for the Durable Object's active turn even after the turn moved the operation to
   `host_ready` or `complete`. The API records an error code as `recordFleetPatchFailure` does and
   notifies the Durable Object, which then returns the current D1 status. The Durable Object keeps the
   active turn ID in storage and returns before the Workflow step timeout; a later call while the Job
   runs waits again instead of launching. No session is held during execution, so the relay's 600 s
   session cap never limits a turn.

## 4. Executor Job

- **Image:** `FLEET_EXECUTOR_IMAGE` is the public GHCR copy of the CI-qualified NodeBootstrap image
  built from the deployed API commit (`ghcr.io/amerged-org/pgcf-regional@sha256:…`; CI already
  publishes `node-bootstrap-sha-<commit>` there with an equivalence readback). It is pulled
  anonymously by digest, like the regional images. New entry point `/app/fleet-patch-job.mjs`.
- **Placement and network:** `nodeSelector` on the control member's hostname; `hostNetwork: true` and
  `dnsPolicy: Default`, like the relay. Connections leave with the control server's address, which the
  generated provider firewall already admits for 50000 and 6443 as region peer and relay address, and
  which the relay already uses live from the same host. Host networking also keeps execution independent
  of the Cilium upgrade the same patch performs in its `platform` stage. The namespace therefore enforces
  Pod Security `privileged`, like `pgcf-bootstrap-transport`. A Pod-network variant with a
  CiliumNetworkPolicy would work (the agent already reaches kubelets on `remote-node:10250`) but would
  depend on the datapath the patch upgrades.
- **Identity:** `automountServiceAccountToken: false`, no Role or binding, `enableServiceLinks: false`.
  The executor acts only with the material Cloudflare delivered.
- **Hardening:** non-root, read-only root filesystem, all capabilities dropped, no privilege escalation,
  `RuntimeDefault` seccomp, `stdin`/`stdinOnce`, no secret in arguments or environment. `TMPDIR` and
  `HOME` point to a size-limited memory-backed `emptyDir`, which holds the existing 0600 files in their
  0700 directory. Requests equal limits (Guaranteed QoS).
- **Lifetime:** `restartPolicy: Never`, `backoffLimit: 0`, a Pod-level `activeDeadlineSeconds` slightly
  above the stdin bound plus the turn budget, enforced by the local kubelet even without API or
  Cloudflare reachability, and `ttlSecondsAfterFinished` for cleanup. The entry point refuses to run
  unless its node (downward API) is `node_name` and the target is a different node.

## 5. Key custody and authentication

- The join bundle stays sealed in D1. Per turn Cloudflare opens it as today and pushes it inside the
  turn input: kubectl in the container, end-to-end TLS through the relay to kube-apiserver with
  Cloudflare's admin client certificate, kubelet, container stdin. It never enters etcd, a Secret, a
  ConfigMap, the Pod specification, an environment variable, a log or a disk. It lives in executor
  memory and tmpfs for one turn and disappears with the Pod.
- The Job needs no credential to obtain its input: Cloudflare creates the Pod and writes its stdin with
  its own cluster-admin identity. Callbacks use the existing per-operation bearer, and every write still
  requires a confirmed `dispatched` CAS.
- During a turn the material is reachable by principals that can attach or exec into the Pod or create
  privileged Pods in its namespace: Cloudflare's admin kubeconfig, Flux (cluster-admin) and operators
  with cluster-wide Pod rights. Each already reaches node root on the control server, which holds the
  region's Kubernetes, etcd and Talos CAs. The regional agent and native controller have no exec,
  attach or Pod-create rights and cannot.
- Customer workers never receive admin material (unchanged). Rotation material is never sent in-region:
  `fleetPatchPreparedAuthority` attaches it only to control-plane members, and the entry point refuses
  an input that carries it.

## 6. Failure modes

| Event | Behavior |
| --- | --- |
| Executor killed mid-write (OOM, eviction, agent deletes the Pod) | As for a container crash today: D1 holds `dispatched`; the next turn resolves from the stage's readback (Talos lifecycle log, boot ID, configuration hash, operation-annotated objects) or keeps the uncertain write as a blocker. Nothing is replayed. A relay cut inside a command no longer exists for these turns. |
| Executor hangs | Its own 600 s abort fires; the kubelet kills the Pod at `activeDeadlineSeconds`. |
| Launch interrupted after create | The Pod exits at its stdin bound; the next launch deletes the finished Job. |
| kube-apiserver restarts during `upgrade-k8s` | The attach session already ended; Talos orchestration runs against apid; Kubernetes calls fail transiently and resolve by readback, as today. |
| Control server reboots or fails during a worker turn | The Pod is lost and not restarted. Nothing can run until the control server returns (in EU the relay is down too); the next launch creates a new Job. |
| Control server unschedulable or image pull fails | The attach wait expires; the launcher deletes the Job and reports `patch_region_executor_unavailable`. There is no silent fallback to per-command relay execution. |
| Concurrent launches | Durable Object serialization, the fixed Job name and the D1 revision CAS allow one executor per operation. |
| Version skew | The executor image is built from the API's commit, so executor and contracts move together, as with the container today. `talosctl`/`kubectl` are the versions pinned in that image. The Job and attach APIs are stable across the retained and target Kubernetes versions. |

## 7. Rollout ordering

One active patch owns a region ([fleet-rollouts.ts](../../apps/api/src/domain/fleet-rollouts.ts)),
and members run customer first, control last. Customer turns therefore run on a control server that
is not being patched, and the control server's own patch keeps the relay path. The first customer
member's `kubernetes` stage runs `talosctl upgrade-k8s` against the control endpoint from the executor
on that same control server: apid is unaffected, while kube-apiserver and kubelet restarts are transient
for a running Pod. Host-ready and finalization passes of customer members also run in-region. R2's EU1
patch runs in-region with no dependency on the regional controller's version, although that patch is
what activates the native controller. A new region starts on the relay path (`AddNode`); its later
worker turns are launched through the EU relay and execute locally.

The control server's patch keeps the per-connection relay cost. After a customer member has converged
the shared Flux and platform objects, its platform stages are read-mostly and use the batched reads.
The batched transports of the "Relay transport cost" row remain the fix for that path, for AddNode and
for rotation.

In-region turns still call `status` before each write and `checkpoint` per stage, and each call
rebuilds the full private input in the API. If those round trips dominate measured turn time, `status`
can use a fenced row check that does not rebuild the private input.

## 8. Option (b): the executor inside the native controller

Not recommended:

- **Sequencing:** EU runs the TypeScript agent; the native controller is activated by R2 through a
  customer-worker patch, which is the operation that needs the in-region executor.
- **Self-replacement:** the patch's `regional` stage replaces the controller Deployment (`Recreate`),
  so the executor would end itself mid-turn. The controller is not pinned to the control server and can
  run on the worker being rebooted.
- **Privilege:** the executor writes Flux, RBAC and Talos machine configuration. The controller would
  need standing region-admin rights or would fetch admin material with its agent key, which would turn
  that key into a region-admin key and contradict the separate-privilege rule of the Rust architecture.
- **Talos client:** the native controller has no Talos API client. The workspace's only gRPC use is the
  sandbox controller's containerd/CRI client, so the Talos machine and COSI APIs would be new vendored
  protos, and `upgrade-k8s` is client-side talosctl orchestration to re-implement or bundle.
- **Two executors and skew:** the TypeScript executor stays for the control server, AddNode and
  rotation. The port duplicates about 4,900 lines of executor logic and 6,700 lines of tests as a second
  implementation that must stay identical. The controller is release-pinned, so every executor fix would
  wait for a release, and mixed TypeScript/Rust execution would occur within one operation.
- **Failure modes:** a controller crash mid-write resolves as in (a) only if the port reproduces every
  readback exactly; the `regional` stage kills it by design; a reboot of the worker it runs on kills it.

Files (b) would touch: new modules in `apps/native-controller/src` (executor stages, Talos client,
platform writes), `Cargo.toml` and vendored Talos protos with notices in `THIRD_PARTY.md`, generated
fleet-patch schemas in `packages/contracts/native`, `infra/platform/regional-native/rbac.yaml` and
`agent.yaml`, and an agent-key turn-input endpoint in `apps/api`.

## 9. Pull variant of (a), not proposed now

A release-pinned executor on the control server (a resident Pod running each turn in a fresh process,
or a CronJob) could pull turns without any relay session. It would need: verification of a
projected ServiceAccount token (audience, namespace, Pod and control Node UID) against the region's
service-account signer from custody, including signer rotation; a turn-claim protocol; the release's
`node-bootstrap` pin assigned to the `control_relay` role; contract compatibility between that pinned
executor and the current API, with relay execution while no compatible executor exists; and Flux
manifests for its namespace and identity. A controller-launched Job would additionally need an admission
policy pinning image and command, because the controller could otherwise start any image under the
executor identity. Every executor fix would then wait for a release.

## 10. Change set for (a)

- `packages/contracts/src/fleet-patches.ts`: optional `region_executor`, `turn_end` body, acknowledgement.
- `apps/api/src/domain/fleet-patches.ts`: eligibility and `region_executor` in `fleetPatchInput`.
- `apps/api/src/routes/fleet-patches.ts`: `kind: "turn_end"`.
- `apps/api/src/bootstrap-container.ts`: launch result, active turn in storage, bounded wait,
  `regionTurnEnded`.
- `apps/api/src/env.ts`, `apps/api/wrangler.example.jsonc`: `FLEET_EXECUTOR_IMAGE`.
- `apps/node-bootstrap/src/fleet-patch.ts`: injectable `dial`.
- New `apps/node-bootstrap/src/fleet-patch-region.ts` (Job manifest, create, attach, acknowledgement)
  and `apps/node-bootstrap/src/fleet-patch-job.ts` (bounded stdin, node and input checks, run, `turn_end`).
- `apps/node-bootstrap/src/server.ts`, `package.json` build entries, `Dockerfile`;
  `scripts/ci/image-profiles.ts` and `scripts/ci/image-qualification.ts` for the new entry point.
- Tests beside each change; the existing executor tests stay because execution logic is unchanged.
- `docs/operations/fleet-patches.md` (execution location) and the ULTRA row once measured.

Unchanged: regional agent, native controller, relay, Talos configuration, provider firewall, Flux
manifests and `THIRD_PARTY.md`. No new dependency, credential, CRD or Secret.

## 11. Riskiest parts

1. Input delivery with `kubectl attach --stdin` through the capability proxy and relay: EOF with
   `stdinOnce`, the Running wait during the first image pull, and the acknowledgement. Prove it first
   with a no-op turn on Dev.
2. Scheduling on the control server: Pod Security labels, allocatable room for Guaranteed requests next
   to the control plane and relay, and the first anonymous pull of the image.
3. `upgrade-k8s` run from the control server it upgrades: the kubelet restart must keep the executor
   container running.
4. Nested bounds: stdin bound, executor abort, Pod deadline, Durable Object wait and Workflow step timeout.
5. Deploy discipline: `FLEET_EXECUTOR_IMAGE` must be the digest built from the deployed commit.

## 12. Acceptance

The next customer-member patch on Dev (EU1's final pass or R2) completes its turns through the executor
with zero operator interventions, and the six node checks pass. Record per turn the relay sessions,
executor start and pull time and turn duration in the ULTRA plan. Thin qualification and thin-storage
turns, which also target customer workers, move only if their relay cost is observed to matter.
