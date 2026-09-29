# Provider inventory and enrolled-node inspection v1

The installation operator can observe its Contabo account and correlate explicitly
enrolled machines with authenticated Kubernetes Nodes before maintenance. This is
read-only fleet evidence. It supplies no server order, reinstall, resize, upgrade,
restart, trusted machine-identity certificate or reserved capacity.

## Installation API

`GET /v1/installation/providers/contabo/instances` requires the existing installation
bootstrap credential. Organization, regional, meter, grantor and maintenance
tokens do not gain provider access. Invalid credentials return `401` before any
provider request. Query parameters or a body return `400`; other methods return
`405`. Responses use `Cache-Control: no-store`.

Four Worker Secrets supply the fixed Contabo OAuth password flow:
`CONTABO_CLIENT_ID`, `CONTABO_CLIENT_SECRET`, `CONTABO_API_USERNAME` and
`CONTABO_API_PASSWORD`. The root password is unused. The only resource calls are
GETs to the documented instance collection with generated request IDs. Callers
cannot select a backend URL and upstream links are not followed. Redirects,
upstream errors and malformed/incomplete pages fail with
`503 provider_inventory_unavailable`. Raw provider errors and tokens are never
returned. [Contabo API](https://api.contabo.com/).

The response contains `provider: "contabo"`, a selected `instances` array,
`observation`, `actionsEnabled: false` and `machineIdentityVerified: false`.
Instance fields are `instanceId`, `region`, `dataCenter`, `status`, `cpuCores`,
`ramMb`, `diskMb`, `ipv4` and `ipv6`. IDs/RAM/disk quantities are exact decimal
strings; unsafe numeric IDs fail rather than rounding. Units retain the provider's
field names; these observations are not allocatable Kubernetes headroom.

One 20-second observation window covers OAuth, resource requests, body reads and
hash creation. Bounds are ten pages, 1,000 instances, 1 MiB per instance page and
16 KiB for authentication. Page size/counters must agree across the scan, every
declared row must be present and IDs must be unique. `enumerationComplete: true`
means that those checks passed; `consistency: "observed-scan"` explicitly does not
promise an atomic provider snapshot or physical-host placement guarantees.

## Enrolled Node correlation

`inspect-fleet` reads the API plus a bounded authenticated Kubernetes Node list.
The adopter supplies private `{ instanceId, nodeName, nodeUid, regionId }` bindings;
these are enrollment authority, not inferred from CSR/DNS/Node status. Bindings
are unique and belong to one explicit region.

Missing provider records, changed Node UID, missing/not-ready Nodes, changed
provider/address observations and unbound Kubernetes Nodes produce blockers.
Unbound provider instances remain unmanaged: an Ubuntu build machine is not
automatically database spare capacity. Address agreement is association evidence,
not authenticated machine identity, a kernel-isolation guarantee or HA proof.

The full selected report is written exclusively to an owner-private file. Public
CLI output contains counts, blocker codes, a hash and false authority flags. It
contains no server IP, instance/Node ID, credential or private path. Config/token/
kubeconfig files must be private regular files; output parents must be private
directories. Existing reports are never overwritten.

The network observation has a shared 20-second limit; local file loading precedes
it. The lane supports static embedded certificate/key or token kubeconfigs with
an embedded CA. It rejects TLS-verification bypass, dynamic auth, token-file and
selected credential-file references before network dispatch. The normal platform
runtime and other tools are not silently reconfigured.

## Maintenance integration

An optional `fleetInventory` operator configuration enables the same inspector
during `prepare-maintenance`. Missing/inconsistent observations make the existing
snapshot incomplete and invalidate its machine-identity evidence. Healthy
association preserves only independently supplied evidence; it never creates a
verified identity or capacity certificate and cannot remove quorum, backup,
staging or recovery blockers. Execution remains unsupported and unauthorized.

See the [operator configuration](../../apps/regional-controller/README.md#fleet-inspection).
Actual provisioning/replacement, staged host maintenance, qualified topology and
recovery remain required M4/M8 work in [PLAN.md](../../PLAN.md).
