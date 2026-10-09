#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Called only by the existing authenticated CI job, after normal runtime qualification.
set -euo pipefail
test "${CI:-}" = true
test "${#GITHUB_SHA}" -eq 40
case "$GITHUB_SHA" in *[!0-9a-f]*) exit 1;; esac
PGCF_RUNTIME_REPORT=$1
shift
PGCF_IMAGE_REPOSITORY=${IMAGE:?existing public image repository required}
PGCF_SOURCE_URI="https://github.com/${GITHUB_REPOSITORY:?}"
PGCF_BOOT_DIRECTORY="${RUNNER_TEMP:?}/pgcf-talos-boot-${GITHUB_SHA}"
PGCF_EXTENSION_GATE="$PGCF_BOOT_DIRECTORY/extension-gate"
PGCF_RECIPE_GATE="$PGCF_BOOT_DIRECTORY/recipe-gate"
PGCF_RECIPE_CONTEXT="$PGCF_BOOT_DIRECTORY/recipe-context"
PGCF_BOOT_OUTPUT="$PGCF_BOOT_DIRECTORY/out"
mkdir -p -m 700 "$PGCF_BOOT_DIRECTORY"
mkdir -p -m 700 "$PGCF_EXTENSION_GATE" "$PGCF_RECIPE_GATE" "$PGCF_BOOT_OUTPUT"
PGCF_RUST_BUILDER=$(node -p 'require("./infra/platform/versions.lock.json").nativeRuntime.testBuilderImage')
PGCF_RUST_VERSION=$(node -p 'require("./infra/platform/versions.lock.json").nativeRuntime.rustVersion')
PGCF_EXTENSION_TAG="$PGCF_IMAGE_REPOSITORY:talos-sandbox-extension-sha-$GITHUB_SHA"
docker build --platform linux/amd64 --provenance=false --sbom=false --target talos-extension \
  --build-arg "RUST_BUILDER=$PGCF_RUST_BUILDER" --build-arg "RUST_VERSION=$PGCF_RUST_VERSION" --build-arg "SOURCE_COMMIT=$GITHUB_SHA" \
  --iidfile "$PGCF_EXTENSION_GATE/image.id" -f apps/sandbox-controller/Dockerfile -t "$PGCF_EXTENSION_TAG" \
  --label "org.opencontainers.image.source=$PGCF_SOURCE_URI" --label "org.opencontainers.image.revision=$GITHUB_SHA" .
PGCF_EXTENSION_ID=$(cat "$PGCF_EXTENSION_GATE/image.id")
node scripts/ci/image-qualification.ts --profile sandbox-extension qualify "$PGCF_EXTENSION_TAG" "$PGCF_EXTENSION_ID" "$GITHUB_SHA" "$PGCF_SOURCE_URI" "$PGCF_EXTENSION_GATE/qualification.json"
# Both layouts must carry the exact same already-qualified first-party executables.
node --input-type=module - "$PGCF_RUNTIME_REPORT" "$PGCF_EXTENSION_GATE/qualification.json" "$GITHUB_SHA" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';
const [normalPath,extensionPath,revision]=process.argv.slice(2),normal=JSON.parse(fs.readFileSync(normalPath,'utf8')),extension=JSON.parse(fs.readFileSync(extensionPath,'utf8'));
assert.equal(normal.profile,'sandbox-controller');assert.equal(normal.revision,revision);assert.equal(normal.unresolved,0);
for(const binary of normal.compiledArtifacts){const match=extension.compiledArtifacts.find(value=>value.path==='rootfs/'+binary.path);assert.ok(match);assert.equal(match.sha256,binary.sha256);assert.equal(match.size,binary.size);}
JS
node scripts/ci/image-qualification.ts --profile sandbox-extension verify "$PGCF_EXTENSION_TAG" "$PGCF_EXTENSION_ID" "$GITHUB_SHA" "$PGCF_SOURCE_URI" "$PGCF_EXTENSION_GATE/qualification.json"
docker push "$PGCF_EXTENSION_TAG"
node scripts/ci/image-qualification.ts --profile sandbox-extension registry "$PGCF_EXTENSION_TAG" "$PGCF_EXTENSION_ID" "$GITHUB_SHA" "$PGCF_SOURCE_URI" "$PGCF_EXTENSION_GATE/qualification.json" "$PGCF_EXTENSION_GATE/registry.json"
PGCF_EXTENSION_DIGEST=$(node -p "require(process.argv[1]).digest" "$PGCF_EXTENSION_GATE/registry.json")
PGCF_EXTENSION_REF="$PGCF_IMAGE_REPOSITORY@$PGCF_EXTENSION_DIGEST"
node infra/talos/sandbox/build-plan.ts prepare "$GITHUB_SHA" "$PGCF_EXTENSION_REF" "$PGCF_RECIPE_CONTEXT" "$@"
PGCF_RECIPE_TAG="$PGCF_IMAGE_REPOSITORY:talos-recipe-sha-$GITHUB_SHA"
docker build --platform linux/amd64 --provenance=false --sbom=false --iidfile "$PGCF_RECIPE_GATE/image.id" \
  --label "org.opencontainers.image.source=$PGCF_SOURCE_URI" --label "org.opencontainers.image.revision=$GITHUB_SHA" \
  -f infra/talos/sandbox/recipe.Dockerfile -t "$PGCF_RECIPE_TAG" "$PGCF_RECIPE_CONTEXT"
