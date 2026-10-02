// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";
import {
  assertExternalReport,
  assertProbeProvenance,
  cidrPoolsDisjoint,
  consumeExternalProbe,
  keyedHash,
  nativeTcp,
  parseProbeConfig,
  probeReport,
} from "../src/external-probe.ts";

const host4 = (...octets: number[]) => octets.join(".");
const host6 = (value: number) => `${value.toString(16)}::1`;
const now = Date.now();
function input() {
  return {
    version: 1,
    nonce: randomBytes(32).toString("hex"),
    salt: randomBytes(32).toString("base64url"),
    created_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 1_200_000).toISOString(),
    targets: [host4(198, 18, 0, 10), host6(0x2001)],
    control: host4(198, 19, 0, 10),
    operator_allowlist: [`${host4(198, 18, 1, 0)}/24`, `${host6(0x2001)}/64`],
    operator_allowlist_complete: true,
  };
}
const context = {
  repository: ["pgcf", "test"].join("/"),
  commit: randomBytes(20).toString("hex"),
  run_id: String(BigInt(`0x${randomBytes(8).toString("hex")}`) + 1n),
  run_attempt: "1",
};
function fixture() {
  const config = parseProbeConfig(JSON.stringify(input()), now);
  const pool = [`${host4(203, 0, 113, 0)}/24`];
  const report = probeReport(config, pool, context, now);
  report.results[0]!.before = {
    state: "connected",
    at: new Date(now).toISOString(),
  };
  report.results[0]!.target = {
    state: "timed_out",
    at: new Date(now + 1).toISOString(),
  };
  report.results[0]!.after = {
    state: "connected",
    at: new Date(now + 2).toISOString(),
  };
  report.finished_at = new Date(now + 3).toISOString();
  return { config, pool, report };
}

test("native TCP reports a real connection and refusal and refuses mapped IPv6", async () => {
  const host = host4(127, 0, 0, 1);
  const server = createServer((socket) => socket.end());
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  assert.equal(await nativeTcp(host, address.port, 1000), "connected");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await nativeTcp(host, address.port, 1000), "refused");
  assert.equal(
    await nativeTcp(`::ffff:${host}`, address.port, 1000),
    "inconclusive",
  );
});

test("source proof checks the whole allowlist and rejects overlapping, mapped and malformed ranges", () => {
  const pool = [`${host4(203, 0, 113, 0)}/24`];
  assert.equal(cidrPoolsDisjoint(pool, [`${host4(198, 18, 1, 0)}/24`]), true);
  assert.equal(
    cidrPoolsDisjoint(pool, [
      `${host4(198, 18, 1, 0)}/24`,
      `${host4(203, 0, 113, 7)}/32`,
    ]),
    false,
  );
  assert.equal(
    cidrPoolsDisjoint([`${host6(0x2001)}/48`], [`${host6(0x2001)}/64`]),
    false,
  );
  assert.throws(() => cidrPoolsDisjoint(pool, []));
  assert.throws(() =>
    cidrPoolsDisjoint([`::ffff:${host4(203, 0, 113, 7)}/128`], pool),
  );
  assert.throws(() => cidrPoolsDisjoint(pool, ["invalid"]));
});

test("secret configuration expires and cannot omit the authoritative allowlist", () => {
  const value = input();
  assert.throws(() =>
    parseProbeConfig(
      JSON.stringify({ ...value, expires_at: new Date(now - 1).toISOString() }),
      now,
    ),
  );
  assert.throws(() =>
    parseProbeConfig(
      JSON.stringify({ ...value, operator_allowlist_complete: false }),
      now,
    ),
  );
  assert.throws(() =>
    parseProbeConfig(JSON.stringify({ ...value, operator_allowlist: [] }), now),
  );
  assert.throws(() =>
    parseProbeConfig(
      JSON.stringify({
        ...value,
        targets: [`::ffff:${host4(198, 18, 0, 10)}`],
      }),
      now,
    ),
  );
});

test("operator consumption refuses missing evidence configuration before accessing files or provider tools", async () => {
  await assert.rejects(consumeExternalProbe(".", [], {}), {
    message: "supplemental_external_tcp_probe_required",
  });
});

