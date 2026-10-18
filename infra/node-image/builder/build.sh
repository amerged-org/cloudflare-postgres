#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Runs inside the builder container; node-image.ts starts it. Never run it on a workstation.
#
#   resolve  Build once from the Debian snapshot and the PGDG archive (network) and hand the
#            resolved package set and the signed indexes to `node-image.ts resolve`.
#   build    Build offline from the sha256-verified locked packages only.
#   advisories
#            Fetch today's package indexes of the suites an image update draws from
#            (trixie-security, trixie-updates, trixie-pgdg) for `node-image.ts advisories`.
#            Installs and builds nothing.
#
# Mounts: /src = infra/node-image (read-only), /debs = verified .debs (read-only),
# /binaries = the four PGCF binaries (read-only, build only), /out = results for the host.
# Environment: PGCF_DEBIAN_SNAPSHOT, PGCF_SOURCE_DATE_EPOCH, PGCF_RELEASE, PGCF_PGDG_URL and
# PGCF_PGDG_SUITE and PGCF_PGDG_FINGERPRINT, all from packages.lock.json.
set -euo pipefail

mode=${1:?usage: build.sh resolve|build|advisories}
: "${PGCF_DEBIAN_SNAPSHOT:?}" "${PGCF_SOURCE_DATE_EPOCH:?}" "${PGCF_RELEASE:?}"
: "${PGCF_PGDG_URL:?}" "${PGCF_PGDG_SUITE:?}" "${PGCF_PGDG_FINGERPRINT:?}"
[[ $PGCF_RELEASE =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo "invalid release name" >&2; exit 2; }

work=/work
rm -rf "$work"
mkdir -p "$work"
# Copy the definition without host ownership or extended attributes.
cp -r --preserve=mode /src "$work/src"

mkosi_args=(
  --directory="$work/src"
  --output-directory="$work/out"
  --workspace-directory="$work/workspace"
  --cache-directory="$work/cache"
  --package-cache-dir="$work/pkgcache"
  --source-date-epoch="$PGCF_SOURCE_DATE_EPOCH"
  --image-version="$PGCF_RELEASE"
  --output=pgcf-node
  --environment=PGCF_DEBIAN_SNAPSHOT="$PGCF_DEBIAN_SNAPSHOT"
  --environment=PGCF_PGDG_URL="$PGCF_PGDG_URL"
  --environment=PGCF_PGDG_SUITE="$PGCF_PGDG_SUITE"
  --force
)
mkdir -p "$work/out" "$work/workspace" "$work/cache" "$work/pkgcache"

case $mode in
resolve)
  sandbox=$work/sandbox
  mkdir -p "$sandbox/etc/apt/sources.list.d" "$sandbox/etc/apt/keyrings"
  cp /src/keys/pgdg.asc "$sandbox/etc/apt/keyrings/pgdg.asc"
  # mkosi adds the snapshot's trixie, trixie-security and debug suites itself; trixie-updates and
  # PGDG come from here.
  cat >"$sandbox/etc/apt/sources.list.d/pgcf-resolve.sources" <<EOF
Types: deb
URIs: https://snapshot.debian.org/archive/debian/$PGCF_DEBIAN_SNAPSHOT
Suites: trixie-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: $PGCF_PGDG_URL
Suites: $PGCF_PGDG_SUITE
Components: main
Signed-By: /etc/apt/keyrings/pgdg.asc
EOF
  mkosi "${mkosi_args[@]}" \
    --snapshot="$PGCF_DEBIAN_SNAPSHOT" \
    --sandbox-tree="$sandbox" \
    --package-directory=/debs \
    build
  mkdir -p /out/lists
  find "$work" -path '*/lists/*' -type f -name '*_Packages' -exec cp {} /out/lists/ \;
  cp "$work/out/pgcf-node.manifest" /out/manifest.json
  (cd "$work/pkgcache" && find . -name '*.deb' -type f -exec sha256sum {} +) >/out/downloaded.sha256
  ;;
build)
  repo=$work/repo
  mkdir -p "$repo/pool" "$repo/dists/trixie/main/binary-amd64"
  cp /debs/*.deb "$repo/pool/"
  (
    cd "$repo"
    apt-ftparchive packages pool >dists/trixie/main/binary-amd64/Packages
    apt-ftparchive \
      -o APT::FTPArchive::Release::Suite=trixie \
      -o APT::FTPArchive::Release::Codename=trixie \
      -o APT::FTPArchive::Release::Components=main \
      -o APT::FTPArchive::Release::Architectures=amd64 \
      release dists/trixie >dists/trixie/Release
  )
  stage=$work/binaries
  mkdir -p "$stage/var/lib/pgcf/bin/$PGCF_RELEASE"
  # Exactly the four binaries node-image.ts digested into pgcf-node.json; a missing one fails the build.
  for binary in pgcf-agent pgcf-native-gateway pgcf-archive pgcf-wal-fetch; do
    install -m 0755 "/binaries/$binary" "$stage/var/lib/pgcf/bin/$PGCF_RELEASE/"
  done
  ln -s "$PGCF_RELEASE" "$stage/var/lib/pgcf/bin/current"
  mkosi "${mkosi_args[@]}" \
    --local-mirror="file://$repo" \
    --extra-tree="$stage:/" \
    build
  cp "$work/out/pgcf-node.raw" /out/pgcf-node.raw
  cp "$work/out/pgcf-node.manifest" /out/manifest.json
  ;;
advisories)
  # Today's indexes, not the snapshot's. apt verifies each one: Debian's against the container's
  # debian-archive-keyring, PGDG's against the key in the repository, accepted only for the locked
  # fingerprint. --error-on=any fails the run on any fetch or signature error.
  rm -f /etc/apt/sources.list.d/snapshot.sources
  cp /src/keys/pgdg.asc /etc/apt/trusted.gpg.d/pgdg.asc
  cat >/etc/apt/sources.list.d/pgcf-advisories.sources <<EOF
Types: deb
URIs: https://deb.debian.org/debian-security
Suites: trixie-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: https://deb.debian.org/debian
Suites: trixie-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: https://apt.postgresql.org/pub/repos/apt
Suites: trixie-pgdg
Components: main
Signed-By: $PGCF_PGDG_FINGERPRINT
EOF
  # Uncompressed, unlike the container's default, so that node-image.ts reads the lists as they are.
  apt-get update --error-on=any -o Acquire::GzipIndexes=false
  mkdir -p /out/lists
  cp /var/lib/apt/lists/*_Packages /out/lists/
  ;;
*)
  echo "unknown mode $mode" >&2
  exit 2
  ;;
esac
