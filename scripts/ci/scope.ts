// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * What a change needs from CI. `native` is the Rust crates, the node agent's kernel test and the
 * node image; `workers` is the tests of the API and of the Rust Edge Worker, which runs the API's
 * code. Everything else (the static checks and the tests of the packages) runs for every change.
 */
export interface Scope {
  native: boolean;
  workers: boolean;
}

export interface Needs {
  [job: string]: { result?: string; outputs?: Record<string, string> };
}

/**
 * The jobs the gate `check` waits for, and the part of the scope that may leave each one out
 * (`null`: never left out). The workflow's `check.needs` is this list and `changes`; a test says so.
 */
export const gatedJobs: Readonly<Record<string, keyof Scope | null>> = {
  static: null,
  "other-tests": null,
  rust: "native",
  kernel: "native",
  "edge-tests": "workers",
  "api-tests": "workers",
};

/** Documents that no test of the native or Workers jobs reads: the top level's and `docs/`. */
const documents = /^(?:docs\/|[^/]+\.md$)/;
/** TypeScript apps that no Rust crate, no image build and no native test reads. */
const workerApps = /^(?:apps\/(?:api|edge|release-signer)\/|packages\/cli\/)/;

const everything: Scope = { native: true, workers: true };

/**
 * The scope of a change. Only a pull request is ever narrowed: a push to main, which `sign-release`
 * signs, and every other event run everything. A path that no rule names, and an empty list, run
 * everything too, so a rule that is missing costs time and never a check.
 */
export function scopeOf(event: string, files: readonly string[]): Scope {
  if (event !== "pull_request" || files.length === 0) return everything;
  if (files.every((file) => documents.test(file)))
    return { native: false, workers: false };
  if (files.every((file) => documents.test(file) || workerApps.test(file)))
    return { native: false, workers: true };
  return everything;
}

/**
 * Why the gate must fail, empty when it may pass. A job counts as passed when it succeeded, or when
 * it was skipped and `changes` said its part of the scope was left out; any other skip is a failure.
 */
export function gateFailures(needs: Needs): string[] {
  const failures: string[] = [];
  const changes = needs["changes"];
  if (changes?.result !== "success")
    failures.push(`changes: ${changes?.result ?? "missing"}`);
  for (const [job, part] of Object.entries(gatedJobs)) {
    const result = needs[job]?.result ?? "missing";
    if (result === "success") continue;
    if (
      result === "skipped" &&
      part !== null &&
      changes?.outputs?.[part] === "false"
    )
      continue;
    failures.push(`${job}: ${result}`);
  }
  return failures;
}

/** The files a pull request changes: the checkout is the merge commit, whose first parent is the base. */
function changedFiles(): string[] {
  const names = execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", "HEAD^1", "HEAD"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return names.split("\0").filter((name) => name.length > 0);
}

function main(): void {
  const command = process.argv[2];
  if (process.argv.length !== 3) throw new Error("invalid_arguments");
  if (command === "scope") {
    const event = process.env["GITHUB_EVENT_NAME"] ?? "";
    const scope = scopeOf(
      event,
      event === "pull_request" ? changedFiles() : [],
    );
    console.error(JSON.stringify({ event: "ci_scope", ...scope }));
    console.log(`native=${scope.native}\nworkers=${scope.workers}`);
  } else if (command === "gate") {
    const failures = gateFailures(
      JSON.parse(process.env["NEEDS"] ?? "{}") as Needs,
    );
    console.error(JSON.stringify({ event: "ci_gate", failures }));
    process.exitCode = failures.length > 0 ? 1 : 0;
  } else {
    throw new Error("invalid_arguments");
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main();
  } catch {
    console.error(JSON.stringify({ event: "ci_scope_failed" }));
    process.exitCode = 1;
  }
}
