// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { bytesToBase64url, newNodeId, newOperationId } from "@pgcf/contracts";
import {
  NodeProofExecutionInput,
  NodeProofSourceStatus,
} from "@pgcf/contracts/node-proof";
import { NodeJoinBundle } from "@pgcf/contracts/node-bootstrap";
import {
  bootstrapRelayClaimsSchema,
  BOOTSTRAP_RELAY_IDENTITY_PATH,
  BOOTSTRAP_RELAY_PATH,
  BOOTSTRAP_RELAY_PROBE_PATH,
  BOOTSTRAP_RELAY_HEADER,
} from "@pgcf/contracts/bootstrap-relay";
import { ApiError, createApp, DIAGNOSTIC_ID_HEADER } from "../../src/app.ts";
import { NodeBootstrap } from "../../src/bootstrap-container.ts";
import { issueNodeProofSession } from "../../src/domain/node-proof-session.ts";
import { installationHash } from "../../src/domain/node-installation.ts";
import { ContaboError } from "../../src/providers/contabo.ts";
import {
  boundInstallationFixture,
  installationFixture,
} from "./installation-fixtures.ts";
import { ContaboClient } from "../../src/providers/contabo.ts";
import { cleanupFixtures } from "./fixtures.ts";
import * as network from "../../src/domain/node-network.ts";
import * as sources from "../../src/domain/node-proof-source.ts";
import * as execution from "../../src/domain/node-proof-execution.ts";
import * as artifacts from "../../src/domain/node-proof-artifacts.ts";
import * as nodes from "../../src/platform/nodes.ts";
import { recordNodeInstallationInspection } from "../../src/domain/node-installation.ts";
import { composeConfiguredNodeBootstrap } from "../../src/domain/bootstrap-composition.ts";
import {
  regionSeedReference,
  storeRegionSeed,
  joinBundleReference,
  storeRegionJoinBundle,
} from "../../src/crypto/bootstrap-credentials.ts";
import { storeNodeInstallationProfile } from "../../src/domain/node-installation.ts";
import {
  readBootstrapJob,
  bootstrapJobInput,
} from "../../src/domain/bootstrap-jobs.ts";

async function sourceGetterFixture() {
  const f = await fixture(),
    selected = await sealedPodSource(f);
  await recordNodeInstallationInspection(f.bindings, f.id, 0, {
    ...f.inspection,
    network_plan_sha256: f.input.binding.plan_sha256,
  });
  await composeConfiguredNodeBootstrap(f.bindings, f.id, {
    provider: f.provider,
  });
  const job = await readBootstrapJob(env.DB, f.id);
  const association = execution.NodeProofSourceBinding.parse({
    operation_id: f.id,
    binding_sha256: f.binding.row.binding_sha256,
    inspection_generation: 1,
    plan_sha256: f.input.binding.plan_sha256,
    input_hash: job.input_hash,
    source: { ...selected.input.source, ipv6: "2001:4860:4860::8844" },
  });
  await f.withStore(async (_instance, state) => {
    await state.storage.put("proof_source_binding", association);
  });
  const sourceRPC = vi.fn(async (id: string) =>
    f.withStore(async (instance, state) => {
      const before = await state.storage.list(),
        alarm = await state.storage.getAlarm();
      Object.defineProperty(state, "container", {
        configurable: true,
        get: () => {
          throw new Error("source_getter_native_forbidden");
        },
      });
      try {
        return await (
          instance as unknown as {
            proofSourceStatus(id: string): Promise<unknown>;
          }
        ).proofSourceStatus(id);
      } finally {
        delete (state as { container?: unknown }).container;
        expect(await state.storage.list()).toEqual(before);
        expect(await state.storage.getAlarm()).toEqual(alarm);
      }
    }),
  );
  const get = vi.fn(() => ({ proofSourceStatus: sourceRPC }));
  const bindings = {
    ...f.bindings,
    NODE_BOOTSTRAP: {
      idFromName: (id: string) => env.NODE_BOOTSTRAP.idFromName(id),
      get,
    } as unknown as typeof env.NODE_BOOTSTRAP,
  };
  const request = async (key = f.fixture.admin, id = f.id) => {
    const context = createExecutionContext();
    const response = await createApp().fetch(
      new Request(`https://api.invalid/v1/nodes/additions/${id}/proof/source`, {
        headers: { Authorization: `Bearer ${key}` },
      }),
      bindings,
      context,
    );
    await waitOnExecutionContext(context);
    return response;
  };
  return { ...f, selected, association, sourceRPC, get, request };
}

it("returns the sealed public proof source through real current CF authority without provider calls, private access or storage changes", async () => {
  const f = await sourceGetterFixture();
  const provider = vi
    .spyOn(ContaboClient.prototype, "getInstance")
    .mockRejectedValue(new Error("source_getter_provider_forbidden"));
  const response = await f.request();
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toEqual({
    ...f.association,
    source: Object.fromEntries(
      Object.entries(f.association.source).filter(([key]) => key !== "access"),
    ),
  });
  const text = JSON.stringify(body);
  expect(text).not.toContain("access");
  expect(text).not.toContain(f.session.bearer);
  expect(text).not.toContain(f.bundle.talos_admin_config);
  expect(text).not.toContain(f.bundle.kubeconfig);
  expect(provider).not.toHaveBeenCalled();
});

it("checks actual administrator scope and local presence before any source RPC", async () => {
  const f = await sourceGetterFixture();
  expect((await f.request(f.fixture.integrator)).status).toBe(403);
  expect(
    (await f.request(f.fixture.integrator, "malformed-operation")).status,
  ).toBe(403);
  expect((await f.request("invalid-credentials")).status).toBe(401);
  expect((await f.request(f.fixture.admin, newOperationId())).status).toBe(404);
  expect(f.get).not.toHaveBeenCalled();
  expect(f.sourceRPC).not.toHaveBeenCalled();
});

