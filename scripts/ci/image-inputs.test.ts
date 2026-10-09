// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  changedImageInputs,
  changedImageInputsFromSuccessfulRun,
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

async function failedPushHistory() {
  const cwd = await mkdtemp(join(tmpdir(), "pgcf-image-baseline-"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
      {
        cwd,
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "PGCF test",
          GIT_AUTHOR_EMAIL: "test@example.invalid",
          GIT_COMMITTER_NAME: "PGCF test",
          GIT_COMMITTER_EMAIL: "test@example.invalid",
        },
      },
    ).trim();
  git("init", "--quiet", "--initial-branch=main");
  const commit = () => {
    git("add", "--all");
    git("commit", "--quiet", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  await writeFile(join(cwd, "pnpm-lock.yaml"), "qualified inputs\n");
  const qualified = commit();
  await writeFile(
    join(cwd, "pnpm-lock.yaml"),
    "changed but unpublished inputs\n",
  );
  const failed = commit();
  await mkdir(join(cwd, "apps/sandbox-controller/src"), { recursive: true });
  await writeFile(
    join(cwd, "apps/sandbox-controller/src/host_proc.rs"),
    "minimal retry fix\n",
  );
  const head = commit();
  return { cwd, qualified, failed, head, git, commit };
}

const workflow = { id: 7, path: ".github/workflows/ci.yml" };
function successfulRun(head: string, number = 1) {
  return {
    id: number,
    run_number: number,
    workflow_id: workflow.id,
    path: workflow.path,
    event: "push",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
    head_sha: head,
    repository: { full_name: "example/pgcf" },
    head_repository: { full_name: "example/pgcf" },
  };
}
function baselineContext(
  history: Awaited<ReturnType<typeof failedPushHistory>>,
  rows: unknown[],
  head = history.head,
) {
  const request: typeof fetch = async (url, init) => {
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer test",
    );
    assert.equal(init?.redirect, "error");
    return Response.json(
      String(url).endsWith(
        "/runs?branch=main&event=push&status=success&per_page=100",
      )
        ? { workflow_runs: rows }
        : workflow,
    );
  };
  return {
    eventName: "push",
    head,
    ref: "refs/heads/main",
    repository: "example/pgcf",
    workflowRef: "example/pgcf/.github/workflows/ci.yml@refs/heads/main",
    runId: "1000",
    token: "test",
    cwd: history.cwd,
    request,
  };
}
test("a failed previous push is never the artifact baseline for its minimal correction", async () => {
  const history = await failedPushHistory();
  try {
    const result = await changedImageInputsFromSuccessfulRun(
      baselineContext(history, [
        { ...successfulRun(history.failed, 3), conclusion: "failure" },
        { ...successfulRun(history.failed, 2), event: "workflow_dispatch" },
        successfulRun(history.qualified),
      ]),
    );
    assert.equal(result.baseline, history.qualified);
    assert.deepEqual(result.inputs, selectImageInputs(null, "push"));
    // Once those artifacts have a successful push CI, an API-only follow-up reuses them.
    await mkdir(join(history.cwd, "apps/api/src"), { recursive: true });
    await writeFile(
      join(history.cwd, "apps/api/src/index.ts"),
      "management change\n",
    );
    const next = history.commit();
    const unchanged = await changedImageInputsFromSuccessfulRun(
      baselineContext(history, [successfulRun(history.head, 4)], next),
    );
    assert.equal(unchanged.baseline, history.head);
    assert.deepEqual(unchanged.inputs, selected());
  } finally {
    await rm(history.cwd, { recursive: true, force: true });
  }
});
test("unrelated workflow history cannot establish a baseline and unknown metadata fails closed", async () => {
  const history = await failedPushHistory();
  try {
    history.git("checkout", "--quiet", "-b", "unrelated", history.qualified);
    await writeFile(join(history.cwd, "different"), "not an ancestor\n");
    const unrelated = history.commit();
    history.git("checkout", "--quiet", "main");
    const good = successfulRun(history.qualified);
    const result = await changedImageInputsFromSuccessfulRun(
      baselineContext(history, [
        { ...successfulRun(history.failed, 5), workflow_id: 99 },
        { ...successfulRun(history.failed, 4), head_branch: "other" },
        {
          ...successfulRun(history.failed, 3),
          head_repository: { full_name: "fork/pgcf" },
        },
        successfulRun(unrelated, 2),
        good,
      ]),
    );
    assert.equal(result.baseline, history.qualified);
    assert.deepEqual(result.inputs, selectImageInputs(null, "push"));
    const unknown = await changedImageInputsFromSuccessfulRun(
      baselineContext(history, [{ ...good, head_sha: "not-a-commit" }]),
    );
    assert.equal(unknown.baseline, null);
    assert.deepEqual(unknown.inputs, selectImageInputs(null, "push"));
    const unavailable = await changedImageInputsFromSuccessfulRun({
      ...baselineContext(history, [good]),
      request: async () => {
        throw Error("unavailable");
      },
    });
    assert.equal(unavailable.baseline, null);
    assert.deepEqual(unavailable.inputs, selectImageInputs(null, "push"));
  } finally {
    await rm(history.cwd, { recursive: true, force: true });
  }
});
