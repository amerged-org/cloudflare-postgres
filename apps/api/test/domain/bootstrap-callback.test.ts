// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bytesToBase64url,
  bytesToHex,
  newNodeId,
  newAgentKey,
  randomString,
} from "@pgcf/contracts";
import {
  NodeBootstrapAuthority,
  NodeBootstrapSpec,
  NodePlatformConfiguration,
} from "../../../../packages/contracts/src/node-bootstrap.ts";
import {
  configureNodeRegionPolicy,
  recordNodeAudit,
  recordNodeReceipt,
  reserveNodeAddition,
  readNodeAddition,
  saveNodeBootstrapCheckpoint,
} from "../../src/domain/node-state.ts";
import {
  bootstrapJobInput,
  configureBootstrapJob,
  readBootstrapJob,
  type NodeBootstrapConfiguration,
} from "../../src/domain/bootstrap-jobs.ts";
import {
  bootstrapSpecHash,
  openBootstrapInput,
  sealBootstrapInput,
} from "../../src/crypto/bootstrap-tickets.ts";
import { createApp } from "../../src/app.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";
import type { Env } from "../../src/env.ts";
import { issueBootstrapTransport } from "../../src/domain/bootstrap-relay.ts";
import {
  importBootstrapVerificationKeys,
  verifyBootstrapRelay,
} from "../../../../packages/contracts/src/bootstrap-relay.ts";
import {
  ContaboClient,
  type ContaboInstance,
} from "../../src/providers/contabo.ts";
import {
  joinBundleReference,
  storeRegionJoinBundle,
} from "../../src/crypto/bootstrap-credentials.ts";
import { finalizeNodeAdmission } from "../../src/domain/bootstrap-jobs.ts";
import {
  verifyNodeCapacity,
  verifyNodeNetwork,
} from "../../src/domain/node-state.ts";

