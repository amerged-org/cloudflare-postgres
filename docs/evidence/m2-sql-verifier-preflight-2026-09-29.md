# Real SQL verifier qualification preflight — 2026-09-29

Status: **setup stopped; no SQL qualification result**. The deployed role/database verifiers are unchanged. This checkpoint does not close the native PostgreSQL pilot or establish real password, ownership or migration behavior.

## Intended bounded lifecycle

The intended qualification uses the exact published regional image from source `218e2adb`, one isolated PostgreSQL `18.4` server and a dedicated internal Docker network without a host port. Disposable credentials/certificates stay private. The sequence is fresh role authentication, missing/existing SQL-name observation, database owner/migration/rollback checks, then fresh old-password rejection after fixture rotation. It is not a matrix, product-source repair or rerun of the existing 37-case gate.

Independent read-only review confirms the PostgreSQL 18.4 SQL syntax, implicit database-owner permissions under NOINHERIT, restricted catalog queries, verified TLS/fixed connection configuration and the installed driver’s rollback/transaction-status and `28P01` behavior. Review is not runtime evidence.

## Official image provenance and stopped setup

Official `docker.io/library/postgres:18.4` registry descriptors and configuration blobs were verified before the pinned pull. Index digest is `sha256:882236b897e39051d2368c5ccc6cda944904723506b2dfc97f2a8f5bc9afa382`, Linux amd64 manifest `sha256:7e6103cf85f88f7a0eddb3ec0b1ba8940eba098ed118ade25a729ca9daee5568` and configuration `sha256:526573c93ea530a230b553cc513075ab9d70b63bfd2300ef5eb5ad1cafbbc595`.

One registry-header case correction resolved the initial read-only assertion. The first actual fixture invocation stopped before setup because Docker 29 reported the index with blank architecture/OS fields. The second bounded setup correction selected explicit Linux amd64 inspection; its configuration-identity predicate then rejected the reported manifest ID. The workflow stopped after that second correction. Both observations and the one-use ledger are retained; no third repair or fixture invocation occurred.

The pinned image pull succeeded. No fixture network/container, generated TLS key/credential, SQL server, verifier connection, cloud/Kubernetes/provider write or product-source change occurred. An image inspection alone is not a PostgreSQL login or rollback result.

## Read-only diagnosis after the stop

A separate read-only local OCI export found and hashed the actual configuration blob. It exactly matches the verified registry configuration, Linux amd64 and package version `18.4-1.pgdg12+1`. Docker’s inspected `Id` is the manifest descriptor, not that configuration digest. The diagnostic’s initial exact package-version string observation is also retained; the full package revision is consistent with PostgreSQL 18.4.

This establishes the image’s identity and explains the observation mismatch. It does not resume or repair the stopped qualifier. Any resumed runtime work must explicitly address the existing stop and preserve its original evidence; renaming the same workflow is insufficient.

## Remaining scope

Real TLS role authentication/password rotation, unmanaged-name refusal, owner SQL schema/migration/confirmed rollback and complete API-to-CNPG/native access remain unverified operational gates. The existing unit/integration fixtures and single canonical gate remain their separately documented evidence; no new test files or broad-gate repeats accompany this preflight.

The R2 credential still awaits its specific confirmation. Physical backups, WAL, full/PITR restore, retention, independent recovery, budgets, sleep/wake, scaling and production isolation remain part of the full objective. `.env.local` is unchanged, owner-readable and excluded from Git and build contexts.
