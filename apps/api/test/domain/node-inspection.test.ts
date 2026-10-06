// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { bytesToBase64url } from "@pgcf/contracts";
import {
  BOOTSTRAP_RELAY_HEADER,
  importBootstrapVerificationKeys,
  verifyBootstrapRelay,
} from "@pgcf/contracts/bootstrap-relay";
import { NodeInspectionInput } from "@pgcf/contracts/node-installation";
import { createApp } from "../../src/app.ts";
import * as network from "../../src/domain/node-network.ts";
import { ContaboClient } from "../../src/providers/contabo.ts";
import {
  installationHash,
  recordNodeInstallationInspection,
} from "../../src/domain/node-installation.ts";
import {
  issueNodeInspectionTransport,
  prepareNodeInspectionInput,
} from "../../src/domain/node-inspection.ts";
import { boundInstallationFixture } from "./installation-fixtures.ts";
import { cleanupFixtures } from "./fixtures.ts";

const regions: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
async function prepared() {
  const f = await boundInstallationFixture();
  regions.push(f.fixture.region);
  const saved = (await env.DB.prepare(
    "SELECT plan_json FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(f.addition.intent.operation_id)
    .first("plan_json")) as string;
  const plan = JSON.parse(saved);
  plan.members[0].firewall_id = f.binding.row.firewall_id;
  await env.DB.prepare(
    "DELETE FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(f.addition.intent.operation_id)
    .run();
  const at = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO node_network_preparations(operation_id,intent_hash,plan_sha256,plan_json,status,readback_at,created_at,updated_at) VALUES(?,?,?,?,'awaiting_proof',?,?,?)",
  )
    .bind(
      f.addition.intent.operation_id,
      f.addition.intent_hash,
      await installationHash(plan),
      JSON.stringify(plan),
      at,
      at,
      at,
    )
    .run();
  vi.spyOn(network, "ensureNodeFirewall").mockResolvedValue(true);
  return f;
}

it("authenticates the new inspection transport before collecting a malformed private body", async () => {
  const f = await prepared();
  const ctx = createExecutionContext();
  const response = await createApp().fetch(
    new Request(
      `https://api.invalid/internal/v1/node-installation/${f.addition.intent.operation_id}/transport`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${crypto.randomUUID()}`,
          "Content-Type": "application/json",
        },
        body: "{",
      },
    ),
    f.bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(401);
});

it("allows measured preflight input from confirmed rescue and owned firewalls without a bootstrap job or signed installation proof", async () => {
  const f = await prepared();
  const input = await prepareNodeInspectionInput(
    f.bindings,
    f.addition.intent.operation_id,
    { provider: f.provider },
  );
  expect(NodeInspectionInput.safeParse(input).success).toBe(true);
  expect(input).not.toHaveProperty("image");
  expect(input?.expected_network).toEqual({
    mac: f.actual.macAddress,
    ipv4: f.actual.ipConfig.v4.ip,
    prefix_length: f.actual.ipConfig.v4.netmaskCidr,
    gateway: f.actual.ipConfig.v4.gateway,
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM node_bootstrap_jobs WHERE operation_id=?",
    )
      .bind(f.addition.intent.operation_id)
      .first("count"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT status FROM node_network_preparations WHERE operation_id=?",
    )
      .bind(f.addition.intent.operation_id)
      .first("status"),
  ).toBe("awaiting_proof");
  vi.mocked(network.ensureNodeFirewall).mockResolvedValueOnce(false);
  expect(
    await prepareNodeInspectionInput(
      f.bindings,
      f.addition.intent.operation_id,
      { provider: f.provider },
    ),
  ).toBeNull();
  f.actual.status = "running";
  expect(
    await prepareNodeInspectionInput(
      f.bindings,
      f.addition.intent.operation_id,
      { provider: f.provider },
    ),
  ).toBeNull();
});

it("mints only rescue SSH on the exact current inspection generation and relay epoch", async () => {
  const f = await prepared();
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("fixture_keypair_invalid");
  const privateKey = await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    publicKey = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (
    !(privateKey instanceof ArrayBuffer) ||
    !(publicKey instanceof ArrayBuffer)
  )
    throw new Error("fixture_export_invalid");
  const epoch = crypto.randomUUID();
  f.bindings.BOOTSTRAP_RELAY_URL = "https://relay.invalid";
  f.bindings.BOOTSTRAP_RELAY_SIGNING_KEYS = JSON.stringify({
    active: "test",
    keys: { test: bytesToBase64url(new Uint8Array(privateKey)) },
  });
  f.bindings.BOOTSTRAP_RELAY_SERVICE = {
    fetch: async () =>
      Response.json({
        v: 1,
        region: f.fixture.region,
        issuer_region: f.fixture.region,
        relay_epoch: epoch,
        allowed_target_regions: [f.fixture.region],
        capabilities: ["rescue_ssh"],
      }),
  } as unknown as Fetcher;
  const transport = await issueNodeInspectionTransport(
    f.bindings,
    f.addition.intent.operation_id,
    0,
    { provider: f.provider },
  );
  expect(transport.expectedTarget).toEqual({
    ip: f.actual.ipConfig.v4.ip,
    port: 22,
  });
  const verified = await verifyBootstrapRelay(transport.token, {
    keys: await importBootstrapVerificationKeys({
      test: bytesToBase64url(new Uint8Array(publicKey)),
    }),
    region: f.fixture.region,
    issuer_region: f.fixture.region,
    relay_epoch: epoch,
    allowedTargetRegions: [f.fixture.region],
  });
  expect(verified.ok).toBe(true);
  if (verified.ok) {
    expect(verified.claims.capability).toBe("rescue_ssh");
    expect(verified.claims.revision).toBe(1);
  }
  await expect(
    issueNodeInspectionTransport(
      f.bindings,
      f.addition.intent.operation_id,
      1,
      { provider: f.provider },
    ),
  ).rejects.toMatchObject({ code: "forbidden" });
});

it("serves the scoped transport route under inspection custody while normal writer authority remains closed", async () => {
  const f = await prepared();
  vi.spyOn(ContaboClient.prototype, "getInstance").mockImplementation(
    f.provider.getInstance,
  );
  const ctx = createExecutionContext();
  const response = await createApp().fetch(
    new Request(
      `https://api.invalid/internal/v1/node-installation/${f.addition.intent.operation_id}/transport`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.binding.inspection_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expected_generation: 1 }),
      },
    ),
    {
      ...f.bindings,
      CONTABO_CLIENT_ID: crypto.randomUUID(),
      CONTABO_CLIENT_SECRET: crypto.randomUUID(),
      CONTABO_USERNAME: crypto.randomUUID(),
      CONTABO_PASSWORD: crypto.randomUUID(),
    },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(403);
});

it("refuses a relay token when a real inspection report advances generation during provider preparation", async () => {
  const f = await prepared();
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("fixture_keypair_invalid");
  const exported = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (!(exported instanceof ArrayBuffer))
    throw new Error("fixture_export_invalid");
  f.bindings.BOOTSTRAP_RELAY_URL = "https://relay.invalid";
  f.bindings.BOOTSTRAP_RELAY_SIGNING_KEYS = JSON.stringify({
    active: "test",
    keys: { test: bytesToBase64url(new Uint8Array(exported)) },
  });
  f.bindings.BOOTSTRAP_RELAY_SERVICE = {
    fetch: async () =>
      Response.json({
        v: 1,
        region: f.fixture.region,
        issuer_region: f.fixture.region,
        relay_epoch: crypto.randomUUID(),
        allowed_target_regions: [f.fixture.region],
        capabilities: ["rescue_ssh"],
      }),
  } as unknown as Fetcher;
  const transport = await issueNodeInspectionTransport(
    f.bindings,
    f.addition.intent.operation_id,
    0,
    { provider: f.provider },
  );
  const forwarded = vi.fn(async () => new Response(null, { status: 409 }));
  f.bindings.BOOTSTRAP_RELAY_SERVICE = {
    fetch: forwarded,
  } as unknown as Fetcher;
  const planHash = await env.DB.prepare(
    "SELECT plan_sha256 FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(f.addition.intent.operation_id)
    .first<string>("plan_sha256");
  vi.spyOn(ContaboClient.prototype, "getInstance").mockImplementation(
    async (id) => {
      await recordNodeInstallationInspection(
        f.bindings,
        f.addition.intent.operation_id,
        0,
        { ...f.inspection, network_plan_sha256: planHash! },
      );
      return f.provider.getInstance(id);
    },
  );
  const ctx = createExecutionContext();
  const response = await createApp().fetch(
    new Request(transport.websocket_url.replace(/^wss:/, "https:"), {
      headers: {
        Authorization: `Bearer ${f.binding.inspection_token}`,
        Upgrade: "websocket",
        [BOOTSTRAP_RELAY_HEADER]: transport.token,
      },
    }),
    {
      ...f.bindings,
      CONTABO_CLIENT_ID: crypto.randomUUID(),
      CONTABO_CLIENT_SECRET: crypto.randomUUID(),
      CONTABO_USERNAME: crypto.randomUUID(),
      CONTABO_PASSWORD: crypto.randomUUID(),
    },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(403);
  expect(forwarded).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare(
      "SELECT inspection_generation FROM node_installation_bindings WHERE operation_id=?",
    )
      .bind(f.addition.intent.operation_id)
      .first("inspection_generation"),
  ).toBe(1);
});
