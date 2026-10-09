// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  changedImageInputs,
  selectImageInputs,
  type ImageInputs,
} from "./image-inputs.ts";
const selected = (value: Partial<ImageInputs> = {}): ImageInputs => ({
  regional: false,
  node_bootstrap: false,
  postgres: false,
  storage: false,
  rust_gateway: false,
  native_controller: false,
  rust_bootstrap_relay: false,
  native_reclaimer: false,
  sandbox_controller: false,
  ...value,
});

test("the storage source lock invalidates both the storage and Native images", () => {
  assert.deepEqual(
    selectImageInputs(["infra/storage/sources.lock.json"], "push"),
    selected({ storage: true, node_bootstrap: true }),
  );
});

test("management-only changes skip images while exact Native and Regional build inputs select their image", () => {
  assert.deepEqual(
    selectImageInputs(["infra/talos/sandbox/runtime-admission.ts"], "push"),
    selected({ node_bootstrap: true, sandbox_controller: true }),
  );
  assert.deepEqual(
    selectImageInputs(["infra/platform/image-manifest.ts"], "push"),
    selected({ node_bootstrap: true }),
  );
  assert.deepEqual(
    selectImageInputs(
      [
        "apps/api/src/domain/node-state.ts",
        "apps/api/migrations/0027_policy.sql",
        "PLAN.md",
        "docs/operations/operator-installation.md",
      ],
      "push",
    ),
    selected(),
  );
  assert.deepEqual(
    selectImageInputs(
      [
        "apps/node-bootstrap/src/postjoin-proof.ts",
        "scripts/e2e/src/node-network-packets.ts",
      ],
      "push",
    ),
    selected({ node_bootstrap: true }),
  );
  assert.deepEqual(
    selectImageInputs(["apps/regional/src/agent/loop.ts"], "push"),
    selected({ regional: true }),
  );
});
test("actual storage and native inputs select only their affected runtime artifacts", () => {
  assert.deepEqual(
    selectImageInputs(["apps/native-gateway/src/budget.rs"], "push"),
    selected({ rust_gateway: true, rust_bootstrap_relay: true }),
  );
  assert.deepEqual(
    selectImageInputs(["apps/native-controller/src/kubernetes.rs"], "push"),
    selected({ native_controller: true, native_reclaimer: true }),
  );
  for (const [path, flag] of [
    ["apps/native-bootstrap-relay/src/main.rs", "rust_bootstrap_relay"],
    ["apps/native-reclaimer/src/main.rs", "native_reclaimer"],
  ])
    assert.equal(
      (
        selectImageInputs([path!], "push") as unknown as Record<string, unknown>
      )[flag!],
      true,
    );
  assert.equal(
    (
      selectImageInputs(
        ["apps/native-controller/Dockerfile"],
        "push",
      ) as unknown as Record<string, unknown>
    ).native_controller,
    true,
  );
  assert.deepEqual(
    selectImageInputs(["infra/talos/sandbox/service.yaml"], "push"),
    selected({ sandbox_controller: true }),
  );
  assert.deepEqual(
    selectImageInputs(["apps/native-gateway/license-bundle.sh"], "push"),
    selected({
      rust_gateway: true,
      native_controller: true,
      rust_bootstrap_relay: true,
      native_reclaimer: true,
      sandbox_controller: true,
    }),
  );
  assert.deepEqual(
    selectImageInputs(["scripts/ci/storage-reviewed-findings.json"], "push"),
    selected({ storage: true }),
  );
  assert.deepEqual(
    selectImageInputs(["scripts/ci/talos-reviewed-findings.json"], "push"),
    selected({ sandbox_controller: true }),
  );
  assert.deepEqual(
    selectImageInputs(["infra/storage/Dockerfile"], "push"),
    selected({ storage: true }),
  );
  assert.deepEqual(
    selectImageInputs(["apps/native-gateway/src/main.rs"], "push"),
    selected({ rust_gateway: true }),
  );
  assert.deepEqual(
    selectImageInputs(["apps/node-runtime/src/linux.rs"], "push"),
    selected({ sandbox_controller: true }),
  );
  assert.deepEqual(
    selectImageInputs(["packages/native-protocol/src/activity.rs"], "push"),
    selected({
      rust_gateway: true,
      native_controller: true,
      rust_bootstrap_relay: true,
      native_reclaimer: true,
      sandbox_controller: true,
    }),
  );
  assert.deepEqual(
    selectImageInputs(["Cargo.lock"], "push"),
    selected({
      rust_gateway: true,
      native_controller: true,
      rust_bootstrap_relay: true,
      native_reclaimer: true,
      sandbox_controller: true,
    }),
  );
});
test("common Docker inputs and qualification changes invalidate every affected profile", () => {
  assert.deepEqual(
    selectImageInputs(["infra/platform/openebs-image.ts"], "push"),
    selected({ regional: true, node_bootstrap: true }),
  );
  assert.deepEqual(
    selectImageInputs(["scripts/ci/reviewed-findings.json"], "push"),
    selected({
      regional: true,
      node_bootstrap: true,
      postgres: true,
      storage: true,
      rust_gateway: true,
      native_controller: true,
      rust_bootstrap_relay: true,
      native_reclaimer: true,
      sandbox_controller: true,
    }),
  );
  assert.deepEqual(
    selectImageInputs(["infra/platform/versions.lock.json"], "push"),
    selected({
      regional: true,
      node_bootstrap: true,
      rust_gateway: true,
      native_controller: true,
      rust_bootstrap_relay: true,
      native_reclaimer: true,
      sandbox_controller: true,
    }),
  );
  assert.deepEqual(
    selectImageInputs(["packages/contracts/src/releases.ts"], "push"),
    selected({ regional: true, node_bootstrap: true }),
  );
  assert.deepEqual(
    selectImageInputs(["apps/api/package.json"], "push"),
    selected({ regional: true, node_bootstrap: true }),
  );
  assert.deepEqual(
    selectImageInputs(["pnpm-lock.yaml"], "push"),
    selected({
      regional: true,
      node_bootstrap: true,
      postgres: true,
      storage: true,
      rust_gateway: true,
      native_controller: true,
      rust_bootstrap_relay: true,
      native_reclaimer: true,
      sandbox_controller: true,
    }),
  );
  assert.deepEqual(
    selectImageInputs(
      ["scripts/ci/image-qualification.ts", ".github/workflows/ci.yml"],
      "push",
    ),
    selected({
      regional: true,
      node_bootstrap: true,
      postgres: true,
      storage: true,
      rust_gateway: true,
      native_controller: true,
      rust_bootstrap_relay: true,
      native_reclaimer: true,
      sandbox_controller: true,
    }),
  );
});
test("PostgreSQL inputs stay scoped and manual, unavailable or malformed comparisons conservatively select all", () => {
  const all = selected({
    regional: true,
    node_bootstrap: true,
    postgres: true,
    storage: true,
    rust_gateway: true,
    native_controller: true,
    rust_bootstrap_relay: true,
    native_reclaimer: true,
    sandbox_controller: true,
  });
  assert.deepEqual(
    selectImageInputs(
      [
        "infra/postgres/sources.lock.json",
        "scripts/ci/postgres-reviewed-findings.json",
      ],
      "push",
    ),
    selected({ postgres: true }),
  );
  assert.deepEqual(selectImageInputs([], "workflow_dispatch"), all);
  assert.deepEqual(selectImageInputs(null, "push"), all);
  assert.deepEqual(selectImageInputs(["../outside"], "push"), all);
  assert.deepEqual(
    changedImageInputs({
      eventName: "push",
      before: "0".repeat(40),
      head: "a".repeat(40),
    }),
    all,
  );
  assert.deepEqual(
    changedImageInputs({
      eventName: "push",
      before: "HEAD;anything",
      head: "a".repeat(40),
    }),
    all,
  );
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    timeout: 10000,
    encoding: "utf8",
  }).trim();
  assert.deepEqual(
    changedImageInputs({ eventName: "push", before: head, head }),
    selected(),
  );
});
