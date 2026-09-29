# Verifier namespace selection guard and Dev controller delivery

Operator-supplied verifier labels can no longer override the configured verifier
namespace. The role executor rejects the reserved raw label key
`io.kubernetes.pod.namespace` before Kubernetes/credential/policy access, and
assigns the fixed Cilium namespace selector after the derived label map.
The database executor shares that validator. Valid existing configurations and
normal ports/selectors remain compatible.

Customers cannot set this operator configuration through the API. This closes a
concrete configuration boundary; it does not establish complete tenant isolation
or imply that customer credentials were exposed.

## Bounded red-first evidence

One new top-level Node case demonstrates the observed failure: the reserved-key
configuration reaches a forbidden Kubernetes read instead of failing with the
configuration conflict. It fails meaningfully in 0.193 seconds. The narrow source
correction passes the same named file in 0.193 seconds on attempt one; its two
existing role lifecycle/uncertain-rotation cases remain unchanged.

Independent bounded review confirms shared database validation occurs before
runtime reads. The frozen canonical format/lint/typecheck/Vitest/Node gate runs
once and passes in 22.201 seconds. It passes 27 Worker and 37 Node cases; six
unchanged Go cases retain their prior source-valid evidence, giving 70 automated
cases. No matrix, speculative suite, assertion weakening or second gate is added.

A separate native network-isolation preflight makes only read-only inventory
requests and stops before establishing a unique cached-image Pod match. It creates
no Namespace, policy, quota, Pod or image. Reviewing that preparation discovers
this guard gap. The native L3/L4 traffic exercise itself is not qualified here,
and no held qualifier is renamed or resumed.

## Actual Dev runtime evidence

Source commit `985d88be9d1a363c286549cafeadb6bc74561c93` supplies a sealed 67-file
public-only Docker context. GitHub Git-blob readback matches every input; no local
environment, credential, private evidence or untracked file enters the context.
The existing pinned Dockerfile produces one nonroot Linux/AMD64 image in 42.368
seconds. The 88,533,504-byte archive, OCI index, architecture manifest and image
configuration digests are independently verified.

One authenticated Talos import succeeds in 17.212 seconds and exact tag/index
readback passes. The controller retains `imagePullPolicy: Never` and uses the
sealed imported tag; no registry push, digest-alias pull or public anonymous image
distribution is claimed. One UID/resource-version/current-image conditional,
image-only Deployment patch succeeds in 0.176 seconds; rollout reaches Ready in
0.979 seconds. All other Deployment fields, RBAC and mounted configuration remain
unchanged.

An initial runtime observer incorrectly expects a repository/index image ID.
The actual tag/Never container exposes its configuration digest. A read-only
correction compares that exact independently verified digest and all 59 compiled
module hashes, without another import, patch or rollout. These checks pass.
The old running module accepts the reserved-key configuration; the new compiled
module rejects it while accepting the unchanged real verifier configuration.

The Node UID/boot remains Ready, all 28 other original Running Pod UIDs/restart
counts remain intact, all four original PVC and five PV identities/specifications
are preserved, the source CNPG Cluster UID/spec/Ready state is unchanged and both
original SQL marker counts remain one. Compiled environment, role and database
clients authenticate and return three empty claims in one 0.706-second probe.
No customer environment, role, database or policy is created.

## Durable accounting and remaining boundaries

The original private schema-two journal identity and file/directory modes are
preserved. Its 4,096 pending facts retain exact sequence, payload and evidence
hashes through the Pod replacement; five prior coverage-gap codes remain present.
Observed sampling advances. The current snapshot's complete flag does not finalize
past coverage, acknowledge those buffered facts or prove complete usage delivery.
The Dev D1 readback still has zero accepted facts/reservations and no API-managed
environments. This concrete saturated buffer and its unreconciled history remain
an M3/M6 accounting/admission gate; no facts are cleared or fabricated.

The Dev Worker version remains `354c182f-0281-4449-a974-3c181583c34c`, all eight
Secret names remain, D1 retains 14 migrations, one organization/project and closed
admission. A deployment-list readback initially selects the oldest entry; a
read-only correction chooses the latest parsed creation time and confirms that
same single active version. No Worker/Secret/D1/provider write occurs.

The ignored local environment files stay byte-identical and untracked. The
stopped Budget/SDK/Birth/Barman/portability candidates remain untouched. Physical
backups/PITR, independent key custody, production isolation, physical stop,
final accounting, sleep/wake, autoscaling and the other v1 gates remain open.
See [PLAN.md](../../PLAN.md) and the
[role contract](../contracts/database-role-credentials-v1.md).
