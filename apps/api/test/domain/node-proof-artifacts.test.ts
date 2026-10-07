// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { bytesToBase64url } from "@pgcf/contracts";
import {
  NodeProofReport,
  canonicalNodeProof,
  type NodeProofReport as Report,
} from "@pgcf/contracts/node-proof";
import * as network from "../../src/domain/node-network.ts";
import {
  canonicalNodePreparationProof,
  NODE_PREPARATION_SIGNATURE_DOMAIN,
  nodePreparationProofSchema,
} from "../../src/domain/node-network.ts";
import {
  issueNodeProofSession,
  authenticateNodeProofSession,
  signNodeProofDocument,
} from "../../src/domain/node-proof-session.ts";
import { acceptNodeProofReport } from "../../src/domain/node-proof-artifacts.ts";
import { ensureNodePreparationProof } from "../../src/domain/node-proof.ts";
import { installationHash } from "../../src/domain/node-installation.ts";
import { boundInstallationFixture } from "./installation-fixtures.ts";
import { cleanupFixtures } from "./fixtures.ts";

const regions: string[] = [],
  operations: string[] = [];
const utf8 = new TextEncoder();
const hashText = async (value: string) => {
  const raw = await crypto.subtle.digest("SHA-256", utf8.encode(value));
  return [...new Uint8Array(raw)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
};
const hashBinding = (value: Report["binding"]) =>
  hashText(canonicalNodeProof(value));
const nonce = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
afterEach(async () => {
  vi.restoreAllMocks();
  for (const op of operations.splice(0)) {
    await env.ARCHIVE.delete(`node-preparation/${op}/proof.json`);
    const listed = await env.ARCHIVE.list({
      prefix: `node-proof-history/${op}/`,
    });
    for (const object of listed.objects) await env.ARCHIVE.delete(object.key);
  }
  for (const region of regions.splice(0))
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM node_installation_bindings WHERE region_id=?",
      ).bind(region),
      env.DB.prepare(
        "DELETE FROM node_installation_profiles WHERE region_id=?",
      ).bind(region),
    ]);
  await cleanupFixtures();
});

