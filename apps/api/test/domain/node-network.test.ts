// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { bytesToBase64url, newNodeId } from "@pgcf/contracts";
import { canonicalNodeProof } from "@pgcf/contracts/node-proof";
import type { ContaboFirewall } from "../../src/providers/contabo.ts";
import {
  NodeBootstrapCheckpoint,
  NodeBootstrapSpec,
  type NodeBootstrapMaintenanceObservation,
} from "@pgcf/contracts/node-bootstrap";
import {
  bootstrapSpecHash,
  sealBootstrapInput,
} from "../../src/crypto/bootstrap-tickets.ts";
import {
  configureNodeRegionPolicy,
  reserveNodeAddition,
  recordNodeReceipt,
  recordNodeAudit,
} from "../../src/domain/node-state.ts";
import {
  ensureNodeNetwork,
  ensureNodeFirewall,
  canonicalNodePreparationProof,
  NODE_PREPARATION_SIGNATURE_DOMAIN,
  type NodeNetworkEnv,
  type NodePreparationProof,
} from "../../src/domain/node-network.ts";
import { fixture, cleanupFixtures } from "./fixtures.ts";
const operations: string[] = [];
const policies: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const op of operations.splice(0)) {
    await env.ARCHIVE.delete(`node-preparation/${op}/proof.json`);
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM node_bootstrap_jobs WHERE operation_id=?",
      ).bind(op),
      env.DB.prepare(
        "DELETE FROM node_network_mutations WHERE operation_id=?",
      ).bind(op),
      env.DB.prepare(
        "DELETE FROM node_network_firewalls WHERE operation_id=?",
      ).bind(op),
      env.DB.prepare(
        "DELETE FROM node_network_preparations WHERE operation_id=?",
      ).bind(op),
      env.DB.prepare("DELETE FROM node_additions WHERE operation_id=?").bind(
        op,
      ),
    ]);
  }
  for (const region of policies.splice(0))
    await env.DB.prepare("DELETE FROM node_region_policies WHERE region_id=?")
      .bind(region)
      .run();
  await cleanupFixtures();
});
it("accepts maintenance timeouts only for the fully written authoritative job and keeps safe checkpoint advances valid", async () => {
  const f = await setup();
  await f.settle();
  const operation = f.addition.intent.operation_id;
  const spec = NodeBootstrapSpec.parse({
    version: 1,
    operation_id: operation,
    node_id: f.addition.intent.node_id,
    region_id: f.state.region,
    provider_instance_id: f.addition.provider_instance_id,
    inventory_revision: f.addition.revision,
    role: "controlplane",
    hostname: f.addition.intent.requested_hostname,
    rescue_host_fingerprint: "SHA256:" + "A".repeat(43),
    hardware: {
      mac: "02:00:00:00:00:01",
      ipv4: address(2),
      prefix_length: 24,
      gateway: address(254),
      dns: [address(254)],
      install_disk: "/dev/sda",
      disk_bytes: 161_061_273_600,
      rescue_ram_min_bytes: 8_326_418_432,
    },
    image: {
      schematic_id: "a".repeat(64),
      compressed_sha256: "b".repeat(64),
      compressed_bytes: 232_142_156,
      raw_sha256: "c".repeat(64),
      raw_bytes: 4_453_302_272,
      installer_digest: "sha256:" + "d".repeat(64),
    },
    storage: { ephemeral_gib: 4, lvm_gib: 8 },
    cluster_name: "maintenance-test",
    cluster_endpoint: `https://${address(2)}:6443`,
    cluster_uid: null,
    join_bundle_sha256: null,
    transport: { mode: "relay", issuer_region_id: f.state.region },
  });
  const input_hash = await bootstrapSpecHash(spec);
  const sealed = await sealBootstrapInput(
    env.CREDENTIAL_KEYS,
    {
      spec,
      input_hash,
      callback: {
        url: `https://api.invalid/internal/v1/node-bootstrap/${operation}`,
        bearer: "x".repeat(32),
      },
      rescue: {
        ssh_private_key: "test-private-material",
        ssh_host_key: "ssh-ed25519 AAAA",
        ssh_host_fingerprint: spec.rescue_host_fingerprint,
      },
      join_bundle: null,
    },
    f.addition.revision,
  );
  const checkpoint = NodeBootstrapCheckpoint.parse({
    stage: "rescue_reboot_intent",
    status: "waiting",
    downloaded_bytes: spec.image.compressed_bytes,
    written_bytes: spec.image.raw_bytes,
    write_intent_offset: null,
    destructive_intent: true,
    sealed_ref: null,
    pre_reboot_boot_id: null,
    release_node_uid: null,
    release_resource_version: null,
    admission_receipt: null,
    error_code: null,
  });
  const at = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO node_bootstrap_jobs(operation_id,node_id,region_id,input_hash,inventory_revision,sealed_revision,input_ciphertext,input_iv,input_kid,callback_hash,revision,checkpoint_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,493,?,?,?)`,
  )
    .bind(
      operation,
      spec.node_id,
      spec.region_id,
      input_hash,
      spec.inventory_revision,
      f.addition.revision,
      sealed.ciphertext,
      sealed.iv,
      sealed.kid,
      "e".repeat(64),
      JSON.stringify(checkpoint),
      at,
      at,
    )
    .run();
  const data = await f.payload();
  const target = data.access.find(
    (access) => access.provider_instance_id === spec.provider_instance_id,
  )!;
  target.checks = [
    { port: 22, outcome: "timed_out" },
    { port: 50000, outcome: "connected" },
    { port: 6443, outcome: "timed_out" },
  ];
  const observation: NodeBootstrapMaintenanceObservation = {
    input_hash,
    checkpoint_revision: 493,
    checkpoint_stage: "rescue_reboot_intent",
    raw_bytes: spec.image.raw_bytes,
    talos_version: "1.14.1",
    install_disk: spec.hardware.install_disk,
    disk_bytes: spec.hardware.disk_bytes,
    observed_at: data.observed_at,
  };
  target.talos_maintenance = observation;
  await f.sign(data);
  expect(await f.run()).toBe(true);
  for (const stage of [
    "config_prepared",
    "config_applied",
    "talos_reboot_intent",
  ] as const) {
    checkpoint.stage = stage;
    if (stage === "talos_reboot_intent")
      checkpoint.pre_reboot_boot_id = value();
    await env.DB.prepare(
      "UPDATE node_bootstrap_jobs SET revision=revision+1,checkpoint_json=? WHERE operation_id=?",
    )
      .bind(JSON.stringify(checkpoint), operation)
      .run();
    expect(await f.run()).toBe(true);
  }
  checkpoint.written_bytes--;
  await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET checkpoint_json=? WHERE operation_id=?",
  )
    .bind(JSON.stringify(checkpoint), operation)
    .run();
  expect(await f.run()).toBe(false);
  checkpoint.written_bytes++;
  checkpoint.stage = "gpt_relocated";
  await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET checkpoint_json=? WHERE operation_id=?",
  )
    .bind(JSON.stringify(checkpoint), operation)
    .run();
  expect(await f.run()).toBe(false);
  checkpoint.stage = "rescue_reboot_intent";
  await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET checkpoint_json=?,cancelled=1 WHERE operation_id=?",
  )
    .bind(JSON.stringify(checkpoint), operation)
    .run();
  expect(await f.run()).toBe(false);
  await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET cancelled=0 WHERE operation_id=?",
  )
    .bind(operation)
    .run();
  observation.input_hash = "0".repeat(64);
  await f.sign(data);
  expect(await f.run()).toBe(false);
  observation.input_hash = input_hash;
  target.checks[1]!.outcome = "timed_out";
  await f.sign(data);
  expect(await f.run()).toBe(false);
  target.checks[1]!.outcome = "connected";
  const peer = data.access.find((access) => access !== target)!;
  peer.checks[0]!.outcome = "timed_out";
  await f.sign(data);
  expect(await f.run()).toBe(false);
});
const value = () => crypto.randomUUID();
const address = (ordinal: number) => [192, 0, 2, ordinal].join(".");
const v6 = (ordinal: number) => ["2001", "db8", "", String(ordinal)].join(":");
async function setup(ipv6 = true) {
  const state = await fixture(),
    ids = [
      String(
        (crypto.getRandomValues(new Uint32Array(1))[0]! % 100000000) + 1000,
      ),
      String(
        (crypto.getRandomValues(new Uint32Array(1))[0]! % 100000000) +
          100001000,
      ),
    ],
    account = value();
  await env.DB.batch([
    env.DB.prepare("UPDATE regions SET provider_region='EU' WHERE id=?").bind(
      state.region,
    ),
    env.DB.prepare(
      "UPDATE nodes SET provider_instance_id=?,ready=0,schedulable=0 WHERE id=?",
    ).bind(ids[0], state.node),
  ]);
  policies.push(state.region);
  await configureNodeRegionPolicy(env.DB, {
    region_id: state.region,
    max_nodes: 3,
    purchases_enabled: false,
    order: null,
  });
  let addition = await reserveNodeAddition(env.DB, {
    request_key: value(),
    request: {
      mode: "adopt",
      region_id: state.region,
      provider_instance_id: ids[1]!,
    },
  });
  operations.push(addition.intent.operation_id);
  addition = await recordNodeReceipt(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      provider_instance_id: ids[1]!,
      request_id: null,
      reference: value(),
      received_at: new Date().toISOString(),
    },
  );
  addition = await recordNodeAudit(
    env.DB,
    addition.intent.operation_id,
    addition.revision,
    {
      provider_instance_id: ids[1]!,
      provider_region: "EU",
      product_id: "fixture",
      image_id: "fixture",
      reference: value(),
      observed_at: new Date().toISOString(),
    },
  );
  const instances = new Map(
    ids.map((id, ordinal) => [
      id,
      {
        tenantId: account,
        customerId: account,
        instanceId: Number(id),
        name: value(),
        displayName: value(),
        dataCenter: "EU",
        region: "EU",
        regionName: "EU",
        productId: "fixture",
        productName: "fixture",
        ipConfig: {
          v4: {
            ip: address(ordinal + 1),
            gateway: address(254),
            netmaskCidr: 24,
          },
          v6: {
            ip: ipv6 ? v6(ordinal + 1) : "",
            gateway: ipv6 ? v6(254) : "",
            netmaskCidr: ipv6 ? 64 : 0,
          },
        },
        ramMb: 1024,
        cpuCores: 2,
        diskMb: 4096,
        osType: "Linux",
        createdDate: new Date().toISOString(),
        cancelDate: null,
        status: "running",
        additionalIps: [] as {
          v4: { ip: string; gateway: string; netmaskCidr: number };
        }[],
        macAddress: value(),
        vHostId: 1,
        vHostNumber: 1,
        vHostName: "fixture",
        addOns: [],
        productType: "ssd",
        applicationId: null,
      },
    ]),
  );
  const drop = {
    protocol: "",
    destPorts: [],
    srcCidr: { ipv4: [], ipv6: [] },
    action: "drop",
    status: "active",
    displayName: "Block all traffic",
  };
  const bindings = Object.fromEntries(ids.map((id) => [id, value()]));
  const firewalls = new Map(
    ids.map((id) => {
      const instance = instances.get(id)!;
      return [
        bindings[id]!,
        {
          tenantId: account,
          customerId: account,
          firewallId: bindings[id],
          name: value(),
          description: "fixture",
          status: "active",
          instanceStatus: [{ instanceId: Number(id), status: "ok" }],
          instances: [
            {
              instanceId: Number(id),
              displayName: null,
              name: instance.name,
              productId: instance.productId,
              ipConfig: instance.ipConfig,
              regionSlug: "EU",
              regionName: "EU",
              dataCenterSlug: "EU",
              dataCenterName: "EU",
            },
          ],
          rules: { inbound: [drop] as unknown[] },
          createdDate: new Date().toISOString(),
          updatedDate: new Date().toISOString(),
        },
      ];
    }),
  );
  const key = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const calls: { method: string; path: string; requestId: string | null }[] =
    [];
  const sentRules: Array<{
    rules: {
      inbound: Array<Record<string, unknown> & { displayName: string }>;
    };
  }> = [];
  let lost = false,
    apply = true,
    reject = false;
  let oauthRequests = 0;
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input)),
      method = options?.method ?? "GET";
    if (url.pathname.endsWith("/token")) {
      oauthRequests++;
      return Response.json({
        access_token: value(),
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    calls.push({
      method,
      path: url.pathname,
      requestId: new Headers(options?.headers).get("x-request-id"),
    });
    const instance = /\/v1\/compute\/instances\/(\d+)$/.exec(url.pathname);
    if (instance)
      return Response.json({
        data: [instances.get(instance[1]!)],
        _links: { self: url.pathname },
      });
    const match = /\/v1\/firewalls\/([^/]+)(?:\/instances\/(\d+))?$/.exec(
      url.pathname,
    );
    if (!match) throw new Error("fixture_unexpected_provider_request");
    const firewall = firewalls.get(match[1]!)!;
    if (method === "PUT") {
      const claim = await env.DB.prepare(
        "SELECT state FROM node_network_mutations WHERE request_id=?",
      )
        .bind(new Headers(options?.headers).get("x-request-id"))
        .first("state");
      expect(claim).toBe("claimed");
      const sent = JSON.parse(String(options?.body));
      sentRules.push(sent);
      if (
        reject ||
        new Set(
          sent.rules.inbound.map(
            (rule: { displayName: string }) => rule.displayName,
          ),
        ).size !== sent.rules.inbound.length
      )
        return Response.json(
          { message: "Rule display name is already used" },
          { status: 400 },
        );
      if (apply) firewall.rules.inbound = [...sent.rules.inbound, drop];
      if (lost) {
        lost = false;
        throw new Error(value());
      }
    }
    if (method === "POST")
      return Response.json({ _links: { self: url.pathname } }, { status: 201 });
    return Response.json({ data: [firewall], _links: { self: url.pathname } });
  };
  const settings: NodeNetworkEnv = {
    DB: env.DB,
    ARCHIVE: env.ARCHIVE,
    CONTABO_CLIENT_ID: value(),
    CONTABO_CLIENT_SECRET: value(),
    CONTABO_USERNAME: value(),
    CONTABO_PASSWORD: value(),
    BOOTSTRAP_FIREWALL_BINDINGS: JSON.stringify(bindings),
    BOOTSTRAP_OPERATOR_SOURCES: JSON.stringify([
      address(10) + "/32",
      v6(10) + "/128",
    ]),
    BOOTSTRAP_RELAY_PROVIDER_INSTANCE_ID: ids[0]!,
    BOOTSTRAP_SCAN_CONTROL: JSON.stringify({
      ipv4: address(11),
      ipv6: v6(11),
      port: 12345,
    }),
    CREDENTIAL_KEYS: env.CREDENTIAL_KEYS,
    BOOTSTRAP_VERIFIER_KEYS: JSON.stringify({
      fixture: bytesToBase64url(
        new Uint8Array(
          (await crypto.subtle.exportKey("raw", key.publicKey)) as ArrayBuffer,
        ),
      ),
    }),
  };
  const run = (time?: number | (() => number)) =>
    ensureNodeNetwork(settings, addition.intent.operation_id, {
      fetcher,
      ...(time === undefined
        ? {}
        : { now: typeof time === "function" ? time : () => time }),
    });
  const firewall = () =>
    ensureNodeFirewall(settings, addition.intent.operation_id, { fetcher });
  const settle = async () => {
    expect(await run()).toBe(false);
    expect(await run()).toBe(false);
  };
  const payload = async (): Promise<NodePreparationProof> => {
    const row = await env.DB.prepare(
      "SELECT plan_json,plan_sha256,readback_at FROM node_network_preparations WHERE operation_id=?",
    )
      .bind(addition.intent.operation_id)
      .first<{ plan_json: string; plan_sha256: string; readback_at: string }>();
    const plan = JSON.parse(row!.plan_json);
    const observed = new Date().toISOString(),
      control = JSON.parse(settings.BOOTSTRAP_SCAN_CONTROL);
    const external = (family: "ipv4" | "ipv6") => {
      const targets = plan.members.flatMap(
        (member: {
          provider_instance_id: string;
          addresses: Record<string, string[]>;
        }) =>
          member.addresses[family]!.map((ip) => ({
            provider_instance_id: member.provider_instance_id,
            address: ip,
            protocol: "tcp",
            first_port: 1,
            last_port: 65535,
            scanned_ports: 65535,
            open_ports: [],
            started_at: row!.readback_at,
            observed_at: observed,
          })),
      );
      return targets.length
        ? {
            source: family === "ipv4" ? address(12) : v6(12),
            positive_control: {
              address: control[family],
              port: control.port,
              outcome: "connected",
              observed_at: observed,
            },
            scans: targets,
          }
        : null;
    };
    return {
      version: 1,
      operation_id: addition.intent.operation_id,
      node_id: addition.intent.node_id,
      region_id: state.region,
      provider_instance_id: ids[1]!,
      intent_hash: addition.intent_hash,
      plan_sha256: row!.plan_sha256,
      observed_at: observed,
      expires_at: new Date(Date.now() + 60000).toISOString(),
      relay_provider_instance_id: ids[0]!,
      firewalls: plan.members.map(
        (member: {
          firewall_id: string;
          provider_instance_id: string;
          rules_sha256: string;
        }) => ({
          firewall_id: member.firewall_id,
          provider_instance_id: member.provider_instance_id,
          rules_sha256: member.rules_sha256,
        }),
      ),
      access: plan.members.map(
        (member: {
          provider_instance_id: string;
          addresses: { ipv4: string[] };
        }) => ({
          provider_instance_id: member.provider_instance_id,
          address: member.addresses.ipv4[0]!,
          relay_source: address(1),
          observed_at: observed,
          checks: [
            { port: 22, outcome: "connected" },
            { port: 50000, outcome: "refused" },
            { port: 6443, outcome: "refused" },
          ],
        }),
      ),
      external: { ipv4: external("ipv4"), ipv6: external("ipv6") },
    } as NodePreparationProof;
  };
  const sign = async (input?: NodePreparationProof) => {
    const data = input ?? (await payload());
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        key.privateKey,
        new TextEncoder().encode(
          NODE_PREPARATION_SIGNATURE_DOMAIN +
            canonicalNodePreparationProof(data),
        ),
      ),
    );
    await env.ARCHIVE.put(
      `node-preparation/${addition.intent.operation_id}/proof.json`,
      JSON.stringify({
        kid: "fixture",
        payload: data,
        signature: bytesToBase64url(signature),
      }),
    );
  };
  return {
    state,
    fetcher,
    oauthRequests: () => oauthRequests,
    addition,
    run,
    firewall,
    settle,
    settings,
    calls,
    sentRules,
    firewalls,
    bindings,
    instances,
    payload,
    sign,
    lose(applied: boolean) {
      lost = true;
      apply = applied;
    },
    rejectRules() {
      reject = true;
    },
  };
}
it("includes each provider IPv6 gateway in initial ICMP policy and preserves the sealed plan", async () => {
  const f = await setup();
  const gateways = new Map<string, string>();
  for (const [index, [id, instance]] of [...f.instances].entries()) {
    const gateway = `fe80::${index + 7}`;
    instance.ipConfig.v6.gateway = gateway;
    gateways.set(id, gateway);
  }
  await f.settle();
  for (const [id, firewallId] of Object.entries(f.bindings)) {
    const rules = f.firewalls.get(firewallId)!.rules
      .inbound as ContaboFirewall["rules"]["inbound"];
    const icmp = rules.filter((rule) => rule.protocol === "icmp");
    expect(icmp).toHaveLength(1);
    expect(icmp[0]).toMatchObject({
      protocol: "icmp",
      destPorts: [],
      srcCidr: { ipv6: [`${gateways.get(id)}/128`] },
      action: "accept",
      status: "active",
    });
    expect(icmp[0]!.srcCidr.ipv4).toBeUndefined();
  }
  const readPlan = () =>
    env.DB.prepare(
      "SELECT plan_json,plan_sha256 FROM node_network_preparations WHERE operation_id=?",
    )
      .bind(f.addition.intent.operation_id)
      .first();
  const sealed = await readPlan();
  await f.sign();
  expect(await f.run()).toBe(true);
  for (const instance of f.instances.values())
    instance.ipConfig.v6.gateway = "fe80::99";
  expect(await f.run()).toBe(false);
  expect(await readPlan()).toEqual(sealed);
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(2);
});
it("rejects ICMP readback with ports, IPv4 sources or a broadened gateway source", async () => {
  const f = await setup();
  await f.settle();
  await f.sign();
  expect(await f.run()).toBe(true);
  const firewall = f.firewalls.values().next().value!;
  const icmp = (
    firewall.rules.inbound as ContaboFirewall["rules"]["inbound"]
  ).find((rule) => rule.protocol === "icmp")!;
  const exact = structuredClone(icmp);
  icmp.destPorts = ["22"];
  expect(await f.run()).toBe(false);
  Object.assign(icmp, structuredClone(exact));
  icmp.srcCidr.ipv4 = [address(9) + "/32"];
  expect(await f.run()).toBe(false);
  Object.assign(icmp, structuredClone(exact));
  icmp.srcCidr.ipv6 = [v6(9) + "/128"];
  expect(await f.run()).toBe(false);
  Object.assign(icmp, structuredClone(exact));
  icmp.srcCidr.ipv6 = [v6(254) + "/64"];
  expect(await f.run()).toBe(false);
  Object.assign(icmp, structuredClone(exact));
  expect(await f.run()).toBe(true);
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(2);
});
it("keeps a pre-existing legacy plan without ICMP byte-exact and eligible", async () => {
  const f = await setup();
  await f.settle();
  const operation = f.addition.intent.operation_id;
  const row = await env.DB.prepare(
    "SELECT plan_json FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(operation)
    .first<{ plan_json: string }>();
  const plan = JSON.parse(row!.plan_json);
  const digest = async (value: unknown) =>
    [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(canonicalNodeProof(value)),
        ),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  for (const member of plan.members) {
    member.rules.rules.inbound = member.rules.rules.inbound.filter(
      (rule: { protocol: string }) => rule.protocol !== "icmp",
    );
    member.rules_sha256 = await digest(
      member.rules.rules.inbound
        .map(
          (rule: {
            protocol: string;
            destPorts: string[];
            srcCidr: { ipv4?: string[]; ipv6?: string[] };
          }) => ({
            protocol: rule.protocol,
            destPorts: [...new Set(rule.destPorts)].sort(),
            srcCidr: {
              ipv4: [...new Set(rule.srcCidr.ipv4 ?? [])].sort(),
              ipv6: [...new Set(rule.srcCidr.ipv6 ?? [])].sort(),
            },
            action: "accept",
            status: "active",
          }),
        )
        .sort((left: unknown, right: unknown) =>
          canonicalNodeProof(left).localeCompare(canonicalNodeProof(right)),
        ),
    );
    const firewall = f.firewalls.get(member.firewall_id)!;
    firewall.rules.inbound = firewall.rules.inbound.filter(
      (rule) => (rule as { protocol: string }).protocol !== "icmp",
    );
  }
  const json = canonicalNodeProof(plan),
    sha = await digest(plan);
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM node_network_mutations WHERE operation_id=?",
    ).bind(operation),
    env.DB.prepare(
      "DELETE FROM node_network_firewalls WHERE operation_id=?",
    ).bind(operation),
    env.DB.prepare(
      "DELETE FROM node_network_preparations WHERE operation_id=?",
    ).bind(operation),
  ]);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO node_network_preparations(operation_id,intent_hash,plan_json,plan_sha256,created_at,updated_at) VALUES(?,?,?,?,?,?)",
  )
    .bind(operation, f.addition.intent_hash, json, sha, now, now)
    .run();
  expect(await f.run()).toBe(false);
  await f.sign();
  expect(await f.run()).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT plan_json,plan_sha256 FROM node_network_preparations WHERE operation_id=?",
    )
      .bind(operation)
      .first(),
  ).toEqual({ plan_json: json, plan_sha256: sha });
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(2);
  expect(f.sentRules).toHaveLength(2);
});
it("uses distinct provider rule labels while retaining the immutable security plan", async () => {
  const f = await setup();
  expect(await f.run()).toBe(false);
  expect(f.sentRules).toHaveLength(2);
  for (const sent of f.sentRules)
    expect(sent.rules.inbound.map((rule) => rule.displayName)).toEqual([
      "PGCF approved management (tcp)",
      "PGCF exact regional peers (tcp)",
      "PGCF exact regional peers (udp)",
      "PGCF exact IPv6 gateway (icmp)",
    ]);
  const row = await env.DB.prepare(
    "SELECT plan_json,plan_sha256 FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(f.addition.intent.operation_id)
    .first<{ plan_json: string; plan_sha256: string }>();
  const plan = JSON.parse(row!.plan_json);
  for (const member of plan.members)
    expect(
      member.rules.rules.inbound.map(
        (rule: { displayName: string }) => rule.displayName,
      ),
    ).toEqual([
      "PGCF approved management",
      "PGCF exact regional peers",
      "PGCF exact regional peers",
      "PGCF exact IPv6 gateway",
    ]);
  expect(await f.run()).toBe(false);
  await f.sign();
  expect(await f.run()).toBe(true);
  expect(
    await env.DB.prepare(
      "SELECT plan_json,plan_sha256 FROM node_network_preparations WHERE operation_id=?",
    )
      .bind(f.addition.intent.operation_id)
      .first(),
  ).toEqual(row);
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(2);
});
it("reuses provider authentication across production firewall lifecycle checks", async () => {
  const f = await setup();
  vi.spyOn(globalThis, "fetch").mockImplementation(f.fetcher);
  expect(
    await ensureNodeFirewall(f.settings, f.addition.intent.operation_id),
  ).toBe(false);
  expect(
    await ensureNodeFirewall(f.settings, f.addition.intent.operation_id),
  ).toBe(true);
  expect(
    await ensureNodeFirewall(f.settings, f.addition.intent.operation_id),
  ).toBe(true);
  expect(f.oauthRequests()).toBe(1);
});

it("acknowledges exact owned policy readback after explicit rejection without redispatching", async () => {
  const f = await setup();
  f.rejectRules();
  expect(await f.run()).toBe(false);
  expect(await f.run()).toBe(false);
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(2);
  const states = async () =>
    (
      await env.DB.prepare(
        "SELECT request_id,state FROM node_network_mutations WHERE operation_id=? AND action='rules' ORDER BY firewall_id",
      )
        .bind(f.addition.intent.operation_id)
        .all<{ request_id: string; state: string }>()
    ).results;
  const rejected = await states();
  expect(rejected.map((row) => row.state)).toEqual(["rejected", "rejected"]);
  const row = await env.DB.prepare(
    "SELECT plan_json FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(f.addition.intent.operation_id)
    .first<{ plan_json: string }>();
  const plan = JSON.parse(row!.plan_json);
  for (const member of plan.members) {
    const firewall = f.firewalls.get(member.firewall_id)!;
    const terminal = firewall.rules.inbound.at(-1);
    firewall.rules.inbound = [
      ...member.rules.rules.inbound.map(
        (rule: Record<string, unknown>, index: number) => ({
          ...rule,
          displayName: `Operator confirmed rule ${index}`,
        }),
      ),
      terminal,
    ];
  }
  expect(await f.run()).toBe(false);
  expect(await states()).toEqual(
    rejected.map((row) => ({ ...row, state: "confirmed" })),
  );
  await f.sign();
  expect(await f.run()).toBe(true);
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(2);
});

it("installation preparation requires signed proof and refuses an already attached processing firewall", async () => {
  const f = await setup();
  await f.settle();
  for (const firewall of f.firewalls.values())
    firewall.instanceStatus[0]!.status = "processing";
  expect(await f.run()).toBe(false);
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  expect(f.calls.some((call) => call.path.includes("/rescue"))).toBe(false);
});

it("separates fully read-back owned firewalls for RAM rescue from signed native installation authority", async () => {
  const f = await setup();
  await f.settle();
  expect(await f.firewall()).toBe(true);
  expect(await f.run()).toBe(false);
  const row = await env.DB.prepare(
    "SELECT status,proof_sha256,proof_expires_at,readback_at FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(f.addition.intent.operation_id)
    .first<{
      status: string;
      proof_sha256: string | null;
      proof_expires_at: string | null;
      readback_at: string | null;
    }>();
  expect(row).toMatchObject({
    status: "awaiting_proof",
    proof_sha256: null,
    proof_expires_at: null,
  });
  expect(row?.readback_at).not.toBeNull();
  for (const value of f.firewalls.values())
    value.instanceStatus[0]!.status = "processing";
  expect(await f.firewall()).toBe(false);
  expect(f.calls.some((call) => call.path.includes("/rescue"))).toBe(false);
});

it("excludes a lost historical peer from firewall preparation and outside-allowlist scan inventory", async () => {
  const f = await setup();
  const lost = newNodeId();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO nodes(id,region_id,k8s_node_name,ready,schedulable,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at,node_uid,lost_at,lost_reason)
      SELECT ?,region_id,?,0,0,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,?,?,?,?,'confirmed loss' FROM nodes WHERE id=?`,
  )
    .bind(
      lost,
      `lost-${lost}`,
      now,
      now,
      crypto.randomUUID(),
      now,
      f.state.node,
    )
    .run();
  expect(await f.run()).toBe(false);
  const row = await env.DB.prepare(
    "SELECT plan_json FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(f.addition.intent.operation_id)
    .first<{ plan_json: string }>();
  expect(row).not.toBeNull();
  const plan = JSON.parse(row!.plan_json);
  expect(
    plan.members.map((member: { node_id: string }) => member.node_id).sort(),
  ).toEqual([f.state.node, f.addition.intent.node_id].sort());
});

