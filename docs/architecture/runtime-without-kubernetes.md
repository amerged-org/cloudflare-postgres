# Proposal: a database runtime without Kubernetes (2026-10-17)

Status: proposal, not decided. The owner asked on 2026-10-17 whether PGCF needs Kubernetes at all.
This page records the answer of that analysis so the rework can start from it. It changes nothing
until the owner decides; until then [AGENTS.md](../../AGENTS.md) ("unmodified PostgreSQL with
CloudNativePG on Talos Linux and Kubernetes") and the [ULTRA plan](cloudflare-convergence-and-serverless-plan.md)
stay authoritative. Figures marked *estimate* are not measured.

## Short answer

PGCF does not need Kubernetes. Every database is one PostgreSQL instance (`instances: 1`) pinned by a
node selector to the node Cloudflare already chose (`apps/native-controller/src/manifests.rs`), and a
move between nodes is already a restore from R2. Placement, routing and generation authority live in
D1. Kubernetes and CloudNativePG (CNPG) schedule nothing; they carry about 20 objects per database
that the controller and gateway use to pass fences, targets and CAs to each other. That layer is the
reason for the slot pool, for most of the cold node path, for the 4–21 s pool miss, for the control
server and for most incidents since 2026-10-12 (guard SIGKILLs, the driver deleting the thin pool,
rollout deadlocks, the stale sleep fence of 2026-10-17).

## What the layer costs today

| Item | Today |
| --- | --- |
| Cold node path, release 23 | 469 ms: attach 75 (ext4 mount 68), archive binding 33, PostgreSQL start after the fence lift 275, release 82 |
| Share of Kubernetes and CNPG plumbing in it | about 280–340 ms (*estimate*) |
| PostgreSQL clean start on EU1 | 111–117 ms to ready including `pg_ctl`'s 100 ms poll; first SQL at 136–169 ms |
| Pool miss | Pod recreation 4.1–5.2 s plus the chain; 20.9 s on the old path |
| Release 24 cold p95 (6 databases × 5 rounds, idle about 125 s, from a Worker) | first answer p50 693 ms, p95 1,080 ms (3 of 29 over 1 s); whole request p50 1.15 s, p95 1.50 s; 1 of 30 refused |
| Fleet rollout | 38–49 min per two-node rollout |
| Node reserve on a 12 GB node | 1 GiB kubelet reserve, about 1 GiB idle platform, 1,650m of 6,000m CPU, 100m/128 MiB backup sidecar per awake database |
| Code shaped by Kubernetes, Talos, CNPG and OpenEBS | about 125k of about 360k lines (*estimate*) |

## Options and scores

Three judges scored four options from 0 to 10 under one lens each.

| Option | Goal and simplicity | Data safety and security | Delivery risk |
| --- | --- | --- | --- |
| A: keep Talos, Kubernetes, CNPG and OpenEBS; simplify inside them | 3.5 | 6 | 7 |
| B: Kubernetes as a thin platform, PostgreSQL processes in one privileged Pod per node | 5.5 | 4.5 | 3 |
| **C: no Kubernetes; systemd and a Rust node agent per VPS** | **8.5** | **7** | **5** |
| D: one Firecracker or Unikraft microVM per database | 1.5 | 4 | 1 |

D is ruled out on cost: Contabo VPS have no `/dev/kvm`, and KVM-capable VDS cost about 3.3 times more
per GB of RAM. B keeps the platform risk and adds C's rebuild.

## Option C

- Each VPS (eu1, eu2, us1, us2) is self-contained: a minimal Linux with systemd (Flatcar with an
  immutable `/usr`, or Debian minimal as the fallback), cloudflared, today's native gateway and one Rust
  node agent. No control server: there is no etcd, API server or relay to host.
- Each database is a sandboxed systemd unit (`pgcf-pg@<id>`) running unmodified PostgreSQL on its own
  thin LVM volume, under its own Linux user, with no network: it listens on a Unix socket only, so the
  VPS still exposes no PostgreSQL port.
- WAL and base backups go to R2 with the barman-cloud 3.20.1 tools that plugin-barman-cloud wraps
  today, with the same destination path and server name, so the R2 layout stays the same. The R2 key
  stays out of the tenant sandbox.
- Cloudflare (D1, Durable Objects, Workflows, R2, Tunnel) stays the only control plane; the agent takes
  orders over the existing outbound link. The Edge, the route token, the gateway's hold-and-release
  protocol, the API, usage metrics and capacity tracking stay.
- Every wake takes the same path (mount if needed, start PostgreSQL, release the gateway): there is no
  pool and no miss branch. *Estimate*: node path 40–140 ms with volumes kept mounted, 110–260 ms when
  mounting at wake; first answer about 0.55–0.65 s in the middle and a p95 of about 0.7–0.9 s, because
  the Cloudflare connect (182–670 ms in release 24) stays.

What we would lose or have to rebuild: CNPG's tested lifecycle (start and backup setup at create, PITR
into a new database, scheduled base backups and retention, crash restart, shutdown order on sleep,
roles and configuration files; the backup part is *estimated* at 1–2k lines), Talos's API-only host,
the live acceptance already earned on the pool path, the plugin's parallel WAL upload, and the
"standard Kubernetes operator" story. Effort *estimate*: 11–14 engineer-weeks, about 4–6 calendar
weeks, new code 8–15k lines including tests.