it("refuses the retained source when its actual CF Node UID changes", async () => {
  const f = await sourceGetterFixture();
  await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
    .bind(crypto.randomUUID(), f.selected.source.fixture.node)
    .run();
  expect((await f.request()).status).toBe(409);
});

it("returns fixed forbidden when the retained association disappears during its awaits", async () => {
  const f = await sourceGetterFixture();
  await f.withStore(async (instance, state) => {
    const original = state.storage.get,
      read = original.bind(state.storage);
    let seen = 0;
    Object.defineProperty(state.storage, "get", {
      configurable: true,
      value: async (...args: unknown[]) => {
        const value = await Reflect.apply(read, state.storage, args);
        if (args[0] === "proof_source_binding" && ++seen === 1)
          await state.storage.delete("proof_source_binding");
        return value;
      },
    });
    try {
      await expect(instance.proofSourceStatus(f.id)).rejects.toMatchObject({
        code: "forbidden",
      });
      expect(await state.storage.get("proof_source_binding")).toBeUndefined();
    } finally {
      Object.defineProperty(state.storage, "get", {
        configurable: true,
        value: original,
      });
    }
  });
});

it("refuses a cancelled current job without exposing the source or private access", async () => {
  const f = await sourceGetterFixture();
  await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET cancelled=1 WHERE operation_id=?",
  )
    .bind(f.id)
    .run();
  const response = await f.request();
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain(f.association.source.ipv4);
});

it("refuses stale association fingerprints and rejects private response fields", async () => {
  const f = await sourceGetterFixture();
  expect(NodeProofSourceStatus.safeParse(f.association).success).toBe(false);
  await f.withStore(async (_instance, state) => {
    await state.storage.put("proof_source_binding", {
      ...f.association,
      inspection_generation: 2,
    });
  });
  expect((await f.request()).status).toBe(403);
});

it("reads matching legacy input without persisting an association or renewing its token", async () => {
  const f = await sourceGetterFixture();
  const fresh = await issueNodeProofSession(f.bindings, f.id, "preparation");
  const input = NodeProofExecutionInput.parse({
    ...f.selected.input,
    claims: fresh.claims,
    session_bearer: fresh.bearer,
    control_keys: fresh.control_keys,
    bootstrap: await bootstrapJobInput(
      f.bindings,
      await readBootstrapJob(env.DB, f.id),
    ),
    source: f.association.source,
  });
  await f.withStore(async (_instance, state) => {
    await state.storage.delete("proof_source_binding");
    await state.storage.put(
      "proof_current:preparation",
      fresh.claims.session_id,
    );
    await state.storage.put(`proof_input:${fresh.claims.session_id}`, input);
  });
  expect((await f.request()).status).toBe(200);
  await f.withStore(async (_instance, state) => {
    expect(await state.storage.get("proof_source_binding")).toBeUndefined();
    expect(await state.storage.get("proof_current:preparation")).toBe(
      fresh.claims.session_id,
    );
  });
});

