// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import {
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import { bytesToBase64url } from "@pgcf/contracts";
import {
  BOOTSTRAP_RELAY_HEADER,
  importBootstrapVerificationKeys,
  verifyBootstrapRelay,
} from "@pgcf/contracts/bootstrap-relay";
import { NodeInspectionInput } from "@pgcf/contracts/node-installation";
import { createApp } from "../../src/app.ts";
import { NodeBootstrap } from "../../src/bootstrap-container.ts";
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

async function retainInspection(
  f: Awaited<ReturnType<typeof prepared>>,
  input: NodeInspectionInput,
) {
  const namespace = env.NODE_BOOTSTRAP;
  const stub = namespace.get(namespace.idFromName(input.operation_id));
  // Use the real DO storage and implementation with this real-D1 fixture's environment.
  f.bindings.NODE_BOOTSTRAP = {
    idFromName: (id: string) => namespace.idFromName(id),
    get: (id: DurableObjectId) => ({
      getInspectionInput: (operation: string) =>
        runInDurableObject(namespace.get(id), async (_instance, state) =>
          new NodeBootstrap(state, f.bindings).getInspectionInput(operation),
        ),
    }),
  } as unknown as typeof f.bindings.NODE_BOOTSTRAP;
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("inspection_input", input);
  });
}
async function relayIdentity(f: Awaited<ReturnType<typeof prepared>>) {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("fixture_keypair_invalid");
  const privateKey = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (!(privateKey instanceof ArrayBuffer))
    throw new Error("fixture_export_invalid");
  const epoch = crypto.randomUUID();
  f.bindings.BOOTSTRAP_RELAY_URL = "https://relay.invalid";
  f.bindings.BOOTSTRAP_RELAY_SIGNING_KEYS = JSON.stringify({
    active: "test",
    keys: { test: bytesToBase64url(new Uint8Array(privateKey)) },
  });
  const fetch = vi.fn(async () =>
    Response.json({
      v: 1,
      region: f.fixture.region,
      issuer_region: f.fixture.region,
      relay_epoch: epoch,
      allowed_target_regions: [f.fixture.region],
      capabilities: ["rescue_ssh"],
    }),
  );
  f.bindings.BOOTSTRAP_RELAY_SERVICE = { fetch } as unknown as Fetcher;
  return fetch;
}