PGCF_RECIPE_ID=$(cat "$PGCF_RECIPE_GATE/image.id")
node scripts/ci/image-qualification.ts --profile talos-recipe qualify "$PGCF_RECIPE_TAG" "$PGCF_RECIPE_ID" "$GITHUB_SHA" "$PGCF_SOURCE_URI" "$PGCF_RECIPE_GATE/qualification.json"
node scripts/ci/image-qualification.ts --profile talos-recipe verify "$PGCF_RECIPE_TAG" "$PGCF_RECIPE_ID" "$GITHUB_SHA" "$PGCF_SOURCE_URI" "$PGCF_RECIPE_GATE/qualification.json"
docker push "$PGCF_RECIPE_TAG"
node scripts/ci/image-qualification.ts --profile talos-recipe registry "$PGCF_RECIPE_TAG" "$PGCF_RECIPE_ID" "$GITHUB_SHA" "$PGCF_SOURCE_URI" "$PGCF_RECIPE_GATE/qualification.json" "$PGCF_RECIPE_GATE/registry.json"
PGCF_RECIPE_DIGEST=$(node -p "require(process.argv[1]).digest" "$PGCF_RECIPE_GATE/registry.json")
PGCF_RECIPE_REF="$PGCF_IMAGE_REPOSITORY@$PGCF_RECIPE_DIGEST"
node infra/talos/sandbox/build-plan.ts bind "$PGCF_RECIPE_CONTEXT" "$PGCF_RECIPE_REF"
PGCF_IMAGER=$(node --input-type=module -e 'import {TALOS_SANDBOX_BUILD_INPUTS as i} from "./infra/talos/sandbox/images.ts";process.stdout.write(i.imager)')
docker run --rm -i --platform linux/amd64 --privileged --mount "type=bind,src=$PGCF_BOOT_OUTPUT,dst=/out" "$PGCF_IMAGER" - < "$PGCF_RECIPE_CONTEXT/installer.profile.json"
docker run --rm -i --platform linux/amd64 --privileged --mount "type=bind,src=$PGCF_BOOT_OUTPUT,dst=/out" "$PGCF_IMAGER" - < "$PGCF_RECIPE_CONTEXT/raw.profile.json"
# The fresh hosted job has finished every Rust/extension build. Keep tagged images and
# assembled outputs, but release unused compiler caches before measured all-byte scan aliases.
if [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ]; then
  docker builder prune --all --force > "$PGCF_BOOT_DIRECTORY/build-cache-cleanup.private.log" 2>&1
fi
# All installer/raw bytes, nested files and the identical raw-image maintenance boot must pass before publication.
node infra/talos/sandbox/boot-image-qualification.ts "$PGCF_BOOT_DIRECTORY" "$GITHUB_SHA"
node --input-type=module - "$PGCF_BOOT_DIRECTORY/whole-os-qualification.json" "$GITHUB_SHA" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';
const [path,revision]=process.argv.slice(2),report=JSON.parse(fs.readFileSync(path,'utf8'));
assert.equal(report.passed,true);assert.equal(report.source_commit,revision);
JS
PGCF_INSTALLER_GATE="$PGCF_BOOT_DIRECTORY/installer-gate"
mkdir -m 700 "$PGCF_INSTALLER_GATE"
docker load --input "$PGCF_BOOT_OUTPUT/installer-amd64.tar" > "$PGCF_INSTALLER_GATE/load.private.log" 2>&1
PGCF_INSTALLER_ID=$(node infra/talos/sandbox/publish-artifacts.ts load-id "$PGCF_INSTALLER_GATE/load.private.log")
docker save --output "$PGCF_INSTALLER_GATE/transport.tar" "$PGCF_INSTALLER_ID"
chmod 600 "$PGCF_INSTALLER_GATE/transport.tar"
node infra/talos/sandbox/publish-artifacts.ts verify-transport "$PGCF_INSTALLER_GATE/transport.tar" \
  "$PGCF_BOOT_DIRECTORY/whole-os-qualification.json" "$GITHUB_SHA" "$PGCF_INSTALLER_GATE/transport.json"
