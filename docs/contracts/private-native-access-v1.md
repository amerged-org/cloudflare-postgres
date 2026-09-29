# Optional private native PostgreSQL access v1

This opt-in path admits an installation-owned application principal to the existing
CNPG direct RW Service and publishes its provisioning observation through the
management API. It uses ordinary PostgreSQL authentication and verified client TLS;
it introduces no protocol proxy, wake operation or second pooler. It supplies
private Kubernetes connectivity, not an external hostname reachable from Workers.

## Catalog and client authority

An installation operator may include exactly this optional block in a new catalog
profile:

```json
{
  "nativeAccess": {
    "version": 1,
    "clientProfileId": "private-application"
  }
}
```

The identifier follows `^[a-z][a-z0-9_-]{0,63}$`. Customers choose the immutable
catalog profile through the existing environment API. They cannot publish a
catalog, specify a namespace or ServiceAccount, supply selectors or hostnames,
choose a port, or grant themselves Kubernetes rights. Explicit null, unknown
fields and unsupported versions are rejected. Omission preserves the earlier
profile serialization/specification hash, resource layout and readiness result.
There is no retrofit or modify-access API in this slice.

The trusted regional configuration resolves the identifier through an optional
`nativeClientProfiles` array of at most 32 unique entries. Each entry contains
exactly `id`, `namespace`, `namespaceUid`, `serviceAccount` and
`serviceAccountUid`. Namespace/ServiceAccount names are DNS labels; identities are
Kubernetes UUIDs. A managed `pgcf-<32 hexadecimal characters>` tenant namespace
cannot be the application principal's namespace.

The operator must create and protect that application namespace and ServiceAccount
independently. The namespace must already carry
`pgcf.io/native-client-uid: <its configured Kubernetes namespace UID>`. The
controller reads both identities and requires the exact marker before any
environment provisioning effect. It never patches the application namespace or
ServiceAccount to make an invalid configuration acceptable.

Application namespace administration, ServiceAccount lifecycle, Pod creation and
identity-relevant labels are trusted operator privileges. A customer database API
token supplies none of those privileges. The Cilium selector matches the namespace
name, its protected namespace marker and the logical ServiceAccount name. **It
does not enforce the ServiceAccount's Kubernetes UID for the lifetime of a grant.**
Before deleting/reusing an admitted ServiceAccount name, the operator must revoke
the old grant and coordinate its network-policy realization. A replacement
namespace must use its own fresh UID marker. Copying an old marker onto a new
namespace violates the trusted operator boundary.

## Direct service and admission reconciliation

The region validates its current fenced environment claim, owned namespace/spec
and current CNPG Cluster before offering native access. It reads the stock
`database-rw` ClusterIP Service and requires:

- `Cluster.status.writeService` names that Service, and its controller owner
  reference identifies the exact accepted `database` Cluster UID.
- The CNPG Cluster label and exact cluster/primary selector match the supported
  stock RW Service, with one TCP `postgresql` port and numeric target port 5432.
  A NodePort, external Service or unready-address route is not adopted.
- A Ready, Running, nondeleting primary Pod matches `currentPrimary`, the Cluster
  UID and the CNPG instance/primary labels.
- One operator-generated EndpointSlice belongs to the exact Service UID and
  selects that primary Pod's UID/namespace/name and observed Pod IP. Its port is
  TCP5432; the endpoint must be ready, serving and nonterminating under Kubernetes
  default semantics. The initial path supports a single address-family slice;
  ambiguous or unsupported routing remains unadvertised.

The controller then ensures one deterministic `native-client-access`
CiliumNetworkPolicy in the managed namespace. Its labels, spec hash, configured
client identities and Cluster owner reference are fixed. The only added ingress
is from the protected application namespace marker and logical ServiceAccount to
CNPG instance TCP5432. Existing database, operator and verifier policies retain
their respective ownership.

An uncertain create is resolved by reading that same deterministic name, never by
creating another grant. Foreign ownership or divergent specification fails;
there is no implicit adoption or repair. Namespace, Cluster, Service, primary,
EndpointSlice, certificates and client UID/resource versions are rechecked before
grant creation and before publication. Authority is checked after asynchronous
reads and immediately before effects. A changed observation defers publication.
Multi-object reads cannot form an atomic transaction with Kubernetes changes by a
trusted administrator; operators must coordinate such changes.

Successful API creation/readback does not prove packet enforcement. Installation
qualification must verify the actual Cilium identities, non-audit policy
realization and allowed/denied traffic. A discovery suppression is not a network
revocation or termination of existing PostgreSQL sessions.

