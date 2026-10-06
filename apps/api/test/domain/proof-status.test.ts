// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { bytesToBase64url, newNodeId } from "@pgcf/contracts";
import { NodeProofExecutionInput } from "@pgcf/contracts/node-proof";
import { NodeBootstrap } from "../../src/bootstrap-container.ts";
import { issueNodeProofSession } from "../../src/domain/node-proof-session.ts";
import {
  installationHash,
  recordNodeInstallationInspection,
} from "../../src/domain/node-installation.ts";
import { configureBootstrapJob } from "../../src/domain/bootstrap-jobs.ts";
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
  await recordNodeInstallationInspection(f.bindings, id, 0, f.inspection);
  await configureBootstrapJob(f.bindings, id, f.body);
  await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET authorized=1 WHERE operation_id=?",
  )
    .bind(id)
    .run();
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
  const response = {
    operation_id: id,
    mode: "preparation",
    session_id: input.claims.session_id,
    status: "failed",
    error_code: "node_proof_scan_failed",
  };
  const fetch = vi.fn(async (request: Request) => {
    expect(request.method).toBe("GET");
    return Response.json(response);
  });
  const container = {
    running: true,
    start: vi.fn(),
    setInactivityTimeout: vi.fn(),
    getTcpPort: vi.fn(() => ({ fetch })),
  };
  const status = () =>
    withStore(async (instance, state) => {
      const old = Object.getOwnPropertyDescriptor(state, "container");
      Object.defineProperty(state, "container", {
        value: container,
        configurable: true,
      });
      try {
        return await (
          instance as NodeBootstrap & {
            proofStatus(
              id: string,
              mode: "preparation",
            ): Promise<Record<string, unknown>>;
          }
        ).proofStatus(id, "preparation");
      } finally {
        if (old) Object.defineProperty(state, "container", old);
        else delete (state as { container?: unknown }).container;
      }
    });
  await withStore(async (_instance, state) => {
    await state.storage.put(
      "proof_current:preparation",
      input.claims.session_id,
    );
    await state.storage.put(
      "inspection_server_binding_sha256",
      f.binding.row.binding_sha256,
    );
  });
  return {
    ...f,
    id,
    input,
    session,
    withStore,
    response,
    fetch,
    container,
    status,
  };
}

