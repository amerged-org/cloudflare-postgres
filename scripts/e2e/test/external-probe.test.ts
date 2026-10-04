// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import {
  assertExternalReport,
  assertProbeProvenance,
  cidrPoolsDisjoint,
  consumeExternalProbe,
  keyedHash,
  nativeTcp,
  parseProbeConfig,
  probeReport,
  sourcePool,
  externalProbeFailure,
} from "../src/external-probe.ts";
import type { ProbeIo } from "../src/external-probe.ts";
import { Run } from "../src/run.ts";
import { fingerprint } from "../src/core.ts";

const host4 = (...octets: number[]) => octets.join(".");
const host6 = (value: number) => `${value.toString(16)}::1`;

test("fixed metadata fetch can authenticate while anonymous non-success remains refused", async () => {
  const token = randomBytes(32).toString("base64url");
  const pool = [`${host4(203, 0, 113, 0)}/24`];
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.github.com/meta");
    assert.equal(options?.redirect, "error");
    assert(options?.signal instanceof AbortSignal);
    const authenticated =
      new Headers(options?.headers).get("Authorization") === `Bearer ${token}`;
    return authenticated
      ? Response.json({ actions_macos: pool })
      : new Response(token, { status: 403 });
  };
  await assert.rejects(sourcePool({}, fetcher), {
    message: "external_probe_source_pool_unavailable",
  });
  assert.deepEqual(await sourcePool({ GH_TOKEN: token }, fetcher), pool);
  assert.equal(calls, 2);
});

test("source pool errors retain numeric HTTP status without body, headers or credentials", async () => {
  const token = randomBytes(32).toString("base64url");
  let cancelled = 0;
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      }),
      { status: 401, headers: { "x-untrusted-detail": token } },
    );
  };
  await assert.rejects(
    sourcePool({ GH_TOKEN: token }, fetcher),
    (error: unknown) => {
      assert.deepEqual(externalProbeFailure(error), {
        external_probe_report: false,
        code: "external_probe_source_pool_unavailable",
        http_status: 401,
      });
      assert.equal(String(error).includes(token), false);
      assert.equal(
        JSON.stringify(externalProbeFailure(error)).includes(token),
        false,
      );
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
});

test("metadata redirects and fetch failures remain refused without secret diagnostics", async () => {
  const token = randomBytes(32).toString("base64url");
  const redirect: typeof fetch = async (url, options) => {
    assert.equal(url, "https://api.github.com/meta");
    assert.equal(options?.redirect, "error");
    return new Response(token, {
      status: 307,
      headers: {
        Location: `https://${["elsewhere", "test"].join(".")}/${token}`,
      },
    });
  };
  await assert.rejects(
    sourcePool({ GH_TOKEN: token }, redirect),
    (error: unknown) => {
      assert.deepEqual(externalProbeFailure(error), {
        external_probe_report: false,
        code: "external_probe_source_pool_unavailable",
        http_status: 307,
      });
      assert.equal(String(error).includes(token), false);
      return true;
    },
  );
  const refused: typeof fetch = async (_url, options) => {
    assert.equal(options?.redirect, "error");
    throw new Error(token);
  };
  await assert.rejects(
    sourcePool({ GH_TOKEN: token }, refused),
    (error: unknown) => {
      assert.deepEqual(externalProbeFailure(error), {
        external_probe_report: false,
        code: "external_probe_source_pool_unavailable",
      });
      assert.equal(String(error).includes(token), false);
      return true;
    },
  );
});