async function fixture() {
  const f = await boundInstallationFixture();
  regions.push(f.fixture.region);
  operations.push(f.addition.intent.operation_id);
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("fixture_signer_invalid");
  const secret = await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    pub = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(secret instanceof ArrayBuffer) || !(pub instanceof ArrayBuffer))
    throw new Error("fixture_signer_invalid");
  f.bindings.BOOTSTRAP_RELAY_SIGNING_KEYS = JSON.stringify({
    active: "automation",
    keys: { automation: bytesToBase64url(new Uint8Array(secret)) },
  });
  f.bindings.BOOTSTRAP_VERIFIER_KEYS = JSON.stringify({
    automation: bytesToBase64url(new Uint8Array(pub)),
  });
  const rule = {
    protocol: "tcp",
    destPorts: ["22", "50000", "6443"],
    srcCidr: { ipv4: [`${f.relay.ipConfig.v4.ip}/32`], ipv6: [] },
    action: "accept",
    status: "active",
  };
  const plan = {
    version: 1,
    operation_id: f.addition.intent.operation_id,
    node_id: f.addition.intent.node_id,
    region_id: f.fixture.region,
    provider_instance_id: f.providerId,
    intent_hash: f.addition.intent_hash,
    operators: { ipv4: ["1.1.1.1/32"], ipv6: [] },
    relay: {
      provider_instance_id: f.relay.id,
      addresses: { ipv4: [f.relay.ipConfig.v4.ip], ipv6: [] },
    },
    scan_control: { ipv4: "9.9.9.9", ipv6: "2606:4700:4700::1111", port: 443 },
    members: [
      {
        node_id: f.addition.intent.node_id,
        provider_instance_id: f.providerId,
        addresses: { ipv4: [f.actual.ipConfig.v4.ip], ipv6: [] },
        primary: { ipv4: [f.actual.ipConfig.v4.ip], ipv6: [] },
        firewall_id: crypto.randomUUID(),
        ownership_sha256: await installationHash([
          f.actual.tenantId,
          f.actual.customerId,
        ]),
        rules: { rules: { inbound: [rule] } },
        rules_sha256: await installationHash([rule]),
      },
    ],
  };
  const now = Date.now(),
    at = (offset: number) => new Date(now + offset).toISOString(),
    readback = at(-900_000),
    planHash = await installationHash(plan);
  await env.DB.prepare(
    "DELETE FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(f.addition.intent.operation_id)
    .run();
  await env.DB.prepare(
    "INSERT INTO node_network_preparations(operation_id,intent_hash,plan_sha256,plan_json,status,readback_at,created_at,updated_at) VALUES(?,?,?,?,'awaiting_proof',?,?,?)",
  )
    .bind(
      f.addition.intent.operation_id,
      f.addition.intent_hash,
      planHash,
      JSON.stringify(plan),
      readback,
      readback,
      readback,
    )
    .run();
  const binding = {
      plan_sha256: planHash,
      readback_at: readback,
      verification: null,
    },
    bindingHash = await hashBinding(binding);
  const report = NodeProofReport.parse({
    binding,
    postjoin: null,
    measurements: [
      {
        purpose: "pgcf-node-measurement/v1",
        binding_sha256: bindingHash,
        kind: "access",
        observed_at: at(0),
        access: [
          {
            provider_instance_id: f.providerId,
            address: f.actual.ipConfig.v4.ip,
            relay_source: f.relay.ipConfig.v4.ip,
            observed_at: at(-500),
            checks: [
              { port: 22, outcome: "connected" },
              { port: 50000, outcome: "refused" },
              { port: 6443, outcome: "refused" },
            ],
          },
        ],
      },
      {
        purpose: "pgcf-node-measurement/v1",
        binding_sha256: bindingHash,
        kind: "scan",
        family: "ipv4",
        source: "8.8.4.4",
        observed_at: at(0),
        scans: [
          {
            provider_instance_id: f.providerId,
            address: f.actual.ipConfig.v4.ip,
            protocol: "tcp",
            first_port: 1,
            last_port: 65535,
            scanned_ports: 65535,
            open_ports: [],
            started_at: at(-8_000),
            observed_at: at(-1_000),
            before: {
              address: plan.scan_control.ipv4,
              port: 443,
              source: "8.8.4.4",
              observed_at: at(-10_000),
              nonce: nonce(),
            },
            after: {
              address: plan.scan_control.ipv4,
              port: 443,
              source: "8.8.4.4",
              observed_at: at(-1_000),
              nonce: nonce(),
            },
          },
        ],
      },
    ],
  });
  const session = await issueNodeProofSession(
    f.bindings,
    f.addition.intent.operation_id,
    "preparation",
  );
  const firewall = vi
      .spyOn(network, "ensureNodeFirewall")
      .mockResolvedValue(true),
    verify = vi.spyOn(network, "ensureNodeNetwork").mockResolvedValue(true);
  const alias = `node-preparation/${f.addition.intent.operation_id}/proof.json`,
    history = (sha: string) =>
      `node-proof-history/${f.addition.intent.operation_id}/preparation/${session.claims.session_id}/${sha}.json`;
  return {
    ...f,
    pair,
    plan,
    report,
    session,
    firewall,
    verify,
    alias,
    history,
  };
}

it("rejects an unauthorized report before any R2 write or firewall gate", async () => {
  const f = await fixture(),
    put = vi.spyOn(env.ARCHIVE, "put");
  await expect(
    acceptNodeProofReport(f.bindings, "invalid", f.report),
  ).rejects.toMatchObject({ code: "unauthorized" });
  expect(put).not.toHaveBeenCalled();
  expect(f.firewall.mock.calls.length).toBe(0);
  expect(f.verify.mock.calls.length).toBe(0);
});

