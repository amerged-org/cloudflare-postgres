# Optional persistent suspend worker

This example runs the existing supervised suspend CLI continuously through
`serve-suspend`. It is a separate installation choice, is not included by default
platform manifests, and does not change the ordinary regional controller's
ServiceAccount, permissions or command.

The worker consumes explicit customer suspension and deletion-child stop work.
Its present executor keeps converged work deferred as
`physical_verification_pending`. It does not publish a successful physical-stop
result, complete deletion, remove a Namespace/PVC/PV, release funding or invent
final usage. A running or Kubernetes-Ready worker is not evidence of physical
termination. See the [suspend contract](../../../../docs/contracts/environment-suspend-v1.md)
and [deletion contract](../../../../docs/contracts/environment-deletion-v1.md).

## Installation inputs

Before separately reviewing and installing this example:

- Provide an existing operator-only `pgcf-system` namespace with restricted Pod
  security enforcement. Keep installation identities and projected inputs
  inaccessible to customers.
- Replace the origin and region UUID placeholders with the installation's
  registered HTTPS management origin and region.
- Supply the existing `pgcf-region-access` Secret in this namespace separately.
  Its regional credential needs ordinary `operations:claim` and
  `operations:report` authority. No credential value belongs in these files.
- Replace both image placeholders with the same authenticated immutable release
  containing `serve-suspend`. The init and worker reuse that release's Node
  runtime; no extra downloaded initializer is needed.
- Select an enforced local-volume StorageClass whose resulting PV uses `Retain`,
  and verify its actual capacity, placement and PVC/PV binding. The separate
  journal requests 1 GiB; it does not alter an existing namespace-wide storage
  quota or the ordinary usage-journal volume. Pod recreation is not a claim of
  node-loss journal recovery.
- Preserve complete journal custody before replacing a worker or moving its
  retained volume. Do not mount imported journal data until its volume root is
  already prepared for the trusted `fsGroup:1000`; `OnRootMismatch` is not a
  universal guarantee that kubelet never adjusts existing child permissions.

Render a reviewed installation overlay with Kustomize. This example deliberately
has unresolved identity, image and storage placeholders; it is not an
automatically installed platform component.

## Configuration and identity boundaries

Kustomize packages `prepare.mjs` and `suspend-config.example.json` as trusted
projected bootstrap inputs. A nonroot init container copies the bounded config
bytes to a regular UID-1000-owned `0600` file in an emptyDir. It generates a second
private regular kubeconfig with one explicit selected context, verified API TLS
and the actual Kubernetes service host/HTTPS port. Only mounted service-account
token-file and CA-file references are written. The initializer does not read,
copy or print token contents, embed keys, select an executable authentication
plugin or contact an API.

Creating `/private/pgcf` accepts the dedicated memory emptyDir's nonsymlink
`/private` root only with UID `0`, GID `1000` and exact sticky/setgid mode `03777`
when that root is world-writable. This exception relies on the operator-only Pod:
the trusted sequential init has the only writable mount, and the worker mounts
it read-only. Do not share this volume with untrusted containers or other
UID-1000 writers. Sticky mode alone does not establish that trust boundary; all
other parents, including the persistent journal volume, retain the strict
world-write rejection.

The init container creates only the exact private `0700` journal child on the
retained PVC. Existing configuration must match its reviewed bytes; existing
journal children must have valid operation filenames, regular-file identity,
the expected owner and `0600` mode. Unsafe symlinks, ownership, modes, unexpected
children and partial mismatched configuration fail without chmod repair or
deleting a seal. Private files are created exclusively and flushed before
startup. Restart retains the same operation seals and stored resource identities.

The separate ServiceAccount can read required namespace, quota, Pod, volume,
CNPG, Deployment and original-node cohort inventories. It can patch only the
named quota, CNPG Cluster and Pooler resources. It has no create/delete verbs,
Secret reads/listing, Pod patch/exec or provider access. Kubernetes RBAC cannot
constrain patches to individual JSON fields or dynamically owned tenant
namespaces: the installation must retain its admission and trusted-operator
boundary. The executor additionally rechecks claim authority, resource ownership,
UID/resourceVersion, epochs and sealed volumes before effects.

Node observers and Pod retirement are absent in this example. Their additional
configuration and rights require separate qualification; they are not enabled
to turn pending work into success. The default runtime needs no Job/ReplicaSet
inventory or node-runtime Exec permission.

## Operation and remaining qualification

One replica with `Recreate` keeps intentional deployment overlap out of the
journal's process-custody boundary. Do not concurrently run another standalone
CLI against this same journal or duplicate its identity on another node.
The main process runs the fixed command
`node /app/dist/main.js serve-suspend --config /private/pgcf/suspend.json --poll-milliseconds 5000`.
It serializes supervised children, retains the original per-attempt deadlines,
stops on unproven child closure or changed private configuration, and reports
only fixed nonsecret status events. Fair queue ordering rotates expired deferred
attempts without pretending they completed.

The 25m CPU / 64 MiB memory requests are scheduler reservations. The 100m CPU /
256 MiB memory limits leave headroom for Node and the Kubernetes SDK; they are
not measured capacity or production acceptance claims. Measure resident memory,
concurrent queue load, journal growth and real operation duration before setting
production limits. No readiness probe here claims physical stop or funded safety.

Live worker identity, restart custody, permission/admission behavior, positive
owned stop, whole-workload physical verification, independent expiry, final
accounting and eventual safe disk disposal remain separate acceptance gates.
Installing this example does not resume any held qualification workflow.
