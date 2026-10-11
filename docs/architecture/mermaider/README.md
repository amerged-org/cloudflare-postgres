# Source-backed architecture diagrams

These views are maintained by [Mermaider](https://github.com/sebmer-com/mermaider).
The selection and reviewed process model live in `.mermaider/`; generated files
carry source references and are checked against the current repository contents.

Open [the diagram gallery](index.html) in a local browser to view all five diagrams,
filter by title, inspect sources and switch to full-size views. The HTML contains
its renderer and works offline. GitHub displays this file as source; download it
or open the local checkout to use the gallery. No website publication is required.

| View | What it establishes |
| --- | --- |
| [Management API resources](api-resources.md) | Resources declared in the public Wrangler configuration template. |
| [Edge resources](edge-resources.md) | Bindings declared by the TypeScript Edge configuration template. |
| [CI pipeline](ci-pipeline.md) | Job dependencies and conditions in the single CI workflow. |
| [Core D1 data model](d1-core.md) | Selected core tables and keys after replaying every API migration, including later schema changes. |
| [AddNode orchestration](add-node.md) | A reviewed, source-backed interpretation of the implemented provisioning workflow. |

The D1 view selects nine core tables to remain readable; the migration stream also
contains provisioning, usage, fleet, storage and capacity tables. Its omission of
other tables is deliberate. It does not claim that every relationship is a
declared foreign key or display every constraint.

Configuration templates describe declared resources, not actual deployed
identities. The TypeScript Edge view does not mark the approved Rust replacement
as deployed. See [PLAN.md](../../../PLAN.md) for current acceptance status and
[Rust runtime and cold starts](../rust-runtime-and-cold-starts.md) for the approved
target and migration gates. No live acceptance gate is closed by these diagrams.

The AddNode diagram is an overview of `AddNode.run` and its referenced helpers,
not a mechanically inferred state machine. It includes the asynchronous wait
cycle, uncertain provider readback, authority checks and optional postjoin gates.
Helper bodies and the orchestrator are bound by declaration hashes. A changed
declaration requires review before its evidence hash is renewed. A fresh output
fingerprint by itself never renews that review.

## Maintain the views

CI installs the immutable Mermaider revision recorded in
`.mermaider/tool-revision` and uses its lockfile. For local use, clone the tool into
the ignored directory `.local/tools/mermaider`, check out that revision, then run:

```sh
npm --prefix .local/tools/mermaider ci --ignore-scripts
npm --prefix .local/tools/mermaider run build
node .local/tools/mermaider/dist/cli.js discover --repo . --json
node .local/tools/mermaider/dist/cli.js update --repo .
node .local/tools/mermaider/dist/cli.js check --repo .
```

Use the discovery catalogue to propose additional views; the saved selection is
not expanded automatically. This pilot inventories the API, TypeScript Edge,
shared contracts and CI sources; widen `include` when selecting a new area. Before
accepting an AddNode change, read the changed
implementation and update the model's claims and evidence together. Use
`mermaider evidence --repo . --path <source> --symbol <declaration>` to obtain the
current declaration hash after reviewing it.

When the Mermaider native plugin is installed and trusted in the active agent,
the project enables change notifications and one bounded completion reminder.
Those hooks only instruct the current agent; they do not provision resources,
deploy software, start a nested agent or create commits. Existing repository
protection hooks remain authoritative. External changes are noticed at the next
agent event. The same diagram check runs inside the existing CI workflow.

Review the resulting documentation diff with its implementation. A separate
documentation commit may be useful when repository rules and the current task
permit it; no automatic commit is required by this integration.
