# Prestarted runtime boot assets

These assets target Talos1.14.2, containerd2.3.6, runc1.5.2, Kubernetes1.36.5 and CNPG1.30.1.
They prepare one common installer/raw image for the retained AMD64 fleet. No node identity,
network address, CA, agent key, machine configuration or other private data belongs in an image.
Runtime, extension and public recipe are separate qualified OCI artifacts.

The extension uses the pinned Talos host service runner. Its fixed native self-launcher finds
the actual CRI process by executable identity and socket argument, opens its namespace handles,
and starts only the same qualified controller in that PID/mount context. This preserves
`SecurityProfileConfig.workloadIsolation:true`; it does not change the security profile or
expose a command executor. The public CRI `.part` is loaded at boot and leaves the default
runtime unchanged. The controller waits for its protected configuration and agent-key files.

## CI order

Whole-OS qualification and initrd expansion require **Node.js 24.21.0 or a later 24.x release**.
Earlier 24.x decoders can silently accept truncated Zstd frames. Other major versions are
unqualified and fail with `boot_node_runtime_unsupported` before Docker or image processing.

Extend the existing single CI workflow. The pure producer/template checks are:

```sh
node --test infra/talos/sandbox/*.test.ts
node packages/contracts/native/generate-compute-pool.ts --check
```

After the existing namespace-kernel primitive, run the public ordinary-containerd scenario:

```sh
node infra/talos/sandbox/run-proof.ts
```

It builds `RuntimeProof.Dockerfile` from the pinned Rust builder and checksum-pinned official
containerd2.3.6/runc1.5.2 artifacts for the native Docker-server architecture (one architecture,
AMD64 in CI). Its exact runtime argv is `docker run --pull never
--name <owned-name> --platform linux/<native-arch> --network none --privileged --cgroupns private
--memory 768m --cpus 2 --pids-limit 256 <owned-image>`. It has no workstation/host mounts,
devices or Docker socket. Build/run deadlines are900/150s; the owned container/image are
removed even on failure. Raw local fixture observations stay in0600 temporary logs; stdout
is a small numeric pass summary and explicitly denies CF/CNPG/SQL acceptance.

1. Build the ordinary `apps/sandbox-controller/Dockerfile` default `runtime` target with the
   existing pinned Rust builder/version and `SOURCE_COMMIT`. Qualify `sandbox-controller`,
   including both version probes, exact generated inputs, actual notices and every layer byte.
   Publish its dedicated source tag and retain its immutable digest and both binary hashes.
2. Build the same Dockerfile with `--target talos-extension`, identical build arguments and
   source/revision OCI labels. Qualify `sandbox-extension`; its binary probes are under
   `/rootfs/usr/local/bin`, and notices/provenance are under
   `/rootfs/usr/local/share/licenses/pgcf-sandbox`. Qualification requires the exact resolved
   manifest, service and CRI part bytes. Publish `talos-sandbox-extension-sha-<commit>` and
   verify anonymous registry bytes before using its digest.
3. Generate the public recipe using only that qualified extension digest and the other
   currently required qualified functional extensions. Replace the old virtual `schematic`
   extension; do not carry two schematic manifests. The output directory is a public-only
   isolated build context, separate from credentials:

   ```sh
   node infra/talos/sandbox/build-plan.ts prepare "$GITHUB_SHA" \
     "$PGCF_SANDBOX_EXTENSION_REF" "$PGCF_RECIPE_DIRECTORY"
   docker build --platform linux/amd64 \
     --label "org.opencontainers.image.source=https://github.com/amerged-org/cloudflare-postgres" \
     --label "org.opencontainers.image.revision=$GITHUB_SHA" \
     -f infra/talos/sandbox/recipe.Dockerfile \
     -t "$PGCF_RECIPE_TAG" "$PGCF_RECIPE_DIRECTORY"
   ```

   Additional functional extension digest arguments follow the output directory. Qualify
   `talos-recipe` and publish `talos-recipe-sha-<commit>`. This data-only scratch profile has
   exactly three files, no claimed runtime/compiler base and no inherited scanner exceptions.
   Its real loaded `schematic` extension version is the canonical public recipe hash.
   Talos projects it into `ImageFactorySchematics.runtime.talos.dev` with flavor `PGCF imager`;
   this is PGCF recipe provenance, not a claim that Image Factory hosted that hash.