test("only a fresh nonce-bound report with both TCP controls closes the IPv4 gap; IPv6 stays open", () => {
  const { config, pool, report } = fixture();
  assert.deepEqual(
    assertExternalReport(
      report,
      config,
      pool,
      context,
      config.operator_allowlist,
      config.targets,
      now + 5,
    ),
    [config.targets[0]],
  );
  const missingControl = structuredClone(report);
  missingControl.results[0]!.after.state = "refused";
  assert.deepEqual(
    assertExternalReport(
      missingControl,
      config,
      pool,
      context,
      config.operator_allowlist,
      config.targets,
      now + 5,
    ),
    [],
  );
  const open = structuredClone(report);
  open.results[0]!.target.state = "connected";
  assert.throws(() =>
    assertExternalReport(
      open,
      config,
      pool,
      context,
      config.operator_allowlist,
      config.targets,
      now + 5,
    ),
  );
  const wrongNonce = structuredClone(report);
  wrongNonce.nonce = randomBytes(32).toString("hex");
  assert.throws(() =>
    assertExternalReport(
      wrongNonce,
      config,
      pool,
      context,
      config.operator_allowlist,
      config.targets,
      now + 5,
    ),
  );
  assert.throws(() =>
    assertExternalReport(
      report,
      config,
      pool,
      context,
      [`${host4(203, 0, 113, 7)}/32`],
      config.targets,
      now + 5,
    ),
  );
  assert.throws(() =>
    assertExternalReport(
      report,
      config,
      pool,
      context,
      config.operator_allowlist,
      config.targets,
      now + 901_000,
    ),
  );
  const mapped = structuredClone(report);
  mapped.results[1]!.family = 4;
  assert.throws(() =>
    assertExternalReport(
      mapped,
      config,
      pool,
      context,
      config.operator_allowlist,
      config.targets,
      now + 5,
    ),
  );
});

test("public report contains keyed hashes and raw states without disclosing configuration or infrastructure", () => {
  const { config, report } = fixture();
  const serialized = JSON.stringify(report);
  for (const secret of [
    ...config.targets,
    config.control,
    ...config.operator_allowlist,
    config.salt,
    context.repository,
    context.run_id,
    context.commit,
  ])
    assert(!serialized.includes(secret));
  assert(serialized.includes(config.nonce));
  assert.notEqual(
    keyedHash(config, "target", config.targets[0]!),
    keyedHash(config, "control", config.targets[0]!),
  );
  assert.notEqual(
    keyedHash(config, "target", config.targets[0]!),
    keyedHash(
      parseProbeConfig(JSON.stringify(input()), now),
      "target",
      config.targets[0]!,
    ),
  );
});

test("attestation policy binds the trusted certificate to the exact hosted main workflow run, not a mutable predicate", () => {
  const certificate = {
    issuer: "https://token.actions.githubusercontent.com",
    subjectAlternativeName: `https://github.com/${context.repository}/.github/workflows/ci.yml@refs/heads/main`,
    sourceRepositoryURI: `https://github.com/${context.repository}`,
    sourceRepositoryDigest: context.commit,
    sourceRepositoryRef: "refs/heads/main",
    runnerEnvironment: "github-hosted",
    buildTrigger: "workflow_dispatch",
    runInvocationURI: `https://github.com/${context.repository}/actions/runs/${context.run_id}/attempts/${context.run_attempt}`,
    sourceRepositoryVisibilityAtSigning: "public",
  };
  const digest = createHash("sha256").update(randomBytes(32)).digest("hex");
  const result = [
    {
      verificationResult: {
        signature: { certificate },
        statement: { subject: [{ digest: { sha256: digest } }] },
        verifiedTimestamps: [{ timestamp: new Date(now).toISOString() }],
      },
    },
  ];
  assert.doesNotThrow(() => assertProbeProvenance(result, context, digest));
  assert.throws(() =>
    assertProbeProvenance(result, context, randomBytes(32).toString("hex")),
  );
  const otherRun = structuredClone(result);
  otherRun[0]!.verificationResult.signature.certificate.runInvocationURI += "0";
  assert.throws(() => assertProbeProvenance(otherRun, context, digest));
  const otherRef = structuredClone(result);
  otherRef[0]!.verificationResult.signature.certificate.sourceRepositoryRef =
    "refs/heads/other";
  assert.throws(() => assertProbeProvenance(otherRef, context, digest));
  const otherCommit = structuredClone(result);
  otherCommit[0]!.verificationResult.signature.certificate.sourceRepositoryDigest =
    randomBytes(20).toString("hex");
  assert.throws(() => assertProbeProvenance(otherCommit, context, digest));
  const selfHosted = structuredClone(result);
  selfHosted[0]!.verificationResult.signature.certificate.runnerEnvironment =
    "self-hosted";
  assert.throws(() => assertProbeProvenance(selfHosted, context, digest));
  assert.throws(() =>
    assertProbeProvenance(
      [{ verificationResult: { statement: { predicate: certificate } } }],
      context,
      digest,
    ),
  );
});
