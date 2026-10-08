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
  hasBootstrapNetworkAuthority,
  establishBootstrapNetworkAuthority,
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
  ensureNodeRescue,
  ensureBootstrapNetworkBoundary,
} from "../../src/workflows/add-node.ts";
import * as network from "../../src/domain/node-network.ts";
import {
  importBootstrapVerificationKeys,
  verifyBootstrapRelay,
} from "../../../../packages/contracts/src/bootstrap-relay.ts";
import {
  ContaboClient,
  type ContaboInstance,
  type ContaboFirewall,
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
afterEach(() => vi.restoreAllMocks());
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

it("records a quarantined storage trial once and refuses replacing its Node ownership on resume", async () => {
  const f = await prepared();
  const checkpoint = {
    ...JSON.parse(f.job.checkpoint_json),
    stage: "regional_ready",
  };
  await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET checkpoint_json=? WHERE operation_id=?",
  )
    .bind(JSON.stringify(checkpoint), f.job.operation_id)
    .run();
  const nodeUid = crypto.randomUUID(),
    lvmUid = crypto.randomUUID(),
    vgUid = crypto.randomUUID();
  const before = {
    observed_at: new Date().toISOString(),
    node_uid: nodeUid,
    lvmnode_uid: lvmUid,
    resource_version: "31",
    vg_uuid: vgUid,
    size: 30 * 1024 ** 3,
    free: 30 * 1024 ** 3,
  };
  const trial = {
    version: 1,
    input_hash: f.job.input_hash,
    node_uid: nodeUid,
    cluster_uid: crypto.randomUUID(),
    storage_namespace_uid: crypto.randomUUID(),
    lvmnode_uid: lvmUid,
    vg_uuid: vgUid,
    pv_uuid: crypto.randomUUID(),
    device: "/dev/vda5",
    partition_uuid: crypto.randomUUID(),
    total_bytes: before.size,
    extent_size_bytes: 4 * 1024 ** 2,
    runs: [
      {
        namespace_name: `pgcf-storage-${f.job.input_hash.slice(0, 20)}-1`,
        trial_sha256: hash(),
        image: `fixture.invalid/image@sha256:${hash()}`,
        data_sha256: hash(),
        volume_bytes: 1024 ** 3,
        stage: "intent",
        namespace_uid: null,
        pvc_uid: null,
        pod_uid: null,
        pv_name: null,
        pv_uid: null,
        volume_handle: null,
        lvmvolume_uid: null,
        lv_uuid: null,
        before,
        allocated: null,
        after: null,
        written_at: null,
        published_at: null,
      },
    ],
  };
  expect(
    (
      await callback(f, {
        ...f.identity,
        kind: "checkpoint",
        expected_revision: 0,
        payload: { ...checkpoint, storage_trial: trial },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await callback(f, {
        ...f.identity,
        kind: "checkpoint",
        expected_revision: 1,
        payload: {
          ...checkpoint,
          stage: "awaiting_verification",
          storage_trial: trial,
        },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await callback(f, {
        ...f.identity,
        kind: "checkpoint",
        expected_revision: 1,
        payload: {
          ...checkpoint,
          storage_trial: { ...trial, node_uid: crypto.randomUUID() },
        },
      })
    ).status,
  ).toBe(409);
  const saved = await readBootstrapJob(env.DB, f.job.operation_id);
  expect(JSON.parse(saved.checkpoint_json).storage_trial.node_uid).toBe(
    nodeUid,
  );
  expect(saved.revision).toBe(1);
});
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
function providerTarget(
  f: Awaited<ReturnType<typeof prepared>>,
): ContaboInstance {
  return {
    id: f.spec.provider_instance_id,
    tenantId: crypto.randomUUID(),
    customerId: crypto.randomUUID(),
    name: f.spec.hostname,
    displayName: f.spec.hostname,
    dataCenter: "fixture",
    region: "EU",
    regionName: "fixture",
    productId: f.addition.audit!.product_id,
    productName: "fixture",
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
    diskMb: 65536,
    macAddress: f.spec.hardware.mac,
    osType: "Linux",
    sshKeys: [],
    createdDate: new Date().toISOString(),
    cancelDate: null,
    status: "rescue",
    addOns: [],
    applicationId: null,
    additionalIps: [],
  };
}
async function beforeDestructiveWrite() {
  const tenant = crypto.randomUUID(),
    customer = crypto.randomUUID();
  let plan!: ReturnType<typeof peerPlan>;
  const f = await prepared(true, async (value) => {
      plan = peerPlan(value);
      delete value.configuration.spec.peer_ipv4;
      plan.members = plan.members.slice(0, 1);
      const member = plan.members[0]!;
      member.ownership_sha256 = bytesToHex(
        new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(
              canonicalConfiguration([tenant, customer]),
            ),
          ),
        ),
      );
      member.rules_sha256 = bytesToHex(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode("[]")),
        ),
      );
      value.bindings.BOOTSTRAP_FIREWALL_BINDINGS = JSON.stringify({
        [member.provider_instance_id]: member.firewall_id,
      });
      value.bindings.BOOTSTRAP_OPERATOR_SOURCES = JSON.stringify(
        plan.operators.ipv4,
      );
      value.bindings.BOOTSTRAP_SCAN_CONTROL = JSON.stringify(plan.scan_control);
      await storePeerPlan(value, plan, { status: "verified" });
      const row = await env.DB.prepare(
        "SELECT plan_sha256 FROM node_network_preparations WHERE operation_id=?",
      )
        .bind(value.addition.intent.operation_id)
        .first<{ plan_sha256: string }>();
      await env.DB.prepare(
        "INSERT INTO node_network_firewalls(firewall_id,operation_id,plan_sha256) VALUES(?,?,?)",
      )
        .bind(
          member.firewall_id,
          value.addition.intent.operation_id,
          row!.plan_sha256,
        )
        .run();
    }),
    current = {
      ...JSON.parse(f.job.checkpoint_json),
      stage: "image_verified",
      status: "running",
      downloaded_bytes: f.spec.image.compressed_bytes,
    };
  f.bindings.CONTABO_CLIENT_ID = crypto.randomUUID();
  f.bindings.CONTABO_CLIENT_SECRET = crypto.randomUUID();
  f.bindings.CONTABO_USERNAME = crypto.randomUUID();
  f.bindings.CONTABO_PASSWORD = crypto.randomUUID();
  await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET checkpoint_json=? WHERE operation_id=?",
  )
    .bind(JSON.stringify(current), f.job.operation_id)
    .run();
  const next = {
    ...current,
    stage: "disk_write_intent",
    destructive_intent: true,
    write_intent_offset: 0,
  };
  const member = plan.members[0]!,
    firewall: ContaboFirewall = {
      tenantId: tenant,
      customerId: customer,
      firewallId: member.firewall_id,
      name: "fixture",
      description: "fixture",
      status: "active",
      instanceStatus: [
        { instanceId: f.spec.provider_instance_id, status: "ok" },
      ],
      instances: [
        {
          instanceId: f.spec.provider_instance_id,
          displayName: null,
          name: f.spec.hostname,
          productId: f.addition.audit!.product_id,
          ipConfig: {
            v4: providerTarget(f).ipConfig!.v4,
            v6: { ip: "", gateway: "", netmaskCidr: 0 },
          },
          regionSlug: "EU",
          regionName: "EU",
          dataCenterSlug: "fixture",
          dataCenterName: "fixture",
        },
      ],
      rules: {
        inbound: [
          {
            protocol: "",
            destPorts: [],
            srcCidr: { ipv4: [], ipv6: [] },
            action: "drop",
            status: "active",
            displayName: "Block all traffic",
          },
        ],
      },
      createdDate: new Date().toISOString(),
      updatedDate: new Date().toISOString(),
    };
  const firewallRead = vi
    .spyOn(ContaboClient.prototype, "getFirewall")
    .mockImplementation(async () => structuredClone(firewall));
  return {
    f,
    next,
    firewall,
    firewallRead,
    plan,
    envelope: {
      ...f.identity,
      kind: "checkpoint",
      expected_revision: 0,
      payload: next,
    },
  };
}
function beforeCheckpointCas(change: () => Promise<void>) {
  const prepare = env.DB.prepare.bind(env.DB);
  vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (sql.startsWith("UPDATE node_bootstrap_jobs SET checkpoint_json")) {
      const bind = statement.bind.bind(statement);
      Object.defineProperty(statement, "bind", {
        value: (...values: unknown[]) => {
          const bound = bind(...values),
            run = bound.run.bind(bound);
          Object.defineProperty(bound, "run", {
            value: async () => {
              await change();
              return run();
            },
          });
          return bound;
        },
      });
    }
    return statement;
  });
}
async function confirmedFirewallAllocation(
  f: Awaited<ReturnType<typeof prepared>>,
  firewall: ContaboFirewall,
) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO node_firewall_allocations(operation_id,node_id,region_id,provider_instance_id,provider_region,product_id,image_id,intent_hash,inventory_revision,tenant_id,customer_id,request_id,name,description,state,firewall_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'confirmed',?,?,?)",
  )
    .bind(
      f.job.operation_id,
      f.job.node_id,
      f.job.region_id,
      f.spec.provider_instance_id,
      f.addition.audit!.provider_region,
      f.addition.audit!.product_id,
      f.addition.audit!.image_id,
      f.addition.intent_hash,
      f.addition.revision,
      firewall.tenantId,
      firewall.customerId,
      crypto.randomUUID(),
      crypto.randomUUID(),
      "fixture",
      firewall.firewallId,
      now,
      now,
    )
    .run();
}
describe("protected bootstrap authority", () => {
  it("refuses legacy continuation without fresh proof and never initializes from a routine read", async () => {
    const { f, envelope } = await beforeDestructiveWrite();
    await env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET checkpoint_json=?,revision=revision+1 WHERE operation_id=?",
    )
      .bind(
        JSON.stringify({
          ...envelope.payload,
          written_bytes: 512,
          write_intent_offset: 512,
        }),
        f.job.operation_id,
      )
      .run();
    const row = await readBootstrapJob(env.DB, f.job.operation_id),
      provider = vi
        .spyOn(ContaboClient.prototype, "getInstance")
        .mockRejectedValue(new Error("unexpected_provider_read"));
    expect(await hasBootstrapNetworkAuthority(f.bindings, row)).toBe(false);
    expect(provider).not.toHaveBeenCalled();
    await env.DB.prepare(
      "UPDATE node_network_preparations SET proof_expires_at=? WHERE operation_id=?",
    )
      .bind(new Date(Date.now() - 1).toISOString(), row.operation_id)
      .run();
    expect(await establishBootstrapNetworkAuthority(f.bindings, row)).toBe(
      false,
    );
    expect(provider).not.toHaveBeenCalled();
    const after = await readBootstrapJob(env.DB, row.operation_id);
    expect(after.network_authorization_json).toBeNull();
    expect(after.checkpoint_json).toBe(row.checkpoint_json);
    expect(after.revision).toBe(row.revision);
  });
  it("establishes legacy authority once without changing acknowledged or pending disk progress", async () => {
    const { f, envelope } = await beforeDestructiveWrite();
    await env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET checkpoint_json=?,revision=revision+1 WHERE operation_id=?",
    )
      .bind(
        JSON.stringify({
          ...envelope.payload,
          written_bytes: 512,
          write_intent_offset: 512,
        }),
        f.job.operation_id,
      )
      .run();
    const row = await readBootstrapJob(env.DB, f.job.operation_id),
      provider = vi
        .spyOn(ContaboClient.prototype, "getInstance")
        .mockResolvedValue(providerTarget(f));
    expect(await establishBootstrapNetworkAuthority(f.bindings, row)).toBe(
      true,
    );
    const current = await readBootstrapJob(env.DB, row.operation_id);
    expect(current.checkpoint_json).toBe(row.checkpoint_json);
    expect(current.revision).toBe(row.revision);
    expect(typeof current.network_authorization_json).toBe("string");
    await env.DB.prepare(
      "UPDATE node_network_preparations SET proof_expires_at=? WHERE operation_id=?",
    )
      .bind(new Date(Date.now() - 1).toISOString(), row.operation_id)
      .run();
    expect(await establishBootstrapNetworkAuthority(f.bindings, current)).toBe(
      true,
    );
    expect(provider).toHaveBeenCalledTimes(1);
    f.bindings.BOOTSTRAP_OPERATOR_SOURCES = JSON.stringify([
      "203.0.113.201/32",
    ]);
    expect(await hasBootstrapNetworkAuthority(f.bindings, current)).toBe(false);
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it("continues a durably authorized disk installation after initial proof expiry and stops on revocation", async () => {
    const { f, envelope } = await beforeDestructiveWrite();
    const provider = vi
      .spyOn(ContaboClient.prototype, "getInstance")
      .mockResolvedValue(providerTarget(f));
    expect((await callback(f, envelope)).status).toBe(200);
    const before = await readBootstrapJob(env.DB, f.job.operation_id);
    await env.DB.prepare(
      "UPDATE node_network_preparations SET proof_expires_at=? WHERE operation_id=?",
    )
      .bind(new Date(Date.now() - 1).toISOString(), f.job.operation_id)
      .run();
    expect((await callback(f, { ...f.identity, kind: "read" })).status).toBe(
      200,
    );
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await readBootstrapJob(env.DB, f.job.operation_id)).toEqual(before);
    const waiting = {
      ...JSON.parse(before.checkpoint_json),
      stage: "awaiting_verification",
      status: "awaiting_verification",
    };
    await env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET checkpoint_json=?,revision=revision+1 WHERE operation_id=?",
    )
      .bind(JSON.stringify(waiting), before.operation_id)
      .run();
    expect((await callback(f, { ...f.identity, kind: "read" })).status).toBe(
      200,
    );
    const awaiting = await readBootstrapJob(env.DB, before.operation_id);
    expect(
      (
        await callback(f, {
          ...f.identity,
          kind: "checkpoint",
          expected_revision: awaiting.revision,
          payload: {
            ...waiting,
            stage: "quarantine_release_intent",
            status: "running",
            release_node_uid: crypto.randomUUID(),
            release_resource_version: "2",
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (await readBootstrapJob(env.DB, before.operation_id)).checkpoint_json,
    ).toBe(awaiting.checkpoint_json);
    await env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET authorized=0 WHERE operation_id=?",
    )
      .bind(f.job.operation_id)
      .run();
    expect((await callback(f, { ...f.identity, kind: "read" })).status).toBe(
      403,
    );
  });
  it("rejects changed firewall rules before first disk intent without repairing provider state", async () => {
    const { f, envelope, firewall, firewallRead } =
        await beforeDestructiveWrite(),
      before = await readBootstrapJob(env.DB, f.job.operation_id);
    vi.spyOn(ContaboClient.prototype, "getInstance").mockResolvedValue(
      providerTarget(f),
    );
    firewall.rules.inbound.unshift({
      protocol: "tcp",
      destPorts: ["5432"],
      srcCidr: { ipv4: ["203.0.113.99/32"] },
      action: "accept",
      status: "active",
      displayName: "Unexpected public access",
    });
    const repair = vi.spyOn(ContaboClient.prototype, "putFirewallRules");
    expect((await callback(f, envelope)).status).toBe(409);
    expect(firewallRead).toHaveBeenCalledTimes(1);
    expect(repair).not.toHaveBeenCalled();
    expect(await readBootstrapJob(env.DB, f.job.operation_id)).toEqual(before);
  });
  it("rejects a foreign firewall owner before the first disk intent", async () => {
    const { f, envelope, firewall } = await beforeDestructiveWrite(),
      before = await readBootstrapJob(env.DB, f.job.operation_id);
    vi.spyOn(ContaboClient.prototype, "getInstance").mockResolvedValue(
      providerTarget(f),
    );
    firewall.tenantId = crypto.randomUUID();
    expect((await callback(f, envelope)).status).toBe(409);
    expect(await readBootstrapJob(env.DB, f.job.operation_id)).toEqual(before);
  });
  it("rejects an actual IPv6 assignment changed while IPv4 and MAC remain sealed", async () => {
    const { f, envelope } = await beforeDestructiveWrite(),
      before = await readBootstrapJob(env.DB, f.job.operation_id),
      actual = providerTarget(f);
    vi.spyOn(ContaboClient.prototype, "getInstance").mockResolvedValue({
      ...actual,
      ipConfig: {
        ...actual.ipConfig!,
        v6: { ip: "2001:db8::70", gateway: "fe80::1", netmaskCidr: 64 },
      },
    });
    expect((await callback(f, envelope)).status).toBe(409);
    expect(await readBootstrapJob(env.DB, f.job.operation_id)).toEqual(before);
  });
  it("rejects an unconfirmed firewall attachment before the first disk intent", async () => {
    const { f, envelope, firewall } = await beforeDestructiveWrite(),
      before = await readBootstrapJob(env.DB, f.job.operation_id);
    vi.spyOn(ContaboClient.prototype, "getInstance").mockResolvedValue(
      providerTarget(f),
    );
    firewall.instanceStatus[0]!.status = "processing";
    const assign = vi.spyOn(ContaboClient.prototype, "assignFirewall");
    expect((await callback(f, envelope)).status).toBe(409);
    expect(assign).not.toHaveBeenCalled();
    expect(await readBootstrapJob(env.DB, f.job.operation_id)).toEqual(before);
  });
  it("blocks a Cloudflare firewall lease changed during provider readback", async () => {
    const { f, envelope, firewall, firewallRead } =
        await beforeDestructiveWrite(),
      before = await readBootstrapJob(env.DB, f.job.operation_id);
    vi.spyOn(ContaboClient.prototype, "getInstance").mockResolvedValue(
      providerTarget(f),
    );
    firewallRead.mockImplementation(async () => {
      await env.DB.prepare(
        "UPDATE node_network_firewalls SET revision=revision+1 WHERE firewall_id=?",
      )
        .bind(firewall.firewallId)
        .run();
      return structuredClone(firewall);
    });
    expect((await callback(f, envelope)).status).toBe(409);
    expect(await readBootstrapJob(env.DB, f.job.operation_id)).toEqual(before);
  });
  it("atomically binds the first disk intent to the exact Cloudflare network snapshot", async () => {
    const { f, envelope } = await beforeDestructiveWrite(),
      before = await readBootstrapJob(env.DB, f.job.operation_id),
      prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(ContaboClient.prototype, "getInstance").mockResolvedValue(
      providerTarget(f),
    );
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.startsWith("UPDATE node_bootstrap_jobs SET checkpoint_json")) {
        const bind = statement.bind.bind(statement);
        Object.defineProperty(statement, "bind", {
          value: (...values: unknown[]) => {
            const bound = bind(...values),
              run = bound.run.bind(bound);
            Object.defineProperty(bound, "run", {
              value: async () => {
                await prepare(
                  "UPDATE node_network_preparations SET revision=revision+1 WHERE operation_id=?",
                )
                  .bind(f.job.operation_id)
                  .run();
                return run();
              },
            });
            return bound;
          },
        });
      }
      return statement;
    });
    expect((await callback(f, envelope)).status).toBe(409);
    expect(await readBootstrapJob(env.DB, f.job.operation_id)).toEqual(before);
  });
  it("fences firewall lease changes between readback and the destructive CAS", async () => {
    const { f, envelope, firewall } = await beforeDestructiveWrite(),
      before = await readBootstrapJob(env.DB, f.job.operation_id);
    vi.spyOn(ContaboClient.prototype, "getInstance").mockResolvedValue(
      providerTarget(f),
    );
    beforeCheckpointCas(async () => {
      await env.DB.prepare(
        "UPDATE node_network_firewalls SET revision=revision+1 WHERE firewall_id=?",
      )
        .bind(firewall.firewallId)
        .run();
    });
    expect((await callback(f, envelope)).status).toBe(409);
    expect(await readBootstrapJob(env.DB, f.job.operation_id)).toEqual(before);
  });
  it("fences a newly created firewall allocation after a static-binding readback", async () => {
    const { f, envelope, firewall } = await beforeDestructiveWrite(),
      before = await readBootstrapJob(env.DB, f.job.operation_id);
    vi.spyOn(ContaboClient.prototype, "getInstance").mockResolvedValue(
      providerTarget(f),
    );
    beforeCheckpointCas(async () => {
      await confirmedFirewallAllocation(f, firewall);
    });
    const response = await callback(f, envelope);
    await env.DB.prepare(
      "DELETE FROM node_firewall_allocations WHERE operation_id=?",
    )
      .bind(f.job.operation_id)
      .run();
    expect(response.status).toBe(409);
    expect(await readBootstrapJob(env.DB, f.job.operation_id)).toEqual(before);
  });
  it("fences revocation of a confirmed allocation before the destructive CAS", async () => {
    const { f, envelope, firewall } = await beforeDestructiveWrite(),
      before = await readBootstrapJob(env.DB, f.job.operation_id);
    vi.spyOn(ContaboClient.prototype, "getInstance").mockResolvedValue(
      providerTarget(f),
    );
    await confirmedFirewallAllocation(f, firewall);
    try {
      beforeCheckpointCas(async () => {
        await env.DB.prepare(
          "UPDATE node_firewall_allocations SET state='blocked' WHERE operation_id=?",
        )
          .bind(f.job.operation_id)
          .run();
      });
      expect((await callback(f, envelope)).status).toBe(409);
      expect(await readBootstrapJob(env.DB, f.job.operation_id)).toEqual(
        before,
      );
    } finally {
      await env.DB.prepare(
        "DELETE FROM node_firewall_allocations WHERE operation_id=?",
      )
        .bind(f.job.operation_id)
        .run();
    }
  });
  it("fences regional membership changed after the provider firewall readback", async () => {
    const { f, envelope } = await beforeDestructiveWrite(),
      before = await readBootstrapJob(env.DB, f.job.operation_id),
      added = await fixture();
    vi.spyOn(ContaboClient.prototype, "getInstance").mockResolvedValue(
      providerTarget(f),
    );
    beforeCheckpointCas(async () => {
      await env.DB.prepare("UPDATE nodes SET region_id=? WHERE id=?")
        .bind(f.job.region_id, added.node)
        .run();
    });
    expect((await callback(f, envelope)).status).toBe(409);
    expect(await readBootstrapJob(env.DB, f.job.operation_id)).toEqual(before);
  });
  it("verifies the initial network boundary once while keeping fresh Cloudflare proof authority", async () => {
    const f = await prepared(),
      verify = vi.spyOn(network, "ensureNodeNetwork").mockResolvedValue(true);
    expect(
      await ensureBootstrapNetworkBoundary(f.bindings, f.job.operation_id),
    ).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(
      (await readNodeAddition(env.DB, f.job.operation_id)).checkpoint?.stage,
    ).toBe("prepared");
    expect(
      await ensureBootstrapNetworkBoundary(f.bindings, f.job.operation_id),
    ).toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
    await env.DB.prepare(
      "UPDATE node_network_preparations SET proof_expires_at=? WHERE operation_id=?",
    )
      .bind(new Date(Date.now() - 1).toISOString(), f.job.operation_id)
      .run();
    expect(
      await ensureBootstrapNetworkBoundary(f.bindings, f.job.operation_id),
    ).toBe(false);
    expect(verify).toHaveBeenCalledTimes(1);
  });
  it("does not poll provider or firewall after sealed rescue is already active", async () => {
    const f = await prepared();
    await env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET rescue_active=1 WHERE operation_id=?",
    )
      .bind(f.job.operation_id)
      .run();
    const get = vi.fn(async () => {
        throw new Error("unexpected_provider_read");
      }),
      rescue = vi.fn(async () => {
        throw new Error("unexpected_rescue_write");
      }),
      firewall = vi
        .spyOn(network, "ensureNodeFirewall")
        .mockResolvedValue(true);
    expect(
      await ensureNodeRescue(f.bindings, f.job.operation_id, {
        getInstance: get,
        rescue,
        actionAudits: vi.fn(async () => []),
      }),
    ).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(rescue).not.toHaveBeenCalled();
    expect(firewall).not.toHaveBeenCalled();
  });
  it("rejects changed provider inventory before the first destructive checkpoint without mutation", async () => {
    const { f, envelope } = await beforeDestructiveWrite(),
      before = await readBootstrapJob(env.DB, f.job.operation_id),
      actual = providerTarget(f),
      provider = vi
        .spyOn(ContaboClient.prototype, "getInstance")
        .mockResolvedValue({ ...actual, productId: "different-product" });
    expect((await callback(f, envelope)).status).toBe(409);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await readBootstrapJob(env.DB, f.job.operation_id)).toEqual(before);
  });
  it("verifies only the first destructive boundary and rejects replayed revisions before provider access", async () => {
    const { f, envelope, next, firewallRead } = await beforeDestructiveWrite(),
      provider = vi
        .spyOn(ContaboClient.prototype, "getInstance")
        .mockResolvedValue(providerTarget(f));
    expect((await callback(f, envelope)).status).toBe(200);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(firewallRead).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0]![1]!.accounting).toEqual({
      operation_id: f.job.operation_id,
      stage: "prewrite",
    });
    expect(firewallRead.mock.calls[0]![1]!.accounting).toEqual({
      operation_id: f.job.operation_id,
      stage: "prewrite",
    });
    expect((await callback(f, envelope)).status).toBe(409);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(firewallRead).toHaveBeenCalledTimes(1);
    expect(
      (
        await callback(f, {
          ...envelope,
          expected_revision: 1,
          payload: { ...next, written_bytes: 256, write_intent_offset: 256 },
        })
      ).status,
    ).toBe(200);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(firewallRead).toHaveBeenCalledTimes(1);
  });
  it("leaves the checkpoint untouched when first-write provider verification fails", async () => {
    const { f, envelope } = await beforeDestructiveWrite(),
      before = await readBootstrapJob(env.DB, f.job.operation_id),
      provider = vi
        .spyOn(ContaboClient.prototype, "getInstance")
        .mockRejectedValue(new Error("provider_read_unavailable"));
    expect((await callback(f, envelope)).status).toBe(500);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await readBootstrapJob(env.DB, f.job.operation_id)).toEqual(before);
  });
  it("rejects a cancelled target and actual unallocated hardware before disk intent", async () => {
    const { f, envelope } = await beforeDestructiveWrite(),
      before = await readBootstrapJob(env.DB, f.job.operation_id),
      actual = providerTarget(f),
      provider = vi
        .spyOn(ContaboClient.prototype, "getInstance")
        .mockResolvedValue({ ...actual, cancelDate: new Date().toISOString() });
    expect((await callback(f, envelope)).status).toBe(409);
    expect(await readBootstrapJob(env.DB, f.job.operation_id)).toEqual(before);
    provider.mockResolvedValue({
      ...actual,
      ramMb: null,
      status: "pending_payment",
    });
    expect((await callback(f, envelope)).status).toBe(409);
    expect(await readBootstrapJob(env.DB, f.job.operation_id)).toEqual(before);
  });
  it("refuses an old revision before provider I/O and a revision changed during that I/O", async () => {
    const { f, envelope } = await beforeDestructiveWrite(),
      before = await readBootstrapJob(env.DB, f.job.operation_id),
      actual = providerTarget(f),
      provider = vi
        .spyOn(ContaboClient.prototype, "getInstance")
        .mockImplementation(async () => {
          await env.DB.prepare(
            "UPDATE node_bootstrap_jobs SET revision=revision+1 WHERE operation_id=?",
          )
            .bind(f.job.operation_id)
            .run();
          return actual;
        });
    expect(
      (await callback(f, { ...envelope, expected_revision: 1 })).status,
    ).toBe(409);
    expect(provider).not.toHaveBeenCalled();
    expect((await callback(f, envelope)).status).toBe(409);
    expect(provider).toHaveBeenCalledTimes(1);
    const after = await readBootstrapJob(env.DB, f.job.operation_id);
    expect(after.checkpoint_json).toBe(before.checkpoint_json);
    expect(after.revision).toBe(1);
  });
  it("refuses provider authority changed during first-write readback", async () => {
    const { f, envelope } = await beforeDestructiveWrite(),
      before = await readBootstrapJob(env.DB, f.job.operation_id),
      actual = providerTarget(f);
    vi.spyOn(ContaboClient.prototype, "getInstance").mockImplementation(
      async () => {
        await env.DB.prepare(
          "UPDATE node_additions SET revision=revision+1,status='failed' WHERE operation_id=?",
        )
          .bind(f.job.operation_id)
          .run();
        return actual;
      },
    );
    expect((await callback(f, envelope)).status).toBe(409);
    expect(await readBootstrapJob(env.DB, f.job.operation_id)).toEqual(before);
  });
  it("atomically binds disk intent to the provider authority even without a revision change", async () => {
    const { f, envelope } = await beforeDestructiveWrite(),
      before = await readBootstrapJob(env.DB, f.job.operation_id),
      prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(ContaboClient.prototype, "getInstance").mockResolvedValue(
      providerTarget(f),
    );
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.startsWith("UPDATE node_bootstrap_jobs SET checkpoint_json")) {
        const bind = statement.bind.bind(statement);
        Object.defineProperty(statement, "bind", {
          value: (...values: unknown[]) => {
            const bound = bind(...values),
              run = bound.run.bind(bound);
            Object.defineProperty(bound, "run", {
              value: async () => {
                await prepare(
                  "UPDATE node_additions SET provider_instance_id=? WHERE operation_id=?",
                )
                  .bind(
                    String(Number(f.spec.provider_instance_id) + 1),
                    f.job.operation_id,
                  )
                  .run();
                return run();
              },
            });
            return bound;
          },
        });
      }
      return statement;
    });
    expect((await callback(f, envelope)).status).toBe(409);
    expect(await readBootstrapJob(env.DB, f.job.operation_id)).toEqual(before);
  });
  it("rejects an audit changed between its parsed read and exact CAS snapshot", async () => {
    const { f, envelope } = await beforeDestructiveWrite(),
      before = await readBootstrapJob(env.DB, f.job.operation_id),
      prepare = env.DB.prepare.bind(env.DB),
      provider = vi
        .spyOn(ContaboClient.prototype, "getInstance")
        .mockResolvedValue(providerTarget(f));
    vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (
        sql.startsWith(
          "SELECT revision,provider_instance_id,intent_hash,audit_json,receipt_json",
        )
      ) {
        const bind = statement.bind.bind(statement);
        Object.defineProperty(statement, "bind", {
          value: (...values: unknown[]) => {
            const bound = bind(...values),
              first = bound.first.bind(bound);
            Object.defineProperty(bound, "first", {
              value: async () => {
                const audit = {
                  ...f.addition.audit!,
                  product_id: "different-product",
                };
                await prepare(
                  "UPDATE node_additions SET audit_json=? WHERE operation_id=?",
                )
                  .bind(JSON.stringify(audit), f.job.operation_id)
                  .run();
                return first();
              },
            });
            return bound;
          },
        });
      }
      return statement;
    });
    expect((await callback(f, envelope)).status).toBe(409);
    expect(provider).not.toHaveBeenCalled();
    expect(await readBootstrapJob(env.DB, f.job.operation_id)).toEqual(before);
  });
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
    const provider = vi
      .spyOn(ContaboClient.prototype, "getInstance")
      .mockResolvedValue(actual);
    const first = await issueBootstrapTransport(settings, row, {
      capability: "rescue_ssh",
    });
    epoch = secondEpoch;
    const second = await issueBootstrapTransport(settings, row, {
      capability: "rescue_ssh",
    });
    expect(provider).not.toHaveBeenCalled();
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
    const platformRow = {
      ...row,
      checkpoint_json: JSON.stringify({
        ...JSON.parse(row.checkpoint_json),
        stage: "cilium_install_intent",
      }),
    };
    await env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET checkpoint_json=? WHERE operation_id=?",
    )
      .bind(platformRow.checkpoint_json, row.operation_id)
      .run();
    const platformTransport = await issueBootstrapTransport(
      settings,
      platformRow,
      { capability: "kubernetes_api" },
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
    service.fetch.mockImplementationOnce(async () => {
      await env.DB.prepare(
        "UPDATE node_bootstrap_jobs SET cancelled=1,authorized=0 WHERE operation_id=?",
      )
        .bind(row.operation_id)
        .run();
      return Response.json({
        v: 1,
        region: f.region,
        issuer_region: f.region,
        relay_epoch: epoch,
        allowed_target_regions: [f.region],
        capabilities: ["rescue_ssh", "talos_api", "kubernetes_api"],
      });
    });
    await expect(
      issueBootstrapTransport(settings, platformRow, {
        capability: "kubernetes_api",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(provider).not.toHaveBeenCalled();
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
      status: "running",
      macAddress: f.spec.hardware.mac,
      cpuCores: 4,
      ramMb: 8192,
      diskMb: 153600,
      ipConfig: {
        v4: { ip: f.spec.hardware.ipv4 },
        v6: { ip: "2001:0DB8:0000:0000:0000:0000:0000:0042" },
      },
      additionalIps: [],
    } as unknown as ContaboInstance & {
      ipConfig: NonNullable<ContaboInstance["ipConfig"]>;
    };
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

async function ciliumRecoveryFixture() {
  const initial = await beforeDestructiveWrite(),
    f = initial.f;
  const clusterUid = crypto.randomUUID();
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 1),
    {
      version: 1,
      cluster_name: f.spec.cluster_name,
      cluster_endpoint: f.spec.cluster_endpoint,
      talos_version: "1.14.1",
      kubernetes_version: "1.36.5",
      kube_system_uid: clusterUid,
      talos_machine_secrets_yaml: "retained machine secrets\n",
      talos_admin_config: "retained Talos config\n",
      kubeconfig: "retained certificate kubeconfig\n",
    },
  );
  const checkpoint = {
    ...JSON.parse(f.job.checkpoint_json),
    stage: "cilium_install_intent",
    status: "waiting",
    error_code: "platform_resource_unconfirmed",
    sealed_ref: "join_bundle:1",
    downloaded_bytes: f.spec.image.compressed_bytes,
    written_bytes: f.spec.image.raw_bytes,
    destructive_intent: true,
  };
  await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET checkpoint_json=?,material_ref_json=? WHERE operation_id=?",
  )
    .bind(
      JSON.stringify(checkpoint),
      JSON.stringify(joinBundleReference(f.region, 1)),
      f.job.operation_id,
    )
    .run();
  vi.spyOn(ContaboClient.prototype, "getInstance").mockResolvedValue({
    ...providerTarget(f),
    tenantId: initial.firewall.tenantId,
    customerId: initial.firewall.customerId,
  });
  expect(
    await establishBootstrapNetworkAuthority(
      f.bindings,
      await readBootstrapJob(env.DB, f.job.operation_id),
    ),
  ).toBe(true);
  const receipt = {
    version: 1,
    operation_id: f.job.operation_id,
    node_id: f.job.node_id,
    region_id: f.region,
    input_hash: f.job.input_hash,
    kube_system_uid: clusterUid,
    node_uid: crypto.randomUUID(),
    node_name: f.spec.hostname,
    chart_sha256:
      "b2afd87b7f75f875f92a14559f14f59b7babbb479d968e3fd625a20bf30ec20e",
    values_sha256:
      "0de1a09a3fd450916cdb316d41fa9dcfd769708f7a6cb5b49496a64ee9b26b39",
    effective_values_sha256: hash(),
    inventory_sha256: hash(),
    resource_count: 12,
    absent_resource_count: 12,
    release_storage_count: 0,
    prior_command_closed: true,
    observed_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  };
  const claimed = {
    ...checkpoint,
    status: "running",
    error_code: null,
    cilium_install: { attempt: 2, state: "intent", recovery_receipt: receipt },
  };
  return { f, checkpoint, receipt, claimed };
}

