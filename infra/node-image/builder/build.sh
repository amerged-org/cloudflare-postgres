#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Runs inside the builder container; node-image.ts starts it. Never run it on a workstation.
#
#   resolve  Build once from the Debian snapshot and the PGDG archive (network) and hand the
#            resolved package set and the signed indexes to `node-image.ts resolve`.
#   build    Build offline from the sha256-verified locked packages only.
#
# Mounts: /src = infra/node-image (read-only), /debs = verified .debs (read-only),
# /binaries = PGCF binaries (read-only, build only), /out = results for the host.
# Environment: PGCF_DEBIAN_SNAPSHOT, PGCF_SOURCE_DATE_EPOCH, PGCF_RELEASE, PGCF_PGDG_URL and
# PGCF_PGDG_SUITE, all from packages.lock.json.
set -euo pipefail

mode=${1:?usage: build.sh resolve|build}
: "${PGCF_DEBIAN_SNAPSHOT:?}" "${PGCF_SOURCE_DATE_EPOCH:?}" "${PGCF_RELEASE:?}"
: "${PGCF_PGDG_URL:?}" "${PGCF_PGDG_SUITE:?}"
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
  if compgen -G '/binaries/*' >/dev/null; then
    install -m 0755 /binaries/* "$stage/var/lib/pgcf/bin/$PGCF_RELEASE/"
  fi
  ln -s "$PGCF_RELEASE" "$stage/var/lib/pgcf/bin/current"
  mkosi "${mkosi_args[@]}" \
    --local-mirror="file://$repo" \
    --extra-tree="$stage:/" \
    build
  cp "$work/out/pgcf-node.raw" /out/pgcf-node.raw
  cp "$work/out/pgcf-node.manifest" /out/manifest.json
  ;;
*)
  echo "unknown mode $mode" >&2
  exit 2
  ;;
esac
