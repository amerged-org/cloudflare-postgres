# Local-image Dev qualification

Status: the separate commit-pinned Dev source is Ready; automatic initial
issuance and all three verified kubelet HTTPS targets pass. Node/database/PVC
preservation is recorded in the [runtime evidence](../../docs/evidence/m4-kubelet-serving-tls-2026-09-28.md).
Later renewal, public pulling and automated fleet enrollment remain open.

This explicit opt-in overlay changes only the image reference and pull policy of
the node-bound serving certificate approver. The tag identifies the frozen
source module; authenticated Talos image readback must match the index and AMD64
identities in [the image lock](../kubelet-serving-certificates/image.lock.json).
It does not establish anonymous public distribution.

Use this profile only when placement is restricted to the node with the verified
import, or every eligible node carries it. The current qualification has one
authenticated, schedulable Node; verify that topology before source activation.
For a larger fleet, supply a private placement constraint rather than letting a
local-only image fail on an unprepared node.

The nine namespace/RBAC/workload objects remain otherwise unchanged. A separate
commit-pinned Flux source owns them; do not repoint the existing platform or
telemetry sources. The private enrollment ConfigMap remains operator-owned and
outside Flux's static inventory. Node/ConfigMap get-only permissions must not be
expanded to compensate for an incorrectly cached reader.

Install and qualify the approver/enrollment before applying the
[native TLS patch](../talos/kubelet-serving-tls.patch.yaml) with explicit
`--mode no-reboot` and verify the returned mode. Observe automatic
approval, correct certificate identity/chain and database preservation across
the bounded kubelet restart. Preserve existing operation counters and stop
limits. See [the component deployment](../kubelet-serving-certificates/README.md).