it("retains one provider-verified inspection input while repeated grants make no provider or firewall calls", async () => {
  const f = await prepared(),
    provider = vi.fn(async (id: string) => f.provider.getInstance(id));
  const input = await prepareNodeInspectionInput(
    f.bindings,
    f.addition.intent.operation_id,
    { provider: { getInstance: provider } },
  );
  expect(input).not.toBeNull();
  await retainInspection(f, input!);
  await relayIdentity(f);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(network.ensureNodeFirewall).toHaveBeenCalledTimes(1);
  await issueNodeInspectionTransport(f.bindings, input!.operation_id, 0);
  await issueNodeInspectionTransport(f.bindings, input!.operation_id, 0);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(network.ensureNodeFirewall).toHaveBeenCalledTimes(1);
});

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
  const input = await prepareNodeInspectionInput(
    f.bindings,
    f.addition.intent.operation_id,
    { provider: f.provider },
  );
  expect(input).not.toBeNull();
  await retainInspection(f, input!);
  const transport = await issueNodeInspectionTransport(
    f.bindings,
    f.addition.intent.operation_id,
    0,
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
    issueNodeInspectionTransport(f.bindings, f.addition.intent.operation_id, 1),
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

it("refuses a stored inspection relay when a real report advances its generation without provider preparation", async () => {
  const f = await prepared(),
    input = await prepareNodeInspectionInput(
      f.bindings,
      f.addition.intent.operation_id,
      { provider: f.provider },
    );
  expect(input).not.toBeNull();
  await retainInspection(f, input!);
  await relayIdentity(f);
  const transport = await issueNodeInspectionTransport(
    f.bindings,
    input!.operation_id,
    0,
  );
  const forwarded = vi.fn(async () => new Response(null, { status: 409 }));
  f.bindings.BOOTSTRAP_RELAY_SERVICE = {
    fetch: forwarded,
  } as unknown as Fetcher;
  await recordNodeInstallationInspection(f.bindings, input!.operation_id, 0, {
    ...f.inspection,
    network_plan_sha256: input!.network_plan_sha256,
  });
  const provider = vi
    .spyOn(ContaboClient.prototype, "getInstance")
    .mockImplementation(async () => {
      throw new Error("routine_provider_read_forbidden");
    });
  const ctx = createExecutionContext();
  const response = await createApp().fetch(
    new Request(transport.websocket_url.replace(/^wss:/, "https:"), {
      headers: {
        Authorization: `Bearer ${f.binding.inspection_token}`,
        Upgrade: "websocket",
        [BOOTSTRAP_RELAY_HEADER]: transport.token,
      },
    }),
    f.bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(response.status).toBe(403);
  expect(forwarded).not.toHaveBeenCalled();
  expect(provider).not.toHaveBeenCalled();
});

it("uses the stored scoped input for relay upgrades without repeated provider or firewall calls", async () => {
  const f = await prepared(),
    initialProvider = vi.fn(async (id: string) => f.provider.getInstance(id));
  const input = await prepareNodeInspectionInput(
    f.bindings,
    f.addition.intent.operation_id,
    { provider: { getInstance: initialProvider } },
  );
  expect(input).not.toBeNull();
  await retainInspection(f, input!);
  await relayIdentity(f);
  const transport = await issueNodeInspectionTransport(
    f.bindings,
    input!.operation_id,
    0,
  );
  const forwarded = vi.fn(async () => new Response(null, { status: 409 }));
  f.bindings.BOOTSTRAP_RELAY_SERVICE = {
    fetch: forwarded,
  } as unknown as Fetcher;
  const provider = vi
    .spyOn(ContaboClient.prototype, "getInstance")
    .mockImplementation(async () => {
      throw new Error("routine_provider_read_forbidden");
    });
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctx = createExecutionContext();
    const response = await createApp().fetch(
      new Request(transport.websocket_url.replace(/^wss:/, "https:"), {
        headers: {
          Authorization: `Bearer ${f.binding.inspection_token}`,
          Upgrade: "websocket",
          [BOOTSTRAP_RELAY_HEADER]: transport.token,
        },
      }),
      f.bindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(409);
  }
  expect(initialProvider).toHaveBeenCalledTimes(1);
  expect(provider).not.toHaveBeenCalled();
  expect(network.ensureNodeFirewall).toHaveBeenCalledTimes(1);
  expect(forwarded).toHaveBeenCalledTimes(2);
});

it("refuses changed stored host custody and expired inspection input before relay I/O", async () => {
  const f = await prepared(),
    input = await prepareNodeInspectionInput(
      f.bindings,
      f.addition.intent.operation_id,
      { provider: f.provider },
    );
  expect(input).not.toBeNull();
  const forwarded = await relayIdentity(f);
  const altered = structuredClone(input!);
  altered.rescue.ssh_host_fingerprint = "SHA256:" + "a".repeat(43);
  await retainInspection(f, altered);
  await expect(
    issueNodeInspectionTransport(f.bindings, input!.operation_id, 0),
  ).rejects.toMatchObject({ code: "forbidden" });
  const expired = structuredClone(input!);
  expired.deadline_at = new Date(Date.now() - 1).toISOString();
  await retainInspection(f, expired);
  await expect(
    issueNodeInspectionTransport(f.bindings, input!.operation_id, 0),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(forwarded).not.toHaveBeenCalled();
});

it("refuses closed lifecycle state rather than refreshing sealed inspection authority", async () => {
  const f = await prepared(),
    input = await prepareNodeInspectionInput(
      f.bindings,
      f.addition.intent.operation_id,
      { provider: f.provider },
    );
  expect(input).not.toBeNull();
  await retainInspection(f, input!);
  const forwarded = await relayIdentity(f);
  await env.DB.prepare(
    "UPDATE node_additions SET slot_held=0,status='cancelled',revision=revision+1 WHERE operation_id=?",
  )
    .bind(input!.operation_id)
    .run();
  await expect(
    issueNodeInspectionTransport(f.bindings, input!.operation_id, 0),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(forwarded).not.toHaveBeenCalled();
});

it("refuses a stored binding replacement and a generation changed during relay identity readback", async () => {
  const f = await prepared(),
    input = await prepareNodeInspectionInput(
      f.bindings,
      f.addition.intent.operation_id,
      { provider: f.provider },
    );
  expect(input).not.toBeNull();
  const identity = await relayIdentity(f),
    replaced = structuredClone(input!);
  replaced.binding_sha256 = "a".repeat(64);
  await retainInspection(f, replaced);
  await expect(
    issueNodeInspectionTransport(f.bindings, input!.operation_id, 0),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(identity).not.toHaveBeenCalled();
  await retainInspection(f, input!);
  identity.mockImplementationOnce(async () => {
    await recordNodeInstallationInspection(f.bindings, input!.operation_id, 0, {
      ...f.inspection,
      network_plan_sha256: input!.network_plan_sha256,
    });
    return Response.json({
      v: 1,
      region: f.fixture.region,
      issuer_region: f.fixture.region,
      relay_epoch: crypto.randomUUID(),
      allowed_target_regions: [f.fixture.region],
      capabilities: ["rescue_ssh"],
    });
  });
  await expect(
    issueNodeInspectionTransport(f.bindings, input!.operation_id, 0),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(identity).toHaveBeenCalledTimes(1);
});
