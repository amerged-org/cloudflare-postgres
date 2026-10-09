// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    selectImageInputs(["scripts/ci/image-profiles.ts"], "push"),
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
    selectImageInputs(["infra/postgres/sources.lock.json"], "push"),
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

async function failedPushHistory(
  fixPath = "apps/sandbox-controller/src/host_proc.rs",
) {
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
  await mkdir(dirname(join(cwd, fixPath)), { recursive: true });
  await writeFile(join(cwd, fixPath), "minimal retry fix\n");
  const head = commit();
  return { cwd, qualified, failed, head, git, commit };
}

const workflow = { id: 7, path: ".github/workflows/ci.yml" };
function successfulRun(head: string, number = 1) {
  return {
    id: number,
    run_number: number,
    run_attempt: 1,
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
    const path = String(url);
    if (path.includes("/runs?")) return Response.json({ workflow_runs: rows });
    const match = /\/actions\/runs\/([0-9]+)\/attempts\/([0-9]+)\/jobs/.exec(
      path,
    );
    if (match) {
      const run = rows.find(
        (raw) => (raw as { id?: number }).id === Number(match[1]),
      ) as ReturnType<typeof successfulRun>;
      const jobs = [
        "check",
        "image",
        "node_bootstrap_image",
        "postgres_image",
        "storage_image",
        "native_runtime_images",
      ].map((name) => ({
        name,
        run_id: run.id,
        head_sha: run.head_sha,
        status: "completed",
        conclusion:
          run.conclusion === "success"
            ? "success"
            : name === "check"
              ? "failure"
              : "skipped",
      }));
      return Response.json({ total_count: jobs.length, jobs });
    }
    return Response.json(workflow);
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
    assert.ok(
      Object.values(result.baselines).every(
        (base) => base === history.qualified,
      ),
    );
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
    assert.ok(
      Object.values(unchanged.baselines).every((base) => base === history.head),
    );
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
    assert.ok(
      Object.values(result.baselines).every(
        (base) => base === history.qualified,
      ),
    );
    assert.deepEqual(result.inputs, selectImageInputs(null, "push"));
    const unknown = await changedImageInputsFromSuccessfulRun(
      baselineContext(history, [{ ...good, head_sha: "not-a-commit" }]),
    );
    assert.ok(Object.values(unknown.baselines).every((base) => base === null));
    assert.deepEqual(unknown.inputs, selectImageInputs(null, "push"));
    const unavailable = await changedImageInputsFromSuccessfulRun({
      ...baselineContext(history, [good]),
      request: async () => {
        throw Error("unavailable");
      },
    });
    assert.ok(
      Object.values(unavailable.baselines).every((base) => base === null),
    );
    assert.deepEqual(unavailable.inputs, selectImageInputs(null, "push"));
  } finally {
    await rm(history.cwd, { recursive: true, force: true });
  }
});

test("a partial CI reuses successful image jobs while rebuilding its failed storage group", async () => {
  const history = await failedPushHistory("infra/storage/image.test.mjs");
  try {
    const partial = {
        ...successfulRun(history.failed, 2),
        run_attempt: 1,
        conclusion: "failure",
      },
      good = { ...successfulRun(history.qualified), run_attempt: 1 };
    const context = baselineContext(history, [partial, good]);
    context.request = async (url, init) => {
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer test",
      );
      const path = String(url);
      if (path.includes("/runs?"))
        return Response.json({ workflow_runs: [partial, good] });
      if (path.includes("/jobs")) {
        const run = path.includes("/runs/2/") ? partial : good;
        const jobs = [
          "check",
          "image",
          "node_bootstrap_image",
          "postgres_image",
          "storage_image",
          "native_runtime_images",
        ].map((name) => ({
          id: 10,
          name,
          run_id: run.id,
          run_attempt: 1,
          head_sha: run.head_sha,
          status: "completed",
          conclusion:
            run === partial && name === "storage_image" ? "failure" : "success",
        }));
        return Response.json({ total_count: jobs.length, jobs });
      }
      return Response.json(workflow);
    };
    const result = await changedImageInputsFromSuccessfulRun(context);
    assert.deepEqual(result.inputs, selected({ storage: true }));
    assert.equal(result.baselines.storage, history.qualified);
    assert.equal(result.baselines.native_controller, history.failed);
    const approvedRead = context.request;
    context.request = async (url, init) => {
      const reply = await approvedRead(url, init);
      if (!String(url).includes("/runs/2/") || !String(url).includes("/jobs"))
        return reply;
      const body = (await reply.json()) as {
        total_count: number;
        jobs: { name: string; conclusion: string }[];
      };
      body.jobs.find((job) => job.name === "check")!.conclusion = "failure";
      return Response.json(body);
    };
    const failedCheck = await changedImageInputsFromSuccessfulRun(context);
    assert.ok(
      Object.values(failedCheck.baselines).every(
        (base) => base === history.qualified,
      ),
    );
    assert.deepEqual(failedCheck.inputs, selectImageInputs(null, "push"));
    context.request = approvedRead;
    // Failure to read older storage history preserves the four independently proved groups.
    const read = context.request;
    context.request = async (url, init) => {
      if (String(url).includes("/runs/1/"))
        throw Error("unknown older storage result");
      return read(url, init);
    };
    const unknown = await changedImageInputsFromSuccessfulRun(context);
    assert.equal(unknown.baselines.storage, null);
    assert.deepEqual(unknown.inputs, selected({ storage: true }));
  } finally {
    await rm(history.cwd, { recursive: true, force: true });
  }
});

