#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# First-party extension and recipe only, after normal runtime qualification.
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
mkdir -p -m 700 "$PGCF_BOOT_DIRECTORY"
mkdir -p -m 700 "$PGCF_EXTENSION_GATE" "$PGCF_RECIPE_GATE"
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
node --input-type=module - "$PGCF_EXTENSION_REF" "$PGCF_RECIPE_REF" "$GITHUB_OUTPUT" <<'JS'
import fs from 'node:fs';
const [extension,recipe,out]=process.argv.slice(2),values={extension_ref:extension,recipe_ref:recipe};
fs.appendFileSync(out,Object.entries(values).map(([key,value])=>`${key}=${value}\n`).join(''));
JS