it("publishes the administrator source identity endpoint and excludes private access in OpenAPI", async () => {
  const response = await createApp().fetch(
    new Request("https://api.invalid/v1/openapi.json"),
    env,
  );
  const document = (await response.json()) as {
    paths: Record<
      string,
      {
        get: {
          security: unknown;
          responses: Record<
            string,
            {
              content: Record<
                string,
                { schema: { properties: Record<string, unknown> } }
              >;
            }
          >;
        };
      }
    >;
  };
  const route = document.paths["/v1/nodes/additions/{id}/proof/source"]?.get;
  expect(route?.security).toEqual([{ bearerAuth: [] }]);
  expect(
    Object.keys(
      route?.responses["200"]?.content["application/json"]?.schema.properties ??
        {},
    ).sort(),
  ).toEqual(
    [
      "operation_id",
      "binding_sha256",
      "inspection_generation",
      "plan_sha256",
      "input_hash",
      "source",
    ].sort(),
  );
  expect(JSON.stringify(route?.responses["200"])).not.toContain('"access"');
  expect(route?.responses["403"]).toBeDefined();
  expect(route?.responses["404"]).toBeDefined();
});

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
async function fixture() {
  const f = await boundInstallationFixture();
  regions.push(f.fixture.region);
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
    throw new Error("fixture_keypair_invalid");
  f.bindings.BOOTSTRAP_RELAY_SIGNING_KEYS = JSON.stringify({
    active: "automation",
    keys: { automation: bytesToBase64url(new Uint8Array(privateKey)) },
  });
  f.bindings.BOOTSTRAP_VERIFIER_KEYS = JSON.stringify({
    automation: bytesToBase64url(new Uint8Array(publicKey)),
  });
  f.bindings.BOOTSTRAP_RELAY_URL = "https://relay.invalid";
  const id = f.addition.intent.operation_id;
  const plan = {
    version: 1,
    operation_id: id,
    node_id: f.addition.intent.node_id,
    region_id: f.fixture.region,
    provider_instance_id: f.providerId,
    intent_hash: f.addition.intent_hash,
    operators: { ipv4: [], ipv6: [] },
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
        ownership_sha256: "a".repeat(64),
        rules_sha256: await installationHash([]),
        rules: { rules: { inbound: [] } },
      },
    ],
  };
  const planHash = await installationHash(plan),
    now = new Date().toISOString();
  await env.DB.prepare(
    "DELETE FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(id)
    .run();
  await env.DB.prepare(
    "INSERT INTO node_network_preparations(operation_id,intent_hash,plan_json,plan_sha256,status,readback_at,created_at,updated_at) VALUES(?,?,?,?,'awaiting_proof',?,?,?)",
  )
    .bind(
      id,
      f.addition.intent_hash,
      JSON.stringify(plan),
      planHash,
      now,
      now,
      now,
    )
    .run();
  const session = await issueNodeProofSession(f.bindings, id, "preparation");
  const input = NodeProofExecutionInput.parse({
    claims: session.claims,
    session_bearer: session.bearer,
    control_keys: session.control_keys,
    api_base_url: session.claims.origin,
    plan,
    binding: { plan_sha256: planHash, readback_at: now, verification: null },
    cluster_bundle: null,
    bootstrap: {
      spec: f.body.spec,
      input_hash: await installationHash(f.body.spec),
      callback: {
        url: `https://api.invalid/internal/v1/node-bootstrap/${id}`,
        bearer: "c".repeat(64),
      },
      rescue: f.body.rescue,
      join_bundle: null,
      platform: f.body.platform,
    },
    source: {
      kind: "rescue",
      operation_id: "op_" + "s".repeat(20),
      node_id: newNodeId(),
      region_id: "source-region",
      provider_instance_id: "99",
      ipv4: "203.0.113.99",
      access: {
        rescue: f.body.rescue,
        expected_network: {
          mac: f.body.spec.hardware.mac,
          prefix_length: 24,
          ipv4: "203.0.113.99",
          gateway: "203.0.113.1",
        },
        binding_sha256: "b".repeat(64),
        inspection_generation: 0,
        profile_sha256: "d".repeat(64),
      },
    },
  });
  async function withStore<T>(
    callback: (
      instance: NodeBootstrap,
      state: DurableObjectState,
    ) => Promise<T>,
  ) {
    return runInDurableObject(
      env.NODE_BOOTSTRAP.get(env.NODE_BOOTSTRAP.idFromName(id)),
      async (_instance, state) =>
        callback(new NodeBootstrap(state, f.bindings), state),
    );
  }
  await withStore(async (_instance, state) => {
    await state.storage.put(`proof_input:${session.claims.session_id}`, input);
  });
  async function request(path: string, body: string, bearer = session.bearer) {
    const ctx = createExecutionContext();
    const result = await createApp().fetch(
      new Request(`https://api.invalid/internal/v1/node-proof/${id}/${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        body,
      }),
      f.bindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return result;
  }
  return { ...f, id, input, session, withStore, request };
}
async function sealedPodSource(f: Awaited<ReturnType<typeof fixture>>) {
  const source = await installationFixture();
  regions.push(source.fixture.region);
  source.actual.region = "US-central";
  source.actual.status = "running";
  source.actual.ipConfig.v4.ip = "8.8.4.4";
  const uid = crypto.randomUUID(),
    at = new Date().toISOString();
  await env.DB.prepare("UPDATE regions SET provider_region=? WHERE id=?")
    .bind(source.actual.region, source.fixture.region)
    .run();
  await storeNodeInstallationProfile(
    source.bindings,
    source.fixture.region,
    source.profile,
  );
  await env.DB.prepare(
    "INSERT INTO nodes(id,region_id,k8s_node_name,provider_instance_id,node_uid,ready,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,last_observed_at,created_at,updated_at) VALUES(?,?,?,?,?,1,8192,8000,32,128,?,?,?)",
  )
    .bind(
      source.fixture.node,
      source.fixture.region,
      source.fixture.nodeName,
      source.actual.id,
      uid,
      at,
      at,
      at,
    )
    .run();
  const bundle = NodeJoinBundle.parse({
    ...f.bundle,
    cluster_name: source.profile.first_region!.cluster_name,
    cluster_endpoint: `https://${source.actual.ipConfig.v4.ip}:6443`,
    kube_system_uid: crypto.randomUUID(),
  });
  await storeRegionJoinBundle(
    env.DB,
    f.bindings.CREDENTIAL_KEYS,
    joinBundleReference(source.fixture.region, 1),
    bundle,
  );
  const input = NodeProofExecutionInput.parse({
    ...f.input,
    source: {
      kind: "pod",
      cluster_uid: bundle.kube_system_uid,
      node_uid: uid,
      node_name: source.fixture.nodeName,
      node_id: source.fixture.node,
      region_id: source.fixture.region,
      provider_instance_id: source.actual.id,
      ipv4: source.actual.ipConfig.v4.ip,
      image: source.profile.first_region!.regional_image,
      access: { join_bundle: bundle },
    },
  });
  await f.withStore(async (_instance, state) => {
    await state.storage.put(
      `proof_input:${f.session.claims.session_id}`,
      input,
    );
  });
  return { source, input, uid };
}
it("authorizes repeated sealed source and target transports without any provider request", async () => {
  const f = await fixture(),
    selected = await sealedPodSource(f);
  Object.assign(f.bindings, {
    CONTABO_CLIENT_ID: crypto.randomUUID(),
    CONTABO_CLIENT_SECRET: "fixture-secret",
    CONTABO_USERNAME: "fixture-user",
    CONTABO_PASSWORD: "fixture-password",
  });
  const provider = vi
    .spyOn(ContaboClient.prototype, "getInstance")
    .mockRejectedValue(new Error("routine_provider_request_forbidden"));
  const fetch = vi.fn(async (request: Request | URL) =>
    new URL((request as Request).url ?? String(request)).pathname ===
    BOOTSTRAP_RELAY_PATH
      ? new Response(null, { status: 426 })
      : Response.json({
          v: 1,
          region: f.fixture.region,
          issuer_region: f.fixture.region,
          relay_epoch: crypto.randomUUID(),
          allowed_target_regions: [
            f.fixture.region,
            selected.source.fixture.region,
          ],
          capabilities: ["rescue_ssh", "talos_api", "kubernetes_api"],
        }),
  );
  f.bindings.BOOTSTRAP_RELAY_SERVICE = { fetch } as unknown as Fetcher;
  let sourceToken: string | undefined;
  for (const body of [
    { capability: "kubernetes_api", direction: "source" },
    { capability: "kubernetes_api", direction: "source" },
    { capability: "talos_api", direction: "target" },
  ]) {
    const response = await f.request("transport", JSON.stringify(body));
    expect(response.status).toBe(200);
    if (body.direction === "source")
      sourceToken = ((await response.json()) as { token: string }).token;
  }
  const relay = await createApp().fetch(
    new Request(`https://api.invalid/internal/v1/node-proof/${f.id}/relay`, {
      headers: {
        Authorization: `Bearer ${f.session.bearer}`,
        Upgrade: "websocket",
        [BOOTSTRAP_RELAY_HEADER]: sourceToken!,
      },
    }),
    f.bindings,
    createExecutionContext(),
  );
  expect(relay.status).toBe(426);
  expect(
    (
      await f.request(
        "ownership",
        JSON.stringify({ action: "read", kind: "source", key: "a".repeat(64) }),
      )
    ).status,
  ).toBe(200);
  expect(provider).not.toHaveBeenCalled();
  await f.withStore(async (_instance, state) => {
    expect(
      await state.storage.get(`proof_input:${f.session.claims.session_id}`),
    ).toEqual(selected.input);
  });
});
it("authenticates every private proof POST before malformed body parsing", async () => {
  const f = await fixture();
  for (const path of ["transport", "access", "report", "ownership"])
    expect((await f.request(path, "{", "invalid")).status).toBe(401);
});
it("logs only a fixed transport failure stage correlated with the unchanged server response", async () => {
  const f = await fixture(),
    canary = "private-transport-error-canary",
    failed = new Error(canary),
    fetch = vi.fn(async () => {
      throw failed;
    }),
    log = vi.spyOn(console, "error").mockImplementation(() => {});
  f.bindings.BOOTSTRAP_RELAY_SERVICE = { fetch } as unknown as Fetcher;
  const issue = execution.issueNodeProofTransport;
  vi.spyOn(execution, "issueNodeProofTransport").mockImplementation(
    async (...args) => {
      try {
        return await issue(...args);
      } catch (error) {
        expect(error).toBe(failed);
        throw error;
      }
    },
  );
  const response = await f.request(
    "transport",
    JSON.stringify({ capability: "rescue_ssh", direction: "target" }),
  );
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: { code: "internal" } });
  expect(fetch).toHaveBeenCalledTimes(1);
  const diagnostics = log.mock.calls
    .map(([message]) => JSON.parse(String(message)))
    .filter((value) => value.event === "node_proof_transport_failed");
  expect(diagnostics).toEqual([
    {
      event: "node_proof_transport_failed",
      stage: "relay_identity",
      category: "error",
      diagnostic_id: response.headers.get(DIAGNOSTIC_ID_HEADER),
    },
  ]);
  expect(response.headers.get(DIAGNOSTIC_ID_HEADER)).toMatch(
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/,
  );
  expect(JSON.stringify(log.mock.calls)).not.toContain(canary);
  expect(JSON.stringify(log.mock.calls)).not.toContain(f.session.bearer);
});
it("validates API diagnostic codes without emitting a forged private code", async () => {
  const f = await fixture(),
    canary = "private-code-canary",
    error = new ApiError("forbidden", "private-message-canary"),
    log = vi.spyOn(console, "error").mockImplementation(() => {});
  Object.defineProperty(error, "code", { value: canary });
  f.bindings.BOOTSTRAP_RELAY_SERVICE = {
    fetch: async () => {
      throw error;
    },
  } as unknown as Fetcher;
  await f.request(
    "transport",
    JSON.stringify({ capability: "rescue_ssh", direction: "target" }),
  );
  const diagnostic = log.mock.calls
    .map(([message]) => JSON.parse(String(message)))
    .find((value) => value.event === "node_proof_transport_failed");
  expect(diagnostic).toMatchObject({
    stage: "relay_identity",
    category: "api_error",
  });
  expect(diagnostic).not.toHaveProperty("code");
  expect(JSON.stringify(log.mock.calls)).not.toContain(canary);
  expect(JSON.stringify(log.mock.calls)).not.toContain(
    "private-message-canary",
  );
});
it("records bounded provider refusal metadata while preserving the original failure", async () => {
  const f = await fixture(),
    failed = new ContaboError("unexpected_status", 429),
    canary = "private-provider-message-canary",
    fetch = vi.fn(async () => {
      throw failed;
    }),
    log = vi.spyOn(console, "error").mockImplementation(() => {}),
    issue = execution.issueNodeProofTransport;
  Object.defineProperty(failed, "message", { value: canary });
  vi.spyOn(execution, "issueNodeProofTransport").mockImplementation(
    async (...args) => {
      try {
        return await issue(...args);
      } catch (error) {
        expect(error).toBe(failed);
        throw error;
      }
    },
  );
  f.bindings.BOOTSTRAP_RELAY_SERVICE = { fetch } as unknown as Fetcher;
  const response = await f.request(
    "transport",
    JSON.stringify({ capability: "rescue_ssh", direction: "target" }),
  );
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: { code: "internal" } });
  expect(fetch).toHaveBeenCalledTimes(1);
  const diagnostic = log.mock.calls
    .map(([message]) => JSON.parse(String(message)))
    .find((value) => value.event === "node_proof_transport_failed");
  expect(diagnostic).toEqual({
    event: "node_proof_transport_failed",
    stage: "relay_identity",
    category: "provider_error",
    provider_code: "unexpected_status",
    provider_status: 429,
    diagnostic_id: response.headers.get(DIAGNOSTIC_ID_HEADER),
  });
  expect(JSON.stringify(log.mock.calls)).not.toContain(canary);
  expect(JSON.stringify(log.mock.calls)).not.toContain(f.session.bearer);
});
it("issues only the fixed target relay capability and refuses stale authority before relay I/O", async () => {
  const f = await fixture(),
    epoch = crypto.randomUUID();
  const fetch = vi.fn(async (request: Request | URL) => {
    expect(new URL(String(request)).pathname).toBe(
      BOOTSTRAP_RELAY_IDENTITY_PATH,
    );
    return Response.json({
      v: 1,
      region: f.fixture.region,
      issuer_region: f.fixture.region,
      relay_epoch: epoch,
      capabilities: ["rescue_ssh", "talos_api", "kubernetes_api"],
      allowed_target_regions: [f.fixture.region],
    });
  });
  f.bindings.BOOTSTRAP_RELAY_SERVICE = { fetch } as unknown as Fetcher;
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await f.request(
    "transport",
    JSON.stringify({ capability: "rescue_ssh", direction: "target" }),
  );
  expect(response.status).toBe(200);
  expect(log).not.toHaveBeenCalled();
  const dto = (await response.json()) as {
    token: string;
    expectedTarget: { ip: string; port: number };
    websocket_url: string;
  };
  expect(dto.expectedTarget).toEqual({ ip: f.actual.ipConfig.v4.ip, port: 22 });
  const claims = bootstrapRelayClaimsSchema.parse(
    JSON.parse(
      atob(dto.token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")),
    ),
  );
  expect(claims).toMatchObject({
    operation: f.id,
    relay_epoch: epoch,
    node: f.addition.intent.node_id,
  });
  expect(dto.websocket_url).toBe(
    `wss://api.invalid/internal/v1/node-proof/${f.id}/relay`,
  );
  expect(new URL(String(fetch.mock.calls[0]![0])).pathname).toBe(
    BOOTSTRAP_RELAY_IDENTITY_PATH,
  );
  await env.DB.prepare(
    "UPDATE node_installation_bindings SET inspection_generation=inspection_generation+1 WHERE operation_id=?",
  )
    .bind(f.id)
    .run();
  expect(
    (
      await f.request(
        "transport",
        JSON.stringify({ capability: "rescue_ssh", direction: "target" }),
      )
    ).status,
  ).toBe(403);
  expect(fetch).toHaveBeenCalledOnce();
});
it("records actual relay outcomes and rejects changed measurement binding without probe I/O", async () => {
  const f = await fixture(),
    epoch = crypto.randomUUID();
  const fetch = vi.fn(async (request: Request | URL) => {
    const url = request instanceof Request ? new URL(request.url) : request;
    if (url.pathname === BOOTSTRAP_RELAY_IDENTITY_PATH)
      return Response.json({
        v: 1,
        region: f.fixture.region,
        issuer_region: f.fixture.region,
        relay_epoch: epoch,
        capabilities: ["rescue_ssh", "talos_api", "kubernetes_api"],
        allowed_target_regions: [f.fixture.region],
      });
    expect(url.pathname).toBe(BOOTSTRAP_RELAY_PROBE_PATH);
    const token = (request as Request).headers.get(BOOTSTRAP_RELAY_HEADER)!;
    const claims = bootstrapRelayClaimsSchema.parse(
      JSON.parse(
        atob(token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/")),
      ),
    );
    return Response.json({
      version: 1,
      region_id: f.fixture.region,
      revision: claims.revision,
      operation_id: f.id,
      node_id: f.addition.intent.node_id,
      address: f.actual.ipConfig.v4.ip,
      port: claims.target.port,
      relay_epoch: epoch,
      source: f.relay.ipConfig.v4.ip,
      outcome: claims.target.port === 22 ? "connected" : "refused",
      observed_at: new Date().toISOString(),
    });
  });
  f.bindings.BOOTSTRAP_RELAY_SERVICE = { fetch } as unknown as Fetcher;
  const bad = { ...f.input.binding, plan_sha256: "f".repeat(64) };
  expect(
    (await f.request("access", JSON.stringify({ binding: bad }))).status,
  ).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
  const response = await f.request(
    "access",
    JSON.stringify({ binding: f.input.binding }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    kind: "access",
    access: [
      {
        relay_source: f.relay.ipConfig.v4.ip,
        checks: [
          { port: 22, outcome: "connected" },
          { port: 50000, outcome: "refused" },
          { port: 6443, outcome: "refused" },
        ],
      },
    ],
  });
  expect(fetch).toHaveBeenCalledTimes(4);
});
it("keeps captured pod UIDs and create intents immutable across proof cleanup retries", async () => {
  const f = await fixture(),
    session = f.session.claims.session_id;
  const state = {
    version: 1,
    input_hash: f.input.bootstrap.input_hash,
    plan_sha256: f.input.binding.plan_sha256,
    operation_id: f.id,
    session_id: session,
    namespace_name: "pgcf-postjoin-test",
    namespace_uid: crypto.randomUUID(),
    namespace_create_attempted: true,
    traffic_nonce: "a".repeat(64),
    stage: "running",
    pods: [
      {
        name: "capture",
        node_name: f.body.spec.hostname,
        node_uid: crypto.randomUUID(),
        uid: crypto.randomUUID(),
        role: "capture",
        create_attempted: true,
      },
    ],
  };
  await f.withStore((instance) =>
    instance.proofOwnership(f.id, session, {
      action: "save",
      kind: "postjoin",
      key: session,
      state,
    }),
  );
  await expect(
    f.withStore((instance) =>
      instance.proofOwnership(f.id, session, {
        action: "save",
        kind: "postjoin",
        key: session,
        state: {
          ...state,
          pods: [{ ...state.pods[0], uid: crypto.randomUUID() }],
        },
      }),
    ),
  ).rejects.toThrow("proof_ownership_identity_changed");
  await expect(
    f.withStore((instance) =>
      instance.proofOwnership(f.id, session, {
        action: "save",
        kind: "postjoin",
        key: session,
        state: { ...state, namespace_create_attempted: false },
      }),
    ),
  ).rejects.toThrow("proof_ownership_identity_changed");
});
it("settles the exact interrupted postjoin journal before starting a new session", async () => {
  const f = await fixture(),
    session = f.session.claims.session_id,
    previous = crypto.randomUUID();
  const old = {
    session_id: previous,
    state: {
      version: 1,
      session_id: previous,
      stage: "cleanup",
      namespace_uid: crypto.randomUUID(),
      traffic_nonce: "e".repeat(64),
    },
  };
  await f.withStore(async (_instance, state) => {
    await state.storage.put(`proof_owner:postjoin:${previous}`, old);
  });
  const found = await f.withStore((instance) =>
    instance.proofOwnership(f.id, session, {
      action: "read",
      kind: "postjoin",
      key: session,
    }),
  );
  expect(found).toEqual({ entry: old });
  await f.withStore((instance) =>
    instance.proofOwnership(f.id, session, {
      action: "save",
      kind: "postjoin",
      key: session,
      state: { ...old.state, stage: "cleaned" },
    }),
  );
  const remaining = await f.withStore((instance) =>
    instance.proofOwnership(f.id, session, {
      action: "expired",
      kind: "postjoin",
    }),
  );
  expect(remaining).toEqual({ entries: [] });
  expect(
    await f.withStore((instance) =>
      instance.proofOwnership(f.id, session, {
        action: "read",
        kind: "postjoin",
        key: session,
      }),
    ),
  ).toEqual({ entry: { ...old, state: { ...old.state, stage: "cleaned" } } });
});
it("passes the decrypted exact region seed to read-only TLS preparation without inventing a cluster UID", async () => {
  const f = await fixture();
  const selected = await sealedPodSource(f);
  await recordNodeInstallationInspection(f.bindings, f.id, 0, {
    ...f.inspection,
    network_plan_sha256: f.input.binding.plan_sha256,
  });
  await composeConfiguredNodeBootstrap(f.bindings, f.id, {
    provider: f.provider,
  });
  const seed = {
    version: f.bundle.version,
    cluster_name: f.bundle.cluster_name,
    cluster_endpoint: f.body.spec.cluster_endpoint,
    talos_version: f.bundle.talos_version,
    kubernetes_version: f.bundle.kubernetes_version,
    talos_machine_secrets_yaml: f.bundle.talos_machine_secrets_yaml,
    talos_admin_config: f.bundle.talos_admin_config,
  };
  const ref = await storeRegionSeed(
    env.DB,
    f.bindings.CREDENTIAL_KEYS,
    regionSeedReference(f.fixture.region, 1),
    seed,
  );
  await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET material_ref_json=? WHERE operation_id=?",
  )
    .bind(JSON.stringify(ref), f.id)
    .run();
  vi.spyOn(network, "ensureNodeFirewall").mockResolvedValue(true);
  vi.spyOn(sources, "selectNodeProofSource").mockResolvedValue(
    selected.input.source,
  );
  const input = await execution.prepareNodeProofInput(
    f.bindings,
    f.id,
    "preparation",
  );
  expect(input!.talos_admin_config).toBe(seed.talos_admin_config);
  expect(input!.cluster_bundle).toBeNull();
  await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET material_ref_json=? WHERE operation_id=?",
  )
    .bind(JSON.stringify({ ...ref, region_id: "foreign-region" }), f.id)
    .run();
  await expect(
    execution.prepareNodeProofInput(f.bindings, f.id, "preparation"),
  ).rejects.toMatchObject({ code: "forbidden" });
});
it("selects a proof source once then renews claims from its sealed association without provider calls", async () => {
  const f = await fixture(),
    selected = await sealedPodSource(f);
  await recordNodeInstallationInspection(f.bindings, f.id, 0, {
    ...f.inspection,
    network_plan_sha256: f.input.binding.plan_sha256,
  });
  await composeConfiguredNodeBootstrap(f.bindings, f.id, {
    provider: f.provider,
  });
  const provider = {
    getInstance: vi.fn(async (id: string) => {
      if (id === f.actual.id) return f.actual;
      if (id === selected.source.actual.id) return selected.source.actual;
      throw new Error("unexpected_lifecycle_provider_identity");
    }),
  };
  const first = await execution.prepareNodeProofInput(
    f.bindings,
    f.id,
    "preparation",
    {
      sourceSelection: { provider },
    },
  );
  expect(first?.source).toEqual({
    ...selected.input.source,
    image: f.profile.first_region!.regional_image,
  });
  expect(provider.getInstance).toHaveBeenCalledTimes(2);
  const boundaryCalls = provider.getInstance.mock.calls.length;
  provider.getInstance.mockRejectedValue(
    new Error("renewal_provider_forbidden"),
  );
  const association = execution.proofSourceBinding(first!);
  const renewed = await execution.prepareNodeProofInput(
    f.bindings,
    f.id,
    "preparation",
    {
      sourceBinding: association,
      sourceSelection: { provider },
    },
  );
  expect(renewed?.source).toEqual(first!.source);
  expect(renewed?.claims.session_id).not.toBe(first!.claims.session_id);
  expect(provider.getInstance).toHaveBeenCalledTimes(boundaryCalls);
  await storeRegionJoinBundle(
    env.DB,
    f.bindings.CREDENTIAL_KEYS,
    joinBundleReference(f.fixture.region, 1),
    {
      ...f.bundle,
      cluster_name: first!.bootstrap.spec.cluster_name,
      cluster_endpoint: first!.bootstrap.spec.cluster_endpoint,
    },
  );
  await env.DB.prepare(
    "UPDATE node_additions SET checkpoint_json=? WHERE operation_id=?",
  )
    .bind(
      JSON.stringify({
        stage: "joined",
        reference: "fixture:joined",
        saved_at: new Date().toISOString(),
        revision: 1,
      }),
      f.id,
    )
    .run();
  await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET checkpoint_json=json_set(checkpoint_json,'$.stage','awaiting_verification') WHERE operation_id=?",
  )
    .bind(f.id)
    .run();
  const postjoin = await execution.prepareNodeProofInput(
    f.bindings,
    f.id,
    "postjoin",
    {
      sourceBinding: association,
      sourceSelection: { provider },
    },
  );
  expect(postjoin?.claims.mode).toBe("postjoin");
  expect(postjoin?.source).toEqual(first!.source);
  expect(postjoin?.cluster_bundle?.kube_system_uid).toBe(
    f.bundle.kube_system_uid,
  );
  expect(provider.getInstance).toHaveBeenCalledTimes(boundaryCalls);
  await expect(
    execution.prepareNodeProofInput(f.bindings, f.id, "preparation", {
      sourceBinding: { ...association, binding_sha256: "0".repeat(64) },
      sourceSelection: { provider },
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(provider.getInstance).toHaveBeenCalledTimes(boundaryCalls);
});
it("dispatches proof continuation only after authenticated shared artifact verification", async () => {
  const f = await fixture();
  const result = {
    sha256: "a".repeat(64),
    operation_id: f.id,
    mode: "preparation" as const,
    verified: false,
  };
  const accept = vi
    .spyOn(artifacts, "acceptNodeProofReport")
    .mockResolvedValue(result);
  const start = vi.spyOn(nodes, "startAddNode").mockResolvedValue(undefined);
  const now = new Date().toISOString();
  const report = {
    binding: f.input.binding,
    postjoin: null,
    measurements: [
      {
        purpose: "pgcf-node-measurement/v1",
        kind: "access",
        binding_sha256: "b".repeat(64),
        observed_at: now,
        access: [
          {
            provider_instance_id: f.providerId,
            address: f.actual.ipConfig.v4.ip,
            relay_source: f.relay.ipConfig.v4.ip,
            observed_at: now,
            checks: [
              { port: 22, outcome: "connected" },
              { port: 50000, outcome: "refused" },
              { port: 6443, outcome: "refused" },
            ],
          },
        ],
      },
    ],
  };
  expect((await f.request("report", JSON.stringify(report))).status).toBe(200);
  expect(start).not.toHaveBeenCalled();
  accept.mockResolvedValue({ ...result, verified: true });
  expect((await f.request("report", JSON.stringify(report))).status).toBe(200);
  expect(start).toHaveBeenCalledExactlyOnceWith(f.bindings, f.id);
  expect(accept).toHaveBeenCalledWith(f.bindings, f.session.bearer, report);
});
it("waits for fresh observations of the retained source before issuing another proof", async () => {
  const f = await sourceGetterFixture(),
    first = await execution.prepareNodeProofInput(
      f.bindings,
      f.id,
      "preparation",
      {
        sourceBinding: f.association,
      },
    ),
    expired = await issueNodeProofSession(
      f.bindings,
      f.id,
      "preparation",
      Date.now() - 600_000,
    ),
    old = NodeProofExecutionInput.parse({
      ...first,
      claims: expired.claims,
      session_bearer: expired.bearer,
      control_keys: expired.control_keys,
    }),
    posts: NodeProofExecutionInput[] = [];
  const provider = vi
    .spyOn(ContaboClient.prototype, "getInstance")
    .mockRejectedValue(new Error("renewal_provider_forbidden"));
  const container = {
    running: true,
    start: vi.fn(),
    setInactivityTimeout: async () => {},
    getTcpPort: () => ({
      fetch: async (request: Request) => {
        if (request.method === "POST") {
          posts.push(NodeProofExecutionInput.parse(await request.json()));
          return new Response(null, { status: 202 });
        }
        return new URL(request.url).pathname === "/"
          ? new Response(null, { status: 401 })
          : Response.json({ status: "failed" });
      },
    }),
  };
  const beforeJob = await readBootstrapJob(env.DB, f.id);
  await f.withStore(async (instance, state) => {
    await state.storage.put(
      "inspection_server_binding_sha256",
      f.binding.row.binding_sha256,
    );
    await state.storage.put(
      "proof_current:preparation",
      expired.claims.session_id,
    );
    await state.storage.put(`proof_input:${expired.claims.session_id}`, old);
    Object.defineProperty(state, "container", {
      configurable: true,
      value: container,
    });
    try {
      await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
        .bind(
          new Date(Date.now() - 181_000).toISOString(),
          f.selected.source.fixture.node,
        )
        .run();
      expect(await instance.prove(f.id, "preparation")).toEqual({
        operation_id: f.id,
        status: "waiting",
      });
      expect(posts).toEqual([]);
      expect(await state.storage.get("proof_current:preparation")).toBe(
        expired.claims.session_id,
      );
      expect(await state.storage.get("proof_source_binding")).toEqual(
        f.association,
      );
      expect(await readBootstrapJob(env.DB, f.id)).toEqual(beforeJob);
      await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
        .bind(new Date().toISOString(), f.selected.source.fixture.node)
        .run();
      const result = await instance.prove(f.id, "preparation");
      expect(result).toMatchObject({ status: "running" });
      expect(posts).toHaveLength(1);
      expect(posts[0]!.claims.session_id).not.toBe(expired.claims.session_id);
      expect(Date.parse(posts[0]!.claims.expires_at)).toBeGreaterThan(
        Date.now(),
      );
      expect(posts[0]!.source).toEqual(f.association.source);
      expect(await state.storage.get("proof_source_binding")).toEqual(
        f.association,
      );
      expect(await readBootstrapJob(env.DB, f.id)).toEqual(beforeJob);
      expect(provider).not.toHaveBeenCalled();
      expect(container.start).not.toHaveBeenCalled();
      const source = f.association.source;
      if (source.kind !== "pod") throw new Error("fixture_pod_source_missing");
      await env.DB.prepare(
        "UPDATE nodes SET node_uid=?,last_observed_at=? WHERE id=?",
      )
        .bind(
          crypto.randomUUID(),
          new Date(Date.now() - 181_000).toISOString(),
          source.node_id,
        )
        .run();
      await expect(instance.prove(f.id, "preparation")).rejects.toMatchObject({
        code: "conflict",
      });
      await env.DB.prepare("UPDATE nodes SET node_uid=? WHERE id=?")
        .bind(source.node_uid, source.node_id)
        .run();
      await state.storage.put("proof_source_binding", {
        ...f.association,
        source: { ...source, cluster_uid: crypto.randomUUID() },
      });
      await expect(instance.prove(f.id, "preparation")).rejects.toMatchObject({
        code: "conflict",
      });
      await state.storage.put("proof_source_binding", f.association);
      await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
        .bind(new Date(Date.now() + 60_000).toISOString(), source.node_id)
        .run();
      await expect(instance.prove(f.id, "preparation")).rejects.toMatchObject({
        code: "conflict",
      });
      expect(posts).toHaveLength(1);
      expect(provider).not.toHaveBeenCalled();
      expect(await readBootstrapJob(env.DB, f.id)).toEqual(beforeJob);
    } finally {
      delete (state as { container?: unknown }).container;
    }
  });
});
it("coalesces running proof sessions without registering a replacement Container job", async () => {
  const f = await fixture();
  const prepare = vi
    .spyOn(execution, "prepareNodeProofInput")
    .mockResolvedValue(f.input);
  const start = vi.fn(),
    methods: string[] = [];
  let nativeStatus = "running";
  const container = {
    running: false,
    start: () => {
      container.running = true;
      start();
    },
    setInactivityTimeout: async () => {},
    getTcpPort: () => ({
      fetch: async (request: Request) => {
        methods.push(`${request.method} ${new URL(request.url).pathname}`);
        if (request.method === "POST")
          return new Response(null, { status: 202 });
        return new URL(request.url).pathname === "/"
          ? new Response(null, { status: 401 })
          : Response.json({ status: nativeStatus });
      },
    }),
  };
  async function invoke(mode: "preparation" | "postjoin" = "preparation") {
    return f.withStore(async (instance, state) => {
      Object.defineProperty(state, "container", {
        configurable: true,
        value: container,
      });
      try {
        return await instance.prove(f.id, mode);
      } finally {
        delete (state as { container?: unknown }).container;
      }
    });
  }
  await f.withStore(async (instance, state) => {
    Object.defineProperty(state, "container", {
      configurable: true,
      value: container,
    });
    try {
      const results = await Promise.all([
        instance.prove(f.id, "preparation"),
        instance.prove(f.id, "preparation"),
      ]);
      expect(results).toEqual([
        expect.objectContaining({ status: "running" }),
        expect.objectContaining({ status: "running" }),
      ]);
    } finally {
      delete (state as { container?: unknown }).container;
    }
  });
  expect(await invoke()).toMatchObject({ status: "running" });
  expect(start).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledOnce();
  expect(methods.filter((value) => value.startsWith("POST"))).toEqual([
    "POST /v1/proofs",
  ]);
  await f.withStore(async (_instance, state) => {
    expect(await state.storage.get("proof_source_binding")).toEqual(
      execution.proofSourceBinding(f.input),
    );
  });
  nativeStatus = "failed";
  const fresh = await issueNodeProofSession(f.bindings, f.id, "preparation");
  const renewed = NodeProofExecutionInput.parse({
    ...f.input,
    claims: fresh.claims,
    session_bearer: fresh.bearer,
    control_keys: fresh.control_keys,
  });
  prepare.mockResolvedValue(renewed);
  expect(await invoke()).toMatchObject({ status: "running" });
  expect(prepare).toHaveBeenLastCalledWith(f.bindings, f.id, "preparation", {
    sourceBinding: execution.proofSourceBinding(f.input),
  });
  await f.withStore(async (_instance, state) => {
    expect(await state.storage.get("proof_source_binding")).toEqual(
      execution.proofSourceBinding(f.input),
    );
    expect(await state.storage.get("proof_current:preparation")).toBe(
      fresh.claims.session_id,
    );
  });
});
it("rejects conflicting legacy proof source associations before selection or dispatch", async () => {
  const f = await fixture();
  const prepare = vi.spyOn(execution, "prepareNodeProofInput");
  const fresh = await issueNodeProofSession(f.bindings, f.id, "preparation");
  const conflicting = NodeProofExecutionInput.parse({
    ...f.input,
    claims: fresh.claims,
    session_bearer: fresh.bearer,
    control_keys: fresh.control_keys,
    source: { ...f.input.source, provider_instance_id: "98" },
  });
  const dispatch = vi.fn(async (request: Request) =>
    new URL(request.url).pathname === "/"
      ? new Response(null, { status: 401 })
      : Response.json({ status: "failed" }),
  );
  await f.withStore(async (instance, state) => {
    await state.storage.put(
      "proof_current:preparation",
      f.session.claims.session_id,
    );
    await state.storage.put("proof_current:postjoin", fresh.claims.session_id);
    await state.storage.put(
      `proof_input:${fresh.claims.session_id}`,
      conflicting,
    );
    Object.defineProperty(state, "container", {
      configurable: true,
      value: {
        running: false,
        start: () => {},
        setInactivityTimeout: async () => {},
        getTcpPort: () => ({ fetch: dispatch }),
      },
    });
    try {
      await expect(instance.prove(f.id, "preparation")).rejects.toThrow(
        "proof_source_binding_changed",
      );
      expect(await state.storage.get("proof_source_binding")).toBeUndefined();
    } finally {
      delete (state as { container?: unknown }).container;
    }
  });
  expect(prepare).not.toHaveBeenCalled();
  expect(
    dispatch.mock.calls.every(([request]) => request.method === "GET"),
  ).toBe(true);
});
it("refuses an authenticated arbitrary transport destination as an invalid request", async () => {
  const f = await fixture();
  expect(
    (
      await f.request(
        "transport",
        JSON.stringify({
          capability: "rescue_ssh",
          direction: "target",
          address: "198.51.100.7",
        }),
      )
    ).status,
  ).toBe(400);
});