it("updates target and every existing peer bidirectionally and requires a real signed fresh bound artifact", async () => {
  const f = await setup();
  await f.settle();
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(2);
  for (const [id, firewall] of f.firewalls) {
    const rules = firewall.rules.inbound as {
      protocol: string;
      destPorts: string[];
      srcCidr: { ipv4?: string[] };
    }[];
    expect(
      rules.some(
        (rule) => rule.protocol === "udp" && rule.destPorts.includes("51871"),
      ),
    ).toBe(true);
    expect(
      rules.some(
        (rule) =>
          rule.destPorts.includes("5432") ||
          rule.destPorts.includes("2379-2380"),
      ),
    ).toBe(false);
    const other = Object.entries(f.bindings).find(
      (entry) => entry[1] !== id,
    )![0];
    expect(
      rules.some((rule) =>
        rule.srcCidr.ipv4?.includes(
          f.instances.get(other)!.ipConfig.v4.ip + "/32",
        ),
      ),
    ).toBe(true);
  }
  await f.sign();
  expect(await f.run()).toBe(true);
  const data = await f.payload();
  data.plan_sha256 = "0".repeat(64);
  await f.sign(data);
  expect(await f.run()).toBe(false);
});
it("an uncertain PUT resolves only by exact GET and never repeats a claimed mutation", async () => {
  const f = await setup();
  f.lose(true);
  expect(await f.run()).toBe(false);
  const puts = f.calls.filter((call) => call.method === "PUT").length;
  await f.settle();
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(puts);
  await f.sign();
  expect(await f.run()).toBe(true);
  const blocked = await setup();
  blocked.lose(false);
  expect(await blocked.run()).toBe(false);
  const before = blocked.calls.filter((call) => call.method === "PUT").length;
  expect(await blocked.run()).toBe(false);
  expect(blocked.calls.filter((call) => call.method === "PUT")).toHaveLength(
    before,
  );
});
it("forged, expired, incomplete or allowlisted-source external proof cannot authorize preparation", async () => {
  const f = await setup();
  await f.settle();
  await f.sign();
  const object = await env.ARCHIVE.get(
    `node-preparation/${f.addition.intent.operation_id}/proof.json`,
  );
  const raw = JSON.parse(await object!.text());
  raw.signature = bytesToBase64url(crypto.getRandomValues(new Uint8Array(64)));
  await env.ARCHIVE.put(
    `node-preparation/${f.addition.intent.operation_id}/proof.json`,
    JSON.stringify(raw),
  );
  expect(await f.run()).toBe(false);
  const expired = await f.payload();
  expired.expires_at = new Date(Date.now() - 1).toISOString();
  await f.sign(expired);
  expect(await f.run()).toBe(false);
  const incomplete = await f.payload();
  incomplete.external.ipv6 = null;
  await f.sign(incomplete);
  expect(await f.run()).toBe(false);
  const allowlisted = await f.payload();
  allowlisted.external.ipv4!.source = address(1);
  await f.sign(allowlisted);
  expect(await f.run()).toBe(false);
});
it("unapproved world rules or foreign firewall members fail the latest readback gate", async () => {
  const f = await setup();
  await f.settle();
  await f.sign();
  const firewall = f.firewalls.values().next().value!;
  firewall.rules.inbound.splice(0, 0, {
    protocol: "tcp",
    destPorts: ["5432"],
    srcCidr: { ipv4: [[0, 0, 0, 0].join(".") + "/0"] },
    action: "accept",
    status: "active",
    displayName: value(),
  });
  expect(await f.run()).toBe(false);
  firewall.instances[0]!.instanceId = 999;
  const before = f.calls.filter((call) => call.method !== "GET").length;
  expect(await f.run()).toBe(false);
  expect(f.calls.filter((call) => call.method !== "GET")).toHaveLength(before);
});
it("IPv6 absence is explicit only when every actual provider member has no IPv6 address", async () => {
  const f = await setup(false);
  await f.settle();
  const data = await f.payload();
  expect(data.external.ipv6).toBeNull();
  await f.sign(data);
  expect(await f.run()).toBe(true);
});

