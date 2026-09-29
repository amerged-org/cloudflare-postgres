# Talos imported image references

Talos `ImageService.Import` and Kubernetes image resolution have distinct postconditions. An authenticated import/readback can prove a named archive and its target digest exist. It does not prove the equivalent `repository@digest` name exists or is resolvable by CRI.

Pinned Talos 1.14.1 imports and unpacks the archive but does not invoke its alias manager. The supported `ImageService.Pull` path invokes alias management even when the requested tag is already present and unpacked. That creates the repository-digest reference through maintained Talos/containerd APIs. [Import implementation](https://github.com/siderolabs/talos/blob/v1.14.1/internal/app/images/images.go), [cached Pull path](https://github.com/siderolabs/talos/blob/v1.14.1/internal/pkg/containers/image/pull.go), [alias handling](https://github.com/siderolabs/talos/blob/v1.14.1/internal/pkg/containers/image/aliases.go).

For an explicitly selected offline lab image:

1. Verify the private archive checksum, pinned source/build inputs, architecture, entrypoint and separate index/manifest/configuration digests before import.
2. Import once into the Kubernetes CRI namespace through authenticated Talos API access. Retain its actual `image_imported_and_present` response and exact-name readback.
3. Verify the imported tag still targets the expected digest. Import must have completed unpacking; a list alone does not prove unpacking.
4. Call the supported single-attempt Pull API for that exact imported tag, with a bounded client deadline. On the verified cached/unpacked path Talos completes alias metadata without a registry pull. Otherwise the API may attempt registry access; do not equate successful tag lookup with cache-only completion.
5. Read the exact tag and exact repository-digest reference back independently. Both must target the approved digest before selecting a Pod image. Never substitute a bare index hash for the CRI image ID, which represents a different object.

The normal CLI operation is:

```sh
talosctl --talosconfig "$PGCF_TALOSCONFIG" \
  --endpoints "$PGCF_NODE" --nodes "$PGCF_NODE" \
  image pull --namespace cri "$PGCF_IMPORTED_REFERENCE"
```

Supply those values from private installation configuration and capture output privately; impose an external deadline. The operation can write image metadata and must not be described as read-only. It does not patch running workloads, restart a stopped qualification, establish physical compute absence or finalize usage.

## Development evidence — 2026-09-29

Independent exact-name observations confirm the previously imported observer tag exists with approved index `sha256:dd98383778a4c2d2a60de4cf34fc88efc657077541110c186643e66a0a607b3e`, while its repository-digest reference was absent. One supported cached Pull completes in 0.165 seconds; subsequent authenticated reads confirm both names target the same unchanged index. No new image build/import or Pod is created and the held observer qualification remains held.

This fixes local image catalog resolution only. The existing public observer recipe now has an independently confirmed digest name available in the development node's image catalog; its actual execution is still unqualified. Before and after evidence remains private under the ignored local evidence directory. The original failure record is preserved.

## Release boundary

Production requires independently usable artifacts. A public source repository does not automatically make a GHCR package public: first publication defaults private. Pin the published registry digest and independently retrieve its index, selected manifest, configuration and layers without developer credentials; validate source/platform/provenance before normal runtime pulling. [GitHub Container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Current GitHub Actions publication exists, but anonymous access remains unqualified. The local CLI lacks `read:packages`, and the available development browser account sees no organization package. Package-management access is pending; no credential scopes, organization permissions, registry tokens or package visibility were changed. Local aliases do not satisfy public release distribution.
