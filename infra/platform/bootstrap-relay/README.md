# Fixed-source bootstrap transport

This optional deployment belongs on one explicitly selected existing VPS. It forwards native
bootstrap connections from Cloudflare to approved VPS targets; Cloudflare remains the authority.
Install it only after CI has qualified a regional image containing `/app/bootstrap-relay.mjs`,
and replace the Kustomization's image digest with that qualified immutable digest. The checked-in relay digest is the regional image qualified by CI run `37269991675`.

The relay and its outbound cloudflared sidecar share host networking. The relay listens only on
`127.0.0.1:8082`; the tunnel metrics listen only on `127.0.0.1:20242`. Host networking gives native
target connections the selected node's source address without relying on Pod masquerading after
cluster membership changes. Verify the actual IPv4 and IPv6 source addresses before bootstrap.
The dedicated namespace permits host networking; both containers remain nonroot, read-only,
without Linux capabilities or an attached Kubernetes service-account token.

This directory retains the TypeScript transport. A release selecting `native-bootstrap-relay`
uses [`../bootstrap-relay-native`](../bootstrap-relay-native), which reuses the same node selection,
public key configuration and tunnel Secret. Its image runs `/pgcf-native-bootstrap-relay` without
Node arguments. Readiness and liveness use the actual HTTP identity endpoint on host loopback;
the fleet patch loads this overlay from the selected immutable source commit and verifies the
observed executable, probe shape and image digest. Source preparation does not activate the relay.

Provide these values through an ignored private overlay or Flux substitution:

- `PGCF_BOOTSTRAP_RELAY_NODE_NAME`: the actual existing Kubernetes hostname.
- `PGCF_BOOTSTRAP_RELAY_ISSUER_REGION`: that node's actual region ID.
- `PGCF_BOOTSTRAP_RELAY_PUBLIC_KEYS`: JSON mapping key IDs to Ed25519 public keys.
- `PGCF_BOOTSTRAP_RELAY_ALLOWED_TARGET_REGIONS`: an explicit JSON array of allowed region IDs.
- Secret `pgcf-bootstrap-tunnel`, key `token`: the dedicated outbound tunnel's credential.

For Flux post-build substitution, encode the two JSON values as JSON string literals, for
example `JSON.stringify(JSON.stringify(publicKeys))`. Kustomize can normalize a placeholder
inside a YAML block scalar; block syntax alone does not keep the substituted map or list a
string. Verify the final ConfigMap data contains the original JSON strings. The retained-node
patch preserves the existing typed ConfigMap and updates the relay Deployment.

Configure the dedicated tunnel's private HTTP origin as `http://127.0.0.1:8082` and connect it
through the API Worker's `BOOTSTRAP_RELAY_SERVICE` VPC binding. Do not add a public hostname for
the relay. The API gives native jobs an authenticated WebSocket route on its own origin, then
forwards through that private binding. The relay gets only public verification keys; signing
keys, provider credentials and database/control credentials remain outside its container.

Each capability binds operation, node, target region, issuer, revision, literal target address,
port, expiry, nonce and the current relay process epoch. Allowed destination ports are 22,
50000 and 6443. Clients still verify SSH host keys and Talos/Kubernetes certificates end to end.
Replacement invalidates old capabilities; a resumed job obtains a new capability. A broken
stream does not replay a native command. Provider firewall readbacks and independent access
proofs must pass before an installation starts, and customer placement remains quarantined
until the separate post-join network and capacity checks pass.

The deployment is deliberately excluded from `../regional/kustomization.yaml`; it must stay
on the chosen fixed-source node rather than appearing on every region or worker.
