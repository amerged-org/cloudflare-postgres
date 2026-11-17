# PostgreSQL application features — design and implementation order

Proposed on 2026-11-17. This design covers three independently releasable capabilities for applications using PGCF. Each linked plan has its own acceptance criteria. The choices reflect common application scenarios and apply across integrators.

| Capability | First usable outcome | Implementation plan |
| --- | --- | --- |
| Database extensions | A database owner can enable indexed typo-tolerant search. An existing booking or case-insensitive uniqueness constraint survives recovery. | [Extension support](2026-11-17-postgres-extensions-plan.md) |
| Supabase migration | An integrator can determine which access rules a schema import preserves and verify the same allowed and denied operations against PGCF. | [Policy-preserving import](2026-11-17-supabase-rls-import-plan.md) |
| Live updates | An authorized viewer of one application board learns when their visible board changes. A change visible only to another viewer produces no browser event. | [Authorized change notifications](2026-11-17-authorized-live-updates-plan.md) |

## Delivery order and ownership

1. Start extension inventory and importer work in parallel. The base extension set is `pg_trgm`, `unaccent`, `btree_gist`, `citext` and `pgcrypto`. Prioritize `pg_trgm` for new search workloads. Activation belongs to the selected database. Preserve the behavior and extension dependencies of existing databases.
2. Qualify those capabilities on the signed PostgreSQL 18 security release. Reuse the separate P1 engine update and its EU1 evidence: a matching installed package digest and a SQL version read from a freshly started fixture on PostgreSQL 18.7 or a superseding patched 18.x release. The November 15 hardening release retained the previous package lock. The remaining security patches are independent. See the [upstream fixes](https://www.postgresql.org/docs/release/18.7/) and [OS maintenance procedure](../operations/recovery.md).
3. Take PostGIS first among the optional extensions when a radius or service-area workload is selected. The other independent options are `pg_jsonschema` for validated JSON documents and `ltree` for hierarchical paths. Each has a concrete acceptance case in the extension plan.
4. Start browser delivery with a selected application, an actual authorization model and one bounded view. PGCF owns committed-event delivery. The adopter owns the end-user session, visible view, browser endpoint and UI. Application authentication, subject mapping and Supabase-specific conversions also live in the adopter repository. Integrators can implement both contracts without adopting another platform's SDK.

## Release boundary

Use the current signed node image, the existing CI workflow and disposable, operator-owned EU1 databases for PGCF acceptance. A live product check for an adopter also crosses that adopter's actual runtime and ingress. Obtain the owner's explicit costed go before a production write or new paid resource. Each work package closes with its measured result in the [ULTRA plan](cloudflare-convergence-and-serverless-plan.md). The entries here are proposed work.
