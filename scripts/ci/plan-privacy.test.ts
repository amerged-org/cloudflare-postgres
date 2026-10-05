// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkPlanPrivacy } from "./plan-privacy.ts";

const quantity = () => randomInt(401, 899);

test("rejects a named adopter's quantified project, branch, database and role inventory", () => {
  const text = `A read-only ohmyho.st inventory contains ${quantity()} projects,\n${quantity()} branches, ${quantity()} databases and ${quantity()} roles.`;
  const findings = checkPlanPrivacy(text);
  assert.deepEqual(findings, [{ line: 1, code: "adopter_numeric_inventory" }]);
  assert.ok(!JSON.stringify(findings).includes(text));
});

test("attributes following version, location and size sentences to their inventory paragraph", () => {
  const text = `The adopter's existing inventory was inspected.\nIts engine is PostgreSQL ${randomInt(11, 31)}.\nThe footprint is ${quantity()} GiB split across ${quantity()} EU and ${quantity()} US databases.`;
  assert.equal(checkPlanPrivacy(text).length, 1);
  const version = `An ohmyhost inventory was sampled. Its engine version is PostgreSQL ${randomInt(11, 31)}.`;
  assert.equal(checkPlanPrivacy(version).length, 1);
  const size = `An adopter dataset was inspected. Its total payload is ${quantity()} bytes.`;
  assert.equal(checkPlanPrivacy(size).length, 1);
});

test("rejects inventory labels followed by counts and table quantities", () => {
  const text = `Ohmyhost's catalog: projects=${quantity()}; branches=${quantity()}; roles=${quantity()}.\nIt includes ${quantity()} application tables.`;
  assert.equal(checkPlanPrivacy(text).length, 1);
  assert.equal(
    checkPlanPrivacy("An adopter currently has zero live databases.").length,
    1,
  );
});

test("future migration wording does not turn current inventory counts into a generic goal", () => {
  const text = `The adopter inventory was read. It currently has ${quantity()} branches; migration will follow.`;
  assert.equal(checkPlanPrivacy(text).length, 1);
});

test("allows generic scale goals and a statement that private inventory remains pending", () => {
  assert.deepEqual(
    checkPlanPrivacy(
      "The goal is 1,000 future customers before adopter migration.",
    ),
    [],
  );
  assert.deepEqual(
    checkPlanPrivacy(
      "Private ohmyho.st inventory remains pending. The platform goal is 1,000 future customers.",
    ),
    [],
  );
  assert.deepEqual(
    checkPlanPrivacy(
      "An adopter can create 1,000 databases as a synthetic scale goal.",
    ),
    [],
  );
});

test("allows generic latency, operator prices and load acceptance measurements", () => {
  const text = `Ohmyhost compatibility work remains pending. Generic latency was ${quantity()} ms at p95.\nThe operator infrastructure price is EUR ${quantity()} per month.\nA load acceptance run used ${quantity()} synthetic tables, transferred ${quantity()} MiB and delivered ${quantity()} SQL/s over ${quantity()} clients.`;
  assert.deepEqual(checkPlanPrivacy(text), []);
  assert.deepEqual(
    checkPlanPrivacy(
      `Private adopter inventory is pending. A COPY acceptance stream verified ${quantity()} MiB.`,
    ),
    [],
  );
  assert.deepEqual(
    checkPlanPrivacy(
      `The public endpoint db.ohmyho.st passed ${quantity()} database trials.`,
    ),
    [],
  );
});

test("keeps attribution inside a paragraph and returns locations without private content", () => {
  const text = `Adopter compatibility remains pending.\n\nThe synthetic platform test created ${quantity()} databases.\n\nOhmyhost currently has ${quantity()} branches.`;
  assert.deepEqual(checkPlanPrivacy(text), [
    { line: 5, code: "adopter_numeric_inventory" },
  ]);
});

test("a later adopter mention cannot attribute earlier operator measurements", () => {
  const text = `The operator exercised ${quantity()} databases and recorded ${quantity()} bytes. Adopter compatibility remains pending.`;
  assert.deepEqual(checkPlanPrivacy(text), []);
});

test("distinct roadmap list items do not inherit adopter attribution", () => {
  const text = `- An adopter can migrate later as a future goal.\n- The operator platform test created ${quantity()} databases.\n- Private ohmyhost inventory remains pending.`;
  assert.deepEqual(checkPlanPrivacy(text), []);
});

test("CLI refuses inventory with count-only output and hides read errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-plan-privacy-"));
  const path = join(directory, "synthetic-plan.txt"),
    marker = randomUUID();
  const text = `Adopter ${marker} currently has ${quantity()} databases and ${quantity()} roles.`;
  try {
    await writeFile(path, text, { mode: 0o600 });
    const run = (file: string) =>
      spawnSync(
        process.execPath,
        [
          "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
          resolve("scripts/ci/plan-privacy.ts"),
          file,
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: { ...process.env, NODE_OPTIONS: "", NODE_DEBUG: "" },
        },
      );
    const refused = run(path);
    assert.equal(refused.status, 1);
    assert.deepEqual(JSON.parse(refused.stdout), {
      event: "plan_privacy",
      findings: 1,
    });
    assert.ok(
      !refused.stdout.includes(marker) && !refused.stderr.includes(marker),
    );
    assert.ok(!refused.stdout.includes(text) && !refused.stderr.includes(text));
    const missing = run(join(directory, marker));
    assert.equal(missing.status, 1);
    assert.deepEqual(JSON.parse(missing.stderr), {
      event: "plan_privacy_failed",
    });
    assert.ok(!missing.stderr.includes(marker));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
