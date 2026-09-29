# Native session pooling checkpoint — 2026-09-29

A single internal CNPG-managed PgBouncer now serves the unchanged manual PostgreSQL lab. This is positive native pooling/TLS/transaction evidence, not an API-managed environment, external customer endpoint, complete pilot or M5 gateway acceptance.

## Reused components and deployment

The [opt-in pooling recipe](../../infra/pooling/README.md) uses CloudNativePG 1.30.1, PgBouncer 1.25.2 and the existing cert-manager release. The official registry index and Linux amd64 manifest were verified by content digest. The running binary reports PgBouncer 1.25.2. No pooler fork or local protocol implementation is introduced.

An independent cert-manager frontend CA and leaf cover the exact internal Pooler Service DNS. Only `clientTLSSecret` is supplied; pinned CNPG source confirms its automatic backend authentication remains enabled. The PostgreSQL server certificate already covers the generated short RW backend hostname. The Pooler requires frontend TLS and backend `verify-full`; its one-instance session policy uses Recreate and explicit main/init requests and limits. These are bounded lab values, not a measured production sizing floor.

The installed API accepts all five objects. One guarded creation sequence completed in 18.790 seconds: two Issuers, two Certificates and one Pooler. All certificates/issuers reached Ready, and the current-generation Deployment has one Ready Pod with zero restarts and the exact pinned image. Both main and initialization resources match the recipe. One ready Service endpoint and the issued frontend SAN are verified. Existing request reservations fit one additional Pooler, while aggregate declared limits remain oversubscribed; sustained memory/load behavior is unqualified.

## Real native SQL evidence

One disposable, deadline-limited client Pod used the existing application credential through Secret references and mounted only the frontend public CA. No password, CA private key or leaf private key was read into local evidence. Its fresh connection uses `sslmode=verify-full` with the exact Pooler hostname. The 7.030-second run passes six checks:

- Expected application user/database, writable primary, nonsuperuser role and PostgreSQL backend TLS.
- Qualification schema/table insert/read inside a transaction, acknowledged rollback and schema absence afterward; temporary session state survives a transaction and subsequent query.
- Unencrypted client connection rejected because TLS is required.
- Incorrect password rejected.
- Native client cancellation of `pg_sleep` returns SQLSTATE `57014`.
- A fresh connection succeeds after cancellation.

The permanent-schema probe is fully rolled back. No committed customer relation is changed. The completed probe Pod was removed with UID/resource-version preconditions and absence readback. The Pooler remains running.

These checks exercise the actual CNPG Pooler and database, independently of the previously stopped standalone PostgreSQL fixture. That fixture was not repaired, restarted or represented as passing. The deployed role/database verifier functions were not invoked by this psql probe; their separate positive qualification remains open.

## Source preservation and bounded observation

Database Cluster UID/spec/current primary remain unchanged. The Node UID/boot identity, 27 existing active Pod identities and regular/init restart counters are preserved. All four PV/PVC identities and specifications remain Bound, and both existing SQL marker counts remain one. Automatic CNPG integration adds its internal pooler authentication role/function/certificate; “unchanged Cluster spec” does not mean no internal SQL administration occurred.

A supplemental read-only attempt to inspect selected nonsecret effective configuration parameters used the wrong generated path. A second source-path resolution attempt failed before another live read. That observer is stopped after two attempts; no third correction/run or effective-file comparison is claimed. The independent successful SQL/TLS/cancellation evidence and CR/Deployment configuration remain intact. This observation failure introduced no workload change or broadened test suite.

The change adds upstream configuration/examples and documentation only. Installed-API dry-runs, artifact/identity/certificate checks and the bounded live SQL qualification replace speculative unit tests; no application runtime source, new top-level test or full workspace gate was added or rerun. The previous recovery-read gate remains separately recorded.

## Remaining integration gates

The manual lab namespace has no tenant network policy; successful internal access establishes no adversarial isolation. Public native/direct endpoints, gateway selection, failover, multi-Pod cancellation, pool exhaustion, credential expiry/rotation and certificate-renewal/reconnect behavior remain unqualified. Transaction mode is not offered by this checkpoint.

Before enabling pooling for API-managed environments, version the desired pooling policy and account for database initialization/maintenance plus Pooler/rollout resources under one quota owner. Keep direct credential verifiers and the direct migration path. Add selected client/Pooler network identities, durable endpoint observations bound to Cluster/Pooler/Deployment identities, attributable Pooler metering, and stop/hibernate behavior covering its compute. Existing instance-only metering and stop evidence do not already cover a Pooler. Do not silently mutate immutable historical profiles or claim all database-related compute is stopped while the Pooler remains active.

Backup/PITR, independent recovery, budget enforcement and production admission remain open. The R2 credential is still prepared pending its specific approval; no Cloudflare access was expanded. Provider credentials stay in existing Worker Secrets, and local credentials/evidence remain ignored.

Sources: [CNPG automatic integration predicate](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/api/v1/pooler_funcs.go), [PgBouncer TLS/configuration generator](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/management/pgbouncer/config/config.go), [generated Deployment and TCP readiness](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/specs/pgbouncer/deployments.go), [PgBouncer 1.25.2 cancellation semantics](https://github.com/pgbouncer/pgbouncer/blob/pgbouncer_1_25_2/doc/config.md).
