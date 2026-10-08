// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { changedImageInputs, selectImageInputs } from "./image-inputs.ts";

test("management-only changes skip images while exact Native and Regional build inputs select their image", () => {
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
    { regional: false, node_bootstrap: false, postgres: false },
  );
  assert.deepEqual(
    selectImageInputs(
      [
        "apps/node-bootstrap/src/postjoin-proof.ts",
        "scripts/e2e/src/node-network-packets.ts",
      ],
      "push",
    ),
    { regional: false, node_bootstrap: true, postgres: false },
  );
  assert.deepEqual(
    selectImageInputs(["apps/regional/src/agent/loop.ts"], "push"),
    { regional: true, node_bootstrap: false, postgres: false },
  );
});
test("common Docker inputs and qualification changes invalidate every affected profile", () => {
  assert.deepEqual(
    selectImageInputs(["scripts/ci/reviewed-findings.json"], "push"),
    { regional: true, node_bootstrap: true, postgres: true },
  );
  assert.deepEqual(
    selectImageInputs(["infra/platform/versions.lock.json"], "push"),
    { regional: true, node_bootstrap: true, postgres: false },
  );
  assert.deepEqual(
    selectImageInputs(["packages/contracts/src/releases.ts"], "push"),
    { regional: true, node_bootstrap: true, postgres: false },
  );
  assert.deepEqual(selectImageInputs(["apps/api/package.json"], "push"), {
    regional: true,
    node_bootstrap: true,
    postgres: false,
  });
  assert.deepEqual(selectImageInputs(["pnpm-lock.yaml"], "push"), {
    regional: true,
    node_bootstrap: true,
    postgres: true,
  });
  assert.deepEqual(
    selectImageInputs(
      ["scripts/ci/image-qualification.ts", ".github/workflows/ci.yml"],
      "push",
    ),
    { regional: true, node_bootstrap: true, postgres: true },
  );
});
test("PostgreSQL inputs stay scoped and manual, unavailable or malformed comparisons conservatively select all", () => {
  const all = { regional: true, node_bootstrap: true, postgres: true };
  assert.deepEqual(
    selectImageInputs(
      [
        "infra/postgres/sources.lock.json",
        "scripts/ci/postgres-reviewed-findings.json",
      ],
      "push",
    ),
    { regional: false, node_bootstrap: false, postgres: true },
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
    { regional: false, node_bootstrap: false, postgres: false },
  );
});
