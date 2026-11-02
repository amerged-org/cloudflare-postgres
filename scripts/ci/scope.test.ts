// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { gateFailures, gatedJobs, scopeOf } from "./scope.ts";
import type { Needs } from "./scope.ts";

const all = { native: true, workers: true };

test("a push, a dispatch and a schedule always run everything, whatever the files", () => {
  for (const event of ["push", "workflow_dispatch", "schedule", ""]) {
    assert.deepEqual(scopeOf(event, ["README.md"]), all);
  }
});

test("a pull request that changes only documents runs neither the native nor the Workers jobs", () => {
  assert.deepEqual(
    scopeOf("pull_request", [
      "PLAN.md",
      "README.md",
      "docs/architecture/ci-speed.md",
      "docs/operations/release-signing.md",
      ".mermaider/manifest.json",
    ]),
    { native: false, workers: false },
  );
});

test("a pull request that changes only the Workers' TypeScript skips the native jobs and still tests the Workers", () => {
  assert.deepEqual(
    scopeOf("pull_request", [
      "apps/api/src/database-actor.ts",
      "apps/api/test/actor.test.ts",
      "apps/edge/src/sql.ts",
      "apps/release-signer/src/index.ts",
      "packages/cli/src/main.ts",
      "docs/architecture/ci-speed.md",
      ".mermaider/manifest.json",
    ]),
    { native: false, workers: true },
  );
});

test("a change to anything the native jobs read runs everything", () => {
  for (const file of [
    "apps/node-agent/src/main.rs",
    "apps/native-gateway/Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "infra/node-image/packages.lock.json",
    "infra/platform/versions.lock.json",
    "packages/contracts/native/generate.ts",
    "packages/contracts/src/edge-sql.ts",
    "scripts/operations/sign-release.ts",
    "scripts/ci/scope.ts",
    ".github/workflows/ci.yml",
    "package.json",
    "pnpm-lock.yaml",
  ]) {
    assert.deepEqual(scopeOf("pull_request", [file]), all, file);
  }
});

test("one path that needs the native jobs among many that do not runs everything", () => {
  const files = [
    ...Array.from({ length: 50 }, (_, i) => `docs/page-${i}.md`),
    ...Array.from({ length: 50 }, (_, i) => `apps/api/src/file-${i}.ts`),
    "apps/node-agent/src/units/ready.rs",
  ];
  assert.deepEqual(scopeOf("pull_request", files), all);
});

test("a path that no rule names, a lookalike prefix, a nested document and an empty change run everything", () => {
  for (const file of [
    "something/new.txt",
    "apps/api-extra/src/index.ts",
    "apps/apifake/index.ts",
    "packages/cli-tools/x.ts",
    "apps/node-agent/README.md",
    "infra/node-image/README.md",
    "documents/page.md",
  ]) {
    assert.deepEqual(scopeOf("pull_request", [file]), all, file);
  }
  assert.deepEqual(scopeOf("pull_request", []), all);
});

const passed = (): Needs => ({
  changes: { result: "success", outputs: { native: "true", workers: "true" } },
  ...Object.fromEntries(
    Object.keys(gatedJobs).map((job) => [job, { result: "success" }]),
  ),
});

test("the gate passes when every job succeeded", () => {
  assert.deepEqual(gateFailures(passed()), []);
});

test("the gate passes a skipped job only when the scope left its part out", () => {
  const narrowed: Needs = {
    ...passed(),
    changes: {
      result: "success",
      outputs: { native: "false", workers: "true" },
    },
    rust: { result: "skipped" },
    kernel: { result: "skipped" },
  };
  assert.deepEqual(gateFailures(narrowed), []);
  // The Workers' part is still in scope: a skipped Workers job is a failure.
  assert.deepEqual(
    gateFailures({ ...narrowed, "api-tests": { result: "skipped" } }),
    ["api-tests: skipped"],
  );
  // A job that is never left out cannot be skipped, whatever the scope says.
  assert.deepEqual(
    gateFailures({
      ...narrowed,
      changes: {
        result: "success",
        outputs: { native: "false", workers: "false" },
      },
      static: { result: "skipped" },
    }),
    ["static: skipped"],
  );
});

test("the gate fails on a failed, cancelled or missing job and on a failed scope", () => {
  assert.deepEqual(gateFailures({ ...passed(), rust: { result: "failure" } }), [
    "rust: failure",
  ]);
  assert.deepEqual(
    gateFailures({ ...passed(), kernel: { result: "cancelled" } }),
    ["kernel: cancelled"],
  );
  const without = passed();
  delete without["edge-tests"];
  assert.deepEqual(gateFailures(without), ["edge-tests: missing"]);
  assert.ok(gateFailures({ ...passed(), changes: { result: "failure" } })[0]);
  // Without the scope's answer a skipped job is not trusted to be left out on purpose.
  assert.deepEqual(
    gateFailures({
      ...passed(),
      changes: { result: "success" },
      rust: { result: "skipped" },
    }),
    ["rust: skipped"],
  );
});