afterEach(cleanupFixtures);
const hash = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const exportBytes = (bytes: ArrayBuffer | JsonWebKey) => {
  if (!(bytes instanceof ArrayBuffer))
    throw new Error("test_key_export_invalid");
  return new Uint8Array(bytes);
};
const standard64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const canonicalConfiguration = (value: unknown): string =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonicalConfiguration).join(",")}]`
      : `{${Object.keys(value)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${canonicalConfiguration((value as Record<string, unknown>)[key])}`,
          )
          .join(",")}}`;
type BeforeBootstrapConfiguration = (value: {
  addition: Awaited<ReturnType<typeof reserveNodeAddition>>;
  configuration: NodeBootstrapConfiguration;
  bindings: Env;
}) => Promise<void>;
async function prepared(
  withPlatform = true,
  beforeConfigure?: BeforeBootstrapConfiguration,
) {
  const f = await fixture();
  await env.DB.prepare("DELETE FROM nodes WHERE id=?").bind(f.node).run();
  await env.DB.prepare("UPDATE regions SET provider_region='EU' WHERE id=?")
    .bind(f.region)
    .run();
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 1,
    purchases_enabled: false,
    order: null,
  });
  const instance = String(BigInt("1" + randomString("0123456789", 9)));
  let addition = await reserveNodeAddition(env.DB, {
    request_key: crypto.randomUUID(),
    request: {
      region_id: f.region,
      mode: "adopt",
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
      provider_region: "EU",
      product_id: crypto.randomUUID(),
      image_id: crypto.randomUUID(),
      reference: crypto.randomUUID(),
      observed_at: new Date().toISOString(),
    },
  );
  const address = [
      192,
      0,
      2,
      17 + (crypto.getRandomValues(new Uint8Array(1))[0]! % 200),
    ].join("."),
    gateway = [192, 0, 2, 1].join(".");
  const keyBlob = new Uint8Array(51),
    view = new DataView(keyBlob.buffer);
  view.setUint32(0, 11);
  keyBlob.set(new TextEncoder().encode("ssh-ed25519"), 4);
  view.setUint32(15, 32);
  keyBlob.set(crypto.getRandomValues(new Uint8Array(32)), 19);
  const fingerprint =
    "SHA256:" +
    standard64(
      new Uint8Array(await crypto.subtle.digest("SHA-256", keyBlob)),
    ).replaceAll("=", "");
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("test_key_pair_invalid");
  const privateKey = standard64(
    exportBytes(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  );
  const rescue = {
    ssh_private_key: `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`,
    ssh_host_key: "ssh-ed25519 " + standard64(keyBlob),
    ssh_host_fingerprint: fingerprint,
  };
  const platform = withPlatform
    ? NodePlatformConfiguration.parse({
        version: 1,
        region_id: f.region,
        api_host: ["api", "invalid"].join("."),
        agent_key: newAgentKey(f.region),
        route_keyring: env.ROUTE_MASTER_KEYS,
        tunnel_token: randomString("abcdefghijklmnopqrstuvwxyz0123456789", 64),
        backup_s3: {
          access_key_id: randomString(
            "abcdefghijklmnopqrstuvwxyz0123456789",
            32,
          ),
          secret_access_key: randomString(
            "abcdefghijklmnopqrstuvwxyz0123456789",
            64,
          ),
        },
      })
    : undefined;
  const spec = NodeBootstrapSpec.parse({
    version: 1,
    operation_id: addition.intent.operation_id,
    node_id: addition.intent.node_id,
    region_id: f.region,
    provider_instance_id: instance,
    inventory_revision: addition.revision,
    role: "controlplane",
    hostname: addition.intent.requested_hostname,
    rescue_host_fingerprint: fingerprint,
    hardware: {
      mac: Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(":"),
      ipv4: address,
      prefix_length: 24,
      gateway,
      dns: [gateway],
      install_disk: "/dev/sda",
      disk_bytes: 64 * 2 ** 30,
      rescue_ram_min_bytes: 2 ** 30,
    },
    image: {
      schematic_id: hash(),
      compressed_sha256: hash(),
      compressed_bytes: 512,
      raw_sha256: hash(),
      raw_bytes: 1024,
      installer_digest: "sha256:" + hash(),
    },
    storage: { ephemeral_gib: 4, lvm_gib: 8 },
    cluster_name: "cluster-" + randomString("abcdefghijklmnopqrstuvwxyz", 8),
    cluster_endpoint: `https://${address}:6443`,
    cluster_uid: null,
    join_bundle_sha256: null,
    ...(platform
      ? {
          platform: {
            reviewed_commit: bytesToHex(
              crypto.getRandomValues(new Uint8Array(20)),
            ),
            regional_image: "registry.invalid/pgcf@sha256:" + hash(),
            configuration_sha256: bytesToHex(
              new Uint8Array(
                await crypto.subtle.digest(
                  "SHA-256",
                  new TextEncoder().encode(canonicalConfiguration(platform)),
                ),
              ),
            ),
          },
        }
      : {}),
    transport: {
      mode: "relay",
      issuer_region_id: f.region,
    },
  });
  const bindings = {
    ...env,
    NODE_BOOTSTRAP_CALLBACK_URL: `https://${["api", "invalid"].join(".")}/`,
  } as Env;
  const configuration = {
    expected_revision: addition.revision,
    spec,
    rescue,
    ...(platform ? { platform } : {}),
  };
  if (!beforeConfigure) {
    const value = { addition, configuration, bindings };
    const plan = peerPlan(value);
    delete configuration.spec.peer_ipv4;
    await storePeerPlan(value, plan, { status: "verified" });
  }
  await beforeConfigure?.({ addition, configuration, bindings });
  await configureBootstrapJob(
    bindings,
    addition.intent.operation_id,
    configuration,
  );
  const job = await readBootstrapJob(env.DB, addition.intent.operation_id),
    input = await bootstrapJobInput(bindings, job);
  const identity = {
    version: 1,
    operation_id: job.operation_id,
    node_id: job.node_id,
    region_id: job.region_id,
    input_hash: job.input_hash,
    request_id: crypto.randomUUID(),
  };
  return { ...f, addition, job, input, spec, bindings, identity };
}
type PeerConfiguration = Parameters<BeforeBootstrapConfiguration>[0];
const approvedPeers = ["192.0.2.2", "198.51.100.3", "198.51.100.4"];
function peerPlan(value: PeerConfiguration) {
  const { addition, configuration, bindings } = value;
  const target = configuration.spec;
  bindings.BOOTSTRAP_RELAY_PROVIDER_INSTANCE_ID = "10001";
  bindings.BOOTSTRAP_RELAY_ISSUER_REGION = target.region_id;
  configuration.spec = NodeBootstrapSpec.parse({
    ...target,
    peer_ipv4: approvedPeers,
  });
  const addresses = (ipv4: string[]) => ({ ipv4, ipv6: [] });
  const member = (
    node_id: string,
    provider_instance_id: string,
    ipv4: string[],
  ) => ({
    node_id,
    provider_instance_id,
    firewall_id: crypto.randomUUID(),
    addresses: addresses(ipv4),
    primary: addresses(ipv4.slice(0, 1)),
    ownership_sha256: hash(),
    rules: { rules: { inbound: [] } },
    rules_sha256: hash(),
  });
  return {
    version: 1,
    operation_id: target.operation_id,
    node_id: target.node_id,
    region_id: target.region_id,
    provider_instance_id: target.provider_instance_id,
    intent_hash: addition.intent_hash,
    operators: addresses(["203.0.113.1/32"]),
    relay: {
      provider_instance_id: bindings.BOOTSTRAP_RELAY_PROVIDER_INSTANCE_ID,
      addresses: addresses(["192.0.2.2", "198.51.100.3"]),
    },
    scan_control: { ipv4: "203.0.113.2", ipv6: "2001:db8::2", port: 443 },
    members: [
      member(target.node_id, target.provider_instance_id, [
        target.hardware.ipv4,
      ]),
      member(newNodeId(), "10002", ["198.51.100.4", "198.51.100.3"]),
    ],
  };
}
async function storePeerPlan(
  value: PeerConfiguration,
  plan: ReturnType<typeof peerPlan>,
  options: { status?: string; digest?: string } = {},
) {
  const json = canonicalConfiguration(plan);
  const digest =
    options.digest ??
    bytesToHex(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json)),
      ),
    );
  const now = new Date().toISOString();
  const verified = options.status === "verified";
  await env.DB.prepare(
    "INSERT INTO node_network_preparations(operation_id,intent_hash,plan_sha256,plan_json,status,readback_at,proof_sha256,proof_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      value.addition.intent.operation_id,
      value.addition.intent_hash,
      digest,
      json,
      options.status ?? "awaiting_proof",
      verified ? now : null,
      verified ? hash() : null,
      verified ? new Date(Date.now() + 300_000).toISOString() : null,
      now,
      now,
    )
    .run();
}
describe("bootstrap peer routes", () => {
  it("seals exactly the immutable regional and relay IPv4 peers", async () => {
    const f = await prepared(true, async (value) => {
      await storePeerPlan(value, peerPlan(value));
    });
    expect(f.input.spec.peer_ipv4).toEqual(approvedPeers);
  });
  it("refuses peer routes when the immutable network plan is missing", async () => {
    let operation = "";
    await expect(
      prepared(true, async (value) => {
        operation = value.addition.intent.operation_id;
        peerPlan(value);
      }),
    ).rejects.toThrow("Peer routes require the immutable network preparation");
    expect(
      await env.DB.prepare(
        "SELECT 1 present FROM node_bootstrap_jobs WHERE operation_id=?",
      )
        .bind(operation)
        .first(),
    ).toBeNull();
  });
  it("refuses an omitted approved peer before sealing", async () => {
    await expect(
      prepared(true, async (value) => {
        await storePeerPlan(value, peerPlan(value));
        value.configuration.spec.peer_ipv4 = approvedPeers.slice(0, -1);
      }),
    ).rejects.toThrow(
      "Peer routes differ from the immutable network preparation",
    );
  });
  it("refuses a forged peer outside the approved plan", async () => {
    await expect(
      prepared(true, async (value) => {
        await storePeerPlan(value, peerPlan(value));
        value.configuration.spec.peer_ipv4 = [
          ...approvedPeers,
          "203.0.113.200",
        ];
      }),
    ).rejects.toThrow(
      "Peer routes differ from the immutable network preparation",
    );
  });
  it("refuses a blocked preparation", async () => {
    await expect(
      prepared(true, async (value) => {
        await storePeerPlan(value, peerPlan(value), { status: "blocked" });
      }),
    ).rejects.toThrow("Peer routes require the immutable network preparation");
  });
  it("checks the full canonical plan digest", async () => {
    await expect(
      prepared(true, async (value) => {
        await storePeerPlan(value, peerPlan(value), { digest: hash() });
      }),
    ).rejects.toThrow("Peer routes require the immutable network preparation");
  });
  it("binds the plan to the node addition intent", async () => {
    await expect(
      prepared(true, async (value) => {
        const plan = peerPlan(value);
        plan.intent_hash = hash();
        await storePeerPlan(value, plan);
      }),
    ).rejects.toThrow("Peer routes require the immutable network preparation");
  });
  it("binds the relay to the configured provider identity", async () => {
    await expect(
      prepared(true, async (value) => {
        await storePeerPlan(value, peerPlan(value));
        value.bindings.BOOTSTRAP_RELAY_PROVIDER_INSTANCE_ID = "10003";
      }),
    ).rejects.toThrow("Peer routes require the immutable network preparation");
  });
  it("requires the actual target IPv4 in its network member", async () => {
    await expect(
      prepared(true, async (value) => {
        const plan = peerPlan(value);
        plan.members[0]!.addresses.ipv4 = ["203.0.113.250"];
        await storePeerPlan(value, plan);
      }),
    ).rejects.toThrow("Peer routes require the immutable network preparation");
  });
  it("bounds the number of IPv4 addresses parsed per member", async () => {
    await expect(
      prepared(true, async (value) => {
        const plan = peerPlan(value);
        plan.members[1]!.addresses.ipv4.push(
          "198.51.100.5",
          "198.51.100.6",
          "198.51.100.7",
        );
        await storePeerPlan(value, plan);
      }),
    ).rejects.toThrow("Peer routes require the immutable network preparation");
  });
});
async function callback(
  f: Awaited<ReturnType<typeof prepared>>,
  value: unknown,
  key = f.input.callback.bearer,
  bindings = f.bindings,
) {
  const context = createExecutionContext();
  const response = await createApp().fetch(
    new Request(f.input.callback.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    }),
    bindings,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}
