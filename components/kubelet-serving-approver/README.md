# Node-bound kubelet serving certificate approver

This component adapts selected runtime source from [Kubelet Serving Certificate Approver v0.12.1](https://github.com/alex1989hu/kubelet-serving-cert-approver/tree/f72897c68e38185aeca848952d10a094054642ba). It retains upstream reconciliation, SubjectAccessReview authorization, event recording, health endpoints and metrics. The added policy binds serving requests to operator-approved node identity and addresses. The original copyright and Apache-2.0 license are retained; [PROVENANCE.json](PROVENANCE.json) records the immutable source and original file hashes.

## Enrollment contract

The configured ConfigMap must contain the `enrollment.json` data key:

```json
{
  "apiVersion": "pgcf.io/kubelet-serving-enrollment/v1",
  "nodes": [
    {
      "name": "node-one",
      "uid": "b3de1faa-ea20-4558-9497-34bd65d220b2",
      "dnsNames": ["node-one"],
      "ipAddresses": ["192.0.2.10"]
    }
  ]
}
```

The example uses reserved documentation addresses and an illustrative UID. An operator must enroll the exact live Node name and UID with independently verified addresses. Node status addresses are not enrollment authority. The [schema](enrollment.schema.json) describes the document shape; the runtime also rejects duplicate JSON members, node names/UIDs and DNS/IP ownership shared between records. `dnsNames` may be omitted when no DNS SAN is approved. Each enrolled node needs at least one literal IP. An empty `nodes` array grants no approvals.

Only trusted operators may write enrollment. Node recreation requires a new approved UID. Address changes require an enrollment update before a CSR containing the new SANs can be approved. Removing enrollment prevents future issuance; it does not revoke certificates already issued by Kubernetes.

## Runtime contract

Run the existing `serve` command. The manager keeps upstream `/healthz` and `/readyz` on port 8080, and `/metrics` on port 9090.

| Environment variable | Flag | Default |
| --- | --- | --- |
| `NAMESPACE` | `--namespace` | `kubelet-serving-cert-approver` |
| `ENROLLMENT_NAMESPACE` | `--enrollment-namespace` | Execution namespace |
| `ENROLLMENT_CONFIGMAP` | `--enrollment-configmap` | `pgcf-node-enrollment` |

Explicit flags take precedence over environment variables. Node and named ConfigMap reads use the manager's uncached API reader. They need only `get`, and start no informers. CSR watching remains upstream behavior. Held policy requests requeue after 30 seconds, so an enrollment correction can take effect without granting Node/ConfigMap list or watch rights. API and enrollment decoding errors return errors and grant no approval.

Approval requires the exact `kubernetes.io/kubelet-serving` signer, requester/CN equality, only `O=system:nodes` and that CN in the subject, exactly the node/authenticated requester groups, a valid CSR signature, and digital-signature/server-auth usages. RSA may additionally request key encipherment. Other or duplicate usages fail. DNS/IP SANs must be unique subsets of that node's enrolled addresses, with at least one requested IP; email and URI SANs fail. The live Node must have the enrolled UID and be active. The upstream SubjectAccessReview must also allow CSR creation.

After SubjectAccessReview, the reconciler reads the CSR, named ConfigMap and exact Node again through the uncached reader and repeats signature, identity and enrollment checks. The CSR UID/spec must match and remain unsigned, unapproved and active. The authority's Node/ConfigMap UIDs and resource versions must match their initial snapshot. Approval submits the fresh CSR resource version using the reconciliation context; conflicts requeue without a blind write. Kubernetes has no transaction spanning those three resources, so this is an immediate read fence, not atomic revocation of authority after its final read.

The same reconciliation path handles initial issuance and renewal. The component never signs certificates or receives CA private keys. Required writes are CSR approval for the serving signer and upstream Events; optional leader election also needs namespaced Lease rights. Enrollment, Node and Secret writes are unnecessary.

## Verification and build

[VERIFICATION.md](VERIFICATION.md) records the bounded three-case RED/GREEN proof. This is source-level qualification; no cluster, deployed image or live TLS result is claimed here.

Use Go 1.26.0 or the pinned Dockerfile builder. The Dockerfile builds the runtime without silently running broad tests. `go.mod` and `go.sum` pin the complete module dependencies. Run only the three named cases during this fix's iteration; the repository owner runs the canonical frozen-candidate gate once.