async function nativeReceiptZip(
  history: Awaited<ReturnType<typeof failedPushHistory>>,
  broken = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-native-receipt-test-")),
    zip = join(directory, "../" + directory.split("/").at(-1) + ".zip"),
    sha = (v: Buffer) => createHash("sha256").update(v).digest("hex");
  try {
    for (const profile of [
      "rust-gateway",
      "native-controller",
      "rust-bootstrap-relay",
      "native-reclaimer",
      "sandbox-controller",
    ]) {
      const path = join(directory, "pgcf-native-image-gate", profile);
      await mkdir(path, { recursive: true });
      const config = "sha256:" + "a".repeat(64),
        q = {
          version: 2,
          profile,
          revision: history.failed,
          source: "https://github.com/example/pgcf",
          configDigest: config,
          imageId: config,
          diffIDs: ["sha256:" + "c".repeat(64)],
          layers: 1,
          opaqueExpectedBytes: 1000,
          opaqueDetectorBytes: 1000,
          unresolved: 0,
          resolved: 0,
          canonicalFindings: 0,
          rawExit: 0,
          compiledArtifacts: [
            { path: "binary", sha256: "e".repeat(64), size: 100 },
          ],
        },
        r = {
          digest: "sha256:" + "b".repeat(64),
          manifestDigest: "sha256:" + "b".repeat(64),
          configDigest:
            broken && profile === "native-reclaimer"
              ? "sha256:" + "f".repeat(64)
              : config,
          layersVerified: 1,
          compressedBytes: 100,
          uncompressedBytes: 1000,
        };
      await writeFile(join(path, "qualification.json"), JSON.stringify(q));
      await writeFile(join(path, "registry.json"), JSON.stringify(r));
    }
    execFileSync("zip", ["-q", "-r", zip, "pgcf-native-image-gate"], {
      cwd: directory,
      timeout: 10000,
    });
    const bytes = await readFile(zip);
    return { bytes, digest: "sha256:" + sha(bytes) };
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(zip, { force: true });
  }
}
test("partial Native receipts reuse exactly four proved runtimes without baselining unfinished Talos output", async () => {
  const history = await failedPushHistory("infra/storage/image.test.mjs");
  try {
    const run = { ...successfulRun(history.failed, 2), conclusion: "failure" },
      archive = await nativeReceiptZip(history);
    const context = baselineContext(history, [run]);
    const request =
      (data: typeof archive): typeof fetch =>
      async (url, init) => {
        const path = String(url);
        if (path.includes("/workflows/ci.yml/runs?"))
          return Response.json({ workflow_runs: [run] });
        if (path.includes("/jobs?")) {
          const jobs = [
            "check",
            "image",
            "node_bootstrap_image",
            "postgres_image",
            "storage_image",
            "native_runtime_images",
          ].map((name) => ({
            name,
            run_id: run.id,
            head_sha: run.head_sha,
            status: "completed",
            conclusion:
              name === "storage_image" || name === "native_runtime_images"
                ? "failure"
                : "success",
          }));
          return Response.json({ total_count: jobs.length, jobs });
        }
        if (path.endsWith("/artifacts?per_page=100"))
          return Response.json({
            total_count: 1,
            artifacts: [
              {
                id: 99,
                name: `pgcf-native-qualification-${run.head_sha}-1`,
                expired: false,
                size_in_bytes: data.bytes.length,
                digest: data.digest,
                workflow_run: {
                  id: run.id,
                  head_sha: run.head_sha,
                  head_branch: "main",
                },
              },
            ],
          });
        if (path.endsWith("/artifacts/99/zip"))
          return new Response(null, {
            status: 302,
            headers: {
              location: "https://test.blob.core.windows.net/receipt.zip",
            },
          });
        if (path === "https://test.blob.core.windows.net/receipt.zip") {
          assert.equal(new Headers(init?.headers).has("authorization"), false);
          return new Response(data.bytes);
        }
        return Response.json(workflow);
      };
    context.request = request(archive);
    const result = await changedImageInputsFromSuccessfulRun(context);
    assert.deepEqual(
      result.inputs,
      selected({ storage: true, sandbox_controller: true }),
    );
    assert.equal(result.baselines.sandbox_controller, null);
    assert.equal(result.baselines.native_controller, history.failed);
    // A mismatched registry/config receipt prevents every partial-runtime baseline.
    context.request = request(await nativeReceiptZip(history, true));
    const unbound = await changedImageInputsFromSuccessfulRun(context);
    assert.deepEqual(
      unbound.inputs,
      selected({
        storage: true,
        rust_gateway: true,
        native_controller: true,
        rust_bootstrap_relay: true,
        native_reclaimer: true,
        sandbox_controller: true,
      }),
    );
  } finally {
    await rm(history.cwd, { recursive: true, force: true });
  }
});
