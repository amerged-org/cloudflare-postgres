// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const jobs = Object.fromEntries(
  workflow
    .slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length)
    .split(/^ {2}(?=[a-z_-]+:\s*$)/m)
    .filter((job) => job.length > 0)
    .map((job) => [job.slice(0, job.indexOf(":")), job] as const),
);

test("the release key is a secret of the environment release-signing, which only a signing job of main reads", () => {
  // Any pull request or dispatched run of the repository can edit this file and print what a job
  // of its own reads. Only an environment whose deployment branch policy names main withholds a
  // secret from them (docs/operations/release-signing.md creates it), so that no other job may
  // name the secret and the one that does is bound to the environment.
  const readers = Object.entries(jobs).filter(([, job]) =>
    job.includes("secrets.RELEASE_SIGNING_KEY"),
  );
  assert.deepEqual(
    readers.map(([name]) => name),
    ["sign-release"],
  );
  assert.equal(
    workflow.match(/secrets\.RELEASE_SIGNING_KEY/g)?.length,
    1,
    "one step reads the secret",
  );
  const job = jobs["sign-release"]!;
  assert.match(job, /^ {4}environment: release-signing$/m);
  assert.match(job, /^ {4}needs: node-image$/m);
  assert.match(
    job,
    /^ {4}if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && !github\.event\.repository\.fork$/m,
  );
  // Read-only: the checkout and the download of the artifact of this run.
  assert.match(
    job,
    /^ {4}permissions:\n {6}contents: read\n {6}actions: read\n/m,
  );
  // The key is the environment of the one step that signs: no step that installs dependencies or
  // runs build scripts, and no job-level environment, sees it.
  const step = job.slice(job.indexOf("- name: Sign the release"));
  assert.match(
    step,
    /^ {8}env:\n {10}RELEASE_SIGNING_KEY: \$\{\{ secrets\.RELEASE_SIGNING_KEY \}\}$/m,
  );
  assert.ok(
    job.indexOf("pnpm install") < job.indexOf("secrets.RELEASE_SIGNING_KEY"),
  );
  assert.doesNotMatch(job, /^ {4}env:/m);
});

test("the job that builds the release signs nothing and holds no key", () => {
  const build = jobs["node-image"]!;
  assert.doesNotMatch(build, /RELEASE_SIGNING_KEY|sign-release\.ts sign/);
  assert.doesNotMatch(build, /^ {4}environment:/m);
  // The signing job takes the release files from the build job's artifact by id, which survives a
  // re-run of the signing job alone (the artifact's name carries the run attempt).
  assert.match(build, /^ {4}outputs:\n {6}release_artifact_id: .*artifact-id/m);
  assert.match(
    jobs["sign-release"]!,
    /artifact-ids: \$\{\{ needs\.node-image\.outputs\.release_artifact_id \}\}/,
  );
});
