// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";

export interface ImageInputs {
  regional: boolean;
  node_bootstrap: boolean;
  postgres: boolean;
}
const all = (): ImageInputs => ({
  regional: true,
  node_bootstrap: true,
  postgres: true,
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
if (import.meta.main) {
  const result = changedImageInputs({
    eventName: process.env.GITHUB_EVENT_NAME ?? "",
    before: process.env.PGCF_IMAGE_BEFORE,
    head: process.env.GITHUB_SHA,
  });
  for (const [name, selected] of Object.entries(result))
    process.stdout.write(`${name}=${selected}\n`);
}