it("additional provider addresses enter peer rules and cannot disappear from the signed scan footprint", async () => {
  const f = await setup();
  f.instances.get(f.addition.provider_instance_id!)!.additionalIps.push({
    v4: { ip: address(99), gateway: address(254), netmaskCidr: 24 },
  });
  await f.settle();
  const data = await f.payload();
  expect(
    data.external.ipv4!.scans.some((scan) => scan.address === address(99)),
  ).toBe(true);
  const missing = structuredClone(data);
  missing.external.ipv4!.scans = missing.external.ipv4!.scans.filter(
    (scan) => scan.address !== address(99),
  );
  await f.sign(missing);
  expect(await f.run()).toBe(false);
  await f.sign(data);
  expect(await f.run()).toBe(true);
});
it("concurrent preparation runners persist one claim before each provider mutation", async () => {
  const f = await setup();
  expect(await Promise.all([f.run(), f.run()])).toEqual([false, false]);
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(2);
  expect(
    await env.DB.prepare(
      "SELECT count(*) count FROM node_network_mutations WHERE operation_id=? AND action='rules'",
    )
      .bind(f.addition.intent.operation_id)
      .first("count"),
  ).toBe(2);
  await f.settle();
  await f.sign();
  expect(await f.run()).toBe(true);
  expect(f.calls.filter((call) => call.method === "PUT")).toHaveLength(2);
});

