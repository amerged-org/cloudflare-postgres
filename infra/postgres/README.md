# PostgreSQL security image

This Linux/amd64 image retains the unmodified CloudNativePG PostgreSQL 18.6 engine
and standard Trixie runtime, and upgrades its installed pgvector package to 0.8.7. It exists
because the verified upstream `18.6-standard-trixie` image's published AMD64 SPDX
SBOM still reports pgvector `0.8.6-1.pgdg13+2`. Upstream pgvector 0.8.7 fixes
[CVE-2026-103484](https://www.postgresql.org/about/news/pgvector-087-released-3392/).
This change addresses that known extension issue; it does not claim that every
package or vulnerability in the resulting image has been cleared.

`sources.lock.json` records the upstream image index, AMD64 manifest and config,
PostgreSQL package, exact PGDG pgvector package version, URL, byte count, SHA-256,
upstream source tag/commit and license references. Docker verifies the downloaded
package's checksum. The build verifies its package identity and version, and
checks that no other installed package version or PostgreSQL engine binary changes.
The engine's byte count and SHA-256 come from the verified official AMD64 image,
and both the build and runtime test compare against those static records.
No floating package upgrade, engine fork, compiler or build dependency is added.
The official image's effective environment, `USER 26`, unset entrypoint, `bash`
command and remaining runtime metadata are preserved and checked from the locked config.

The upstream base contains an unused generated snakeoil key and its certificate.
The build removes only that pair after patching, then assembles a `FROM scratch`
image by copying the complete patched root filesystem. Earlier key-bearing base
layers are not inherited by the published image. A later-layer deletion would
leave their bytes available and would fail the all-layer qualification gate.
All other runtime files and inherited package/license notices remain intact.

Build and verify locally:

```sh
docker buildx build --platform linux/amd64 --load --provenance=false \
  --tag pgcf-postgres-security:local infra/postgres
PGCF_TEST_POSTGRES_IMAGE=pgcf-postgres-security:local \
  node --test infra/postgres/image.test.mjs
```

The test starts a disposable PostgreSQL cluster inside a container with no network,
read-only image files and a bounded temporary filesystem. It checks the engine,
package/control-file versions, runtime metadata, absence of the unused key pair,
provenance, creation of the actual vector extension
and a vector-distance query. It does not connect to Dev or qualify a live upgrade.
The repository's single CI workflow must qualify the complete image and publish its
immutable registry digest before any configured regional image pin uses it.

Existing databases still need a coordinated engine image rollout and
`ALTER EXTENSION vector UPDATE` where vector is installed. An image replacement
alone does not change an existing database's extension catalog version. Preserve
Cluster/PVC identities, backup evidence and the normal uncertain-write safeguards.
PostgreSQL 18.6's [release notes](https://www.postgresql.org/docs/release/18.6/)
also describe index and configuration checks for existing databases.

## Licenses and notices

The assembly files in this directory are Apache-2.0. Upstream PostgreSQL and
pgvector retain the PostgreSQL License. The CloudNativePG container assembly is
Apache-2.0; its Debian and other inherited packages retain their own licenses.
The upgraded Debian package's copyright notice remains at
`/usr/share/doc/postgresql-18-pgvector/copyright`.

Before publishing, update the root `THIRD_PARTY.md` record with the final qualified
image digest, the unmodified upstream PostgreSQL image index, the pgvector package
version/SHA-256 and its pinned upstream source/notice references from
`sources.lock.json`. This directory does not replace the upstream notices or the
repository's image qualification policy.
