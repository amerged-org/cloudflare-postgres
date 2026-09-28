# Database roles and credential rotation v1

This generic lifecycle creates restricted login roles, applies them through CloudNativePG, verifies fresh password-authenticated PostgreSQL connections and reveals only the currently applied credential. A role does not automatically gain table privileges or ownership. Database/owner management, public endpoints, pooling and complete installation qualification remain separate requirements.

## Customer API

The base path is `/v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/roles`. Existing organization `projects:read` permits metadata reads. `projects:write` is required for creation, rotation and credential disclosure; metering/budget/region credentials never authorize customer disclosure. All identities derive from an existing ready environment and its accepted Cluster UID/spec; callers cannot provide a backend URL, namespace, admin credentials, privileged attributes or role memberships.

`POST` with `Idempotency-Key` accepts exactly `{name, connectionLimit}`. A lowercase identifier of at most 63 characters excludes `app`, `postgres`, `streaming_replica`, and prefixes `pg_`/`cnpg_`. Connection limit is an integer from 1 to 1000. Server-generated passwords have 256 random bits. The response is `202 {role, operation}` without a password. Repeated identical requests recover the same immutable intention; changed payloads under the same key conflict.

`GET /{roleId}` reports metadata and desired/applied credential revisions. `GET /{roleId}/credentials` returns `{credential:{roleId,credentialRevision,username,password,database:"app",observedAt}}` only after the latest desired revision was verified and applied. Pending/failed/superseded state returns a conflict. Responses use `Cache-Control: no-store`; errors never echo credentials.

`POST /{roleId}/rotate` with `Idempotency-Key` accepts exactly `{expectedCredentialRevision}`. One pending operation per role is allowed. Rotation is conditional on the latest revision already being applied. It creates a new immutable credential version and operation; exact old request/result replay cannot overwrite or reveal a newer revision.

## Storage and execution authority

`ROLE_CREDENTIAL_KEYS` is a dedicated Worker Secret with `{active,keys}`; each named key is a base64url-encoded 32-byte AES key. Retain previous keys for recovery and decrypting existing revisions. Do not reuse provider credentials or allowance keys. AES-256-GCM uses a fresh 96-bit nonce and authenticates organization, project, environment, region, spec/Cluster identity, role and credential revision. D1 stores ciphertext and key/context metadata, never plaintext passwords. Missing keys fail before issuing work; key loss remains a disaster-recovery responsibility.

Separate role-operation tables and `/v1/regions/{regionId}/role-operations/{claim|operationId/renew|operationId/result}` reuse executor `operations:claim`/`operations:report` permissions while preserving the existing create-only protocol. Claims return the exact current task, credential and previous credential only to the bound trusted regional executor over HTTPS. Stable immutable operations, scoped idempotency, token identity, lease epoch/hash/expiry and current desired revision fence retries and uncertain results. Claims expire; no administrative password is supplied. Failed results accept only `ownership_mismatch`, `spec_conflict` or `credential_verification_failed` with a null observation. Unknown transport, TLS or operator outcomes remain deferred rather than becoming guessed failures.

## Regional application and connection verification

Bind the owned namespace/Cluster to the accepted environment/spec/Cluster UID. Each credential revision has an immutable owned `kubernetes.io/basic-auth` Secret; the stable `DatabaseRole` references its exact Secret name. Its immutable cluster/name and explicit restricted attributes prevent privilege escalation. Apply UID/resource-version conditional changes with a monotonic credential-revision annotation; never downgrade a newer role. Lost create/patch responses require matching owned readback before further writes.

Wait for `DatabaseRole.status.applied`, current `observedGeneration`, and `secretResourceVersion` equal to the exact intended Secret resourceVersion. A noticed-Secret condition or successful CRD patch is insufficient. Read back Cluster/role/Secret identity around verification. Namespace policy admits only the installation-configured trusted verifier Pod identity to owned database Pods.

The maintained PostgreSQL driver opens a fresh connection to the derived `database-rw.<owned-namespace>.svc:5432`, using only the public server CA certificate and strict hostname/TLS verification. No client certificate, environment-derived DSN, arbitrary host or superuser is used. Check expected user/database, writable primary and restricted role attributes. On rotation a second fresh connection using the old password must fail specifically with SQLSTATE `28P01`; a network/TLS timeout is not password invalidation evidence. Close every connection, bound transport/query deadlines and sanitize errors. Existing sessions can survive password rotation.

Report success only with exact role/Secret/Cluster identities, applied versions and authenticated connection observations. Unknown outcomes remain retryable through the same durable operation; they cannot publish a credential. Customer password disclosure does not establish an externally reachable endpoint, backup/restore health, tenant isolation, or independent budget enforcement.

## Bounded qualification

Three top-level red-first cases cover the Worker lifecycle through encrypted intent/disclosure/rotation, regional uncertain application with exact readiness, and stale/lost-authority/foreign ownership refusal. Use changed-file tests during iteration and one final frozen canonical gate. Real CNPG application, new/old password checks, role privileges, networking, key recovery and the selected container/runtime still require independent operational evidence.

Upstream behavior: [CNPG 1.30.1 role management](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/docs/src/declarative_role_management.md), [role status](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/api/v1/databaserole_types.go), [SQL application](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/management/controller/databaserole_controller.go), [node-postgres TLS](https://node-postgres.com/features/ssl).