it("claims exactly one Cilium retry from complete fresh no-effect readback without rewinding the original intent", async () => {
  const { f, checkpoint, claimed } = await ciliumRecoveryFixture();
  const response = await callback(f, {
    ...f.identity,
    kind: "checkpoint",
    expected_revision: 0,
    payload: claimed,
  });
  expect(response.status).toBe(200);
  const saved = await readBootstrapJob(env.DB, f.job.operation_id);
  expect(saved.revision).toBe(1);
  const { cilium_install, status, error_code, ...preserved } = JSON.parse(
    saved.checkpoint_json,
  );
  expect(preserved).toEqual(
    Object.fromEntries(
      Object.entries(checkpoint).filter(
        ([k]) => !["status", "error_code"].includes(k),
      ),
    ),
  );
  expect(cilium_install).toEqual(claimed.cilium_install);
  expect(status).toBe("running");
  expect(error_code).toBeNull();
  expect(
    (
      await callback(f, {
        ...f.identity,
        kind: "checkpoint",
        expected_revision: 0,
        payload: claimed,
      })
    ).status,
  ).toBe(409);
});

it("refuses changing sealed progress or submitting stale incomplete Cilium no-effect evidence", async () => {
  const { f, claimed } = await ciliumRecoveryFixture();
  const send = (payload: unknown) =>
    callback(f, {
      ...f.identity,
      kind: "checkpoint",
      expected_revision: 0,
      payload,
    });
  expect((await send({ ...claimed, sealed_ref: "join_bundle:2" })).status).toBe(
    409,
  );
  expect(
    (await send({ ...claimed, written_bytes: claimed.written_bytes + 512 }))
      .status,
  ).toBe(409);
  const stale = {
    ...claimed.cilium_install.recovery_receipt,
    observed_at: new Date(Date.now() - 120001).toISOString(),
    completed_at: new Date(Date.now() - 120001).toISOString(),
  };
  expect(
    (
      await send({
        ...claimed,
        cilium_install: { ...claimed.cilium_install, recovery_receipt: stale },
      })
    ).status,
  ).toBe(409);
  const changedCluster = {
    ...claimed.cilium_install.recovery_receipt,
    kube_system_uid: crypto.randomUUID(),
  };
  expect(
    (
      await send({
        ...claimed,
        cilium_install: {
          ...claimed.cilium_install,
          recovery_receipt: changedCluster,
        },
      })
    ).status,
  ).toBe(409);
  const incomplete = {
    ...claimed.cilium_install.recovery_receipt,
    absent_resource_count: 11,
  };
  expect(
    (
      await send({
        ...claimed,
        cilium_install: {
          ...claimed.cilium_install,
          recovery_receipt: incomplete,
        },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await send({
        ...claimed,
        cilium_install: { ...claimed.cilium_install, attempt: 3 },
      })
    ).status,
  ).toBe(400);
  expect((await readBootstrapJob(env.DB, f.job.operation_id)).revision).toBe(0);
});

it("retains consumed Cilium retry authority through readback and forbids erasure or replacement", async () => {
  const { f, checkpoint, claimed } = await ciliumRecoveryFixture();
  expect(
    (
      await callback(f, {
        ...f.identity,
        kind: "checkpoint",
        expected_revision: 0,
        payload: claimed,
      })
    ).status,
  ).toBe(200);
  const send = (payload: unknown) =>
    callback(f, {
      ...f.identity,
      kind: "checkpoint",
      expected_revision: 1,
      payload,
    });
  expect(
    (await send({ ...checkpoint, status: "running", error_code: null })).status,
  ).toBe(409);
  const changedNode = {
    ...claimed.cilium_install.recovery_receipt,
    node_uid: crypto.randomUUID(),
  };
  expect(
    (
      await send({
        ...claimed,
        cilium_install: {
          ...claimed.cilium_install,
          recovery_receipt: changedNode,
        },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await send({
        ...claimed,
        status: "waiting",
        error_code: "cilium_release_unconfirmed",
      })
    ).status,
  ).toBe(200);
  const saved = await readBootstrapJob(env.DB, f.job.operation_id);
  expect(JSON.parse(saved.checkpoint_json).cilium_install).toEqual(
    claimed.cilium_install,
  );
  expect(saved.revision).toBe(2);
});

it("consumes only one competing Cilium recovery claim at the exact CF revision", async () => {
  const { f, claimed } = await ciliumRecoveryFixture();
  const replies = await Promise.all([
    callback(f, {
      ...f.identity,
      kind: "checkpoint",
      expected_revision: 0,
      payload: claimed,
    }),
    callback(f, {
      ...f.identity,
      request_id: crypto.randomUUID(),
      kind: "checkpoint",
      expected_revision: 0,
      payload: claimed,
    }),
  ]);
  expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((await readBootstrapJob(env.DB, f.job.operation_id)).revision).toBe(1);
});

it("logs only a finite owned Cilium rejection reason and bounded ages while retaining HTTP409", async () => {
  const { f, claimed } = await ciliumRecoveryFixture();
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const stale = {
    ...claimed.cilium_install.recovery_receipt,
    observed_at: new Date(Date.now() - 120001).toISOString(),
    completed_at: new Date(Date.now() - 120001).toISOString(),
  };
  expect(
    (
      await callback(f, {
        ...f.identity,
        kind: "checkpoint",
        expected_revision: 0,
        payload: {
          ...claimed,
          cilium_install: {
            ...claimed.cilium_install,
            recovery_receipt: stale,
          },
        },
      })
    ).status,
  ).toBe(409);
  const events = log.mock.calls.flatMap((args) => {
    if (args.length !== 1 || typeof args[0] !== "string") return [];
    const value = JSON.parse(args[0]);
    return value.event === "cilium_recovery_claim_rejected" ? [value] : [];
  });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    event: "cilium_recovery_claim_rejected",
    reason: "stale_observation",
    operation_id: f.job.operation_id,
  });
  expect(Object.keys(events[0]).sort()).toEqual([
    "completed_age_ms",
    "event",
    "future_observation",
    "observed_age_ms",
    "operation_id",
    "reason",
  ]);
  expect(Number.isInteger(events[0].observed_age_ms)).toBe(true);
  expect(events[0].observed_age_ms).toBeGreaterThanOrEqual(120001);
  expect(events[0].observed_age_ms).toBeLessThanOrEqual(600000);
  expect(JSON.stringify(events)).not.toContain(stale.node_uid);
  expect(JSON.stringify(events)).not.toContain(stale.input_hash);
  expect((await readBootstrapJob(env.DB, f.job.operation_id)).revision).toBe(0);
});

async function fluxRepairFixture() {
  const { f, checkpoint, claimed } = await ciliumRecoveryFixture();
  const current = {
    ...checkpoint,
    stage: "flux_install_intent",
    cilium_install: claimed.cilium_install,
  };
  await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET checkpoint_json=? WHERE operation_id=?",
  )
    .bind(JSON.stringify(current), f.job.operation_id)
    .run();
  const receipt = {
    version: 1,
    operation_id: f.job.operation_id,
    node_id: f.job.node_id,
    region_id: f.region,
    input_hash: f.job.input_hash,
    kube_system_uid: claimed.cilium_install.recovery_receipt.kube_system_uid,
    node_uid: claimed.cilium_install.recovery_receipt.node_uid,
    node_name: f.spec.hostname,
    manifest_sha256:
      "9c1fda7e401429531ed1478f67ba06b3edff6513b75da7ee47bde9f1c4d4251c",
    inventory_sha256: hash(),
    resource_count: 43,
    present_resource_count: 40,
    missing: [
      {
        kind: "Service",
        name: "source-watcher",
        namespace: "flux-system",
        spec_sha256: hash(),
      },
      {
        kind: "Service",
        name: "webhook-receiver",
        namespace: "flux-system",
        spec_sha256: hash(),
      },
      {
        kind: "Deployment",
        name: "helm-controller",
        namespace: "flux-system",
        spec_sha256: hash(),
      },
    ],
    present_set_sha256: hash(),
    prior_command_closed: true,
    observed_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
  };
  const repair = {
    ...current,
    status: "running",
    error_code: null,
    flux_repair: { attempt: 1, state: "intent", receipt },
  };
  return { f, current, receipt, repair };
}

it("claims one exact missing Flux subset repair while preserving the original intent and consumed Cilium attempt", async () => {
  const { f, current, repair } = await fluxRepairFixture();
  expect(
    (
      await callback(f, {
        ...f.identity,
        kind: "checkpoint",
        expected_revision: 0,
        payload: repair,
      })
    ).status,
  ).toBe(200);
  const saved = await readBootstrapJob(env.DB, f.job.operation_id);
  const { flux_repair, status, error_code, ...preserved } = JSON.parse(
    saved.checkpoint_json,
  );
  expect(preserved).toEqual(
    Object.fromEntries(
      Object.entries(current).filter(
        ([k]) => !["status", "error_code"].includes(k),
      ),
    ),
  );
  expect(flux_repair).toEqual(repair.flux_repair);
  expect(status).toBe("running");
  expect(error_code).toBeNull();
  expect(saved.revision).toBe(1);
  expect(
    (
      await callback(f, {
        ...f.identity,
        kind: "checkpoint",
        expected_revision: 0,
        payload: repair,
      })
    ).status,
  ).toBe(409);
});

it("rejects stale or out-of-scope Flux repair and leaves all prior installation authority intact", async () => {
  const { f, repair } = await fluxRepairFixture();
  const send = (payload: unknown) =>
    callback(f, {
      ...f.identity,
      kind: "checkpoint",
      expected_revision: 0,
      payload,
    });
  expect(
    (await send({ ...repair, written_bytes: repair.written_bytes + 512 }))
      .status,
  ).toBe(409);
  expect((await send({ ...repair, sealed_ref: "join_bundle:2" })).status).toBe(
    409,
  );
  const stale = {
    ...repair.flux_repair.receipt,
    observed_at: new Date(Date.now() - 120001).toISOString(),
    completed_at: new Date(Date.now() - 120001).toISOString(),
  };
  expect(
    (
      await send({
        ...repair,
        flux_repair: { ...repair.flux_repair, receipt: stale },
      })
    ).status,
  ).toBe(409);
  const nodeChanged = {
    ...repair.flux_repair.receipt,
    node_uid: crypto.randomUUID(),
  };
  expect(
    (
      await send({
        ...repair,
        flux_repair: { ...repair.flux_repair, receipt: nodeChanged },
      })
    ).status,
  ).toBe(409);
  const unrelated = {
    ...repair.flux_repair.receipt,
    missing: [
      {
        kind: "Service",
        name: "unrelated",
        namespace: "flux-system",
        spec_sha256: hash(),
      },
    ],
    present_resource_count: 42,
  };
  expect(
    (
      await send({
        ...repair,
        flux_repair: { ...repair.flux_repair, receipt: unrelated },
      })
    ).status,
  ).toBe(400);
  const duplicate = {
    ...repair.flux_repair.receipt,
    missing: [
      repair.flux_repair.receipt.missing[0],
      repair.flux_repair.receipt.missing[0],
    ],
    present_resource_count: 41,
  };
  expect(
    (
      await send({
        ...repair,
        flux_repair: { ...repair.flux_repair, receipt: duplicate },
      })
    ).status,
  ).toBe(400);
  expect((await readBootstrapJob(env.DB, f.job.operation_id)).revision).toBe(0);
});

it("never erases or expands a consumed Flux subset repair and permits only retained readback progress", async () => {
  const { f, current, repair } = await fluxRepairFixture();
  expect(
    (
      await callback(f, {
        ...f.identity,
        kind: "checkpoint",
        expected_revision: 0,
        payload: repair,
      })
    ).status,
  ).toBe(200);
  const send = (payload: unknown) =>
    callback(f, {
      ...f.identity,
      kind: "checkpoint",
      expected_revision: 1,
      payload,
    });
  expect(
    (await send({ ...current, status: "running", error_code: null })).status,
  ).toBe(409);
  const replaced = {
    ...repair.flux_repair.receipt,
    present_set_sha256: hash(),
  };
  expect(
    (
      await send({
        ...repair,
        flux_repair: { ...repair.flux_repair, receipt: replaced },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await send({
        ...repair,
        flux_repair: { ...repair.flux_repair, attempt: 2 },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await send({
        ...repair,
        status: "waiting",
        error_code: "flux_repair_unconfirmed",
      })
    ).status,
  ).toBe(200);
  expect(
    JSON.parse(
      (await readBootstrapJob(env.DB, f.job.operation_id)).checkpoint_json,
    ).flux_repair,
  ).toEqual(repair.flux_repair);
});

it("atomically grants only one competing missing Flux subset repair", async () => {
  const { f, repair } = await fluxRepairFixture();
  const responses = await Promise.all([
    callback(f, {
      ...f.identity,
      kind: "checkpoint",
      expected_revision: 0,
      payload: repair,
    }),
    callback(f, {
      ...f.identity,
      request_id: crypto.randomUUID(),
      kind: "checkpoint",
      expected_revision: 0,
      payload: repair,
    }),
  ]);
  expect(responses.map((x) => x.status).sort()).toEqual([200, 409]);
  expect((await readBootstrapJob(env.DB, f.job.operation_id)).revision).toBe(1);
});
