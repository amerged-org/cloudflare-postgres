# cloudflare-postgres

Open-source, Neon-style serverless PostgreSQL that runs on **your Cloudflare account** and **your
Contabo VPS**. Cloudflare runs the whole control plane and is the only way into the databases.
The VPS run real, unmodified PostgreSQL under CloudNativePG.

- Create, resize, suspend, restore and delete databases through a versioned API.
- Connect through Cloudflare: PostgreSQL over WebSocket. The VPS expose no database port.
- Databases sleep when idle and wake on the next connection.
- Continuous backups to R2 with point-in-time recovery.
- Usage and infrastructure-cost metrics per database. You put your own pricing on top.
- Horizontal scaling: Cloudflare adds Contabo VPS through the Contabo API within your caps.

[ohmyho.st](https://ohmyho.st) is the first adopter. It replaces Neon with this service.

## Status

**Reset on 2026-10-02.** A lean design (below) replaces the first implementation. The working
Talos, Flux platform and R2 backup/PITR recipes in [infra/](infra/README.md) are kept. The
services described here are being built; see [PLAN.md](PLAN.md) for phases and status.

## Architecture

```mermaid
flowchart LR
  subgraph Clients
    App["Apps and Workers<br/>PostgreSQL over WebSocket"]
    Tools["psql and migrations<br/>via pgcf connect"]
    Integrator["Integrator backend<br/>e.g. ohmyho.st"]
  end

  subgraph CF["Your Cloudflare account: control plane"]
    Edge["Edge Worker<br/>db.your-domain"]
    API["API Worker<br/>/v1"]
    DBA["DatabaseActor DO<br/>per database: wake, idle, traffic"]
    RL["RegionLink DO<br/>per region"]
    WF["Workflows<br/>create, restore, add node"]
    D1[("D1<br/>state and usage")]
    R2[("R2<br/>backups and WAL")]
    Boot["Container<br/>node bootstrap"]
  end

  subgraph Region["Contabo region: Talos and Kubernetes"]
    CFD["cloudflared<br/>outbound tunnel"]
    GW["Gateway"]
    Agent["Regional agent"]
    CNPG["CloudNativePG"]
    PG[("PostgreSQL per database<br/>local LVM volume")]
  end

  Contabo["Contabo API"]

  App --> Edge
  Tools --> Edge
  Integrator -->|"manage, usage, costs"| API
  Edge <--> DBA
  Edge -->|"Cloudflare transport, signed route"| CFD
  CFD --> GW
  GW --> PG
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

  C->>E: wss://db.your-domain/v2 (database=id, user)
  E->>A: ensureAwake()
  A->>R: wake (coalesced)
  R->>G: wake db-id
  G->>P: remove CNPG hibernation
  P-->>G: ready
  G-->>R: observed ready
  R-->>A: ready
  A-->>E: awake
  E->>P: WebSocket via Tunnel and gateway (signed route)
  C->>P: PostgreSQL protocol, SCRAM end to end
```

| Part | Where | Job |
| --- | --- | --- |
| API Worker | Cloudflare | `/v1` API, D1 state, Durable Objects, Workflows, usage rollups |
| Edge Worker | Cloudflare | Database endpoint: wake, route, count traffic |
| Regional agent | Kubernetes | Reconciles databases into CNPG resources; hibernate/wake; reports status and samples |
| Gateway + cloudflared | Kubernetes | Only entry from Cloudflare to PostgreSQL |
| Node bootstrap | Cloudflare Container | Turns a Contabo VPS into a Talos node |
| Platform | Kubernetes (Flux) | Cilium, OpenEBS LocalPV LVM, cert-manager, CloudNativePG, Barman Cloud plugin |

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

## License

Original code and documentation: [Apache License 2.0](LICENSE). Third-party components keep their
own licenses. This is an independent project, not affiliated with Cloudflare, Contabo, Neon,
Supabase or CloudNativePG.