it("a malformed provider terminal DROP cannot be assumed to protect an omitted address family", async () => {
  const f = await setup();
  await f.settle();
  await f.sign();
  const terminal = f.firewalls.values().next().value!.rules.inbound.at(-1) as {
    srcCidr: { ipv4: string[]; ipv6?: string[] };
  };
  delete terminal.srcCidr.ipv6;
  expect(await f.run()).toBe(false);
});

it("assignment remains fenced until exact membership readback and is never repeated", async () => {
  const f = await setup(),
    id = f.addition.provider_instance_id!,
    firewall = f.firewalls.get(f.bindings[id]!)!;
  const instance = firewall.instances[0]!;
  firewall.instances = [];
  firewall.instanceStatus = [];
  await f.settle();
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(
    await env.DB.prepare(
      "SELECT state FROM node_network_mutations WHERE operation_id=? AND action='assign'",
    )
      .bind(f.addition.intent.operation_id)
      .first("state"),
  ).toBe("accepted");
  expect(await f.run()).toBe(false);
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  firewall.instances = [instance];
  firewall.instanceStatus = [{ instanceId: Number(id), status: "ok" }];
  expect(await f.run()).toBe(false);
  await f.sign();
  expect(await f.run()).toBe(true);
});
it("a still-unexpired signed observation older than the freshness window remains blocked", async () => {
  const f = await setup();
  await f.settle();
  const data = await f.payload();
  data.expires_at = new Date(Date.now() + 180000).toISOString();
  await f.sign(data);
  expect(await f.run(Date.now() + 125000)).toBe(false);
});

it("proof cannot age beyond the freshness window while final provider readbacks finish", async () => {
  const f = await setup();
  await f.settle();
  const data = await f.payload();
  data.expires_at = new Date(Date.now() + 180000).toISOString();
  await f.sign(data);
  let reads = 0;
  const clock = () => Date.now() + (++reads < 3 ? 119000 : 121000);
  expect(await f.run(clock)).toBe(false);
});
