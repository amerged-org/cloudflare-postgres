// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const { parse: parseYaml } = createRequire(
  new URL("../../apps/node-bootstrap/package.json", import.meta.url),
)("yaml") as { parse(source: string): unknown };

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
  "scripts/ci/image-qualification.ts",
  "scripts/ci/scanner.ts",
  "scripts/ci/registry.ts",
  "scripts/ci/image-profiles.ts",
  "scripts/ci/toolchain.mjs",
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
const nativeSchemaInputs = new Set(
  [
    "protocol",
    "controller",
    "power",
    "measurements",
    "bootstrap",
    "reclaim",
    "compute-pool",
  ].map((name) => `packages/contracts/native/${name}.generated.json`),
);
function rustInputs(path: string, directory: string): boolean {
  return (
    path === `${directory}/Dockerfile` ||
    path === `${directory}/Cargo.toml` ||
    path === `${directory}/build.rs` ||
    (path.startsWith(`${directory}/src/`) && path.endsWith(".rs")) ||
    (path.startsWith(`${directory}/proto/`) && !path.endsWith(".md"))
  );
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
function workflowInputs(change: {
  before: string;
  after: string;
}): ImageInputs {
  if (
    change.before.length > 2 * 1024 * 1024 ||
    change.after.length > 2 * 1024 * 1024
  )
    return all();
  const project = (raw: string) => {
    const workflow = metadataObject(parseYaml(raw)),
      jobs = metadataObject(workflow.jobs);
    return Object.fromEntries(
      Object.keys(imageJobs).map((name) => {
        const job = metadataObject(jobs[name]);
        if (!Array.isArray(job.steps) || job.steps.length > 500)
          throw Error("Image workflow steps unavailable");
        const steps = job.steps
          .map(metadataObject)
          .filter((step) => {
            // Receipt retention and the separately verified installer delivery do not build these images.
            if (
              typeof step.uses === "string" &&
              step.uses.startsWith("actions/upload-artifact@")
            )
              return false;
            return !(
              typeof step.run === "string" &&
              /^printf '%s' "\$GH_TOKEN" \| docker login ghcr\.io --username "\$GITHUB_ACTOR" --password-stdin\nnode scripts\/operations\/publish-talos-installer\.mjs "\$PGCF_TALOS_INSTALLER_RELEASE" "\$RUNNER_TEMP\/[a-zA-Z0-9_/-]+"\s*$/.test(
                step.run,
              )
            );
          })
          .map((step) =>
            Object.fromEntries(
              Object.entries(step).filter(([key]) => key !== "name"),
            ),
          );
        return [
          name,
          canonical({
            global_env: workflow.env,
            global_defaults: workflow.defaults,
            runner: job["runs-on"],
            container: job.container,
            services: job.services,
            defaults: job.defaults,
            env: job.env,
            steps,
          }),
        ];
      }),
    );
  };
  try {
    const before = project(change.before),
      after = project(change.after),
      result = selectImageInputs([], "push");
    for (const [job, flags] of Object.entries(imageJobs))
      if (JSON.stringify(before[job]) !== JSON.stringify(after[job]))
        for (const flag of flags) result[flag] = true;
    return result;
  } catch {
    return all();
  }
}
export function selectImageInputs(
  paths: readonly string[] | null,
  eventName: string,
  workflowChange?: { before: string; after: string },
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
    if (path === ".github/workflows/ci.yml") {
      const affected = workflowChange ? workflowInputs(workflowChange) : all();
      for (const flag of Object.keys(affected) as (keyof ImageInputs)[])
        result[flag] ||= affected[flag];
    }
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
    if (
      [
        "infra/storage/Dockerfile",
        "infra/storage/.dockerignore",
        "infra/storage/sources.lock.json",
        "infra/storage/image.test.mjs",
      ].includes(path)
    )
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
      rustInputs(path, "packages/native-protocol") ||
      nativeSchemaInputs.has(path)
    ) {
      result.rust_gateway = true;
      result.native_controller = true;
      result.rust_bootstrap_relay = true;
      result.native_reclaimer = true;
      result.sandbox_controller = true;
    }
    if (path === ".dockerignore") result.storage = true;
    if (rustInputs(path, "apps/native-gateway")) result.rust_gateway = true;
    if (
      path === "apps/native-gateway/Cargo.toml" ||
      path === "apps/native-gateway/build.rs" ||
      (path.startsWith("apps/native-gateway/src/") &&
        path.endsWith(".rs") &&
        path !== "apps/native-gateway/src/main.rs")
    )
      result.rust_bootstrap_relay = true;
    if (rustInputs(path, "apps/native-bootstrap-relay"))
      result.rust_bootstrap_relay = true;
    if (rustInputs(path, "apps/native-reclaimer"))
      result.native_reclaimer = true;
    if (rustInputs(path, "apps/native-controller"))
      result.native_controller = true;
    if (
      path === "apps/native-controller/Cargo.toml" ||
      path === "apps/native-controller/build.rs" ||
      (path.startsWith("apps/native-controller/src/") &&
        path.endsWith(".rs") &&
        path !== "apps/native-controller/src/main.rs")
    )
      result.native_reclaimer = true;
    if (path === "apps/native-gateway/license-bundle.sh") {
      result.rust_gateway = true;
      result.native_controller = true;
      result.rust_bootstrap_relay = true;
      result.native_reclaimer = true;
      result.sandbox_controller = true;
    }
    if (
      rustInputs(path, "apps/sandbox-controller") ||
      rustInputs(path, "apps/node-runtime") ||
      (path.startsWith("infra/talos/sandbox/") &&
        !path.endsWith(".md") &&
        !path.includes(".test.") &&
        !path.endsWith("/tsconfig.json"))
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
    const paths = text === "" ? [] : text.slice(0, -1).split("\0");
    const workflowChange = paths.includes(".github/workflows/ci.yml")
      ? {
          before: execFileSync(
            "git",
            ["show", `${input.before}:.github/workflows/ci.yml`],
            options,
          ).toString("utf8"),
          after: execFileSync(
            "git",
            ["show", `${input.head}:.github/workflows/ci.yml`],
            options,
          ).toString("utf8"),
        }
      : undefined;
    return selectImageInputs(paths, input.eventName, workflowChange);
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
const imageJobs = {
  image: ["regional"],
  node_bootstrap_image: ["node_bootstrap"],
  postgres_image: ["postgres"],
  storage_image: ["storage"],
  native_runtime_images: [
    "rust_gateway",
    "native_controller",
    "rust_bootstrap_relay",
    "native_reclaimer",
    "sandbox_controller",
  ],
} as const satisfies Record<string, readonly (keyof ImageInputs)[]>;
type ImageJob = keyof typeof imageJobs;
const runtimeProfiles = {
  rust_gateway: "rust-gateway",
  native_controller: "native-controller",
  rust_bootstrap_relay: "rust-bootstrap-relay",
  native_reclaimer: "native-reclaimer",
} as const;
/** One failed image job does not revoke another group's successfully qualified immutable artifacts. */
export async function changedImageInputsFromSuccessfulRun(
  input: SuccessfulRunInputs,
): Promise<{
  baselines: Record<keyof ImageInputs, string | null>;
  inputs: ImageInputs;
}> {
  const groups = Object.keys(imageJobs) as ImageJob[],
    flags = Object.keys(all()) as (keyof ImageInputs)[],
    baselines = Object.fromEntries(flags.map((name) => [name, null])) as Record<
      keyof ImageInputs,
      string | null
    >;
  const result = () => {
    const inputs = all(),
      comparisons = new Map<string, ImageInputs>();
    for (const flag of flags) {
      const baseline = baselines[flag];
      if (baseline === null) continue;
      let comparison = comparisons.get(baseline);
      if (!comparison) {
        comparison = changedImageInputs({
          eventName: input.eventName,
          before: baseline,
          head: input.head,
          cwd: input.cwd,
        });
        comparisons.set(baseline, comparison);
      }
      inputs[flag] = comparison[flag];
    }
    return { baselines, inputs };
  };
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
    return result();
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
      return result();
    const request = input.request ?? fetch,
      deadline = AbortSignal.timeout(30000);
    async function metadata(path: string): Promise<Record<string, unknown>> {
      const response = await request(
        `https://api.github.com/repos/${repository}/${path}`,
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
        throw Error("Image baseline read unavailable");
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024)
          throw Error("Image baseline metadata bound");
        chunks.push(Buffer.from(chunk));
      }
      return metadataObject(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    }
    async function partialRuntimeReceipts(candidate: {
      sha: string;
      id: number;
      attempt: number;
    }) {
      let directory: string | undefined;
      try {
        const envelope = await metadata(
            `actions/runs/${candidate.id}/artifacts?per_page=100`,
          ),
          values = envelope.artifacts;
        if (
          !Array.isArray(values) ||
          values.length > 100 ||
          envelope.total_count !== values.length
        )
          return false;
        const matches = values.filter(
          (raw) =>
            metadataObject(raw).name ===
            `pgcf-native-qualification-${candidate.sha}-${candidate.attempt}`,
        );
        if (matches.length !== 1) return false;
        const artifact = metadataObject(matches[0]),
          run = metadataObject(artifact.workflow_run);
        if (
          !Number.isSafeInteger(artifact.id) ||
          Number(artifact.id) <= 0 ||
          artifact.expired !== false ||
          !Number.isSafeInteger(artifact.size_in_bytes) ||
          Number(artifact.size_in_bytes) <= 0 ||
          Number(artifact.size_in_bytes) > 8 * 1024 * 1024 ||
          typeof artifact.digest !== "string" ||
          !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) ||
          run.id !== candidate.id ||
          run.head_sha !== candidate.sha ||
          run.head_branch !== "main"
        )
          return false;
        let target = `https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`,
          bytes: Buffer | undefined;
        for (let redirects = 0; redirects < 4; redirects++) {
          const response = await request(target, {
            headers:
              redirects === 0
                ? {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${input.token}`,
                    "X-GitHub-Api-Version": "2026-03-10",
                    "User-Agent": "pgcf-image-inputs",
                  }
                : undefined,
            redirect: "manual",
            signal: AbortSignal.any([deadline, AbortSignal.timeout(10000)]),
          });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const next = new URL(
              response.headers.get("location") ?? "",
              target,
            );
            await response.body?.cancel();
            if (
              next.protocol !== "https:" ||
              next.username ||
              next.password ||
              next.hash ||
              !(
                next.hostname.endsWith(".blob.core.windows.net") ||
                next.hostname.endsWith(".actions.githubusercontent.com")
              )
            )
              return false;
            target = next.href;
            continue;
          }
          if (response.status !== 200 || !response.body) return false;
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 8 * 1024 * 1024) return false;
            chunks.push(Buffer.from(chunk));
          }
          bytes = Buffer.concat(chunks);
          break;
        }
        if (
          !bytes ||
          bytes.length !== artifact.size_in_bytes ||
          "sha256:" + createHash("sha256").update(bytes).digest("hex") !==
            artifact.digest
        )
          return false;
        directory = await mkdtemp(join(tmpdir(), "pgcf-image-receipts-"));
        const zip = join(directory, "receipts.zip");
        await writeFile(zip, bytes, { mode: 0o600 });
        const entries = execFileSync("unzip", ["-Z1", zip], {
          timeout: 10000,
          maxBuffer: 1024 * 1024,
          encoding: "utf8",
        })
          .trim()
          .split("\n");
        if (entries.length > 64) return false;
        const read = (profile: string, name: string) => {
          const path = `pgcf-native-image-gate/${profile}/${name}.json`;
          if (entries.filter((value) => value === path).length !== 1)
            throw Error("Native receipt missing");
          return metadataObject(
            JSON.parse(
              execFileSync("unzip", ["-p", zip, path], {
                timeout: 10000,
                maxBuffer: 1024 * 1024,
              }).toString("utf8"),
            ),
          );
        };
        const digest = (v: unknown) =>
            typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v),
          positive = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
        for (const profile of Object.values(runtimeProfiles)) {
          const q = read(profile, "qualification"),
            r = read(profile, "registry");
          if (
            q.version !== 2 ||
            q.profile !== profile ||
            q.revision !== candidate.sha ||
            q.source !== `https://github.com/${repository}` ||
            q.unresolved !== 0 ||
            q.canonicalFindings !== 0 ||
            q.resolved !== 0 ||
            q.rawExit !== 0 ||
            !digest(q.configDigest) ||
            !digest(q.imageId) ||
            !Array.isArray(q.diffIDs) ||
            !q.diffIDs.length ||
            q.diffIDs.length > 128 ||
            !q.diffIDs.every(digest) ||
            q.layers !== q.diffIDs.length ||
            !positive(q.opaqueExpectedBytes) ||
            q.opaqueDetectorBytes !== q.opaqueExpectedBytes ||
            !Array.isArray(q.compiledArtifacts) ||
            !q.compiledArtifacts.length ||
            !q.compiledArtifacts.every((raw) => {
              const binary = metadataObject(raw);
              return (
                typeof binary.path === "string" &&
                binary.path.length > 0 &&
                typeof binary.sha256 === "string" &&
                /^[a-f0-9]{64}$/.test(binary.sha256) &&
                positive(binary.size)
              );
            }) ||
            !digest(r.digest) ||
            !digest(r.manifestDigest) ||
            r.configDigest !== q.configDigest ||
            r.layersVerified !== q.diffIDs.length ||
            !positive(r.compressedBytes) ||
            !positive(r.uncompressedBytes) ||
            ![q.configDigest, r.manifestDigest, r.digest].includes(q.imageId)
          )
            return false;
        }
        return true;
      } catch {
        return false;
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
    const workflow = await metadata("actions/workflows/ci.yml");
    if (
      !Number.isSafeInteger(workflow.id) ||
      Number(workflow.id) <= 0 ||
      workflow.path !== workflowPath
    )
      return result();
    const runs = (
      await metadata(
        "actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=100",
      )
    ).workflow_runs;
    if (!Array.isArray(runs) || runs.length > 100) return result();
    const candidates: {
      sha: string;
      number: number;
      id: number;
      attempt: number;
    }[] = [];
    for (const raw of runs) {
      const run = metadataObject(raw);
      // A partial failed/cancelled run is usable only through its successful check and image job.
      if (
        run.event !== "push" ||
        run.head_branch !== "main" ||
        run.path !== workflowPath ||
        run.workflow_id !== workflow.id ||
        run.status !== "completed" ||
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
        Number(run.id) <= 0 ||
        !Number.isSafeInteger(run.run_attempt) ||
        Number(run.run_attempt) <= 0
      )
        return result();
      candidates.push({
        sha: run.head_sha,
        number: Number(run.run_number),
        id: Number(run.id),
        attempt: Number(run.run_attempt),
      });
    }
    candidates.sort((a, b) => b.number - a.number);
    for (const candidate of candidates) {
      if (flags.every((name) => baselines[name] !== null)) break;
      try {
        execFileSync(
          "git",
          ["merge-base", "--is-ancestor", candidate.sha, input.head],
          options,
        );
      } catch (error) {
        if ((error as { status?: number }).status === 1) continue;
        return result();
      }
      const value = await metadata(
          `actions/runs/${candidate.id}/attempts/${candidate.attempt}/jobs?per_page=100`,
        ),
        jobs = value.jobs;
      if (
        !Array.isArray(jobs) ||
        jobs.length > 100 ||
        value.total_count !== jobs.length
      )
        return result();
      const successful = (name: string) => {
        const matches = jobs.filter((raw) => metadataObject(raw).name === name);
        if (matches.length !== 1) return false;
        const job = metadataObject(matches[0]);
        return (
          job.run_id === candidate.id &&
          // The attempt is bound by the endpoint; this field is absent in documented job replies.
          (job.run_attempt === undefined ||
            job.run_attempt === candidate.attempt) &&
          job.head_sha === candidate.sha &&
          job.status === "completed" &&
          job.conclusion === "success"
        );
      };
      if (!successful("check")) continue;
      for (const name of groups)
        if (successful(name))
          for (const flag of imageJobs[name])
            if (baselines[flag] === null) baselines[flag] = candidate.sha;
      // A failed Native job can retain proved Rust publications, never unfinished OS output.
      const native = jobs.filter(
        (raw) => metadataObject(raw).name === "native_runtime_images",
      );
      if (
        native.length === 1 &&
        !successful("native_runtime_images") &&
        metadataObject(native[0]).status === "completed" &&
        metadataObject(native[0]).run_id === candidate.id &&
        metadataObject(native[0]).head_sha === candidate.sha &&
        (metadataObject(native[0]).run_attempt === undefined ||
          metadataObject(native[0]).run_attempt === candidate.attempt) &&
        ["failure", "cancelled", "timed_out"].includes(
          String(metadataObject(native[0]).conclusion),
        ) &&
        Object.keys(runtimeProfiles).some(
          (flag) => baselines[flag as keyof typeof runtimeProfiles] === null,
        ) &&
        (await partialRuntimeReceipts(candidate))
      )
        for (const flag of Object.keys(
          runtimeProfiles,
        ) as (keyof typeof runtimeProfiles)[])
          if (baselines[flag] === null) baselines[flag] = candidate.sha;
    }
  } catch {
    return result();
  }
  return result();
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
    `Image comparison baselines: ${JSON.stringify(result.baselines)}\n`,
  );
  for (const [name, selected] of Object.entries(result.inputs))
    process.stdout.write(`${name}=${selected}\n`);
}
