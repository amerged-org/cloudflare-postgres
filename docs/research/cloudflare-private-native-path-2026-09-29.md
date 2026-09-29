# Cloudflare connection to private PostgreSQL

Reviewed: 2026-09-29. Status: provider documentation assessment, not an installed
integration or a selected gateway architecture. No Tunnel, VPC Service,
Hyperdrive configuration or credential is created by this assessment.

Cloudflare documents a path from a Worker through Hyperdrive and a TCP Workers
VPC Service to an outbound `cloudflared` tunnel in the database's private network.
The VPC Service specifies its origin and port; a Kubernetes service hostname is
not directly reachable merely because the platform returns it. Workers VPC is
currently beta. [Private database guide](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database-vpc/),
[VPC Service configuration](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/).

The documented default is certificate-chain and hostname verification. Workers
VPC trusts public certificate authorities and Cloudflare Origin CA; the private
database guide explicitly says custom CA upload is not supported. `verify_ca`
skips hostname verification while retaining chain verification. From that trust
model we infer that it alone cannot establish trust in CNPG's private CA. Disabling verification
is not an acceptable integration shortcut. [TLS boundary](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database-vpc/#tls-certificate-verification),
[verification modes](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/#tls-certificate-verification-mode).

For PGCF, a protected tunnel connector identity could eventually consume the
same private native-access policy as another approved application. That is an
integration proposal: first qualify origin certificate trust and hostname,
connector isolation, exact account/service/tenant routing, credential rotation,
connection ownership and reconnect behavior. Verify one real Worker transaction
before advertising compatibility. Keep management API credentials separate from
database and tunnel credentials. Do not add Cloudflare resources to an
environment solely to make discovery metadata look usable.

The optional private native path can supply an internal CNPG endpoint and its
public CA to clients capable of using that trust configuration. It does not
resolve the Workers VPC trust limitation, provide a public native endpoint or
replace the gateway and recovery gates in [PLAN.md](../../PLAN.md).
