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
const signer = await readFile(
  new URL("../../apps/release-signer/wrangler.jsonc", import.meta.url),
  "utf8",
);
/** The lines of a YAML text that are not comments. */
const code = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

test("the signing job holds no secret: it proves itself to the signer with its run's identity token", () => {
  // A secret of the repository is handed to any branch's workflow, and the key is not a secret of
  // GitHub at all: it is the signer Worker's, which nobody can read. No job names it, and the
  // signing job names no secret of any kind and no environment.
  assert.doesNotMatch(code(workflow), /RELEASE_SIGNING_KEY/);
  const job = code(jobs["sign-release"]!);
  assert.doesNotMatch(job, /secrets\./);
  assert.doesNotMatch(job, /^ {4}environment:/m);
  assert.doesNotMatch(job, /GH_TOKEN|github\.token/);
  assert.match(job, /^ {4}needs: node-image$/m);
  assert.match(
    job,
    /^ {4}if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && !github\.event\.repository\.fork$/m,
  );
  // The checkout, the download of this run's artifact and the identity token, and nothing else.
  assert.match(
    job,
    /^ {4}permissions:\n {6}contents: read\n {6}actions: read\n {6}id-token: write\n {4}steps:/m,
  );
  // The signer's address is a variable of the repository (an origin; it is no secret) that only the
  // signing step reads.
  assert.equal(workflow.match(/vars\.RELEASE_SIGNER_URL/g)?.length, 1);
  const step = job.slice(job.indexOf("- name: Sign the release"));
  assert.match(
    step,
    /^ {8}env:\n {10}RELEASE_SIGNER_URL: \$\{\{ vars\.RELEASE_SIGNER_URL \}\}\n {8}run: \|\n/m,
  );
  assert.match(step, /node scripts\/operations\/sign-release\.ts sign /);
  // No dependency runs a script while the job holds the credential for the token, and the install
  // is before the step that signs.
  assert.match(job, /pnpm install --frozen-lockfile --ignore-scripts$/m);
  assert.ok(job.indexOf("pnpm install") < job.indexOf("sign-release.ts sign"));
});

test("a push to main is never signed by skipping: nothing in the signing job can pass over its signing step", () => {
  const job = code(jobs["sign-release"]!);
  // The one condition is the job's own (a push to main of this repository, not of a fork); a step
  // that is conditional, or may fail without failing the job, could leave a release unsigned and green.
  assert.equal(job.match(/^ +if:/gm)?.length, 1);
  assert.doesNotMatch(job, /continue-on-error|\|\| *(true|:)|set \+e/);
  // The step fails when the signer's address is missing, when it cannot be reached, when it refuses,
  // and while the committed key is the placeholder: sign-release.ts's tests, which run in this
  // workflow's `check` job, say so.
  assert.ok(
    job.indexOf("Sign the release") < job.indexOf("Keep the signature"),
  );
  assert.match(job, /if-no-files-found: error/);
});

test("only two jobs may request an identity token, and the one that is not the signing job runs only on a dispatch, which the signer refuses", () => {
  assert.doesNotMatch(
    code(workflow.slice(0, workflow.indexOf("\njobs:\n"))),
    /id-token/,
    "the workflow's own permissions grant none",
  );
  const holders = Object.entries(jobs).filter(([, job]) =>
    /id-token/.test(code(job)),
  );
  // `external_probe` attests its sanitized report (`actions/attest`, which needs the grant). It runs
  // only for a dispatched run, and the identity token of a dispatched run says `event_name:
  // workflow_dispatch`, which the signer does not accept: only a push signs.
  assert.deepEqual(
    holders.map(([name]) => name),
    ["external_probe", "sign-release"],
  );
  assert.match(
    code(jobs["external_probe"]!),
    /^ {4}if: github\.event_name == 'workflow_dispatch' && /m,
  );
  assert.equal(code(workflow).match(/id-token: write/g)?.length, 2);
  const build = code(jobs["node-image"]!);
  assert.doesNotMatch(build, /sign-release\.ts sign|RELEASE_SIGNER_URL/);
  assert.doesNotMatch(build, /^ {4}environment:/m);
  // The signing job takes the release files from the build job's artifact by id, which survives a
  // re-run of the signing job alone (the artifact's name carries the run attempt).
  assert.match(build, /^ {4}outputs:\n {6}release_artifact_id: .*artifact-id/m);
  assert.match(
    jobs["sign-release"]!,
    /artifact-ids: \$\{\{ needs\.node-image\.outputs\.release_artifact_id \}\}/,
  );
});

test("what the signer requires of a caller is what this workflow is: the one file, the ref, and the release name of its commit", () => {
  // The signer's variables name the workflow file and the ref that the job runs at.
  assert.match(signer, /"SIGNER_WORKFLOW": "\.github\/workflows\/ci\.yml"/);
  assert.match(signer, /"SIGNER_REF": "refs\/heads\/main"/);
  assert.match(jobs["sign-release"]!, /github\.ref == 'refs\/heads\/main'/);
  // The signer signs only `sha-<first 12 digits of the commit>`, the name this job's build gives its release.
  assert.match(jobs["node-image"]!, /--release "sha-\$\{GITHUB_SHA::12\}"/);
  // The configuration is tracked, so it holds nothing private: no account, no secret, no zone.
  assert.doesNotMatch(
    signer.replace(/\/\/.*$/gm, ""),
    /account_id|RELEASE_SIGNING_KEY|secret|zone|route|d1_|r2_|kv_|\bservices\b|durable|queues|"ai"/i,
  );
});
