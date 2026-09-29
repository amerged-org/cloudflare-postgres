# Existing customer lifecycle API contract completion

The OpenAPI contract now includes seven already implemented customer methods:
role creation, role item metadata, role credential disclosure, role rotation,
owned database creation, database item metadata and database credential disclosure.
The [adopter workflow](../guides/database-lifecycle-v1.md) explains those methods
using generic HTTP request templates and placeholder identities/credentials.
No runtime route, permission, data model, migration, Secret or SDK is changed.

## Contract checks

The runtime request predicates, public DTOs and role/database contracts supply
the request and response shapes. Creation/rotation bodies reject additional
properties; their real integer/name bounds and required Idempotency-Key are
recorded. Organization bearer authority and required read/write scopes are
explicit. Credential responses have no-store headers and expose only the latest
verified/applied credential. Accepted immutable operation responses contain no
password or regional lease authority; replay is distinct from current progress.

Strict YAML parsing, all 624 local references, operation-ID uniqueness and the
seven new path/method mappings pass structural checks. All 45 previously
specified methods and every existing component schema remain semantically
unchanged. This is structural/source agreement evidence, not a claim that a
formal complete OpenAPI metaschema or every generated client was validated.
Edited documentation links, formatting and diff checks pass. An initial generic
Markdown-link scanner mistakes a YAML regex for a link; restricting that scanner
to Markdown corrects the tooling assertion without changing the contract.

The guide covers stable retries, operation/resource observation, same-environment
ownership, rotation locks, private credential custody and deliberately configured
endpoint/TLS setup. The API does not supply a public host/port/CA/connection URL.
The examples do not promise production availability or bypass closed Dev admission.
No new runtime tests or broad workspace gate is introduced for documentation.
The separately frozen namespace-guard runtime gate subsequently includes and
passes this formatted OpenAPI file once.

## Remaining developer-experience gates

The stopped SDK worktree is untouched. Generated/published clients, full CLI
installation and end-to-end independent adopter qualification remain M3/M7 work.
There are still zero API-managed Dev environments; positive role application,
rotation, database ownership, native connectivity and recovery must each be
qualified under their own installation gates. No example creates a privileged
customer role, bypasses runtime budget enforcement or adds hosted billing.