test("metadata byte limits, malformed JSON and IPv4 source-pool validation remain strict", async () => {
  const oversized: typeof fetch = async () =>
    new Response(" ".repeat(1_000_001));
  await assert.rejects(sourcePool({}, oversized), {
    message: "external_probe_source_pool_invalid",
  });
  const token = randomBytes(32).toString("base64url");
  const malformed: typeof fetch = async () => new Response(token);
  await assert.rejects(
    sourcePool({ GH_TOKEN: token }, malformed),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "external_probe_source_pool_invalid" &&
      !String(error).includes(token),
  );
  const wrongFamily: typeof fetch = async () =>
    Response.json({ actions_macos: [`${host6(0x2001)}/64`] });
  await assert.rejects(sourcePool({}, wrongFamily), {
    message: "external_probe_source_pool_invalid",
  });
  const malformedCidr: typeof fetch = async () =>
    Response.json({ actions_macos: ["invalid"] });
  await assert.rejects(sourcePool({}, malformedCidr));
});
const now = Date.now();
function input() {
  return {
    version: 1,
    nonce: randomBytes(32).toString("hex"),
    salt: randomBytes(32).toString("base64url"),
    created_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 1_200_000).toISOString(),
    targets: [host4(11, 1, 2, 3), host6(0x2001)],
    control: host4(12, 1, 2, 3),
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

test("a loopback TCP control cannot prove public SMTP egress", () => {
  assert.throws(() =>
    parseProbeConfig(
      JSON.stringify({ ...input(), control: host4(127, 0, 0, 1) }),
      now,
    ),
  );
});

test("a private TCP control cannot prove public SMTP egress", () => {
  assert.throws(() =>
    parseProbeConfig(
      JSON.stringify({ ...input(), control: host4(10, 1, 2, 3) }),
      now,
    ),
  );
});

test("a link-local TCP control cannot prove public SMTP egress", () => {
  assert.throws(() =>
    parseProbeConfig(
      JSON.stringify({ ...input(), control: host4(169, 254, 1, 2) }),
      now,
    ),
  );
});

test("a reserved TCP control cannot prove public SMTP egress", () => {
  assert.throws(() =>
    parseProbeConfig(
      JSON.stringify({ ...input(), control: host4(198, 18, 1, 2) }),
      now,
    ),
  );
  assert.throws(() =>
    parseProbeConfig(
      JSON.stringify({ ...input(), control: host4(224, 0, 1, 2) }),
      now,
    ),
  );
  assert.throws(() =>
    parseProbeConfig(
      JSON.stringify({ ...input(), control: host4(100, 64, 1, 2) }),
      now,
    ),
  );
});

test("a private target cannot produce a public firewall proof", () => {
  assert.throws(() =>
    parseProbeConfig(
      JSON.stringify({ ...input(), targets: [host4(192, 168, 1, 2)] }),
      now,
    ),
  );
});

test("a report cannot bypass public target validation with a documentation address", () => {
  const { config, pool, report } = fixture();
  config.targets[0] = host4(203, 0, 113, 2);
  report.results[0]!.target_hash = keyedHash(
    config,
    "target",
    config.targets[0],
  );
  assert.throws(() =>
    assertExternalReport(
      report,
      config,
      pool,
      context,
      config.operator_allowlist,
      config.targets,
      now + 5,
    ),
  );
});

test("IANA globally reachable anycast exceptions remain valid public addresses", () => {
  assert.doesNotThrow(() =>
    parseProbeConfig(
      JSON.stringify({
        ...input(),
        control: host4(192, 0, 0, 9),
        targets: [host4(192, 0, 0, 10)],
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

async function consumerFixture(t: TestContext, targets: string[]) {
  const config = parseProbeConfig(JSON.stringify({ ...input(), targets }));
  const pool = [`${host4(203, 0, 113, 0)}/24`];
  const instant = Date.now();
  const report = probeReport(config, pool, context, instant - 5);
  for (const row of report.results) {
    if (!row.native_source_proven) continue;
    row.before = {
      state: "connected",
      at: new Date(instant - 4).toISOString(),
    };
    row.target = { state: "refused", at: new Date(instant - 3).toISOString() };
    row.after = { state: "connected", at: new Date(instant - 2).toISOString() };
  }
  report.finished_at = new Date(instant - 1).toISOString();
  const raw = `  ${JSON.stringify(report, null, 2)}\n`;
  let signedDigest = createHash("sha256").update(raw).digest("hex");
  const root = await mkdtemp(resolve(tmpdir(), "pgcf-e6-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = resolve(root, ".local/evidence/phase1/pgcf-e6-native.json");
  await mkdir(resolve(root, ".local/evidence/phase1"), { recursive: true });
  await writeFile(path, raw);
  let verifications = 0;
  const io: ProbeIo = {
    sourcePool: async () => pool,
    command: async (program, args) => {
      if (program === "git") {
        if (args[0] === "rev-parse") {
          assert.deepEqual(args, ["rev-parse", "HEAD"]);
          return `${context.commit}\n`;
        }
        assert.deepEqual(args, ["symbolic-ref", "HEAD"]);
        return "refs/heads/main\n";
      }
      assert.equal(program, "gh");
      if (args[0] === "attestation") {
        verifications++;
        assert.equal(args[2], path);
        assert(args.includes("--deny-self-hosted-runners"));
        assert(args.includes("--source-digest"));
        assert(args.includes(context.commit));
        assert(args.includes("refs/heads/main"));
        assert(args.includes(`${context.repository}/.github/workflows/ci.yml`));
        return JSON.stringify([
          {
            verificationResult: {
              signature: {
                certificate: {
                  issuer: "https://token.actions.githubusercontent.com",
                  subjectAlternativeName: `https://github.com/${context.repository}/.github/workflows/ci.yml@refs/heads/main`,
                  sourceRepositoryURI: `https://github.com/${context.repository}`,
                  sourceRepositoryDigest: context.commit,
                  sourceRepositoryRef: "refs/heads/main",
                  runnerEnvironment: "github-hosted",
                  buildTrigger: "workflow_dispatch",
                  runInvocationURI: `https://github.com/${context.repository}/actions/runs/${context.run_id}/attempts/${context.run_attempt}`,
                  sourceRepositoryVisibilityAtSigning: "public",
                },
              },
              statement: { subject: [{ digest: { sha256: signedDigest } }] },
              verifiedTimestamps: [
                { timestamp: new Date(instant).toISOString() },
              ],
            },
          },
        ]);
      }
      assert.equal(args[0], "api");
      if (args.at(-1)?.endsWith("/artifacts")) {
        assert.equal(
          args.at(-1),
          `repos/${context.repository}/actions/runs/${context.run_id}/artifacts`,
        );
        return JSON.stringify({
          artifacts: [{ name: "pgcf-e6-native", expired: false }],
        });
      }
      assert.equal(
        args.at(-1),
        `repos/${context.repository}/actions/runs/${context.run_id}`,
      );
      return JSON.stringify({
        event: "workflow_dispatch",
        head_branch: "main",
        head_sha: context.commit,
        path: ".github/workflows/ci.yml",
        run_attempt: Number(context.run_attempt),
        status: "completed",
        conclusion: "success",
      });
    },
  };
  const env = {
    PGCF_E2E_EXTERNAL_PROBE_CONFIG: JSON.stringify(config),
    PGCF_E2E_EXTERNAL_PROBE_EXPECTATION: JSON.stringify({
      ...context,
      nonce: config.nonce,
    }),
    PGCF_E2E_OPERATOR_ALLOWLIST: JSON.stringify(config.operator_allowlist),
  };
  return {
    root,
    env,
    io,
    report,
    path,
    consume: () => consumeExternalProbe(root, targets, env, io),
    verifications: () => verifications,
    useReserializedDigest: () => {
      signedDigest = createHash("sha256")
        .update(JSON.stringify(JSON.parse(raw)))
        .digest("hex");
    },
    replaceReport: async () => {
      const bytes = `  ${JSON.stringify(report, null, 2)}\n`;
      signedDigest = createHash("sha256").update(bytes).digest("hex");
      await writeFile(path, bytes);
    },
  };
}

test("actual consumer verifies the raw signed JSON bytes including whitespace and its trailing newline", async (t) => {
  const target = host4(11, 1, 2, 3);
  const fixture = await consumerFixture(t, [target]);
  assert.deepEqual(await fixture.consume(), new Set([target]));
  assert.equal(fixture.verifications(), 1);
});

test("actual consumer rejects a signature digest for reserialized JSON instead of its raw file bytes", async (t) => {
  const fixture = await consumerFixture(t, [host4(11, 1, 2, 3)]);
  fixture.useReserializedDigest();
  await assert.rejects(fixture.consume(), {
    message: "external_probe_attestation_mismatch",
  });
  assert.equal(fixture.verifications(), 1);
});

function resumedScan(
  targets: string[],
  proof: () => Promise<Set<string>>,
): Run {
  const names = targets.map((_, index) => `pgcf-node-${index}`);
  return Object.assign(Object.create(Run.prototype) as Run, {
    c: { values: { PGCF_E2E_REGIONAL_NAMESPACE: "pgcf-system" } },
    state: {
      completed: ["E5"],
      scans: targets.map((host, index) =>
        fingerprint(`${names[index]}:${host}`),
      ),
      operator_scans: [],
      scan_ranges: {},
    },
    assertCluster: async () => undefined,
    kube: {
      read: async (resource: string) =>
        resource === "nodes"
          ? {
              items: targets.map((host, index) => ({
                metadata: { name: names[index] },
                status: { addresses: [{ type: "ExternalIP", address: host }] },
              })),
            }
          : { items: [] },
    },
    nativeProof: proof,
    save: async () => undefined,
    emit: async () => undefined,
  });
}

test("resumed Run.scan cannot complete E6 when a target lacks native coverage", async (t) => {
  const targets = [host4(11, 1, 2, 3), host4(13, 1, 2, 3)];
  const fixture = await consumerFixture(t, targets);
  fixture.report.results[1]!.after.state = "inconclusive";
  await fixture.replaceReport();
  const run = resumedScan(targets, fixture.consume);
  await assert.rejects(run.scan(), {
    message: "supplemental_external_tcp_probe_required",
  });
  assert.deepEqual(run.state.completed, ["E5"]);
});

test("resumed Run.scan cannot complete E6 while IPv6 remains inconclusive", async (t) => {
  const targets = [host4(11, 1, 2, 3), host6(0x2001)];
  const fixture = await consumerFixture(t, targets);
  const run = resumedScan(targets, fixture.consume);
  await assert.rejects(run.scan(), {
    message: "supplemental_external_tcp_probe_required",
  });
  assert.deepEqual(run.state.completed, ["E5"]);
});

test("resumed Run.scan completes E6 only after the actual consumer covers every current target", async (t) => {
  const targets = [host4(11, 1, 2, 3), host4(13, 1, 2, 3)];
  const fixture = await consumerFixture(t, targets);
  const run = resumedScan(targets, fixture.consume);
  assert.equal(await run.scan(), true);
  assert.deepEqual(run.state.completed, ["E5", "E6"]);
  assert.equal(fixture.verifications(), 1);
});
