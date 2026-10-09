# OpenEBS thin metadata tools

The official OpenEBS LVM LocalPV 1.10.1 image contains LVM but omits the
`thin_check` and `thin_repair` executables named by its own LVM configuration.
This extension adds the checksum-pinned, signature-verified official Alpine
`thin-provisioning-tools` package. It preserves the upstream driver, LVM binary,
installed dependency versions and effective runtime configuration. It does not
disable metadata checking or automatically repair damaged pools.

`sources.lock.json` records the exact image, source commit, package, binary and
license hashes. The image includes the corresponding upstream source archive
and GPL-3.0-only COPYING under `/usr/share/pgcf` and
`/usr/share/licenses/pgcf-thin-tools`. The first-party recipe is Apache-2.0;
inherited packages retain their licenses.

```sh
docker buildx build --platform linux/amd64 --network none --load --provenance=false \
  --tag pgcf-storage:local infra/storage
PGCF_TEST_STORAGE_IMAGE=pgcf-storage:local node --test infra/storage/image.test.mjs
```

The unprivileged tests use regular files in a bounded temporary filesystem,
without network, host devices or capabilities. They prove real metadata restore,
check, explicit-geometry repair and rejection of corrupt metadata. They do not
prove live pool activation, capacity growth, full-pool recovery or reclamation;
those need the separately fenced real Talos/OpenEBS qualification.

The existing CI image qualification must scan every layer and publish the
immutable driver digest before release selection. Use the existing public
`pgcf-regional` package with a separate `lvm-thin-sha-<commit>` tag, preserving
its manifest. Selecting this image does not activate thin storage, change the
default thick StorageClass or remove thick-volume quota accounting.
