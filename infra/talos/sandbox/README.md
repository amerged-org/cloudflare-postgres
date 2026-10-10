# Sandbox extension and public recipe

Release R1 uses official Talos1.14.2 from Image Factory, Kubernetes1.36.5 and the pinned
platform through supported in-place upgrades. The current CI gate produces first-party
artifacts without building, booting or publishing a custom installer or raw OS image.
R2 adds the sandbox extension through a separately accepted Talos upgrade with controlled
interruption and resume. These source artifacts do not establish either live release gate.

Use immutable digest and signature/SBOM verification for upstream Talos and other upstream
images. Secret scanning covers our extension, public recipe and binaries. The upstream
Talos payload extraction, whole-OS byte scanner and reviewed-finding lists have been removed.
No node identity, network address, CA, agent key, machine configuration or private data belongs
in an image or public recipe.

The extension uses the pinned Talos host service runner. Its native self-launcher finds the
actual CRI process by executable identity and socket argument, opens its namespace handles,
and starts the same qualified controller in that PID/mount context. This preserves
`SecurityProfileConfig.workloadIsolation:true`. The public CRI `.part` leaves the default
runtime unchanged. The controller waits for its protected configuration and agent-key files.

## First-party CI artifacts

Pure source checks use the existing single CI workflow:

```sh
node --test infra/talos/sandbox/build-plan.test.ts infra/talos/sandbox/images.test.ts \
  infra/talos/sandbox/publish-artifacts.test.ts
```

The existing `ci-artifacts.sh` producer consumes the successful `sandbox-controller`
qualification report from the same source revision. Its complete execution is:

1. Build the `talos-extension` target from `apps/sandbox-controller/Dockerfile`, using the
   pinned Rust builder/version and source/revision OCI labels. Qualify `sandbox-extension`,
   including both first-party binaries, generated manifest/service/CRI inputs and notices.
   Both binary hashes must equal those in the ordinary runtime qualification report.
2. Verify and publish `talos-sandbox-extension-sha-<commit>`, then read back its immutable
   registry digest.
3. Generate the public recipe with `build-plan.ts prepare`, using that extension digest and
   any explicitly selected functional-extension digests. Build `recipe.Dockerfile` from the
   isolated public context. The `talos-recipe` scratch profile contains exactly three files
   and inherits no upstream scanner exceptions.
4. Verify and publish `talos-recipe-sha-<commit>`, read back its immutable digest, then return
   only `extension_ref` and `recipe_ref`. The producer ends here.

The recipe hash describes PGCF's canonical public recipe. Its projected `schematic` metadata
uses the `PGCF imager` flavor; it does not assert that Image Factory hosts that recipe hash.
`images.ts` and `build-plan.ts bind` retain the pure recipe/profile construction used by R2.
They select the Talos version and immutable imager/base-installer references from
`infra/platform/versions.lock.json` and keep private machine configuration outside the recipe.
Generating these profiles does not run the imager or qualify an OS image.

An operator may stage a verified preassembled installer as a repository release containing
`installer-amd64.transport.tar` and `installer-binding.json`, then select its tag with the optional
`PGCF_TALOS_INSTALLER_RELEASE` Actions variable. The existing CI uses its scoped package writer to
run `scripts/operations/publish-talos-installer.mjs`, verify the exact source CI, archive, upstream
identity and registry layers, and retain the publication receipt. It neither rebuilds native
images nor deploys a node. The default empty variable performs no publication; clear the variable
after delivery. An existing matching immutable tag is verified without another push.

## R2 transport and retained-node requirements

`publish-artifacts.ts` retains the content-addressed transport and publication identity
checks for separately qualified R2 artifacts. It verifies config identity, upstream Talos
labels, diffIDs and compressed layers; a qualified report must bind the exact source, recipe
and raw artifact. It cannot create that qualification. The opt-in CI step publishes an already
assembled installer; raw-image publication remains separate. Publication-state receipts resolve an uncertain remote write
through exact tag/asset reads before another mutation is considered.

The R2 upgrade must establish actual Talos/kernel/containerd/runc versions, loaded extension
and recipe identity, first-party binary hashes and working CRI. A host service waiting for
protected files is not a ready pool. Database readiness and authenticated SQL remain separate
live acceptance gates.

Existing nodes receive the two fixed0600 files through the authenticated API's sealed
node-host configuration and serialized Native `host_config` stage before OS activation.
The key derives from encrypted regional custody; administration exposes metadata only.
Node/Cluster UID, current material/profile/release, configuration revision and file hash bind
the private loader. Fresh configuration requires Ready; already sealed configuration may be
read during its planned reboot while physical, assignment and material checks remain valid.
Material-only refresh preserves the storage supervisor and authority deadlines; confirmation
waits for an actual current-material Cloudflare pool observation.

Supported upgrades preserve persistent configuration and retained storage. Compare active and
persistent Talos resources, unowned documents/files and actual network resources before and
after. Existing servers are upgraded in place without raw-image disk replay.

## CNPG RuntimeClass seam

CNPG1.30.1's Cluster schema has no runtimeClassName/PodTemplate seam. Kubernetes1.36.5 provides
GA `admissionregistration.k8s.io/v1` MutatingAdmissionPolicy. `runtime-admission.ts` renders
one fixed `pgcf-prestarted` RuntimeClass plus cluster policy/binding for managed namespaces
labeled `pgcf.io/database-id` and the exact CNPG operator service account. It matches only
CREATE of Pods labeled `cnpg.io/podRole: instance` with `cnpg.io/cluster` present;
pooler/backup/job/system Pods are outside that match. Its sole mutation is runtimeClassName,
so CNPG still owns the normal processes, credentials, PVC mounts and backup sidecar.

Render with `render-runtime-admission.ts <protected-scope.json> <new-output.json>`. The scope
contains operator namespace/service-account names, the qualified profile hash and bounded per-slot
CPU/RAM; it contains no credentials. First use actual API discovery and server dry-run/type
checking. Read back a proposed actual CNPG instance Pod and its operator identity before
activating the binding. Only label a physical Node with the returned compute-profile selector
after installed code, configuration, current Node UID and actual pool observations pass.
Keep customer activation closed until real CRI/Cilium/CNPG/local-PV and authenticated SQL gates pass.

Sources: [Talos host service schema](https://github.com/siderolabs/talos/blob/v1.14.2/pkg/machinery/extensions/services/services.go),
[Talos workload isolation](https://github.com/siderolabs/talos/blob/v1.14.2/internal/app/machined/pkg/sandboxd/enabled.go),
[Talos imager profiles](https://github.com/siderolabs/talos/blob/v1.14.2/pkg/imager/profile/profile.go),
[schematic resource projection](https://github.com/siderolabs/talos/blob/v1.14.2/internal/app/machined/pkg/controllers/runtime/image_factory_schematic.go),
[CNPG instance Pods](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/pkg/specs/pods.go),
[MutatingAdmissionPolicy](https://kubernetes.io/docs/reference/access-authn-authz/mutating-admission-policy/).
