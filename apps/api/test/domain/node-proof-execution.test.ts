// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { bytesToBase64url, newNodeId } from "@pgcf/contracts";
import { NodeProofExecutionInput } from "@pgcf/contracts/node-proof";
import {
  bootstrapRelayClaimsSchema,
  BOOTSTRAP_RELAY_IDENTITY_PATH,
  BOOTSTRAP_RELAY_PROBE_PATH,
  BOOTSTRAP_RELAY_HEADER,
} from "@pgcf/contracts/bootstrap-relay";
import { createApp } from "../../src/app.ts";
import { NodeBootstrap } from "../../src/bootstrap-container.ts";
import { issueNodeProofSession } from "../../src/domain/node-proof-session.ts";
import { installationHash } from "../../src/domain/node-installation.ts";
import { boundInstallationFixture } from "./installation-fixtures.ts";
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
} from "../../src/crypto/bootstrap-credentials.ts";

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
it("authenticates every private proof POST before malformed body parsing", async () => {
  const f = await fixture();
  for (const path of ["transport", "access", "report", "ownership"])
    expect((await f.request(path, "{", "invalid")).status).toBe(401);
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
  const response = await f.request(
    "transport",
    JSON.stringify({ capability: "rescue_ssh", direction: "target" }),
  );
  expect(response.status).toBe(200);
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
  vi.spyOn(sources, "selectNodeProofSource").mockResolvedValue(f.input.source);
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
it("coalesces running proof sessions without registering a replacement Container job", async () => {
  const f = await fixture();
  const prepare = vi
    .spyOn(execution, "prepareNodeProofInput")
    .mockResolvedValue(f.input);
  const start = vi.fn(),
    methods: string[] = [];
  const container = {
    running: false,
    start,
    setInactivityTimeout: async () => {},
    getTcpPort: () => ({
      fetch: async (request: Request) => {
        methods.push(`${request.method} ${new URL(request.url).pathname}`);
        if (request.method === "POST")
          return new Response(null, { status: 202 });
        return new URL(request.url).pathname === "/"
          ? new Response(null, { status: 401 })
          : Response.json({ status: "running" });
      },
    }),
  };
  async function invoke() {
    return f.withStore(async (instance, state) => {
      Object.defineProperty(state, "container", {
        configurable: true,
        value: container,
      });
      try {
        return await instance.prove(f.id, "preparation");
      } finally {
        delete (state as { container?: unknown }).container;
      }
    });
  }
  expect(await invoke()).toMatchObject({ status: "running" });
  container.running = true;
  expect(await invoke()).toMatchObject({ status: "running" });
  expect(start).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledOnce();
  expect(methods.filter((value) => value.startsWith("POST"))).toEqual([
    "POST /v1/proofs",
  ]);
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
