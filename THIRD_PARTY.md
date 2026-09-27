# Third-party component inventory

Reviewed: 2026-09-27.

**This is a planning inventory. No third-party source code, binaries, container images, or dependencies are bundled in the initial repository.** No implementation versions have been selected or pinned. The links below identify the upstream projects and license evidence reviewed for the approved architecture; they are not a dependency lockfile.

The repository's [Apache License 2.0](LICENSE) applies to original project work. Upstream components retain their own licenses, copyright statements, notices, and any source-availability obligations. Recheck the exact selected release and its dependencies before integration or redistribution.

## Planned database and access components

Every component in this table is **not integrated**. A planned role expresses an architecture decision, not verified compatibility.

| Component and source | License evidence | Planned role and boundary |
|---|---|---|
| [PostgreSQL](https://www.postgresql.org/) | [PostgreSQL License](https://www.postgresql.org/about/licence/) | Ordinary PostgreSQL engine; supported versions and extensions will be pinned and tested. |
| [CloudNativePG](https://github.com/cloudnative-pg/cloudnative-pg) | [Apache-2.0](https://github.com/cloudnative-pg/cloudnative-pg/blob/main/LICENSE) | Core operator for database lifecycle, replication, failover, roles, resizing, hibernation, and recovery integration. |
| [PgBouncer](https://github.com/pgbouncer/pgbouncer) | [ISC](https://github.com/pgbouncer/pgbouncer/blob/master/COPYRIGHT) | Default pooling through CNPG Pooler resources. Upstream COPYRIGHT identifies ISC even when automated repository detection reports NOASSERTION. |
| [Supabase postgres-meta](https://github.com/supabase/postgres-meta) | [Apache-2.0](https://github.com/supabase/postgres-meta/blob/master/LICENSE) | Private metadata, schema administration, SQL tooling, and type generation behind our authorization and routing. Not a public standalone security boundary. |
| [Supabase Studio](https://github.com/supabase/supabase/tree/master/apps/studio) | [Apache-2.0 monorepo license](https://github.com/supabase/supabase/blob/master/LICENSE) | Adapt its selected-database workbench. Multi-project SaaS management and billing require our product layer. Review package-level assets and dependencies when selecting code. |
| [PostgREST](https://github.com/PostgREST/postgrest) | [MIT](https://github.com/PostgREST/postgrest/blob/main/LICENSE) | Optional per-database REST/RPC API; preserve PostgreSQL grants, RLS, and JWT role boundaries. Not the platform management API. |
| [Neon proxy](https://github.com/neondatabase/neon/tree/main/proxy) | [Apache-2.0 core repository license](https://github.com/neondatabase/neon/blob/main/LICENSE) | Preferred gateway adaptation candidate for native PostgreSQL, WebSocket, HTTP SQL, access control, and compute wake integration. Production backend adaptation remains a feasibility gate. |
| [Neon serverless driver](https://github.com/neondatabase/serverless) | [MIT](https://github.com/neondatabase/serverless/blob/main/LICENSE) | Reuse as a supported client after proving our gateway's corresponding HTTP/WS contracts. |
| [Barman Cloud CNPG-I plugin](https://github.com/cloudnative-pg/plugin-barman-cloud) | [Apache-2.0](https://github.com/cloudnative-pg/plugin-barman-cloud/blob/main/LICENSE) | CNPG integration for physical backup, WAL archival, and recovery. Full R2 restore compatibility must be tested. |
| [Barman / barman-cloud](https://github.com/EnterpriseDB/barman) | [GPL-3.0 license text](https://github.com/EnterpriseDB/barman/blob/REL_3_X_master/LICENSE); declaration discrepancy below | Backup/recovery tooling used with the plugin; separately licensed and not relicensed by this repository. |

### Barman declaration discrepancy

Current upstream [package metadata](https://github.com/EnterpriseDB/barman/blob/REL_3_X_master/pyproject.toml) declares `GPL-3.0-only`, while the [README](https://github.com/EnterpriseDB/barman/blob/REL_3_X_master/README.rst) and [source header](https://github.com/EnterpriseDB/barman/blob/REL_3_X_master/src/barman/__init__.py) describe GPL version 3 or later. Record the exact declarations at the selected release and resolve the discrepancy before redistribution. Do not present either SPDX variant as an unqualified repository-wide finding. The CNPG plugin's Apache-2.0 license does not change Barman's license.

## Planned server and operations components

All entries remain **not integrated**. Contabo/Talos bootstrap, local storage, and maintenance behavior require the acceptance gates in [PLAN.md](PLAN.md).

| Component and source | License evidence | Planned role and boundary |
|---|---|---|
| [Talos Linux](https://github.com/siderolabs/talos) | [MPL-2.0](https://github.com/siderolabs/talos/blob/main/LICENSE) | API-managed guest OS and Kubernetes foundation. Distributed OS packages retain their own licenses; Talos is not Apache-licensed. |
| [Kubernetes](https://github.com/kubernetes/kubernetes) | [Apache-2.0](https://github.com/kubernetes/kubernetes/blob/master/LICENSE) | Scheduling, resource policy, controller APIs, and cluster lifecycle through the selected Talos release. |
| [Flux](https://github.com/fluxcd/flux2) | [Apache-2.0](https://github.com/fluxcd/flux2/blob/main/LICENSE) | Platform release reconciliation and configuration drift control. Does not patch the host OS. |
| [OpenEBS LocalPV LVM](https://github.com/openebs/lvm-localpv) | [Apache-2.0](https://github.com/openebs/lvm-localpv/blob/develop/LICENSE) | Candidate for hard-sized local volumes and expansion; Talos compatibility and node-loss recovery must be proven. |
| [Cilium](https://github.com/cilium/cilium) | [Apache-2.0 LICENSE](https://github.com/cilium/cilium/blob/main/LICENSE); [BPF licensing distinction](https://github.com/cilium/cilium#license) | Pod network isolation. User-space code is Apache-2.0; BPF templates use `(GPL-2.0-only OR BSD-2-Clause)`. Keep host-firewall ownership with the chosen Talos policy. |
| [cert-manager](https://github.com/cert-manager/cert-manager) | [Apache-2.0](https://github.com/cert-manager/cert-manager/blob/master/LICENSE) | External certificate lifecycle; distinct from CNPG internal PKI. |
| [Prometheus](https://github.com/prometheus/prometheus) | [Apache-2.0](https://github.com/prometheus/prometheus/blob/main/LICENSE) | Operational metrics; not the authoritative customer billing ledger. |
| [Alertmanager](https://github.com/prometheus/alertmanager) | [Apache-2.0](https://github.com/prometheus/alertmanager/blob/main/LICENSE) | Alert routing, grouping, and incident notifications. |
| [OpenTelemetry Collector](https://github.com/open-telemetry/opentelemetry-collector) | [Apache-2.0](https://github.com/open-telemetry/opentelemetry-collector/blob/main/LICENSE) | Telemetry collection and export. Select only required receivers/processors/exporters. |
| [OpenTelemetry Collector Contrib](https://github.com/open-telemetry/opentelemetry-collector-contrib) | [Apache-2.0](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/LICENSE) | Optional collector components if needed; inspect their transitive dependencies individually. |

## Alternatives, optional additions, and exclusions

These entries are **not selected for the default v1 stack and not integrated**.

| Component and source | License evidence | Decision |
|---|---|---|
| [Supavisor](https://github.com/supabase/supavisor) | [Apache-2.0](https://github.com/supabase/supavisor/blob/main/LICENSE) | Alternative multi-tenant pooler only if measured requirements justify it. Do not assume a generic wake callback or deploy beside PgBouncer without a clear need. |
| [Neon wsproxy](https://github.com/neondatabase/wsproxy) | [Apache-2.0](https://github.com/neondatabase/wsproxy/blob/master/LICENSE) | Optional lightweight WebSocket-to-TCP bridge for compatibility work. It does not supply SQL-over-HTTP, pooling, or wake orchestration. |
| [Neon storage engine](https://github.com/neondatabase/neon) | [Apache-2.0](https://github.com/neondatabase/neon/blob/main/LICENSE) | Excluded from CNPG v1. Its patched PostgreSQL, pageservers, and safekeepers form a different storage architecture. Reconsider separately for later branching requirements. |
| [Neon autoscaling / NeonVM](https://github.com/neondatabase/autoscaling) | [Apache-2.0](https://github.com/neondatabase/autoscaling/blob/main/LICENSE) | Excluded from v1; its virtualization and scheduling stack is unnecessary for the accepted reconnect-based scaling contract. |
| [pg_graphql](https://github.com/supabase/pg_graphql) | [Apache-2.0](https://github.com/supabase/pg_graphql/blob/master/LICENSE) | Optional future extension if GraphQL enters scope; not an initial acceptance requirement. |
| [OpenMeter](https://github.com/openmeterio/openmeter) | [Apache-2.0](https://github.com/openmeterio/openmeter/blob/main/LICENSE) | Optional metering/billing integration if operating its dependencies is justified. Infrastructure facts and budget enforcement remain our responsibility. |
| [OpenCost](https://github.com/opencost/opencost) | [Apache-2.0](https://github.com/opencost/opencost/blob/develop/LICENSE) | Optional internal infrastructure cost and margin attribution, not customer invoice authority. |
| [Omni](https://github.com/siderolabs/omni) | [Business Source License 1.1 / BUSL-1.1](https://github.com/siderolabs/omni/blob/main/LICENSE) | Excluded from the default open-source stack. Its production and business-dependent use conditions require a separate licensing decision. |

## Adoption and provenance rules

1. Prefer supported upstream images, packages, and APIs; write narrow adapters before maintaining forks.
2. Before integration, record the exact release/commit, source URL, artifact digest, license files, notices, dependency inventory, and any local changes.
3. Preserve required copyright and license material. Distribute corresponding source or notices when an upstream license requires them.
4. Treat product names, logos, and other branding separately from source-code licenses. Use this project's own identity.
5. Never label a candidate as integrated or compatible without its real acceptance evidence. Passing a build is not proof of safe multi-tenant operation.
6. Do not copy private ohmyho.st source or configuration into this public repository without an explicit provenance and publication review. The approved architecture can be implemented independently.
7. Replace moving-branch evidence with pinned-release references when adopting a component, and revisit licensing when upgrading.

Cloudflare and Contabo are deployment/service providers, not bundled open-source components. Their service terms and operational capabilities are separate from the licenses above.
