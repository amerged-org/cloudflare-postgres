# Third-party component inventory

Reviewed: 2026-09-27. Scope follows the open-source-first revision in [PLAN.md](PLAN.md); hosted billing and reselling are deferred, while usage reporting and budget APIs remain in v1.

**This is a planning inventory. No third-party source code, binaries, container images, or dependencies are bundled in the initial repository.** No implementation versions have been selected or pinned. The links below identify the upstream projects and license evidence reviewed for the approved architecture; they are not a dependency lockfile.

The repository's [Apache License 2.0](LICENSE) applies to original project work. Upstream components retain their own licenses, copyright statements, notices, and any source-availability obligations. Recheck the exact selected release and its dependencies before integration or redistribution.

## Planned database and access components

Every component in this table is **not integrated**. A planned role expresses an architecture decision, not verified compatibility.

| Component and source | License evidence | Planned role and boundary |
|---|---|---|
| [PostgreSQL](https://www.postgresql.org/) | [PostgreSQL License](https://www.postgresql.org/about/licence/) | Ordinary PostgreSQL engine; supported versions and extensions will be pinned and tested. |
| [CloudNativePG](https://github.com/cloudnative-pg/cloudnative-pg) | [Apache-2.0](https://github.com/cloudnative-pg/cloudnative-pg/blob/main/LICENSE) | Core operator for database lifecycle, replication, failover, roles, resizing, hibernation, and recovery integration. |
| [PgBouncer](https://github.com/pgbouncer/pgbouncer) | [ISC](https://github.com/pgbouncer/pgbouncer/blob/master/COPYRIGHT) | Default pooling through CNPG Pooler resources. Upstream COPYRIGHT identifies ISC even when automated repository detection reports NOASSERTION. |
| [Supabase postgres-meta](https://github.com/supabase/postgres-meta) | [Apache-2.0](https://github.com/supabase/postgres-meta/blob/master/LICENSE) | Optional private metadata, schema administration, SQL tooling, and type generation after the native pilot. Keep it behind our authorization and routing; it is not a standalone security boundary. |
| [Supabase Studio](https://github.com/supabase/supabase/tree/master/apps/studio) | [Apache-2.0 monorepo license](https://github.com/supabase/supabase/blob/master/LICENSE) | Optional selected-database workbench after the native pilot. Prefer narrow integration before committing to a persistent fork. Hosted account/billing UI is later scope. Review package-level assets and dependencies when selecting code. |
| [PostgREST](https://github.com/PostgREST/postgrest) | [MIT](https://github.com/PostgREST/postgrest/blob/main/LICENSE) | Optional per-database REST/RPC API; preserve PostgreSQL grants, RLS, and JWT role boundaries. Not the platform management API. |
| [Neon proxy](https://github.com/neondatabase/neon/tree/main/proxy) | [Apache-2.0 core repository license](https://github.com/neondatabase/neon/blob/main/LICENSE) | Evaluation candidate, not preferred or selected. Require a production adapter plus explicit maintainer, security-update process, protocol acceptance, and bounded patch surface. |
| [Neon serverless driver](https://github.com/neondatabase/serverless) | [MIT](https://github.com/neondatabase/serverless/blob/main/LICENSE) | Optional supported client after proving the selected gateway's HTTP/WS contracts; not needed for the generic native PostgreSQL pilot. |
| [Barman Cloud CNPG-I plugin](https://github.com/cloudnative-pg/plugin-barman-cloud) | [Apache-2.0](https://github.com/cloudnative-pg/plugin-barman-cloud/blob/main/LICENSE) | CNPG integration for physical backup, WAL archival, and recovery. Test R2 restore, retention, deletion, and distinct source/target archive identities. |
| [Barman / barman-cloud](https://github.com/EnterpriseDB/barman) | [GPL-3.0 license text](https://github.com/EnterpriseDB/barman/blob/REL_3_X_master/LICENSE); declaration discrepancy below | Backup/recovery tooling used with the plugin; separately licensed and not relicensed by this repository. |

### Maintenance and compatibility evidence

The Neon proxy has very limited recent public activity, including a functional [authentication fix on 2026-05-25](https://github.com/neondatabase/neon/commit/8f60b04da47ffefe0e52bda2440134b42874eb75). This justifies the maintenance gate; it is not evidence that the project is officially discontinued.

The original R2 restore reporter in [Barman plugin issue #411](https://github.com/cloudnative-pg/plugin-barman-cloud/issues/411#issuecomment-3572945793) resolved the failure as a naming/archive conflict. Other comments describe retention/deletion issues with other S3 systems. Validate every offered backup operation on pinned versions rather than labeling all R2 restore paths broken.

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
| [Prometheus](https://github.com/prometheus/prometheus) | [Apache-2.0](https://github.com/prometheus/prometheus/blob/main/LICENSE) | Operational metrics; authoritative usage observations and budget reservations follow the D1-backed product contract. |
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
| [OpenMeter](https://github.com/openmeterio/openmeter) | [Apache-2.0](https://github.com/openmeterio/openmeter/blob/main/LICENSE) | Unselected future hosted-service option. No v1 dependency or implementation work is required for usage reporting and budget enforcement. |
| [OpenCost](https://github.com/opencost/opencost) | [Apache-2.0](https://github.com/opencost/opencost/blob/develop/LICENSE) | Unselected future option. No cost/margin study or v1 adoption task is included in this revision. |
| [Omni](https://github.com/siderolabs/omni) | [Business Source License 1.1 / BUSL-1.1](https://github.com/siderolabs/omni/blob/main/LICENSE) | Excluded from the default open-source stack. Its production and business-dependent use conditions require a separate licensing decision. |

## Adoption and provenance rules

1. Prefer supported upstream images, packages, and APIs; write narrow adapters before maintaining forks.
2. Before integration, record the exact release/commit, source URL, artifact digest, license files, notices, dependency inventory, and any local changes.
3. Preserve required copyright and license material. Distribute corresponding source or notices when an upstream license requires them.
4. Treat product names, logos, and other branding separately from source-code licenses. Use this project's own identity.
5. Never label a candidate as integrated or compatible without its real acceptance evidence. Passing a build is not proof of safe multi-tenant operation.
6. Do not copy private consumer source or configuration into this public repository without an explicit provenance and publication review. Consumer adapters and compatibility TODOs belong in consumer repositories.
7. Replace moving-branch evidence with pinned-release references when adopting a component, and revisit licensing when upgrading.

Cloudflare and Contabo are deployment/service providers, not bundled open-source components. Their service terms and operational capabilities are separate from the licenses above. V1 self-hosting requires the adopter's own Cloudflare account; Workers, D1, Durable Objects, R2, and secret bindings are managed-service dependencies, not Apache-licensed software shipped by this repository.