4. Bind both profiles to the independently qualified recipe extension:

   ```sh
   node infra/talos/sandbox/build-plan.ts bind \
     "$PGCF_RECIPE_DIRECTORY" "$PGCF_RECIPE_EXTENSION_REF"
   ```

   `installer.profile.json` and `raw.profile.json` are actual imager input profiles, with the
   same exact extension set. Read the selected Talos version and immutable imager/base-installer
   references from `infra/platform/versions.lock.json` (`target.talosVersion` and `talosBoot`).
   The recipe uses the vendor's 1246 MiB nominal minimum. The pinned imager itself adds the
   expanded BOOT/BIOS geometry; passing an already expanded output size adds it twice.
   See upstream [minimum profile](https://github.com/siderolabs/talos/blob/v1.14.2/pkg/imager/profile/default.go)
   and [output defaults](https://github.com/siderolabs/talos/blob/v1.14.2/pkg/imager/profile/output.go).
   Always measure the resulting raw length/GPT and use actual compressed/raw lengths in
   the existing RAM-backed rescue checks. The nominal size does not limit the real VPS
   disk: STATE, ephemeral and customer LVM layout are configured later on the full device.
   Run that imager in an isolated privileged CI build container with only a public output
   directory mounted at `/out`, using argument `-` and each profile on standard input.
   It emits `installer-amd64.tar` and `nocloud-amd64.raw.xz`. Do not pass an embedded config,
   private META value or per-node kernel argument. Record archive/compressed/raw digests and
   sizes. Qualify the assembled installer bytes and real boot result before a fleet write;
   native extension qualification alone does not qualify the entire installer.

## Boot and retained-node gates

Boot the exact raw output in an isolated disposable AMD64 guest before changing a retained
node. Use a separately generated protected test configuration with workload isolation enabled;
it is supplied after image creation. Verify actual Talos/kernel/containerd/runc versions,
loaded `pgcf-sandbox-controller` extension version, the projected recipe hash/flavor, actual
controller/holder binary hashes and working CRI. A host service waiting for protected files
is not a ready pool. Keep runtime/API observations separate from PostgreSQL/SQL acceptance.

Existing nodes receive only the two fixed0600 files through the authenticated API's sealed
node-host configuration and the serialized Native `host_config` stage before OS activation.
The key is derived from existing encrypted regional custody. Administration reads metadata only.
Node/Cluster UID, current material/profile/release, configuration revision and file hash bind
the private loader. New configuration requires fresh Ready; exact existing configuration can
be loaded during its planned reboot while physical/lost/assignment/material identity checks remain.
The future postjoin helper accepts only current verified quarantine/admission authority and
cannot reopen an already admitted job.
The demonstrated material-only refresh is consumed by the running controller from these
sealed files. It preserves the same storage supervisor and authority deadlines; host-service
confirmation waits for an actual current-material Cloudflare pool observation. It does not
restart the daemon or hot-reload runtime images, executable paths or public trust keys.

The supported upgrade preserves persistent configuration and retained storage. Compare the
active/persistent Talos configuration resources, every unowned document/file and all actual
network resources before/after. Their vendor resource proof is not a claim of reading raw
STATE filesystem bytes. No raw-image disk replay is part of an in-place upgrade.

Fresh raw activation still needs the programmed installer's approved source/download and
per-node first-boot network delivery; this producer does not silently switch the existing
Image Factory URL contract or put those private inputs into the common raw image.

## Qualified artifact publication

The existing native-image CI job publishes the installer only after the whole-OS gate
passes. Its local Docker transport must retain the qualified config, upstream Talos labels,
diffIDs and exact compressed layers. The content-addressed GHCR tag is checked before any
push, and `verifyTalosInstallerRegistry` reads every registry byte before returning a digest.

The raw image, public qualification report and canonical recipe use content-addressed
filenames in prerelease `talos-sha-<full source SHA>` on the existing public GitHub repository.
The publisher verifies uploads while the release is a draft, publishes once, then reads every
asset anonymously over bounded HTTPS and checks its complete size and SHA256. The compressed
raw asset must be smaller than 2 GiB. These outputs are distribution artifacts; initial Factory
transport and common-image adoption retain their separately authorized installation path.

`publication-state.json` is fsynced before each mutation and retained by the CI artifact step.
It contains public bindings and attempt state only. An uncertain request is resolved by exact
tag/asset reads; it is never blindly retried or overwritten. For recovery, download the exact
prior artifact ID and pass its `pgcf-talos-boot-<SHA>/publication-state.json` through
`PGCF_PUBLICATION_RECEIPT_PATH`. Without that receipt, reruns can verify an already complete
publication and otherwise stop unresolved. Only the explicit safe qualification/publication
JSON files belong in the retained artifact; raw logs and candidate files stay private.

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
