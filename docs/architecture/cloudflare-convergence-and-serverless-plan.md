# ULTRA — customer-ready PostgreSQL

Canonical scope and status. The owner decision of **11 October 2026** makes the fleet EU-only and
supersedes the earlier execution order, including the 03:30 Europe/Amsterdam coaching of the same
day. Customer migration is not yet authorized.

## Fixed scope

Cloudflare is the global control plane: it owns configuration, placement, progress, releases and
provider actions for every region. The fleet is **EU control** (relay host, no customer databases)
and **customer EU1**. Preserve both servers, existing data and keys; no EU reinstall. The US region
is cancelled at Contabo: US1 runs until 2026-11-05 only as the R1.1 canary and is then marked lost.
US and Oceania return later from the same region configuration. Automatic EU purchases stay
enabled under the configured policy; US purchases are off.

**R1-final is frozen:** the qualified Golden image containing the sandbox DNS/hostname fix,
Talos 1.14.2 and Kubernetes 1.36.5. Its installer and raw image are privately distributed and
fully verified. Further Golden changes require an observed boot or data blocker; other work
belongs to R2. Runtime/platform references are immutable release inputs from the verified lock.
R1.1 is the fleet release that carries these frozen bytes.

**R1 uses standard PostgreSQL runtime.** A region API switch selects the pool runtime; it stays
off for R1 acceptance and turns on for EU with R2. The shared prestarted pool, Rust runtime and
measured first SQL below one second remain mandatory **before migration**. Pool tests must not
block the standard-runtime fleet acceptance.

