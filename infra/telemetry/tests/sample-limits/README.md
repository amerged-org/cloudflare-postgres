# Pinned Operator sample-limit proof

This development-only module has exactly one top-level test and no subtests.
It calls `prometheus-operator` v0.94.1's exported `NewConfigGenerator` and
`GenerateServerConfiguration` with the actual selected rendered Prometheus,
ServiceMonitor and PodMonitor resources. The API types use the matching
v0.94.1 module; dependency versions are not overridden.

Set `PGCF_TELEMETRY_RENDER_DIR` to a directory containing
`baseline-render.yaml` and `candidate-render.yaml`. Each is a complete public
Helm YAML stream plus the two unchanged target PodMonitors; `v1/List` entries
are flattened. Inputs must contain the reviewed selected monitoring resources
with explicit namespaces and Prometheus declared version 3.15.0-distroless
(the pinned binary is 3.15.0). Selection/discovery is
an operator responsibility; this generator does not discover or select live
objects. The expected inventory is the observed fourteen jobs.

The generator uses its default endpoints/pod discovery options, matching the
actual Operator's disabled EndpointSlice flag. Its non-nil asset store has no
API clients. The single public kubelet CA ConfigMap reference is seeded with an
explicit placeholder through `AddObject`. Authorization credential Secret
names/keys are derived from the selected rendered ServiceMonitor endpoints;
typed Secrets with explicitly dummy bytes are cached in each monitor's own
namespace through `AddObject`. No runtime token is fetched or copied. This
prepares configuration generation only; it validates neither TLS nor credentials.
Warning/error logs cause the test to fail instead of accepting silently missing
credentials. No live configuration, addresses, tokens or CA keys belong in
these render inputs or this module.

The emitted global default must remain 20,000. The candidate API-server job
must have a finite 40,000 limit, above the observed 32,254 retained samples;
all other job identities and effective limits must equal the baseline. Reading
an absent job field through the emitted global default follows Prometheus YAML
inheritance. The test does not reproduce the Operator's clipping arithmetic.

Use Go 1.26.0. Once the repository owner supplies and reviews both render
inputs, run only the named test during this fix:

```sh
PGCF_TELEMETRY_RENDER_DIR=/absolute/path/to/reviewed/render-inputs \
  go test -run '^TestAPIServerSampleLimitPreservesOtherJobs$' \
  -count=1 -timeout=180s .
```

Run from this module directory with a caller-enforced bounded total wall-clock
limit; Go's test timeout alone does not bound dependency downloads or compiling.
The already selected official Go 1.26.0 builder is
`golang:1.26.0@sha256:fb612b7831d53a89cbc0aaa7855b69ad7b0caf603715860cf538df854d047b84`.
Do not run the test before actual render inputs exist. Before/after render
provenance must distinguish an initial Helm 3 diagnostic from production
Helm SDK 4 qualification. The final frozen-candidate gate runs once.

This proof establishes generated sample limits only. Live API scraping, current
sample cardinality, memory/head-series/storage impact and operational acceptance
require their own bounded runtime evidence.