## Staged path

1. **Now:** keep EU1 on the pool and fix live failures only; no further Kubernetes-only work (decision A
   stage B, single-node clusters, pool pre-mount). Finish a proper p95 run with databases idle at
   least one hour.
2. **Two lab tests on EU1** (2–3 days, Dev, no spend, no reinstall): (1) start `postgres -D` directly
   on a slept volume, 20 runs, with and without a CPU cap and with the volume kept mounted or mounted at
   wake; pass at a node path p95 of 150 ms or less. (2) Restore an archive that plugin-barman-cloud wrote
   with the plain barman-cloud tools, including a point-in-time restore; pass when the
   `system_identifier` matches. A lab volume must never be a thin LV the thin inventory cannot
   attribute (that makes `data_accounting_complete` false and blocks the node); use a loop file or an
   accounted name.
3. **Owner decision** if both pass: amend AGENTS.md, lift the plan's fixed scope ("no EU reinstall"),
   and choose the timing: switch EU1 before the first integrator's canary (go-live slips about 4–8
   weeks; EU1 holds only test data), or go live on the pool once a one-hour-idle p95 passes and move
   databases later by R2 restore onto a new VPS (needs a costed go).
4. **Build C** beside the running pool in three lanes (node agent; archive helper, gateway local mode
   and OS image; API, contracts and Edge), then switch EU1 in one announced window: placement off,
   every database asleep with its archive verified, final D1 backup, reinstall, enroll, restore what is
   needed, live acceptance (create, SQL, base backup and WAL, PITR, delete with reclaim, the cold p95,
   kill and reboot under writes with no lost acknowledged commit).
5. **Retire:** the control VPS, then the Kubernetes, Talos, CNPG, OpenEBS, pool, relay and fleet-patch
   code in one change, with AGENTS.md, READMEs, THIRD_PARTY and runbooks updated.

## Decisions for the owner

- Amend AGENTS.md line 7 to "unmodified PostgreSQL under systemd with local LVM"; lines 6 (Cloudflare
  ingress, no PostgreSQL port) and 8 (Barman Cloud to R2 with PITR) stay.
- Lift the fixed scope that keeps both EU servers and forbids an EU reinstall.
- Timing: switch before the first integrator's canary, or go live on the pool first.
- Run the two lab tests.
- Operating system: Flatcar or Debian minimal.
- Accept shared-kernel isolation through systemd sandboxing (the same kernel features containers use,
  plus a user per database and no tenant network).