**New nodes require thin storage**; there is no thick fallback for them. Retained thick volumes
keep their backend and data. Thin activation needs a release-bound receipt from the
[qualification gates](#thin-storage-qualification-gates).

## Delivery architecture

- **One Golden image.** New nodes, control or customer, install the selected release's Golden raw
  image and installer through `AddNode`; retained nodes upgrade to the same installer through
  fleet patches. Roles differ only in generated machine configuration and release role pins
  (`control_relay`, `customer`). Network settings, keys and cluster custody stay outside the image.
- **Cloudflare is global.** One API, D1, Durable Objects and Workflows manage every region.
  `AddNode` installs new nodes. An approved fleet release plus one `POST /v1/fleet/rollouts`
  request patches every listed node automatically, customer members before their region's
  control server, without operator steps.
- **A region is one control server plus N identical customer workers.** The control server
  follows the documented
  [per-region configuration](../../infra/talos/README.md#control-server-configuration-per-region):
  Talos role `controlplane`, fleet role `control_relay`, database placement disabled, operator
  sources and the generated provider firewall, and material rotation through Cloudflare custody.
  Customer workers join it through `AddNode` from the Golden image and take all customer
  databases. EU1 predates the Golden image; it converges in place and is not reinstalled.
- **One relay for the whole fleet.** The bootstrap relay is a singleton add-on on EU control.
  It carries Cloudflare's native transport to every region; no other control server runs it.
  `AddNode` never targets the relay host. EU control predates the programmed installer: fleet
  releases converge its software, and only the manual Talos recipe can rebuild it.
- **US and Oceania later.** A new region follows the
  [new-region runbook](../operations/operator-installation.md#control-server-of-a-new-region):
  `POST /v1/regions` with a new region ID, the Cloudflare prerequisites, an installation profile
  with `first_region`, then `AddNode` for the control server (a region's first node becomes its
  control plane), placement off and role `control_relay`, then workers. The cancelled US records
  stay dormant and are not reused.
- **Current constraints.** `AddNode` refuses before any provider order until the region selects a
  thin-qualified release with matching `compute_pool` and `thin_storage` templates, so every new
  node waits for R2b. Its outside network proof scans from a Ready, uncancelled node in another
  Contabo region; while EU is the only region, an EU addition has no automatic scan source and
  needs the manual network-proof path. EU also lacks its write-once installation profile, which an
  EU addition needs before it can install. The purchase itself checks neither, so an automatic EU
  order after R2b would buy a server that waits for both.

## Done

| Completed step | Measurement / boundary |
| --- | --- |
| Generic API controls | RAM threshold and purchase switches accepted live; fresh installations buy/send nothing. |
| Credential retirement | US authority and route signer checked; current US custody metadata retains the same keys. EU replacement is prepared. |
| Daily infrastructure backup | D1 and both etcd artifacts fully verified in R2; successful run 232.7 s. Email remains operator-configured. |
| EU read-only preparation | 279 role documents validated; isolated role boot passed in 125.7 s; direct rescue/config/snapshot custody ready. |
| US technical release | Ready at 21:35 UTC via Cloudflare; later operator repairs are counted separately. US database acceptance is no longer pursued. |
| Corrected sandbox runtime qualification | AMD64 proof passed: pool claims 10.4/11.5 ms. These are runtime timings, not first-SQL results. |
| Frozen R1-final image | One installer/raw composition: 11.5/28.0 s. Five private immutable objects fully read back; public eligibility remains open. |
| Observed-error class corrections | Generation, host-file activation, Kubelet pin, persistent taint and safe held-target replacement tested; qualified/current delivery varies below. |

## Open

One row per step, in dependency order. A step moves to Done only with its measured result.

| Step | Status | Finished when |
| --- | --- | --- |
| R1.1 US1 canary | In progress | US1's R1.1 patch completes through the programmed rollout. EU stays held at its rotation snapshot gate. |
| Batch A/CI-green deploy | Open | One CI passes; API and NodeBootstrap deploy between patches. Successors then drop lost members and `operator_hold_` holds; backups skip regions without a live node. |
| US1 mark-lost and Cloudflare US cleanup | Open | US test database deleted while US1 runs; US1 marked lost before the EU successor, at the latest by 2026-11-05; US Tunnel, VPC binding, firewall/rescue entries and tokens removed; `ARCHIVE_US` kept until retained US archives expire. |
| Terminal Pods after reboots | Fixed in code | R1.2 carries the fixed regional agent, and after its reboot EU1 databases wake, suspend and delete. Failed or Succeeded Pods left by a reboot made these power transitions fail. |
| CNPG in-place restart | Being fixed | The pool runtime switch yields a primary Pod with the selected RuntimeClass, and the EU rotation's consumer renewal yields new database Pods. CNPG's default restart method applies `kubectl.kubernetes.io/restartedAt` inside the running Pod, but both need a new Pod. NodeBootstrap carries the fix before the EU rotation; the native controller carries it with R2. |
| EU hold release | Open | The successor rollout of release R1.2 (new release ID, same Golden bytes) with `expected_previous_rollout_id` starts the EU rotation at its snapshot gate, which needs a complete backup run at most 36 h old. |
| EU rotation | Open | Prepared EU authority (material revision 2) is active and retired authority is rejected. |
| EU1 | Open | EU1 is patched first, passes the six checks and needs zero operator interventions. |
| Control | Open | Control/relay is patched last, passes the six checks, the relay is reachable and no intervention was needed. |
| Notifier | Open | RAM, CPU and storage warning thresholds are delivered; one real alarm arrives after the owner sets recipient and sender through the API. CPU values arrive only from R2's native controller. |
| R2 | Open | Native gateway, native controller and the EU pool switch (relay keeps its pin) roll out EU1 then control; six checks pass. R2 pins the thin guard, so each node's host configuration stage also waits until `dm_thin_pool` is loaded. Needs the CNPG in-place restart fix first. |
| Pool cold-start test | Open | A sleeping database's pool-hit first SQL is measured from one start (<1 s target, unproven), data is preserved and refill is observed; a miss is labelled a miss. |
| Thin qualification | Open | A scratch-first run on EU1 passes the seven [gates](#thin-storage-qualification-gates) and yields the receipt. |
| R2b | Open | An R2 successor carries the receipt; EU `thin_storage` template and EU1 thin selection are active; thin create, backup, restore and delete pass; density and sleeping CPU release are measured. |
| Handover | Open | Client adapter, timeout policy, restore/new ID mapping, capacity and recovery are documented. Neon migration is a separate task. |

## Restart class — one pre-EU gate

| Changed fact | Required programmed behavior |
| --- | --- |
| Host files | Apply declarations, activate at the supported boot, verify both actual files. |
| Kubelet serving leaf | Refresh the public pin through authenticated identity-bound Talos/Kubernetes; keep strict TLS. |
| Bootstrap taint | Remove only its owned persisted entry for admitted nodes; wait for vendor reconciliation. |
| Boot/Node/cluster identity | Verify fresh boot while retaining Node, cluster, hardware and volume identities. |
| Pool slots / Pod IPs | Respect the region runtime switch, refill only enabled pools, refresh actual routes and observations. |
| Operation deadlines | Preserve original orders/storage and uncertain writes; handle maintenance without expiring valid work. |

## Node acceptance

Six checks per node:

1. Selected Talos/Kubernetes release and Node Ready.
2. Flux/Helm/platform Ready at the selected immutable revision.
3. Fresh actual RAM and inventory in Cloudflare.
4. Real SQL through `db.ohmyho.st`, correct roles/TLS, deletion and physical storage reclamation.
5. R2 base backup, archived WAL and real restore into a separate target.
6. Existing databases and committed markers preserved.

US intervention accounting retains three historical OS actions, one later operator configuration
apply, public-pin/inventory repairs, one create retry and qualified consumer cycles. A programmed
activation reboot is separate. Do not claim fully automatic US acceptance from those results.
EU has no operator exception. No new server purchase is part of this corrective rollout.

The installation selects actual RAM at 76% over ten fresh consecutive minutes/stable physical
Node UID; threshold and automatic purchasing are API configurable. Eligible nodes remain available
during expansion under hard startup/CPU/storage/PostgreSQL/Barman bounds. There is no 81% cutoff,
personal email default or fixed purchase cap. Historical real ten-minute RAM acceptance is reused;
new workload density still requires measurement.

## Thin storage qualification gates

A receipt (`thin_storage_qualification` in an approved fleet release) states that all seven gates
passed for one complete thin profile hash, `openebs-lvm` driver image, `pgcf-sandbox-controller`
host extension image and exact `nodeInfo.kernelVersion` string. Activation compares exactly these
values, so a change to any of them needs a new run. The receipt comes only from a completed
`POST /v1/nodes/{id}/thin-qualifications` run (ThinQualification Workflow): release approval
refuses any other receipt, and gate flags typed into a release are not a qualification. The
producer has not run live yet.

The run is scratch-first on EU1 after R2: it creates `pgcf_thinpool` with the product command and
the exact profile geometry from free extents, uses a fenced deny-all namespace with a quota, scratch
volumes and a PostgreSQL Pod from the release's `postgres` pin, then deletes its volumes and pool.
It creates no node thin selection, because a selection cannot be undone. It records the node
identity at setup and the measured evidence of every gate; Cloudflare computes each pass decision
from that evidence. Preconditions: R2 accepted with the EU pool switch on. The run needs a release
that pins the thin guard, as R2 does; such a release configures and requires `dm_thin_pool` on
every role, so R2's own patch loads the module on EU1 and control without a receipt. A
receipt-bearing release requires thin write authority only from members that take databases or
already have a selection, so control/relay converges without a pool.

The [qualification runbook](../operations/recovery.md#thin-storage-qualification-run) is the single
definition of the complete preconditions, the procedure and the pass criteria computed by code.

| Gate | Proves |
| --- | --- |
| `data_full` | A full data pool fails writes fast and recovers by growth without losing commits. |
| `metadata_full` | Metadata never runs out before data, and metadata exhaustion fails closed. |
| `noflush_quiescence` | A noflush suspend freezes writers, also on a full pool, and resume drains within budget. |
| `resume_marker` | Resuming the exact volume keeps committed data and drops uncommitted work. |
| `startup_bound` | A cold start (initdb plus bulk load) stays inside the profile's startup and IO bounds. |
| `trim_delete_recreate` | Deleting a volume returns its extents, and a recreated volume starts clean. |
| `retained_thick_preservation` | Thin work leaves retained thick volumes and databases with the same identities, readiness and WAL archiving. |

The thin class sets no filesystem `discard` option, so the run qualifies extent return only on
volume deletion, not for deletes inside a running filesystem; requiring them is an open owner
decision.

Keep Done to one row per completed step, at most one measurement line and roughly 15 lines.
Record only final customer-readiness results here; detailed hashes, bytes and intermediate
corrections remain in Git history and protected receipts. Runbooks are English and API-only.
[Runtime design](rust-runtime-and-cold-starts.md) and [operations](../operations) supply procedures.