it("accepts a completed fresh scan after cleanup when its historical start remains inside the same session", async () => {
  const f = await fixture(),
    now = Date.now();
  const session = await issueNodeProofSession(
    f.bindings,
    f.addition.intent.operation_id,
    "preparation",
    now - 200_000,
  );
  const report = structuredClone(f.report);
  const measurement = report.measurements.find(
    (value) => value.kind === "scan",
  )!;
  if (measurement.kind !== "scan") throw new Error("fixture_scan_missing");
  const scan = measurement.scans[0]!;
  scan.before.observed_at = new Date(now - 142_000).toISOString();
  scan.started_at = new Date(now - 140_000).toISOString();
  scan.observed_at = scan.after.observed_at = new Date(
    now - 60_000,
  ).toISOString();
  measurement.observed_at = scan.observed_at;
  const result = await acceptNodeProofReport(
    f.bindings,
    session.bearer,
    report,
  );
  expect(result.verified).toBe(true);
  expect(f.firewall).toHaveBeenCalledTimes(1);
  const stored = await env.ARCHIVE.get(f.alias);
  const document = JSON.parse(await stored!.text());
  expect(await trusted(f, document)).toBe(true);
  expect(document.payload.external.ipv4.scans[0].started_at).toBe(
    scan.started_at,
  );
  expect(document.payload.external.ipv4.scans[0].observed_at).toBe(
    scan.observed_at,
  );
});