it("reads the existing preparation failure without starting work, altering the stored session or issuing a new proof", async () => {
  const f = await fixture();
  const before = await env.DB.prepare(
    "SELECT * FROM node_bootstrap_jobs WHERE operation_id=?",
  )
    .bind(f.id)
    .first();
  expect(await f.status()).toEqual({
    operation_id: f.id,
    mode: "preparation",
    session_id: f.session.claims.session_id,
    binding_sha256: f.binding.row.binding_sha256,
    plan_sha256: f.input.claims.plan_sha256,
    input_hash: f.input.claims.input_hash,
    status: "failed",
    error_code: "node_proof_scan_failed",
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  const request = f.fetch.mock.calls[0]![0];
  expect(new URL(request.url).pathname).toBe(`/v1/proofs/${f.id}/preparation`);
  expect(request.headers.get("Authorization")).toBe(
    `Bearer ${f.binding.inspection_token}`,
  );
  expect(request.body).toBeNull();
  expect(f.container.start).not.toHaveBeenCalled();
  expect(f.container.setInactivityTimeout).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare(
      "SELECT * FROM node_bootstrap_jobs WHERE operation_id=?",
    )
      .bind(f.id)
      .first(),
  ).toEqual(before);
  await f.withStore(async (_instance, state) => {
    expect(await state.storage.get("proof_current:preparation")).toBe(
      f.session.claims.session_id,
    );
    expect(
      await state.storage.get(`proof_input:${f.session.claims.session_id}`),
    ).toEqual(f.input);
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

it("does not query a stopped container or mint a missing stored session", async () => {
  const f = await fixture();
  f.container.running = false;
  expect(await f.status()).toMatchObject({
    status: "unavailable",
    error_code: "proof_status_unavailable",
  });
  await f.withStore(async (_instance, state) => {
    await state.storage.delete("proof_current:preparation");
  });
  expect(await f.status()).toMatchObject({
    status: "unavailable",
    error_code: "proof_input_required",
    session_id: null,
  });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.container.start).not.toHaveBeenCalled();
});

it("rejects a foreign native session and arbitrary native error text without exposing it or retrying", async () => {
  const f = await fixture();
  f.response.session_id = crypto.randomUUID();
  expect(await f.status()).toMatchObject({
    status: "unavailable",
    error_code: "proof_status_invalid",
  });
  f.response.session_id = f.session.claims.session_id;
  const secret = crypto.randomUUID();
  f.response.error_code = secret;
  const status = await f.status();
  expect(status).toMatchObject({
    status: "unavailable",
    error_code: "proof_status_invalid",
  });
  expect(JSON.stringify(status)).not.toContain(secret);
  expect(f.fetch).toHaveBeenCalledTimes(2);
});

it("rechecks the current network authority after native I/O before returning a proof result", async () => {
  const f = await fixture();
  f.fetch.mockImplementationOnce(async () => {
    await env.DB.prepare(
      "UPDATE node_network_preparations SET status='blocked' WHERE operation_id=?",
    )
      .bind(f.id)
      .run();
    return Response.json(f.response);
  });
  expect(await f.status()).toMatchObject({
    status: "unavailable",
    error_code: "proof_status_invalid",
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

it("refuses a job whose cancellation raced the native read", async () => {
  const f = await fixture();
  f.fetch.mockImplementationOnce(async () => {
    await env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET cancelled=1 WHERE operation_id=?",
    )
      .bind(f.id)
      .run();
    return Response.json(f.response);
  });
  expect(await f.status()).toMatchObject({
    status: "unavailable",
    error_code: "proof_authority_closed",
  });
  expect(f.container.start).not.toHaveBeenCalled();
});

it("rejects a changed stored session input before native I/O", async () => {
  const f = await fixture();
  await f.withStore(async (_instance, state) => {
    await state.storage.put(`proof_input:${f.session.claims.session_id}`, {
      ...f.input,
      claims: { ...f.input.claims, binding_sha256: "e".repeat(64) },
    });
  });
  expect(await f.status()).toMatchObject({
    status: "unavailable",
    error_code: "proof_status_invalid",
  });
  expect(f.fetch).not.toHaveBeenCalled();
});

it("bounds the native response body at two KiB", async () => {
  const f = await fixture();
  f.fetch.mockImplementationOnce(async () => new Response("x".repeat(2049)));
  expect(await f.status()).toMatchObject({
    status: "unavailable",
    error_code: "proof_status_invalid",
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

it("bounds a stalled native fetch at five seconds without starting work", async () => {
  const f = await fixture(),
    abort = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(abort.signal);
  let began!: () => void;
  const fetching = new Promise<void>((resolve) => {
    began = resolve;
  });
  f.fetch.mockImplementationOnce(async () => {
    began();
    return new Promise<Response>(() => {});
  });
  const pending = f.status();
  await fetching;
  expect(timeout).toHaveBeenCalledWith(5000);
  abort.abort();
  expect(await pending).toMatchObject({
    status: "unavailable",
    error_code: "proof_status_unavailable",
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.container.start).not.toHaveBeenCalled();
});

it("bounds a stalled native response stream with the same deadline", async () => {
  const f = await fixture(),
    abort = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(abort.signal);
  let reading!: () => void;
  const began = new Promise<void>((resolve) => {
    reading = resolve;
  });
  f.fetch.mockImplementationOnce(
    async () =>
      new Response(
        new ReadableStream({
          pull() {
            reading();
            return new Promise<void>(() => {});
          },
        }),
      ),
  );
  const pending = f.status();
  await began;
  abort.abort();
  expect(await pending).toMatchObject({
    status: "unavailable",
    error_code: "proof_status_unavailable",
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.container.start).not.toHaveBeenCalled();
});

it("refuses a replaced current session after native I/O without returning the stale result", async () => {
  const f = await fixture();
  f.fetch.mockImplementationOnce(async () => {
    await f.withStore(async (_instance, state) => {
      await state.storage.put("proof_current:preparation", crypto.randomUUID());
    });
    return Response.json(f.response);
  });
  expect(await f.status()).toMatchObject({
    status: "unavailable",
    error_code: "proof_status_invalid",
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
});