describe("protected bootstrap authority", () => {
  it("lets a joined worker skip platform installation while a control plane cannot", async () => {
    const f = await prepared();
    const previous = {
      ...JSON.parse(f.job.checkpoint_json),
      stage: "kubernetes_joined",
    };
    await env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET checkpoint_json=? WHERE operation_id=?",
    )
      .bind(JSON.stringify(previous), f.job.operation_id)
      .run();
    const next = {
      ...previous,
      stage: "awaiting_verification",
      status: "awaiting_verification",
    };
    const envelope = {
      ...f.identity,
      kind: "checkpoint",
      expected_revision: 0,
      payload: next,
    };
    expect((await callback(f, envelope)).status).toBe(409);
    const workerData = {
      ...f.spec,
      role: "worker",
      cluster_uid: crypto.randomUUID(),
      join_bundle_sha256: hash(),
    };
    delete workerData.platform;
    const workerSpec = NodeBootstrapSpec.parse(workerData);
    const inputHash = await bootstrapSpecHash(workerSpec);
    const workerInput = {
      ...f.input,
      spec: workerSpec,
      input_hash: inputHash,
      join_bundle: {
        version: 1 as const,
        cluster_name: workerSpec.cluster_name,
        cluster_endpoint: workerSpec.cluster_endpoint,
        talos_version: "1.14.1" as const,
        kubernetes_version: "1.36.3" as const,
        talos_machine_secrets_yaml: randomString(
          "abcdefghijklmnopqrstuvwxyz",
          32,
        ),
        talos_admin_config: randomString("abcdefghijklmnopqrstuvwxyz", 32),
        kube_system_uid: workerSpec.cluster_uid!,
        kubeconfig: randomString("abcdefghijklmnopqrstuvwxyz", 32),
      },
    };
    delete workerInput.platform;
    const ticket = await sealBootstrapInput(env.CREDENTIAL_KEYS, workerInput);
    const workerRow = {
      ...f.job,
      checkpoint_json: JSON.stringify(previous),
      input_hash: inputHash,
      input_ciphertext: ticket.ciphertext,
      input_iv: ticket.iv,
      input_kid: ticket.kid,
    };
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM node_bootstrap_jobs WHERE operation_id=?",
      ).bind(f.job.operation_id),
      env.DB.prepare(
        `INSERT INTO node_bootstrap_jobs(${Object.keys(workerRow).join(",")}) VALUES(${Object.keys(
          workerRow,
        )
          .map(() => "?")
          .join(",")})`,
      ).bind(...Object.values(workerRow)),
    ]);
    expect(
      (await callback(f, { ...envelope, input_hash: inputHash })).status,
    ).toBe(200);
  });
  it("seals first-region platform secrets and rejects an altered private configuration", async () => {
    const f = await prepared(true);
    expect(f.input.platform?.region_id).toBe(f.region);
    expect(f.input.platform?.agent_key).toMatch(/^pgcf_ak_/);
    expect(JSON.stringify(f.job)).not.toContain(f.input.platform!.agent_key);
    await expect(
      configureBootstrapJob(f.bindings, f.identity.operation_id, {
        expected_revision: f.addition.revision,
        spec: f.spec,
        rescue: f.input.rescue,
        ...{
          platform: {
            ...f.input.platform!,
            tunnel_token: randomString(
              "abcdefghijklmnopqrstuvwxyz0123456789",
              64,
            ),
          },
        },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const persisted = await readBootstrapJob(env.DB, f.identity.operation_id);
    expect(persisted.input_ciphertext).toBe(f.job.input_ciphertext);
  });
  it("seals private input with operation, digest, revision and key domain separation", async () => {
    const f = await prepared();
    const ticket = await sealBootstrapInput(env.CREDENTIAL_KEYS, f.input);
    expect(JSON.stringify(ticket)).not.toContain(
      f.input.rescue.ssh_private_key,
    );
    expect(await openBootstrapInput(env.CREDENTIAL_KEYS, ticket)).toEqual(
      f.input,
    );
    await expect(
      openBootstrapInput(env.CREDENTIAL_KEYS, {
        ...ticket,
        operation_id:
          f.addition.intent.operation_id.slice(0, -1) +
          (f.addition.intent.operation_id.endsWith("a") ? "b" : "a"),
      }),
    ).rejects.toThrow();
    await expect(
      openBootstrapInput(env.CREDENTIAL_KEYS, {
        ...ticket,
        revision: ticket.revision + 1,
      }),
    ).rejects.toThrow();
    await expect(
      sealBootstrapInput(env.CREDENTIAL_KEYS, {
        ...f.input,
        spec: { ...f.spec, hostname: "node-" + crypto.randomUUID() },
      }),
    ).rejects.toThrow();
    expect(await bootstrapSpecHash(f.spec)).toBe(f.input.input_hash);
  });
  it("authenticates before private body collection and binds the exact admitted operation", async () => {
    const f = await prepared();
    const large = {
      ...f.identity,
      kind: "read",
      padding: crypto.randomUUID().repeat(16_000),
    };
    expect((await callback(f, large, crypto.randomUUID())).status).toBe(401);
    expect(
      (await callback(f, { ...f.identity, kind: "read", node_id: newNodeId() }))
        .status,
    ).toBe(403);
    const response = await callback(f, { ...f.identity, kind: "read" });
    expect(response.status).toBe(200);
    const authority = NodeBootstrapAuthority.parse(await response.json());
    expect(authority.input_hash).toBe(f.input.input_hash);
    expect(authority.admission_authorized).toBe(false);
    expect(authority.protected_material).toBeNull();
    await env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET authorized=0 WHERE operation_id=?",
    )
      .bind(f.job.operation_id)
      .run();
    expect((await callback(f, { ...f.identity, kind: "read" })).status).toBe(
      403,
    );
  });
  it("accepts a bounded protected seal above the public 64 KiB limit and returns only a custody reference", async () => {
    const f = await prepared(),
      canary = crypto.randomUUID().repeat(2200);
    const material = {
      version: 1,
      cluster_name: f.spec.cluster_name,
      cluster_endpoint: f.spec.cluster_endpoint,
      talos_version: "1.14.1",
      kubernetes_version: "1.36.3",
      talos_machine_secrets_yaml: canary,
      talos_admin_config: crypto.randomUUID(),
    };
    const response = await callback(f, {
      ...f.identity,
      kind: "seal",
      expected_revision: 0,
      payload: { purpose: "region_seed", material },
    });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(canary);
    const authority = NodeBootstrapAuthority.parse(
      await (await callback(f, { ...f.identity, kind: "read" })).json(),
    );
    expect(authority.revision).toBe(1);
    expect(
      authority.protected_material?.material.talos_machine_secrets_yaml,
    ).toBe(canary);
    const publicStatus = await (
      await request(
        `/v1/nodes/additions/${f.job.operation_id}/bootstrap`,
        f.admin,
      )
    ).text();
    expect(publicStatus).not.toContain(canary);
    expect(publicStatus).not.toContain(f.input.callback.bearer);
    expect(publicStatus).not.toContain(f.input.rescue.ssh_private_key);
    expect(
      (
        await callback(f, {
          ...f.identity,
          kind: "checkpoint",
          expected_revision: 0,
          payload: authority.checkpoint,
        })
      ).status,
    ).toBe(409);
  });
  it("refuses arbitrary transport targets and untrusted relay identity", async () => {
    const f = await prepared();
    const service = {
      fetch: vi.fn(async () =>
        Response.json({
          v: 1,
          region: f.foreign,
          issuer_region: f.foreign,
          relay_epoch: crypto.randomUUID(),
          allowed_target_regions: [f.region],
          capabilities: ["rescue_ssh", "talos_api", "kubernetes_api"],
        }),
      ),
    };
    const settings = {
      ...f.bindings,
      BOOTSTRAP_RELAY_SERVICE: service as unknown as Fetcher,
      BOOTSTRAP_RELAY_URL: `https://${["relay", "invalid"].join(".")}/_pgcf/bootstrap-relay`,
      BOOTSTRAP_RELAY_ISSUER_REGION: f.region,
    };
    expect(
      (
        await callback(
          f,
          {
            ...f.identity,
            kind: "transport",
            payload: {
              capability: "rescue_ssh",
              host: "forged-" + crypto.randomUUID(),
            },
          },
          undefined,
          settings,
        )
      ).status,
    ).toBe(400);
    expect(service.fetch).not.toHaveBeenCalled();
    await expect(
      issueBootstrapTransport(settings, f.job, { capability: "rescue_ssh" }),
    ).rejects.toThrow(
      "Trusted relay identity is outside the configured operation scope",
    );
    service.fetch.mockClear();
    expect(
      (
        await callback(
          f,
          {
            ...f.identity,
            kind: "transport",
            payload: {
              capability: "rescue_ssh",
            },
          },
          undefined,
          settings,
        )
      ).status,
    ).toBe(409);
    expect(service.fetch).toHaveBeenCalledTimes(1);
  });
  it("authenticates operation relay upgrades before touching the private VPC binding", async () => {
    const f = await prepared(),
      forward = vi.fn(async (request: Request) => {
        expect(request.headers.get("Upgrade")).toBe("websocket");
        return new Response(null, { status: 204 });
      });
    const claims = {
      v: 1,
      purpose: "bootstrap",
      operation: f.job.operation_id,
      node: f.job.node_id,
      region: f.region,
      issuer_region: f.region,
      relay_epoch: crypto.randomUUID(),
      revision: 1,
      capability: "rescue_ssh",
      target: { address: f.spec.hardware.ipv4, port: 22 },
      nonce: bytesToBase64url(crypto.getRandomValues(new Uint8Array(24))),
      kid: "test",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 30,
    };
    const token = `br1.${bytesToBase64url(new TextEncoder().encode(JSON.stringify(claims)))}.${bytesToBase64url(crypto.getRandomValues(new Uint8Array(64)))}`;
    const settings = {
      ...f.bindings,
      BOOTSTRAP_RELAY_SERVICE: { fetch: forward } as unknown as Fetcher,
      BOOTSTRAP_RELAY_URL: `https://${["relay", "invalid"].join(".")}/_pgcf/bootstrap-relay`,
    };
    const upgrade = async (key: string) => {
      const context = createExecutionContext();
      const response = await createApp().fetch(
        new Request(
          new URL(
            `/internal/v1/node-bootstrap/${f.job.operation_id}/relay`,
            f.input.callback.url,
          ),
          {
            headers: {
              Authorization: `Bearer ${key}`,
              Upgrade: "websocket",
              "X-PGCF-Bootstrap": token,
            },
          },
        ),
        settings,
        context,
      );
      await waitOnExecutionContext(context);
      return response;
    };
    expect((await upgrade(crypto.randomUUID())).status).toBe(401);
    expect(forward).not.toHaveBeenCalled();
    expect((await upgrade(f.input.callback.bearer)).status).toBe(204);
    expect(forward).toHaveBeenCalledTimes(1);
    const forwarded = forward.mock.calls[0]![0] as Request;
    expect(forwarded.headers.get("X-PGCF-Bootstrap")).toBe(token);
    expect(forwarded.headers.has("Authorization")).toBe(false);
    forward.mockClear();
    await env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET admitted=1,authorized=0 WHERE operation_id=?",
    )
      .bind(f.job.operation_id)
      .run();
    expect((await upgrade(f.input.callback.bearer)).status).toBe(403);
    expect(forward).not.toHaveBeenCalled();
  });
  it("signs a fresh trusted relay epoch after replacement while preserving the same immutable job hash", async () => {
    const f = await prepared(),
      firstEpoch = crypto.randomUUID(),
      secondEpoch = crypto.randomUUID();
    let epoch = firstEpoch;
    const service = {
      fetch: vi.fn(async () =>
        Response.json({
          v: 1,
          region: f.region,
          issuer_region: f.region,
          relay_epoch: epoch,
          allowed_target_regions: [f.region],
          capabilities: ["rescue_ssh", "talos_api", "kubernetes_api"],
        }),
      ),
    };
    const pair = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    if (!("privateKey" in pair)) throw new Error("test_key_pair_invalid");
    const privateKey = bytesToBase64url(
        exportBytes(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
      ),
      publicKey = bytesToBase64url(
        exportBytes(await crypto.subtle.exportKey("raw", pair.publicKey)),
      );
    const settings = {
      ...f.bindings,
      BOOTSTRAP_RELAY_SERVICE: service as unknown as Fetcher,
      BOOTSTRAP_RELAY_URL: `https://${["relay", "invalid"].join(".")}/_pgcf/bootstrap-relay`,
      BOOTSTRAP_RELAY_ISSUER_REGION: f.region,
      BOOTSTRAP_RELAY_SIGNING_KEYS: JSON.stringify({
        active: "test",
        keys: { test: privateKey },
      }),
    };
    await env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET rescue_active=1 WHERE operation_id=?",
    )
      .bind(f.job.operation_id)
      .run();
    const row = await readBootstrapJob(env.DB, f.job.operation_id);
    const actual: ContaboInstance = {
      id: f.spec.provider_instance_id,
      tenantId: crypto.randomUUID(),
      customerId: crypto.randomUUID(),
      name: f.spec.hostname,
      displayName: f.spec.hostname,
      dataCenter: crypto.randomUUID(),
      region: "EU",
      regionName: crypto.randomUUID(),
      productId: f.addition.audit!.product_id,
      productName: crypto.randomUUID(),
      imageId: f.addition.audit!.image_id,
      ipConfig: {
        v4: {
          ip: f.spec.hardware.ipv4,
          gateway: f.spec.hardware.gateway,
          netmaskCidr: f.spec.hardware.prefix_length,
        },
        v6: { ip: "", gateway: "", netmaskCidr: 0 },
      },
      ramMb: 8192,
      cpuCores: 4,
      diskMb: 64000,
      macAddress: f.spec.hardware.mac,
      osType: "Linux",
      sshKeys: [],
      createdDate: new Date().toISOString(),
      cancelDate: "",
      status: "rescue",
      addOns: [],
      applicationId: null,
      additionalIps: [],
    };
    const provider = { getInstance: vi.fn(async () => actual) };
    const first = await issueBootstrapTransport(
      settings,
      row,
      { capability: "rescue_ssh" },
      provider,
    );
    epoch = secondEpoch;
    const second = await issueBootstrapTransport(
      settings,
      row,
      { capability: "rescue_ssh" },
      provider,
    );
    const keys = await importBootstrapVerificationKeys({ test: publicKey }),
      expected = {
        keys,
        region: f.region,
        issuer_region: f.region,
        allowedTargetRegions: [f.region],
      };
    expect(
      (
        await verifyBootstrapRelay(first.token, {
          ...expected,
          relay_epoch: firstEpoch,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await verifyBootstrapRelay(first.token, {
          ...expected,
          relay_epoch: secondEpoch,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await verifyBootstrapRelay(second.token, {
          ...expected,
          relay_epoch: secondEpoch,
        })
      ).ok,
    ).toBe(true);
    expect(first.token).not.toBe(second.token);
    const platformTransport = await issueBootstrapTransport(
      settings,
      {
        ...row,
        checkpoint_json: JSON.stringify({
          ...JSON.parse(row.checkpoint_json),
          stage: "cilium_install_intent",
        }),
      },
      { capability: "kubernetes_api" },
      provider,
    );
    expect(
      (
        await verifyBootstrapRelay(platformTransport.token, {
          ...expected,
          relay_epoch: secondEpoch,
        })
      ).ok,
    ).toBe(true);
    expect(
      (await readBootstrapJob(env.DB, f.job.operation_id)).input_hash,
    ).toBe(f.job.input_hash);
    const url = new URL(second.websocket_url);
    expect(url.origin).toBe(
      new URL(f.input.callback.url).origin.replace(/^https:/, "wss:"),
    );
    expect(url.pathname).toBe(
      `/internal/v1/node-bootstrap/${f.job.operation_id}/relay`,
    );
    expect(url.search).toBe("");
  });
  it("refuses unsigned verification artifacts before any provider request or quarantine release", async () => {
    const f = await prepared();
    const addition = await saveNodeBootstrapCheckpoint(
      env.DB,
      f.job.operation_id,
      f.addition.revision,
      {
        stage: "joined",
        reference: `${f.job.input_hash}:0`,
        saved_at: new Date(Date.now() - 1000).toISOString(),
      },
    );
    const now = new Date().toISOString(),
      artifact = {
        kid: "test",
        payload: {
          purpose: "pgcf-node-verification/v1",
          operation_id: f.job.operation_id,
          node_id: f.job.node_id,
          region_id: f.region,
          provider_instance_id: f.spec.provider_instance_id,
          intent_hash: addition.intent_hash,
          input_hash: f.job.input_hash,
          checkpoint_reference: addition.checkpoint!.reference,
          cluster_uid: crypto.randomUUID(),
          node_uid: crypto.randomUUID(),
          node_resource_version: "1",
          observed_at: now,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          addresses: { ipv4: f.spec.hardware.ipv4, ipv6: null },
          wireguard: { mode: "wireguard", peers: [], packet_observations: [] },
          scans: [
            {
              family: "ipv4",
              address: f.spec.hardware.ipv4,
              source: [198, 51, 100, 1].join("."),
              observed_at: now,
              scanned_ports: 65535,
              open_ports: [],
              control: {
                address: [198, 51, 100, 2].join("."),
                port: 443,
                connected: true,
              },
            },
          ],
        },
        signature: bytesToBase64url(crypto.getRandomValues(new Uint8Array(64))),
      };
    const pair = await crypto.subtle.generateKey("Ed25519", true, [
        "sign",
        "verify",
      ]),
      publicKey = bytesToBase64url(
        exportBytes(
          await crypto.subtle.exportKey(
            "raw",
            "publicKey" in pair
              ? pair.publicKey
              : (() => {
                  throw new Error("test_key_pair_invalid");
                })(),
          ),
        ),
      );
    const proofKey = `node-verification/${f.job.operation_id}/${addition.checkpoint!.reference}/proof.json`,
      bytes = new TextEncoder().encode(JSON.stringify(artifact));
    await env.ARCHIVE.put(proofKey, bytes);
    try {
      const context = createExecutionContext();
      const response = await createApp().fetch(
        new Request(
          new URL(
            `/v1/nodes/additions/${f.job.operation_id}/verify`,
            f.input.callback.url,
          ),
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${f.admin}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              expected_revision: addition.revision,
              sha256: bytesToHex(
                new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
              ),
            }),
          },
        ),
        {
          ...f.bindings,
          BOOTSTRAP_VERIFIER_KEYS: JSON.stringify({ test: publicKey }),
        },
        context,
      );
      await waitOnExecutionContext(context);
      expect(response.status).toBe(403);
      expect(
        (await readBootstrapJob(env.DB, f.job.operation_id))
          .admission_authorized,
      ).toBe(0);
    } finally {
      await env.ARCHIVE.delete(proofKey);
    }
  });
  it("compares signed inventory and refreshes admission revisions only before release intent", async () => {
    const f = await prepared(),
      uid = crypto.randomUUID(),
      clusterUid = crypto.randomUUID(),
      now = new Date().toISOString();
    const addition = await saveNodeBootstrapCheckpoint(
      env.DB,
      f.job.operation_id,
      f.addition.revision,
      {
        stage: "joined",
        reference: `${f.job.input_hash}:0`,
        saved_at: new Date(Date.now() - 1000).toISOString(),
      },
    );
    await storeRegionJoinBundle(
      env.DB,
      env.CREDENTIAL_KEYS,
      joinBundleReference(f.region, 1),
      {
        version: 1,
        cluster_name: f.spec.cluster_name,
        cluster_endpoint: f.spec.cluster_endpoint,
        kube_system_uid: clusterUid,
        talos_version: "1.14.1",
        kubernetes_version: "1.36.3",
        talos_machine_secrets_yaml: crypto.randomUUID(),
        talos_admin_config: crypto.randomUUID(),
        kubeconfig: crypto.randomUUID(),
      },
    );
    await env.DB.prepare(
      "INSERT INTO nodes(id,region_id,k8s_node_name,provider_instance_id,node_uid,ready,schedulable,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at) VALUES(?,?,?,?,?,1,0,4096,2000,30,128,100,?,?,?)",
    )
      .bind(
        f.job.node_id,
        f.region,
        f.spec.hostname,
        f.spec.provider_instance_id,
        uid,
        now,
        now,
        now,
      )
      .run();
    const pair = await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ]);
    if (!("privateKey" in pair)) throw new Error("test_key_pair_invalid");
    const actual = {
      ipConfig: {
        v4: { ip: f.spec.hardware.ipv4 },
        v6: { ip: "2001:0DB8:0000:0000:0000:0000:0000:0042" },
      },
      additionalIps: [],
    } as unknown as ContaboInstance;
    const provider = vi
        .spyOn(ContaboClient.prototype, "getInstance")
        .mockResolvedValue(actual),
      workflow = { create: vi.fn(async () => ({})) },
      proofKey = `node-verification/${f.job.operation_id}/${addition.checkpoint!.reference}/proof.json`;
    let expectedRevision = addition.revision;
    const submit = async (
      ipv6: string | null = "2001:db8::42",
      resourceVersion = "12",
    ) => {
      const payload = {
        purpose: "pgcf-node-verification/v1",
        operation_id: f.job.operation_id,
        node_id: f.job.node_id,
        region_id: f.region,
        provider_instance_id: f.spec.provider_instance_id,
        intent_hash: addition.intent_hash,
        input_hash: f.job.input_hash,
        checkpoint_reference: addition.checkpoint!.reference,
        cluster_uid: clusterUid,
        node_uid: uid,
        node_resource_version: resourceVersion,
        observed_at: now,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        addresses: { ipv4: f.spec.hardware.ipv4, ipv6 },
        wireguard: { mode: "wireguard", peers: [], packet_observations: [] },
        scans: [
          { family: "ipv4", address: f.spec.hardware.ipv4 },
          ...(ipv6 === null ? [] : [{ family: "ipv6", address: ipv6 }]),
        ].map((scan) => ({
          ...scan,
          source: scan.family === "ipv4" ? "198.51.100.1" : "2001:db8:1::1",
          observed_at: now,
          scanned_ports: 65535,
          open_ports: [],
          control: { address: "198.51.100.2", port: 443, connected: true },
        })),
      };
      const signature = bytesToBase64url(
          exportBytes(
            await crypto.subtle.sign(
              "Ed25519",
              pair.privateKey,
              new TextEncoder().encode(
                `pgcf-node-verification/v1\n${canonicalConfiguration(payload)}`,
              ),
            ),
          ),
        ),
        bytes = new TextEncoder().encode(
          JSON.stringify({ kid: "test", payload, signature }),
        );
      await env.ARCHIVE.put(proofKey, bytes);
      const context = createExecutionContext(),
        response = await createApp().fetch(
          new Request(
            new URL(
              `/v1/nodes/additions/${f.job.operation_id}/verify`,
              f.input.callback.url,
            ),
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${f.admin}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                expected_revision: expectedRevision,
                sha256: bytesToHex(
                  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
                ),
              }),
            },
          ),
          {
            ...f.bindings,
            ADD_NODE: workflow as unknown as Env["ADD_NODE"],
            CONTABO_CLIENT_ID: crypto.randomUUID(),
            CONTABO_CLIENT_SECRET: crypto.randomUUID(),
            CONTABO_USERNAME: crypto.randomUUID(),
            CONTABO_PASSWORD: crypto.randomUUID(),
            BOOTSTRAP_VERIFIER_KEYS: JSON.stringify({
              test: bytesToBase64url(
                exportBytes(
                  await crypto.subtle.exportKey("raw", pair.publicKey),
                ),
              ),
            }),
          },
          context,
        );
      await waitOnExecutionContext(context);
      if (response.status === 202)
        expectedRevision = (
          (await response.clone().json()) as { revision: number }
        ).revision;
      return response;
    };
    const reject = async (
      ipv6?: string | null,
      message = "Proof addresses differ from current provider inventory",
    ) => {
      const response = await submit(ipv6);
      expect(response.status).toBe(409);
      expect(
        ((await response.json()) as { error: { message: string } }).error
          .message,
      ).toBe(message);
      expect(
        (await readBootstrapJob(env.DB, f.job.operation_id))
          .admission_authorized,
      ).toBe(0);
      expect(workflow.create).not.toHaveBeenCalled();
    };
    try {
      actual.ipConfig.v4.ip = "192.0.2.250";
      if (actual.ipConfig.v4.ip === f.spec.hardware.ipv4)
        actual.ipConfig.v4.ip = "192.0.2.251";
      await reject();
      actual.ipConfig.v4.ip = f.spec.hardware.ipv4;
      actual.ipConfig.v6!.ip = "2001:db8::43";
      await reject();
      actual.ipConfig.v6!.ip = "";
      await reject();
      delete actual.ipConfig.v6;
      await reject();
      actual.ipConfig.v6 = {
        ip: "2001:0DB8:0000:0000:0000:0000:0000:0042",
        gateway: "",
        netmaskCidr: 64,
      };
      await reject(null);
      actual.ipConfig.v6.ip = "2001:db8::42";
      actual.additionalIps = [
        { v4: { ...actual.ipConfig.v4, ip: "198.51.100.250" } },
      ];
      await reject(
        undefined,
        "Additional provider addresses require complete verified outside-allowlist scan coverage",
      );
      actual.additionalIps = [
        { v4: { ...actual.ipConfig.v4, ip: f.spec.hardware.ipv4 } },
        { v4: { ...actual.ipConfig.v4, ip: "" } },
      ];
      actual.ipConfig.v6.ip = "2001:0DB8:0000:0000:0000:0000:0000:0042";
      const accepted = await submit();
      expect(accepted.status).toBe(202);
      expect(
        (await readBootstrapJob(env.DB, f.job.operation_id))
          .admission_authorized,
      ).toBe(1);
      expect(workflow.create).toHaveBeenCalledOnce();
      expect(
        (await env.DB.prepare("SELECT schedulable FROM nodes WHERE id=?")
          .bind(f.job.node_id)
          .first<{ schedulable: number }>())!.schedulable,
      ).toBe(0);
      const before = await readBootstrapJob(env.DB, f.job.operation_id);
      const checkpoint = {
        ...JSON.parse(before.checkpoint_json),
        stage: "awaiting_verification",
        status: "awaiting_verification",
      };
      await env.DB.prepare(
        "UPDATE node_bootstrap_jobs SET checkpoint_json=? WHERE operation_id=?",
      )
        .bind(JSON.stringify(checkpoint), f.job.operation_id)
        .run();
      expect((await submit(undefined, "13")).status).toBe(202);
      const refreshed = await readBootstrapJob(env.DB, f.job.operation_id);
      const binding = JSON.parse(refreshed.admission_binding_json!);
      expect(binding.resource_version).toBe("13");
      expect(binding.node_uid).toBe(uid);
      expect(binding.kube_system_uid).toBe(clusterUid);
      expect(binding.checkpoint_revision).toBe(0);

      const differentIdentity = { ...binding, node_uid: crypto.randomUUID() };
      await env.DB.prepare(
        "UPDATE node_bootstrap_jobs SET admission_binding_json=? WHERE operation_id=?",
      )
        .bind(JSON.stringify(differentIdentity), f.job.operation_id)
        .run();
      expect((await submit(undefined, "14")).status).toBe(409);
      expect(
        JSON.parse(
          (await readBootstrapJob(env.DB, f.job.operation_id))
            .admission_binding_json!,
        ),
      ).toEqual(differentIdentity);
      await env.DB.prepare(
        "UPDATE node_bootstrap_jobs SET admission_binding_json=? WHERE operation_id=?",
      )
        .bind(JSON.stringify(binding), f.job.operation_id)
        .run();

      const release = {
        ...checkpoint,
        stage: "quarantine_release_intent",
        release_node_uid: uid,
        release_resource_version: "13",
      };
      await env.DB.prepare(
        "UPDATE node_bootstrap_jobs SET checkpoint_json=?,revision=revision+1 WHERE operation_id=?",
      )
        .bind(JSON.stringify(release), f.job.operation_id)
        .run();
      expect((await submit(undefined, "14")).status).toBe(202);
      expect(
        (await readBootstrapJob(env.DB, f.job.operation_id))
          .admission_binding_json,
      ).toBe(JSON.stringify(binding));

      const released = {
        ...release,
        stage: "quarantine_released",
        status: "released",
        admission_receipt: {
          version: 1,
          operation_id: f.job.operation_id,
          node_id: f.job.node_id,
          region_id: f.region,
          input_hash: f.job.input_hash,
          checkpoint_revision: 0,
          node_uid: uid,
          kube_system_uid: clusterUid,
          previous_resource_version: "13",
          resource_version: "14",
          quarantine_removed: true,
        },
      };
      await env.DB.prepare(
        "UPDATE node_bootstrap_jobs SET checkpoint_json=?,revision=revision+1 WHERE operation_id=?",
      )
        .bind(JSON.stringify(released), f.job.operation_id)
        .run();
      expect((await submit(undefined, "15")).status).toBe(202);
      const completedRelease = await readBootstrapJob(
        env.DB,
        f.job.operation_id,
      );
      expect(completedRelease.admission_binding_json).toBe(
        JSON.stringify(binding),
      );
      expect(
        JSON.parse(completedRelease.checkpoint_json).admission_receipt,
      ).toEqual(released.admission_receipt);

      await env.DB.prepare(
        "UPDATE node_bootstrap_jobs SET checkpoint_json=? WHERE operation_id=?",
      )
        .bind(JSON.stringify(checkpoint), f.job.operation_id)
        .run();
      provider.mockImplementationOnce(async () => {
        await env.DB.prepare(
          "UPDATE node_bootstrap_jobs SET checkpoint_json=?,revision=revision+1 WHERE operation_id=?",
        )
          .bind(JSON.stringify(release), f.job.operation_id)
          .run();
        return actual;
      });
      expect((await submit(undefined, "15")).status).toBe(409);
      const raced = await readBootstrapJob(env.DB, f.job.operation_id);
      expect(raced.admission_binding_json).toBe(JSON.stringify(binding));
      expect(JSON.parse(raced.checkpoint_json).stage).toBe(
        "quarantine_release_intent",
      );
      expectedRevision = (await readNodeAddition(env.DB, f.job.operation_id))
        .revision;
      await env.DB.prepare(
        "UPDATE node_bootstrap_jobs SET checkpoint_json=? WHERE operation_id=?",
      )
        .bind(JSON.stringify(checkpoint), f.job.operation_id)
        .run();
      provider.mockImplementationOnce(async () => {
        await env.DB.prepare(
          "UPDATE node_bootstrap_jobs SET cancelled=1 WHERE operation_id=?",
        )
          .bind(f.job.operation_id)
          .run();
        return actual;
      });
      expect((await submit(undefined, "16")).status).toBe(409);
      const cancelled = await readBootstrapJob(env.DB, f.job.operation_id);
      expect(cancelled.cancelled).toBe(1);
      expect(cancelled.admission_binding_json).toBe(JSON.stringify(binding));
    } finally {
      provider.mockRestore();
      await env.ARCHIVE.delete(proofKey);
    }
  });
  it("publishes only after an exact persisted native release receipt and closes callback custody", async () => {
    const f = await prepared(),
      uid = crypto.randomUUID(),
      clusterUid = crypto.randomUUID(),
      now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO nodes(id,region_id,k8s_node_name,provider_instance_id,node_uid,ready,schedulable,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at) VALUES(?,?,?,?,?,1,0,4096,2000,30,128,100,?,?,?)",
    )
      .bind(
        f.job.node_id,
        f.region,
        f.spec.hostname,
        f.spec.provider_instance_id,
        uid,
        now,
        now,
        now,
      )
      .run();
    let addition = await saveNodeBootstrapCheckpoint(
      env.DB,
      f.job.operation_id,
      f.addition.revision,
      { stage: "joined", reference: `${f.job.input_hash}:0`, saved_at: now },
    );
    const scope = {
      operation_id: f.job.operation_id,
      node_id: f.job.node_id,
      intent_hash: addition.intent_hash,
      checkpoint_reference: addition.checkpoint!.reference,
      proof_reference: crypto.randomUUID(),
    };
    addition = await verifyNodeNetwork(
      env.DB,
      f.job.operation_id,
      addition.revision,
      { ...scope, verified_at: now },
    );
    await verifyNodeCapacity(env.DB, f.job.operation_id, addition.revision, {
      ...scope,
      observed_at: now,
      allocatable_memory_mib: 4096,
      allocatable_cpu_millicores: 2000,
      storage_gib_total: 30,
      platform_reserved_memory_mib: 128,
      platform_reserved_cpu_millicores: 100,
    });
    const binding = {
      checkpoint_revision: 0,
      node_uid: uid,
      resource_version: "12",
      kube_system_uid: clusterUid,
      quarantine: {
        key: "pgcf.io/quarantine",
        value: "bootstrap",
        effect: "NoSchedule",
      },
    };
    const checkpoint = {
      ...JSON.parse(f.job.checkpoint_json),
      stage: "awaiting_verification",
      status: "awaiting_verification",
    };
    await env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET checkpoint_json=?,admission_authorized=1,admission_binding_json=?,admission_expires_at=? WHERE operation_id=?",
    )
      .bind(
        JSON.stringify(checkpoint),
        JSON.stringify(binding),
        new Date(Date.now() + 60_000).toISOString(),
        f.job.operation_id,
      )
      .run();
    expect(await finalizeNodeAdmission(f.bindings, f.job.operation_id)).toBe(
      false,
    );
    const intent = {
      ...checkpoint,
      stage: "quarantine_release_intent",
      status: "running",
      release_node_uid: uid,
      release_resource_version: binding.resource_version,
    };
    expect(
      (
        await callback(f, {
          ...f.identity,
          kind: "checkpoint",
          expected_revision: 0,
          payload: intent,
        })
      ).status,
    ).toBe(200);
    const receipt = {
      version: 1,
      operation_id: f.job.operation_id,
      node_id: f.job.node_id,
      region_id: f.region,
      input_hash: f.job.input_hash,
      checkpoint_revision: 0,
      node_uid: uid,
      kube_system_uid: clusterUid,
      previous_resource_version: binding.resource_version,
      resource_version: "13",
      quarantine_removed: true,
    };
    expect(
      (
        await callback(f, {
          ...f.identity,
          kind: "checkpoint",
          expected_revision: 1,
          payload: {
            ...intent,
            stage: "quarantine_released",
            status: "released",
            admission_receipt: { ...receipt, node_uid: crypto.randomUUID() },
          },
        })
      ).status,
    ).toBe(409);
    expect(
      await env.DB.prepare("SELECT schedulable FROM nodes WHERE id=?")
        .bind(f.job.node_id)
        .first("schedulable"),
    ).toBe(0);
    expect(
      (
        await callback(f, {
          ...f.identity,
          kind: "checkpoint",
          expected_revision: 1,
          payload: {
            ...intent,
            stage: "quarantine_released",
            status: "released",
            admission_receipt: receipt,
          },
        })
      ).status,
    ).toBe(200);
    expect(await finalizeNodeAdmission(f.bindings, f.job.operation_id)).toBe(
      true,
    );
    expect(
      await env.DB.prepare("SELECT schedulable FROM nodes WHERE id=?")
        .bind(f.job.node_id)
        .first("schedulable"),
    ).toBe(1);
    expect((await callback(f, { ...f.identity, kind: "read" })).status).toBe(
      403,
    );
  });
});