## Certificate material and observation

Read only the Cluster's observed server CA and server TLS certificate references.
The Kubernetes adapter exposes one requested public certificate field and minimal
ownership/version metadata. It excludes private keys, other data fields and raw
Secret annotations, including possible last-applied payloads. The reconciler
accepts a bounded single PEM certificate for each field. It verifies the
self-signed CA, leaf signature/issuer, server-auth purpose, current certificate
validity and the exact derived Service DNS name with SAN verification and no
wildcards or common-name fallback. Certificate chains/custom PKI outside this
supported CNPG arrangement defer or fail; they are not silently trusted.

The optional `nativeConnection` observation contains exactly:

- Fixed `version: 1`, `visibility: private`, `mode: direct`, `port: 5432` and
  `clientProfileId`.
- `namespaceUid`, `clusterUid`, `clusterGeneration`, `specHash`, `serviceUid`,
  `serviceResourceVersion`, `primaryPodUid`, `endpointSliceUid` and `policyUid`.
- The derived actual Service `host`, public `caCertificate`,
  `caCertificateSha256` of that PEM, and `serverCertificateSha256` of the leaf DER.
- `caValidFrom`, `caValidUntil`, `serverValidUntil` and `observedAt` as UTC timestamps.

This is a **provisioning-time Kubernetes/certificate-material observation**. It
does not attest a wire SQL connection, perpetual Service/Pod identity, immediate
certificate loading or continuous health. It requires no customer password and
never supplies a client certificate or private key. CNPG remains responsible for
ordinary certificate renewal. Clients verify the actual server and current
certificate on every new connection.

## Fenced publication and customer discovery

Native-enabled profiles require the extra exact observation in the existing
leased environment-ready report; legacy profiles forbid it. The Worker binds
its client profile, namespace-derived hostname, spec hash and Cluster
UID/generation to the authoritative environment before the existing atomic D1
result/observation batch. The public CA's digest is checked. No migration or
second credential store is introduced. Worker validation trusts the authenticated
regional executor's certificate and Kubernetes evidence; it is not an independent
regional or TLS verifier.

`GET /v1/organizations/{organizationId}/projects/{projectId}/environments/{environmentId}/connections`
requires organization `projects:read`. It accepts no query parameters and returns
`200 {connection}` with the stored public observation plus `environmentId`,
`specRevision`, `sslmode: verify-full` and `observationScope: provisioning`.
Passwords remain behind the existing write-scoped credential endpoints.
Responses use `Cache-Control: no-store`.

One primary D1 snapshot rechecks the actor, owned parent/resource, active project,
enabled region, current running runtime and project/environment requested budget
state. Native-disabled/pending/suspending/suspended/paused or mismatched records
return `409 native_connection_unavailable`; foreign resource reads return 404.
A mismatched execution epoch, invalid public CA digest or currently invalid CA
also suppresses the response. The creation-only protocol supplies no periodic
connection proof refresh. There is no arbitrary short TTL or leaf-expiry check
that would invalidate discovery solely because CNPG renewed a leaf under the
same still-valid CA. CA replacement/recovery requires a separately designed
refresh path; this API cannot promise that an old observed CA remains usable.

This read neither grants compute authority nor enforces physical budget stopping.
Existing false enforcement flags, allowance requirements, closed lab admission
and remaining operational gates are unchanged. Public routing, Cloudflare
Tunnel/Hyperdrive integration, gateway selection, sleep/wake, automatic resizing,
backup/independent restore and an externally reachable application pilot remain
separate implementation and qualification work.

## Bounded verification

Exactly three new top-level cases cover the Worker opt-in/publication/discovery
lifecycle, regional convergence after an uncertain policy create, and refusal at
the client/routing/TLS/authority boundary. Each fails for the missing feature
before implementation. Iteration uses only those named changed-package files;
the parent freezes and runs the canonical full gate once. Runtime packet/TLS/SQL
acceptance is independent evidence, not implied by mock Kubernetes results.

Sources: [CNPG 1.30.1 RW Service](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/specs/services.go),
[CNPG Service ownership](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/internal/controller/cluster_create.go),
[CNPG certificate status](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/api/v1/cluster_types.go),
[Kubernetes 1.36.3 EndpointSlice target references](https://github.com/kubernetes/kubernetes/blob/v1.36.3/staging/src/k8s.io/endpointslice/utils.go),
[Cilium namespace/ServiceAccount policy identities](https://docs.cilium.io/en/stable/security/policy/kubernetes/).