it("still rejects stale completion and an excessive scan interval before any firewall or archive write", async () => {
  const f = await fixture(),
    now = Date.now(),
    report = structuredClone(f.report),
    measurement = report.measurements.find((value) => value.kind === "scan")!;
  if (measurement.kind !== "scan") throw new Error("fixture_scan_missing");
  const scan = measurement.scans[0]!;
  measurement.observed_at = new Date(now - 130_000).toISOString();
  scan.observed_at = scan.after.observed_at = measurement.observed_at;
  await expect(
    acceptNodeProofReport(f.bindings, f.session.bearer, report),
  ).rejects.toMatchObject({ code: "conflict" });
  measurement.observed_at = f.report.measurements[1]!.observed_at;
  scan.observed_at = scan.after.observed_at = new Date(
    now - 1_000,
  ).toISOString();
  scan.started_at = new Date(now - 122_000).toISOString();
  scan.before.observed_at = new Date(now - 124_000).toISOString();
  await expect(
    acceptNodeProofReport(f.bindings, f.session.bearer, report),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(f.firewall).not.toHaveBeenCalled();
  expect(f.verify).not.toHaveBeenCalled();
  expect(await env.ARCHIVE.get(f.alias)).toBeNull();
});

it("renews preparation authority from confirmed Cloudflare readback without polling provider firewalls", async () => {
  const f = await fixture(),
    prove = vi.fn(async () => ({ status: "running" }));
  const bindings = {
    ...f.bindings,
    NODE_BOOTSTRAP: {
      idFromName: () => f.addition.intent.operation_id,
      get: () => ({ prove }),
    } as unknown as typeof f.bindings.NODE_BOOTSTRAP,
  };
  f.firewall.mockRejectedValue(new Error("renewal_provider_forbidden"));
  expect(
    await ensureNodePreparationProof(bindings, f.addition.intent.operation_id),
  ).toBe(false);
  expect(prove).toHaveBeenCalledWith(
    f.addition.intent.operation_id,
    "preparation",
  );
  expect(f.firewall).not.toHaveBeenCalled();
  await env.DB.prepare(
    "UPDATE node_network_preparations SET readback_at=NULL WHERE operation_id=?",
  )
    .bind(f.addition.intent.operation_id)
    .run();
  f.firewall.mockResolvedValue(false);
  expect(
    await ensureNodePreparationProof(bindings, f.addition.intent.operation_id),
  ).toBe(false);
  expect(f.firewall).toHaveBeenCalledTimes(1);
  expect(prove).toHaveBeenCalledTimes(1);
});

async function preparationDocument(
  f: Awaited<ReturnType<typeof fixture>>,
  offset = 0,
) {
  const now = Date.now() + offset,
    at = (milliseconds: number) => new Date(now + milliseconds).toISOString();
  const payload = nodePreparationProofSchema.parse({
    version: 1,
    operation_id: f.addition.intent.operation_id,
    node_id: f.addition.intent.node_id,
    region_id: f.fixture.region,
    provider_instance_id: f.providerId,
    intent_hash: f.addition.intent_hash,
    plan_sha256: f.report.binding.plan_sha256,
    observed_at: at(0),
    expires_at: at(120_000),
    relay_provider_instance_id: f.relay.id,
    access: [
      {
        provider_instance_id: f.providerId,
        address: f.actual.ipConfig.v4.ip,
        relay_source: f.relay.ipConfig.v4.ip,
        observed_at: at(-500),
        checks: [
          { port: 22, outcome: "connected" },
          { port: 50000, outcome: "refused" },
          { port: 6443, outcome: "refused" },
        ],
      },
    ],
    firewalls: f.plan.members.map((member) => ({
      firewall_id: member.firewall_id,
      provider_instance_id: member.provider_instance_id,
      rules_sha256: member.rules_sha256,
    })),
    external: {
      ipv4: {
        source: "8.8.4.4",
        positive_control: {
          address: f.plan.scan_control.ipv4,
          port: f.plan.scan_control.port,
          outcome: "connected",
          observed_at: at(-1_000),
        },
        scans: [
          {
            provider_instance_id: f.providerId,
            address: f.actual.ipConfig.v4.ip,
            protocol: "tcp",
            first_port: 1,
            last_port: 65535,
            scanned_ports: 65535,
            open_ports: [],
            started_at: at(-8_000),
            observed_at: at(-1_000),
          },
        ],
      },
      ipv6: null,
    },
  });
  return signNodeProofDocument(
    f.bindings,
    NODE_PREPARATION_SIGNATURE_DOMAIN,
    payload,
    canonicalNodePreparationProof,
  );
}
type Document = Awaited<ReturnType<typeof preparationDocument>>;
async function trusted(f: Awaited<ReturnType<typeof fixture>>, doc: Document) {
  const signature = Uint8Array.from(
    atob(doc.signature.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );
  return crypto.subtle.verify(
    "Ed25519",
    f.pair.publicKey,
    signature,
    utf8.encode(
      NODE_PREPARATION_SIGNATURE_DOMAIN +
        canonicalNodePreparationProof(doc.payload),
    ),
  );
}
async function alias(f: Awaited<ReturnType<typeof fixture>>) {
  const value = await env.ARCHIVE.get(f.alias);
  expect(value !== null).toBe(true);
  return { object: value!, text: await value!.text() };
}
function exactGateCalls(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.firewall.mock.calls.length).toBe(1);
  expect(f.verify.mock.calls.length).toBe(1);
  // Never assert an entire Env object: assertion diagnostics must not print private keys.
  expect(f.firewall.mock.calls[0]![0] === f.bindings).toBe(true);
  expect(f.firewall.mock.calls[0]![1] === f.addition.intent.operation_id).toBe(
    true,
  );
  expect(f.verify.mock.calls[0]![0] === f.bindings).toBe(true);
  expect(f.verify.mock.calls[0]![1] === f.addition.intent.operation_id).toBe(
    true,
  );
}

it("rejects a changed report binding before any R2 write", async () => {
  const f = await fixture(),
    put = vi.spyOn(env.ARCHIVE, "put"),
    report = structuredClone(f.report);
  report.binding.plan_sha256 = "f".repeat(64);
  await expect(
    acceptNodeProofReport(f.bindings, f.session.bearer, report),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(put).not.toHaveBeenCalled();
  expect(f.verify.mock.calls.length).toBe(0);
});

it("rejects a partial full-port scan before persisting any proof", async () => {
  const f = await fixture(),
    put = vi.spyOn(env.ARCHIVE, "put");
  const report = {
    ...f.report,
    measurements: f.report.measurements.map((measurement) =>
      measurement.kind === "scan"
        ? {
            ...measurement,
            scans: measurement.scans.map((scan) => ({
              ...scan,
              scanned_ports: 65534,
            })),
          }
        : measurement,
    ),
  } as unknown as Report;
  await expect(
    acceptNodeProofReport(f.bindings, f.session.bearer, report),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(put).not.toHaveBeenCalled();
  expect(f.verify.mock.calls.length).toBe(0);
});

it("rejects a source inside a member CIDR instead of treating its different host address as outside", async () => {
  const f = await fixture();
  f.plan.members[0]!.rules.rules.inbound[0]!.srcCidr.ipv4 = ["8.8.0.0/16"];
  f.plan.members[0]!.rules_sha256 = await installationHash(
    f.plan.members[0]!.rules.rules.inbound,
  );
  const planHash = await installationHash(f.plan);
  await env.DB.prepare(
    "DELETE FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(f.addition.intent.operation_id)
    .run();
  await env.DB.prepare(
    "INSERT INTO node_network_preparations(operation_id,intent_hash,plan_sha256,plan_json,status,readback_at,created_at,updated_at) VALUES(?,?,?,?,'awaiting_proof',?,?,?)",
  )
    .bind(
      f.addition.intent.operation_id,
      f.addition.intent_hash,
      planHash,
      JSON.stringify(f.plan),
      f.report.binding.readback_at,
      f.report.binding.readback_at,
      f.report.binding.readback_at,
    )
    .run();
  f.report.binding.plan_sha256 = planHash;
  const bindingHash = await hashBinding(f.report.binding);
  for (const measurement of f.report.measurements)
    measurement.binding_sha256 = bindingHash;
  f.session = await issueNodeProofSession(
    f.bindings,
    f.addition.intent.operation_id,
    "preparation",
  );
  const put = vi.spyOn(env.ARCHIVE, "put");
  await expect(
    acceptNodeProofReport(f.bindings, f.session.bearer, f.report),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(put).not.toHaveBeenCalled();
  expect(f.verify.mock.calls.length).toBe(0);
});

it("publishes a signed preparation proof to immutable history and the fixed alias, then invokes the existing gates", async () => {
  const f = await fixture(),
    put = vi.spyOn(env.ARCHIVE, "put");
  const claims = await authenticateNodeProofSession(
    f.bindings,
    f.session.bearer,
    f.addition.intent.operation_id,
  );
  expect(claims.mode).toBe("preparation");
  const result = await acceptNodeProofReport(
    f.bindings,
    f.session.bearer,
    f.report,
  );
  expect(result).toMatchObject({
    operation_id: f.addition.intent.operation_id,
    mode: "preparation",
    verified: true,
  });
  expect(/^[a-f0-9]{64}$/.test(result.sha256)).toBe(true);
  const published = await alias(f),
    doc = JSON.parse(published.text) as Document;
  expect(nodePreparationProofSchema.safeParse(doc.payload).success).toBe(true);
  expect(await trusted(f, doc)).toBe(true);
  expect(await hashText(published.text)).toBe(result.sha256);
  expect(doc.payload.plan_sha256).toBe(f.report.binding.plan_sha256);
  expect(doc.payload.external.ipv4?.scans[0]?.scanned_ports).toBe(65535);
  const history = await env.ARCHIVE.get(f.history(result.sha256));
  expect(history !== null).toBe(true);
  expect(await history!.text()).toBe(published.text);
  const write = put.mock.calls.find((call) => call[0] === f.alias),
    condition = write?.[2]?.onlyIf;
  expect(write !== undefined).toBe(true);
  expect(
    condition instanceof Headers
      ? condition.get("if-none-match") === "*"
      : condition?.etagDoesNotMatch === "*",
  ).toBe(true);
  exactGateCalls(f);
});

it("refreshes only an expired exact signed alias by real R2 etag CAS while retaining its immutable history", async () => {
  const f = await fixture(),
    old = await preparationDocument(f, -600_000),
    oldBody = JSON.stringify(old),
    oldSha = await hashText(oldBody),
    oldHistory = `node-proof-history/${f.addition.intent.operation_id}/preparation/${crypto.randomUUID()}/${oldSha}.json`;
  expect(await trusted(f, old)).toBe(true);
  await env.ARCHIVE.put(oldHistory, oldBody, {
    onlyIf: { etagDoesNotMatch: "*" },
  });
  const prior = await env.ARCHIVE.put(f.alias, oldBody);
  expect(prior !== null).toBe(true);
  const put = vi.spyOn(env.ARCHIVE, "put"),
    result = await acceptNodeProofReport(
      f.bindings,
      f.session.bearer,
      f.report,
    );
  const current = await alias(f),
    doc = JSON.parse(current.text) as Document;
  expect(current.text === oldBody).toBe(false);
  expect(await trusted(f, doc)).toBe(true);
  expect(await hashText(current.text)).toBe(result.sha256);
  expect(await (await env.ARCHIVE.get(oldHistory))!.text()).toBe(oldBody);
  const retained = await env.ARCHIVE.get(f.history(oldSha));
  expect(retained !== null).toBe(true);
  expect(await retained!.text()).toBe(oldBody);
  const write = put.mock.calls.find((call) => call[0] === f.alias);
  expect(write !== undefined).toBe(true);
  const condition = write?.[2]?.onlyIf;
  expect(
    condition instanceof Headers
      ? [prior!.etag, prior!.httpEtag].includes(condition.get("if-match") ?? "")
      : [prior!.etag, prior!.httpEtag].includes(condition?.etagMatches ?? ""),
  ).toBe(true);
  exactGateCalls(f);
});

it("preserves a fresh exact trusted alias and gates its actual hash", async () => {
  const f = await fixture(),
    current = await preparationDocument(f),
    body = JSON.stringify(current),
    currentSha = await hashText(body);
  await env.ARCHIVE.put(f.alias, body);
  const put = vi.spyOn(env.ARCHIVE, "put"),
    before = await env.ARCHIVE.head(f.alias),
    result = await acceptNodeProofReport(
      f.bindings,
      f.session.bearer,
      f.report,
    ),
    after = await alias(f);
  expect(after.text).toBe(body);
  expect(after.object.etag).toBe(before!.etag);
  expect(result.sha256).toBe(currentSha);
  expect(result.verified).toBe(true);
  expect(put.mock.calls.length).toBe(0);
  exactGateCalls(f);
});

it("never overwrites an unknown alias even when the submitted report is current", async () => {
  const f = await fixture(),
    body = "unknown operator-owned content";
  await env.ARCHIVE.put(f.alias, body);
  await expect(
    acceptNodeProofReport(f.bindings, f.session.bearer, f.report),
  ).rejects.toMatchObject({ code: "conflict" });
  expect((await alias(f)).text).toBe(body);
  expect(f.verify.mock.calls.length).toBe(0);
});

it("never overwrites a signature-valid alias belonging to another operation", async () => {
  const f = await fixture(),
    doc = await preparationDocument(f),
    foreign = await signNodeProofDocument(
      f.bindings,
      NODE_PREPARATION_SIGNATURE_DOMAIN,
      { ...doc.payload, operation_id: "op_" + "b".repeat(20) },
      canonicalNodePreparationProof,
    ),
    body = JSON.stringify(foreign);
  await env.ARCHIVE.put(f.alias, body);
  await expect(
    acceptNodeProofReport(f.bindings, f.session.bearer, f.report),
  ).rejects.toMatchObject({ code: "conflict" });
  expect((await alias(f)).text).toBe(body);
  expect(f.verify.mock.calls.length).toBe(0);
});

it("an initial alias creation race uses the current valid winner rather than overwriting it", async () => {
  const f = await fixture(),
    winner = await preparationDocument(f),
    winnerBody = JSON.stringify(winner),
    winnerSha = await hashText(winnerBody),
    original = env.ARCHIVE.put.bind(env.ARCHIVE);
  let raced = false;
  vi.spyOn(env.ARCHIVE, "put").mockImplementation(
    async (key, value, options) => {
      if (key === f.alias && !raced) {
        raced = true;
        await original(f.alias, winnerBody);
      }
      return original(key, value, options);
    },
  );
  const result = await acceptNodeProofReport(
    f.bindings,
    f.session.bearer,
    f.report,
  );
  expect(raced).toBe(true);
  expect((await alias(f)).text).toBe(winnerBody);
  expect(result.sha256).toBe(winnerSha);
  expect(result.verified).toBe(true);
  exactGateCalls(f);
});

it("an expired-alias refresh race preserves the current trusted winner and its actual etag", async () => {
  const f = await fixture(),
    old = await preparationDocument(f, -600_000),
    winner = await preparationDocument(f),
    winnerBody = JSON.stringify(winner),
    winnerSha = await hashText(winnerBody),
    original = env.ARCHIVE.put.bind(env.ARCHIVE);
  await env.ARCHIVE.put(f.alias, JSON.stringify(old));
  let raced = false;
  vi.spyOn(env.ARCHIVE, "put").mockImplementation(
    async (key, value, options) => {
      if (key === f.alias && !raced) {
        raced = true;
        await original(f.alias, winnerBody);
      }
      return original(key, value, options);
    },
  );
  const result = await acceptNodeProofReport(
    f.bindings,
    f.session.bearer,
    f.report,
  );
  expect(raced).toBe(true);
  expect((await alias(f)).text).toBe(winnerBody);
  expect(result.sha256).toBe(winnerSha);
  expect(result.verified).toBe(true);
  exactGateCalls(f);
});
