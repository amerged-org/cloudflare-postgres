// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { gatedJobs } from "./scope.ts";

const root = new URL("../../", import.meta.url).pathname;
const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
const jobs = Object.fromEntries(
  workflow
    .slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length)
    .split(/^ {2}(?=[a-z_-]+:\s*$)/m)
    .filter((job) => job.length > 0)
    .map((job) => [job.slice(0, job.indexOf(":")), job] as const),
);
const code = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

test("the gate waits for the scope and for exactly the jobs that check the code", () => {
  const needs = /^ {4}needs: \[(.*)\]$/m.exec(jobs["check"]!)?.[1];
  assert.ok(needs, "the gate lists its needs on one line");
  assert.deepEqual(
    needs.split(", ").sort(),
    ["changes", ...Object.keys(gatedJobs)].sort(),
  );
  // It runs also when a part failed, which is when it must say so, but not when the run was
  // cancelled or the scope itself was skipped (a schedule, or a dispatch of another job).
  assert.match(
    jobs["check"]!,
    /^ {4}if: \$\{\{ !cancelled\(\) && needs\.changes\.result != 'skipped' \}\}$/m,
  );
  for (const job of Object.keys(gatedJobs)) {
    assert.ok(jobs[job], `the gate waits for the job ${job}, which exists`);
    assert.match(code(jobs[job]!), /^ {4}needs: changes$/m, job);
  }
});

test("a job that the scope can leave out runs exactly when its part of the scope is true", () => {
  const parts: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(gatedJobs).filter(([, part]) => part !== null),
    ),
    "node-image": "native",
  };
  for (const [job, part] of Object.entries(parts)) {
    assert.match(
      code(jobs[job]!),
      new RegExp(
        `^ {4}if: needs\\.changes\\.outputs\\.${part} == 'true'$`,
        "m",
      ),
      job,
    );
  }
  // The jobs that always run for a change have no condition of their own.
  for (const job of Object.entries(gatedJobs)
    .filter(([, part]) => part === null)
    .map(([name]) => name)) {
    assert.doesNotMatch(code(jobs[job]!), /^ {4}if:/m, job);
  }
});

test("every package that has a test script is tested by name in exactly one job", () => {
  const packages: string[] = [];
  for (const directory of ["apps", "packages", "scripts"]) {
    for (const name of readdirSync(join(root, directory))) {
      const file = join(root, directory, name, "package.json");
      if (!existsSync(file)) continue;
      const manifest = JSON.parse(readFileSync(file, "utf8")) as {
        name: string;
        scripts?: { test?: string };
      };
      if (manifest.scripts?.test) packages.push(manifest.name);
    }
  }
  assert.ok(packages.length >= 6, "the workspace's packages are found");
  for (const name of packages) {
    const holders = Object.entries(jobs).filter(([, job]) =>
      code(job).includes(`pnpm --filter ${name} test\n`),
    );
    assert.equal(
      holders.length,
      1,
      `${name} is tested by name in ${holders.length} jobs`,
    );
  }
  // The root's own `test` script runs every package in turn; no job may run it, or a package
  // would be tested twice and the split would buy nothing.
  assert.doesNotMatch(code(workflow), /run: pnpm test$/m);
});

test("the Rust Edge Worker is built and tested in the same job that keeps its bytes", () => {
  const job = code(jobs["edge-tests"]!);
  const built = job.indexOf("pnpm --filter @pgcf/edge-rust build");
  const tested = job.indexOf("pnpm --filter @pgcf/edge-rust test");
  const kept = job.indexOf("name: pgcf-rust-edge-");
  assert.ok(built >= 0 && tested > built && kept > tested);
});

test("the Rust cache feeds verdicts only: a pull request restores it, only main saves it, and the shipped builds restore none", () => {
  const rust = code(jobs["rust"]!);
  assert.match(rust, /uses: actions\/cache\/restore@[0-9a-f]{40} # v/);
  assert.match(
    rust,
    /if: success\(\) && github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && steps\.rust_cache\.outputs\.cache-hit != 'true'\n {8}uses: actions\/cache\/save@/,
  );
  assert.doesNotMatch(rust, /uses: actions\/cache@/);
  // The node binaries that `sign-release` signs and the Edge Worker bytes that are kept compile
  // from nothing: no cache of compiled output reaches them.
  for (const job of ["node-image", "edge-tests", "sign-release"]) {
    assert.doesNotMatch(code(jobs[job]!), /actions\/cache/, job);
  }
});