PGCF_INSTALLER_MANIFEST=$(node -p 'require(process.argv[1]).manifestDigest' "$PGCF_INSTALLER_GATE/transport.json")
PGCF_INSTALLER_TAG="$PGCF_IMAGE_REPOSITORY:talos-installer-sha-$GITHUB_SHA-${PGCF_INSTALLER_MANIFEST#sha256:}"
docker tag "$PGCF_INSTALLER_ID" "$PGCF_INSTALLER_TAG"
PGCF_INSTALLER_PRESENCE=$(node infra/talos/sandbox/publish-artifacts.ts registry-presence "$PGCF_INSTALLER_TAG" "$PGCF_INSTALLER_MANIFEST")
case "$PGCF_INSTALLER_PRESENCE" in absent) docker push "$PGCF_INSTALLER_TAG";; present) :;; *) exit 1;; esac
node --input-type=module - "$PGCF_INSTALLER_TAG" "$PGCF_BOOT_DIRECTORY/whole-os-qualification.json" "$PGCF_INSTALLER_GATE/transport.json" "$PGCF_INSTALLER_GATE/registry.json" <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';
import {verifyTalosInstallerRegistry} from './scripts/ci/registry.ts';
import versions from './infra/platform/versions.lock.json' with {type:'json'};
const [tag,path,transportPath,out]=process.argv.slice(2),report=JSON.parse(fs.readFileSync(path,'utf8')),transport=JSON.parse(fs.readFileSync(transportPath,'utf8'));
const result=await verifyTalosInstallerRegistry(tag,report.installer,versions.target.talosVersion,out);
assert.equal(result.manifestDigest,transport.manifestDigest);assert.equal(result.compressedBytes,transport.compressedBytes);
JS
PGCF_INSTALLER_DIGEST=$(node -p 'require(process.argv[1]).digest' "$PGCF_INSTALLER_GATE/registry.json")
PGCF_INSTALLER_REF="$PGCF_IMAGE_REPOSITORY@$PGCF_INSTALLER_DIGEST"
if [ -n "${PGCF_PUBLICATION_RECEIPT_PATH:-}" ]; then
  test -f "$PGCF_PUBLICATION_RECEIPT_PATH"
  test ! -L "$PGCF_PUBLICATION_RECEIPT_PATH"
  test ! -e "$PGCF_BOOT_DIRECTORY/publication-state.json"
  cp -- "$PGCF_PUBLICATION_RECEIPT_PATH" "$PGCF_BOOT_DIRECTORY/publication-state.json"
  chmod 600 "$PGCF_BOOT_DIRECTORY/publication-state.json"
fi
node infra/talos/sandbox/publish-artifacts.ts publish "$PGCF_BOOT_DIRECTORY" "$GITHUB_SHA" "$PGCF_INSTALLER_REF"
node --input-type=module - "$PGCF_BOOT_DIRECTORY" "$PGCF_EXTENSION_REF" "$PGCF_RECIPE_REF" "$GITHUB_OUTPUT" <<'JS'
import fs from 'node:fs';
const [directory,extension,recipe,out]=process.argv.slice(2),result=JSON.parse(fs.readFileSync(directory+'/publication.json','utf8')),qualification=JSON.parse(fs.readFileSync(directory+'/whole-os-qualification.json','utf8'));
const values={extension_ref:extension,recipe_ref:recipe,installer_ref:result.installer_ref,release_url:result.release_url,raw_url:result.assets.raw.url,raw_sha256:result.assets.raw.sha256,raw_bytes:result.assets.raw.size,raw_uncompressed_sha256:qualification.raw.decompressed.sha256,raw_uncompressed_bytes:qualification.raw.decompressed.size,qualification_url:result.assets.report.url,recipe_url:result.assets.recipe.url,boot_directory:directory,whole_os_qualification:directory+'/whole-os-qualification.json',publication_receipt:directory+'/publication-state.json'};
fs.appendFileSync(out,Object.entries(values).map(([key,value])=>`${key}=${value}\n`).join(''));
JS
