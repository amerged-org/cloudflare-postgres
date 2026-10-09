// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";

export interface ImageInputs {
  regional: boolean;
  node_bootstrap: boolean;
  postgres: boolean;
  storage: boolean;
  rust_gateway: boolean;
  native_controller: boolean;
  rust_bootstrap_relay: boolean;
  native_reclaimer: boolean;
  sandbox_controller: boolean;
}
const all = (): ImageInputs => ({
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
// Explicit inputs copied by the two repository-root Dockerfiles.
const sharedNodeInputs = new Set([
  ".dockerignore",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "LICENSE",
  "apps/api/package.json",
  "apps/edge/package.json",
  "apps/regional/package.json",
  "apps/node-bootstrap/package.json",
  "scripts/e2e/package.json",
  "infra/platform/versions.lock.json",
  "infra/platform/openebs-image.ts",
]);
// These also govern qualification of PostgreSQL, despite not entering its image filesystem.
const sharedQualificationInputs = new Set([
  "package.json",
  "pnpm-lock.yaml",
  ".github/workflows/ci.yml",
  "scripts/ci/image-qualification.ts",
  "scripts/ci/scanner.ts",
  "scripts/ci/registry.ts",
  "scripts/ci/reviewed-findings.ts",
  "scripts/ci/reviewed-findings.json",
]);
const nativeInputs = new Set([
  "apps/node-bootstrap/Dockerfile",
  "apps/node-bootstrap/tsconfig.json",
  "infra/talos/publish-storage-capacity.ts",
  "infra/platform/base/values/cilium.yaml",
  "infra/platform/image-manifest.ts",
  "infra/storage/sources.lock.json",
  "infra/talos/sandbox/runtime-admission.ts",
  "scripts/e2e/src/node-network-native.ts",
  "scripts/e2e/src/node-network-packets.ts",
]);
const postgresInputs = new Set([
  "infra/postgres/Dockerfile",
  "infra/postgres/.dockerignore",
  "infra/postgres/sources.lock.json",
  "infra/postgres/image.test.mjs",
  "scripts/ci/postgres-reviewed-findings.json",
]);
function validPath(path: string): boolean {
  return (
    !!path &&
    !/[\\\p{C}]/u.test(path) &&
    !path.startsWith("/") &&
    !path
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  );
}
export function selectImageInputs(
  paths: readonly string[] | null,
  eventName: string,
): ImageInputs {
  if (
    eventName !== "push" ||
    paths === null ||
    paths.length > 10000 ||
    paths.some((path) => !validPath(path))
  )
    return all();
  const result: ImageInputs = {
    regional: false,
    node_bootstrap: false,
    postgres: false,
    storage: false,
    rust_gateway: false,
    native_controller: false,
    rust_bootstrap_relay: false,
    native_reclaimer: false,
    sandbox_controller: false,
  };
  for (const path of paths) {
    if (sharedQualificationInputs.has(path)) return all();
    if (sharedNodeInputs.has(path) || path.startsWith("packages/contracts/")) {
      result.regional = true;
      result.node_bootstrap = true;
    }
    if (
      path === "apps/regional/Dockerfile" ||
      path === "apps/regional/tsconfig.json" ||
      path.startsWith("apps/regional/src/")
    )
      result.regional = true;
    if (
      nativeInputs.has(path) ||
      path.startsWith("apps/node-bootstrap/src/") ||
      path.startsWith("apps/node-bootstrap/assets/")
    )
      result.node_bootstrap = true;
    if (postgresInputs.has(path)) result.postgres = true;
    if (path.startsWith("infra/storage/")) result.storage = true;
    if (path === "scripts/ci/storage-reviewed-findings.json")
      result.storage = true;
    if (
      [
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
        "LICENSE",
        ".dockerignore",
        "infra/platform/versions.lock.json",
      ].includes(path) ||
      path.startsWith("packages/native-protocol/") ||
      path.startsWith("packages/contracts/native/")
    ) {
      result.rust_gateway = true;
      result.native_controller = true;
      result.rust_bootstrap_relay = true;
      result.native_reclaimer = true;
      result.sandbox_controller = true;
    }
    if (path === ".dockerignore") result.storage = true;
    if (path.startsWith("apps/native-gateway/")) result.rust_gateway = true;
    if (
      path === "apps/native-gateway/Cargo.toml" ||
      path === "apps/native-gateway/build.rs" ||
      (path.startsWith("apps/native-gateway/src/") &&
        path !== "apps/native-gateway/src/main.rs")
    )
      result.rust_bootstrap_relay = true;
    if (path.startsWith("apps/native-bootstrap-relay/"))
      result.rust_bootstrap_relay = true;
    if (path.startsWith("apps/native-reclaimer/"))
      result.native_reclaimer = true;
    if (path.startsWith("apps/native-controller/"))
      result.native_controller = true;
    if (
      path === "apps/native-controller/Cargo.toml" ||
      path === "apps/native-controller/build.rs" ||
      (path.startsWith("apps/native-controller/src/") &&
        path !== "apps/native-controller/src/main.rs")
    )
      result.native_reclaimer = true;
    if (path === "apps/native-gateway/license-bundle.sh") {
      result.native_controller = true;
      result.rust_bootstrap_relay = true;
      result.native_reclaimer = true;
      result.sandbox_controller = true;
    }
    if (
      path.startsWith("apps/sandbox-controller/") ||
      path.startsWith("apps/node-runtime/") ||
      path.startsWith("infra/talos/sandbox/") ||
      path === "scripts/ci/talos-reviewed-findings.json"
    )
      result.sandbox_controller = true;
  }
  return result;
}
/** Git's tracked-tree comparison includes both sides of moves; no untracked or private files are scanned. */
export function changedImageInputs(input: {
  eventName: string;
  before?: string;
  head?: string;
  cwd?: string;
}): ImageInputs {
  const sha = /^[0-9a-f]{40}$/i;
  if (
    input.eventName !== "push" ||
    !input.before ||
    !input.head ||
    !sha.test(input.before) ||
    !sha.test(input.head) ||
    /^0{40}$/.test(input.before) ||
    /^0{40}$/.test(input.head)
  )
    return all();
  const options = {
    cwd: input.cwd ?? process.cwd(),
    timeout: 10000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  };
  try {
    const current = execFileSync(
      "git",
      ["rev-parse", "--verify", "HEAD"],
      options,
    )
      .toString("utf8")
      .trim();
    if (current.toLowerCase() !== input.head.toLowerCase()) return all();
    const bytes = execFileSync(
      "git",
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--name-only",
        "-z",
        input.before,
        input.head,
        "--",
      ],
      options,
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text !== "" && !text.endsWith("\0")) return all();
    return selectImageInputs(
      text === "" ? [] : text.slice(0, -1).split("\0"),
      input.eventName,
    );
  } catch {
    return all();
  }
}
interface SuccessfulRunInputs {
  eventName: string;
  head?: string;
  ref?: string;
  repository?: string;
  workflowRef?: string;
  runId?: string;
  token?: string;
  cwd?: string;
  request?: typeof fetch;
}
const workflowPath = ".github/workflows/ci.yml";
function metadataObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Image baseline metadata unavailable");
  return value as Record<string, unknown>;
}
/** Failed pushes publish no complete artifact set, so event.before is not an image baseline. */
export async function changedImageInputsFromSuccessfulRun(
  input: SuccessfulRunInputs,
): Promise<{ baseline: string | null; inputs: ImageInputs }> {
  const unknown = () => ({ baseline: null, inputs: all() });
  const repository = input.repository;
  if (
    input.eventName !== "push" ||
    input.ref !== "refs/heads/main" ||
    !repository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    input.workflowRef !== `${repository}/${workflowPath}@refs/heads/main` ||
    !input.head ||
    !/^[a-f0-9]{40}$/i.test(input.head) ||
    /^0{40}$/.test(input.head) ||
    !input.runId ||
    !/^[1-9][0-9]*$/.test(input.runId) ||
    !input.token
  )
    return unknown();
  const options = {
    cwd: input.cwd ?? process.cwd(),
    timeout: 10000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  };
  try {
    if (
      execFileSync("git", ["rev-parse", "--verify", "HEAD"], options)
        .toString()
        .trim()
        .toLowerCase() !== input.head.toLowerCase()
    )
      return unknown();
    const request = input.request ?? fetch,
      deadline = AbortSignal.timeout(20000);
    async function metadata(suffix: string): Promise<Record<string, unknown>> {
      const response = await request(
        `https://api.github.com/repos/${repository}/actions/workflows/ci.yml${suffix}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${input.token}`,
            "X-GitHub-Api-Version": "2026-03-10",
            "User-Agent": "pgcf-image-inputs",
          },
          redirect: "error",
          signal: AbortSignal.any([deadline, AbortSignal.timeout(10000)]),
        },
      );
      if (response.status !== 200 || !response.body)
        throw new Error("Image baseline read unavailable");
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024)
          throw new Error("Image baseline metadata bound");
        chunks.push(Buffer.from(chunk));
      }
      return metadataObject(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    }
    const workflow = await metadata("");
    if (
      !Number.isSafeInteger(workflow.id) ||
      Number(workflow.id) <= 0 ||
      workflow.path !== workflowPath
    )
      return unknown();
    const runs = (
      await metadata("/runs?branch=main&event=push&status=success&per_page=100")
    ).workflow_runs;
    if (!Array.isArray(runs) || runs.length > 100) return unknown();
    const candidates: { sha: string; number: number }[] = [];
    for (const raw of runs) {
      const run = metadataObject(raw);
      // Explicitly exclude supplemental dispatch, forks, other branches and other workflows.
      if (
        run.event !== "push" ||
        run.head_branch !== "main" ||
        run.path !== workflowPath ||
        run.workflow_id !== workflow.id ||
        run.status !== "completed" ||
        run.conclusion !== "success" ||
        metadataObject(run.repository).full_name !== repository ||
        metadataObject(run.head_repository).full_name !== repository ||
        String(run.id) === input.runId
      )
        continue;
      if (
        typeof run.head_sha !== "string" ||
        !/^[a-f0-9]{40}$/i.test(run.head_sha) ||
        /^0{40}$/.test(run.head_sha) ||
        !Number.isSafeInteger(run.run_number) ||
        Number(run.run_number) <= 0 ||
        !Number.isSafeInteger(run.id) ||
        Number(run.id) <= 0
      )
        return unknown();
      candidates.push({ sha: run.head_sha, number: Number(run.run_number) });
    }
    candidates.sort((a, b) => b.number - a.number);
    for (const candidate of candidates) {
      try {
        execFileSync(
          "git",
          ["merge-base", "--is-ancestor", candidate.sha, input.head],
          options,
        );
      } catch (error) {
        if ((error as { status?: number }).status === 1) continue;
        return unknown();
      }
      return {
        baseline: candidate.sha,
        inputs: changedImageInputs({
          eventName: input.eventName,
          before: candidate.sha,
          head: input.head,
          cwd: input.cwd,
        }),
      };
    }
  } catch {
    return unknown();
  }
  return unknown();
}
if (import.meta.main) {
  const result = await changedImageInputsFromSuccessfulRun({
    eventName: process.env.GITHUB_EVENT_NAME ?? "",
    head: process.env.GITHUB_SHA,
    ref: process.env.GITHUB_REF,
    repository: process.env.GITHUB_REPOSITORY,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    runId: process.env.GITHUB_RUN_ID,
    token: process.env.GH_TOKEN,
  });
  process.stderr.write(
    `Image comparison baseline: ${result.baseline ?? "unknown; all artifacts selected"}\n`,
  );
  for (const [name, selected] of Object.entries(result.inputs))
    process.stdout.write(`${name}=${selected}\n`);
}
