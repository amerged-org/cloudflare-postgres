// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ContaboClient,
  ContaboRescueInput,
} from "../../src/providers/contabo.ts";
import * as network from "../../src/domain/node-network.ts";
import {
  configureNodeRegionPolicy,
  reserveNodeAddition,
  recordNodeReceipt,
  recordNodeAudit,
} from "../../src/domain/node-state.ts";
import { ensureNodeRescue } from "../../src/workflows/add-node.ts";
import { cleanupFixtures, fixture } from "./fixtures.ts";
import { configureBootstrapJob } from "../../src/domain/bootstrap-jobs.ts";
import {
  auditedRescueConfiguration,
  generateRescueHostIdentity,
} from "./rescue-fixtures.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
async function hostIdentity() {
  const identity = await generateRescueHostIdentity();
  return {
    ssh_host_key: identity.ssh_host_key,
    ssh_host_fingerprint: identity.ssh_host_fingerprint,
    user_data: `#cloud-config\nssh_keys:\n  ed25519_public: '${identity.ssh_host_key}'\n`,
  };
}
async function setup() {
  const f = await fixture();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: false,
    order: null,
  });
  const instance = String(1 + crypto.getRandomValues(new Uint32Array(1))[0]!);
  let addition = await reserveNodeAddition(env.DB, {
    request_key: crypto.randomUUID(),
    request: {
      mode: "adopt",
      region_id: f.region,
      provider_instance_id: instance,
    },
  });
  addition = await recordNodeReceipt(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      provider_instance_id: instance,
      request_id: null,
      reference: crypto.randomUUID(),
      received_at: new Date().toISOString(),
    },
  );
  addition = await recordNodeAudit(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      provider_instance_id: instance,
      provider_region: "test",
      product_id: crypto.randomUUID(),
      image_id: crypto.randomUUID(),
      reference: crypto.randomUUID(),
      observed_at: new Date().toISOString(),
    },
  );
  vi.spyOn(network, "ensureNodeFirewall").mockResolvedValue(true);
  const calls: ContaboRescueInput[] = [];
  const get = vi.fn(async () => ({ id: instance, status: "running" }) as never);
  const rescue = vi.fn<ContaboClient["rescue"]>(async (_id, input) => {
    calls.push(input);
    return { kind: "accepted", code: "accepted", value: {} } as never;
  });
  const provider = {
    getInstance: get,
    rescue,
    actionAudits: vi.fn(async () => []),
  };
  const settings = {
    ...env,
    CONTABO_RESCUE_SSH_KEY_IDS: JSON.stringify(["17"]),
  };
  return {
    ...f,
    addition,
    instance,
    calls,
    provider,
    settings,
    entry: await hostIdentity(),
  };
}

it("passes exact plain cloud-config user data once in the existing rescue dispatch", async () => {
  const f = await setup();
  const settings = {
    ...f.settings,
    CONTABO_RESCUE_CONFIGURATION: JSON.stringify({ [f.instance]: f.entry }),
  };
  expect(
    await ensureNodeRescue(
      settings,
      f.addition.intent.operation_id,
      f.provider,
    ),
  ).toBe(false);
  expect(f.calls).toEqual([{ sshKeys: ["17"], userData: f.entry.user_data }]);
  expect(
    await ensureNodeRescue(
      settings,
      f.addition.intent.operation_id,
      f.provider,
    ),
  ).toBe(false);
  expect(f.provider.rescue).toHaveBeenCalledTimes(1);
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM node_provider_mutations WHERE operation_id=? AND mutation='rescue'",
    )
      .bind(f.addition.intent.operation_id)
      .first("count"),
  ).toBe(1);
});

it("blocks a missing configured target before any provider mutation claim", async () => {
  const f = await setup();
  const settings = { ...f.settings, CONTABO_RESCUE_CONFIGURATION: "{}" };
  await expect(
    ensureNodeRescue(settings, f.addition.intent.operation_id, f.provider),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(f.provider.getInstance).not.toHaveBeenCalled();
  expect(f.provider.rescue).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM node_provider_mutations WHERE operation_id=?",
    )
      .bind(f.addition.intent.operation_id)
      .first("count"),
  ).toBe(0);
});

it("refuses an altered Ed25519 fingerprint before claiming or dispatching rescue", async () => {
  const f = await setup();
  const other = await hostIdentity();
  const settings = {
    ...f.settings,
    CONTABO_RESCUE_CONFIGURATION: JSON.stringify({
      [f.instance]: {
        ...f.entry,
        ssh_host_fingerprint: other.ssh_host_fingerprint,
      },
    }),
  };
  await expect(
    ensureNodeRescue(settings, f.addition.intent.operation_id, f.provider),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(f.provider.rescue).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM node_provider_mutations WHERE operation_id=?",
    )
      .bind(f.addition.intent.operation_id)
      .first("count"),
  ).toBe(0);
});

it("rejects a malformed OpenSSH blob even when its fingerprint matches its exact bytes", async () => {
  const f = await setup();
  const blob = Uint8Array.from(
    atob(f.entry.ssh_host_key.split(" ")[1]!),
    (character) => character.charCodeAt(0),
  );
  new DataView(blob.buffer).setUint32(0, 12);
  const malformed = {
    ...f.entry,
    ssh_host_key: `ssh-ed25519 ${base64(blob)}`,
    ssh_host_fingerprint: `SHA256:${base64(new Uint8Array(await crypto.subtle.digest("SHA-256", blob))).replaceAll("=", "")}`,
  };
  const settings = {
    ...f.settings,
    CONTABO_RESCUE_CONFIGURATION: JSON.stringify({ [f.instance]: malformed }),
  };
  await expect(
    ensureNodeRescue(settings, f.addition.intent.operation_id, f.provider),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(f.provider.rescue).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM node_provider_mutations WHERE operation_id=?",
    )
      .bind(f.addition.intent.operation_id)
      .first("count"),
  ).toBe(0);
});

it("checks actual sealed job host identities against the selected rescue configuration before dispatch", async () => {
  const f = await auditedRescueConfiguration();
  const settings = {
    ...env,
    NODE_BOOTSTRAP_CALLBACK_URL: "https://api.invalid",
    CONTABO_RESCUE_SSH_KEY_IDS: JSON.stringify(["17"]),
  };
  const job = await configureBootstrapJob(
    settings,
    f.addition.intent.operation_id,
    f.body,
  );
  const configured = await hostIdentity();
  const bindings = {
    ...settings,
    CONTABO_RESCUE_CONFIGURATION: JSON.stringify({
      [f.providerId]: configured,
    }),
  };
  const get = vi.fn(
    async () => ({ id: f.providerId, status: "running" }) as never,
  );
  const rescue = vi.fn<ContaboClient["rescue"]>(async () => {
    throw new Error("unexpected_rescue_dispatch");
  });
  await expect(
    ensureNodeRescue(bindings, f.addition.intent.operation_id, {
      getInstance: get,
      rescue,
      actionAudits: vi.fn(async () => []),
    }),
  ).rejects.toMatchObject({ code: "conflict" });
  expect(get).not.toHaveBeenCalled();
  expect(rescue).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) count FROM node_provider_mutations WHERE operation_id=?",
    )
      .bind(f.addition.intent.operation_id)
      .first("count"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT input_hash FROM node_bootstrap_jobs WHERE operation_id=?",
    )
      .bind(f.addition.intent.operation_id)
      .first("input_hash"),
  ).toBe(job.input_hash);
});
