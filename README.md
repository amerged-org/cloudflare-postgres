# cloudflare-postgres

Open-source, Neon-style serverless PostgreSQL that runs on **your Cloudflare account** and **your
Contabo VPS**. Cloudflare runs the whole control plane and is the only way into the databases.
The VPS run real, unmodified PostgreSQL under CloudNativePG. The planned initial deployment uses two EU
VPS (one control-plane/worker and one worker) and one US control-plane/worker VPS. Customer
databases run on all three nodes with resources reserved for the system and platform; server
loss is recovered from R2.

- Create, resize, suspend, restore and delete databases through a versioned API.
- Connect through Cloudflare: PostgreSQL over WebSocket. The VPS expose no database port.
- Databases sleep when idle and wake on the next connection.
- Continuous backups to R2 with point-in-time recovery.
- Usage and infrastructure-cost metrics per database. You put your own pricing on top.
- Horizontal scaling: Cloudflare adds Contabo VPS through the Contabo API within your caps.

[ohmyho.st](https://ohmyho.st) is the first adopter. It will replace Neon with this service.

## Status

**Dev foundation rebuilt; full database path pending (2026-10-03).** The first EU node and all
five Flux platform releases are `Ready`. Authoritative storage cycles completed, and a fresh
identity-bound proof published 95 GiB in 112.09 s. CI run `37120159676` for `0846597` passed; the
regional agent and gateway pin the published image digest recorded in [PLAN.md](PLAN.md#11-status).
Image signing remains pending.

Phase 1 services and native WebSocket forwarding are implemented. Against real PostgreSQL,
100 MiB and 1 GiB COPY and SELECT wire-hash checks passed with unchanged 192 MiB local memory
guards. The original default Neon decoded-binary result assertions still fail because of upstream
parsing. Dev decommission and independent re-inventory completed with all 174 foreign resources
unchanged; first-EU operator access and foreign IPv4/IPv6 refusal checks passed.

S1 preliminary DNS, TLS, HTTP, WebSocket, 1 MiB binary and 30 s checks passed. The full 600 s test
failed strict completion at 599,970 ms despite 24 ping/pong exchanges; clock correction and a full
rerun remain pending. Rollback rejected the returned domain ID before transport, so the spike
Worker and custom domain remain present pending reviewed correction and cleanup. Temporary
worktree cleanup and the formal Phase 0 live harness rerun after the layout fix remain pending.
Phase 0 and Phase 1's E0–E6 complete database chain have not passed live acceptance; Phase 2 has
not begun. The second EU node is untouched, the US node has not been bought and no production
writes occurred. See [PLAN.md](PLAN.md#11-status) for measured results and remaining work.

## Architecture

```mermaid
flowchart LR
  subgraph Clients
    App["Apps and Workers<br/>PostgreSQL over WebSocket<br/>database and user hints"]
    Tools["psql and migrations<br/>via pgcf connect"]
    Integrator["Integrator backend<br/>e.g. ohmyho.st"]
  end

  subgraph CF["Your Cloudflare account: control plane"]
    Edge["Edge Worker<br/>D1 admission, signed route"]
    API["API Worker<br/>/v1"]
    DBA["DatabaseActor DO<br/>per database: wake, idle, usage"]
    RL["RegionLink DO<br/>per region"]
    WF["Workflows<br/>restore, add node"]
    D1[("D1<br/>state and usage")]
    R2[("R2<br/>backups and WAL")]
    Boot["Container<br/>node bootstrap"]
  end

  subgraph Region["Contabo region: Talos and Kubernetes"]
    CFD["cloudflared<br/>outbound tunnel"]
    GW["Gateway<br/>Startup validation, TLS, traffic"]
    Agent["Regional agent"]
    CNPG["CloudNativePG"]
    PG[("PostgreSQL per database<br/>local LVM volume")]
  end

  Contabo["Contabo API"]

  App --> Edge
  Tools --> Edge
  Integrator -->|"manage, usage, costs"| API
  Edge <--> DBA
  Edge -->|"native WebSocket, signed v2 route"| CFD
  CFD --> GW
  GW -->|"validated Startup, TLS"| PG
  API --> D1
  API --> WF
  DBA <--> RL
  RL <-->|"outbound WebSocket"| Agent
  Agent --> CNPG
  CNPG --> PG
  PG -->|"Barman Cloud"| R2
  WF --> Contabo
  WF --> Boot
  Boot -->|"install Talos, join"| Region
```

Connecting to a sleeping database (sleep and wake arrive in Phase 2; in Phase 1 databases always run):

```mermaid
sequenceDiagram
  participant C as Client
  participant E as Edge Worker
  participant A as DatabaseActor
  participant R as RegionLink
  participant G as Regional agent
  participant P as PostgreSQL

  C->>E: GET /v2?database=id&user=role (untrusted hints)
  E->>A: ensureAwake()
  A->>R: wake (coalesced)
  R->>G: wake db-id
  G->>P: remove CNPG hibernation
  P-->>G: ready
  G-->>R: observed ready
  R-->>A: ready
  A-->>E: awake
  E->>P: native WebSocket via Tunnel and gateway (signed v2 route)
  C->>P: gateway validates Startup; PostgreSQL SCRAM end to end
```

| Part                  | Where                | Job                                                                                  |
| --------------------- | -------------------- | ------------------------------------------------------------------------------------ |
| API Worker            | Cloudflare           | `/v1` API, D1 state, Durable Objects, Workflows, usage rollups                       |
| Edge Worker           | Cloudflare           | Database endpoint: D1 admission, wake, signed route, native forwarding |
| Regional agent        | Kubernetes           | Reconciles databases into CNPG resources; hibernate/wake; reports status and samples |
| Gateway + cloudflared | Kubernetes           | Entry from Cloudflare; startup validation before PostgreSQL dial, TLS, stream counters |
| Node bootstrap        | Cloudflare Container | Turns a Contabo VPS into a Talos node                                                |
| Platform              | Kubernetes (Flux)    | Cilium, OpenEBS LocalPV LVM, cert-manager, CloudNativePG, Barman Cloud plugin        |

The approved client endpoint is `GET /v2?database=<id>&user=<role>` on the single database hostname.
Configure the Neon serverless driver's `Pool`/`Client` WebSocket mode with `pipelineConnect=false`
and a `wsProxy` URL containing both URL-encoded hints. Requests to the bare `/v2` endpoint or with
missing or invalid hints are unsupported. Edge checks the database and role against D1, signs a
v2 routing token with mandatory user, and returns the unopened upstream WebSocket for native
forwarding. Admission failures return a small failure-only `101` WebSocket carrying a PostgreSQL
SQLSTATE error before any gateway upgrade or PostgreSQL dial. The live Cloudflare transport is
still unselected.

The gateway checks the actual PostgreSQL StartupMessage database and user against the signed
route before opening PostgreSQL. It owns SSL/GSS preludes, CancelRequest, startup parsing and the
startup deadline, negotiates verified TLS to PostgreSQL, and measures stream bytes and connection
events. SCRAM authentication runs end to end with PostgreSQL; uncertain writes are never replayed.

## Self-hosting requirements

- A Cloudflare account on the Workers Paid plan, with a zone that hosts one endpoint hostname
  (`db.your-domain`): Workers, D1, Durable Objects, Workflows, R2, Tunnel and Containers.
- A Contabo account with API credentials. The lab uses Cloud VPS with 4 vCPU and 8 GiB.

An install path is part of the open-source release phase in [PLAN.md](PLAN.md#phase-5--open-source-release).

## Documents

- [PLAN.md](PLAN.md): scope, architecture, phases, decisions and status.
- [AGENTS.md](AGENTS.md): contributor and coding-agent brief.
- [THIRD_PARTY.md](THIRD_PARTY.md): upstream components and licenses.
- [infra/](infra/README.md): Talos, platform and backup recipes.
- [Native external probe](docs/operations/native-external-probe.md): the supplemental Dev TCP/25
  check for Phase 1 network isolation, including provenance verification and cleanup.

## License

Original code and documentation: [Apache License 2.0](LICENSE). Third-party components keep their
own licenses. This is an independent project, not affiliated with Cloudflare, Contabo, Neon,
Supabase or CloudNativePG.
