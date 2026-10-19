// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INSTALLER_PROGRESS_PATH,
  NodeEnrollmentResponse,
  NodeEnrollmentSeed,
  bytesToHex,
  hashApiKey,
} from "@pgcf/contracts";
import { releaseFileUrl } from "@pgcf/contracts/releases";
import { INSTALLER_SCRIPT } from "@pgcf/contracts/node-installer";
import {
  driveNodeInstall,
  type InstallProvider,
} from "../../src/domain/node-installer.ts";
import { readNodeAddition } from "../../src/domain/node-state.ts";
import {
  ContaboError,
  type ContaboFirewall,
  type Instance,
} from "../../src/providers/contabo.ts";
import {
  API_ORIGIN,
  assignRelease,
  cleanupFixtures,
  rawRequest,
} from "./fixtures.ts";
import {
  auditedAddition,
  enroll,
  forgetInstalls,
  newKey,
  progress,
  v4,
} from "./node-fixtures.ts";

afterEach(async () => {
  await forgetInstalls();
  await env.DB.prepare(
    "DELETE FROM fleet_region_releases WHERE release_id LIKE 'installer-test-%'",
  ).run();
  await env.DB.prepare(
    "DELETE FROM fleet_releases WHERE id LIKE 'installer-test-%'",
  ).run();
  await cleanupFixtures();
});

const MIB = 1024 ** 2;
const API = API_ORIGIN;
const FIREWALL_ID = "0c1d7ef0-5a52-4b6a-9a1e-6b3f2d1c9e10";
const settings = {
  ...env,
  NODE_API_ORIGIN: API,
  NODE_DNS_SERVERS: JSON.stringify(["192.0.2.53", "2001:db8::53"]),
  CONTABO_ORDER_SSH_KEY_IDS: JSON.stringify(["4711"]),
  CONTABO_NODE_FIREWALL_ID: FIREWALL_ID,
};
const hex = (letter: string) => letter.repeat(64);
const spec = (id: string) => ({
  version: 2,
  image: {
    url: "https://images.example.org/node-images/r1/pgcf-node.raw.zst",
    sha256: hex("1"),
    format: "raw.zst",
    size_bytes: 400 * MIB,
    raw_sha256: hex("2"),
    raw_bytes: 2048 * MIB,
  },
  binaries: Object.fromEntries(
    ["pgcf-agent", "pgcf-native-gateway", "pgcf-archive", "pgcf-wal-fetch"].map(
      (name) => [
        name,
        {
          url: `https://images.example.org/${id}/${name}`,
          sha256: hex("3"),
          size_bytes: MIB,
        },
      ],
    ),
  ),
  os: {
    image_version: "1.2.0",
    debian_snapshot: "20261016T000000Z",
    package_lock: {
      url: `https://images.example.org/${id}/packages.lock.json`,
      sha256: hex("4"),
      size_bytes: MIB,
    },
    packages_sha256: hex("6"),
    kernel_release: "6.12.113+deb13-amd64",
  },
  signature: "e".repeat(128),
});
async function release(region: string) {
  const id = `installer-test-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
    ).bind(id, JSON.stringify(spec(id)), hex("5"), now),
    env.DB.prepare(
      "INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at) VALUES(?,?,1,?)",
    ).bind(region, id, now),
  ]);
  return id;
}

/** The instance as Contabo reports it once it exists: 300 GiB, 12 GiB, a MAC and both networks. */
const instance = (id: string): Instance => ({
  id,
  tenantId: "DE",
  customerId: "1",
  name: "vps",
  displayName: "pgcf-node-x",
  dataCenter: "European Union 1",
  region: "EU",
  regionName: "European Union",
  productId: "V160",
  productName: "Cloud VPS 40",
  imageId: "image",
  ipConfig: {
    v4: { ip: "192.0.2.10", gateway: "192.0.2.1", netmaskCidr: 23 },
    v6: {
      ip: "2001:db8:1234:5678::10",
      gateway: "fe80::1",
      netmaskCidr: 64,
    },
  },
  additionalIps: [],
  ramMb: 12288,
  cpuCores: 6,
  diskMb: 307200,
  macAddress: "00:50:56:AA:BB:CC",
  osType: "Linux",
  applicationId: null,
  createdDate: "2026-10-18T10:00:00.000Z",
  cancelDate: null,
  status: "running",
  addOns: [],
});
type InboundRule = ContaboFirewall["rules"]["inbound"][number];
const rule = (action: "accept" | "drop", ...ports: string[]): InboundRule => ({
  protocol: ports.length > 0 ? "tcp" : "",
  destPorts: ports,
  srcCidr: { ipv4: [], ipv6: [] },
  action,
  status: "active",
  displayName: action === "accept" ? "ssh" : "final deny",
});
/** The firewall as Contabo reports it, holding the instances in `held` and applying `inbound`. */
const contaboFirewall = (
  held: Instance[],
  inbound: InboundRule[] = [],
): ContaboFirewall => ({
  tenantId: "DE",
  customerId: "1",
  firewallId: FIREWALL_ID,
  name: "pgcf-nodes",
  description: "deny-all inbound for the nodes",
  status: "active",
  instanceStatus: held.map((held) => ({
    instanceId: held.id,
    status: "ok" as const,
  })),
  instances: held.map((held) => ({
    instanceId: held.id,
    displayName: held.displayName,
    name: held.name ?? "vps",
    productId: held.productId,
    ipConfig: { v4: held.ipConfig!.v4, v6: held.ipConfig!.v6! },
    regionSlug: held.region,
    regionName: held.regionName!,
    dataCenterSlug: "eu1",
    dataCenterName: held.dataCenter!,
  })),
  rules: { inbound },
  createdDate: "2026-10-18T09:00:00.000Z",
  updatedDate: "2026-10-18T09:00:00.000Z",
});
function provider(
  providerInstance: string,
  answer: "accepted" | "rejected" | "unknown" = "accepted",
  /**
   * The operator's firewall: by default it already holds the instance and applies no rule. An
   * assignment is listed at once, or only after `settle()` when Contabo applies it later.
   */
  node: {
    held?: boolean;
    inbound?: InboundRule[];
    applies?: "at once" | "later";
  } = {},
) {
  const rescue = vi.fn(async (_id: string, _input, request) => ({
    kind: answer,
    code: answer === "accepted" ? "accepted" : "provider_rejected",
    requestId: request.requestId,
    dispatched: true,
    ...(answer === "accepted"
      ? {
          status: 201,
          value: {
            instanceId: providerInstance,
            action: "rescue",
          },
        }
      : {}),
  }));
  const restart = vi.fn(async (_id: string, request) => ({
    kind: "accepted",
    code: "accepted",
    status: 201,
    requestId: request.requestId,
    dispatched: true,
    value: { instanceId: providerInstance, action: "restart" },
  }));
  const firewall = contaboFirewall(
    node.held === false ? [] : [instance(providerInstance)],
    node.inbound,
  );
  const list = (id: string) => {
    const listed = contaboFirewall([instance(id)]);
    firewall.instances.push(...listed.instances);
    firewall.instanceStatus.push(...listed.instanceStatus);
  };
  const queued: string[] = [];
  const getFirewall = vi.fn(async (id: string) => {
    if (id !== FIREWALL_ID) throw new ContaboError("unexpected_status", 404);
    return structuredClone(firewall);
  });
  const assignFirewall = vi.fn(
    async (id: string, instanceId: string, request) => {
      if (node.applies === "later") queued.push(instanceId);
      else list(instanceId);
      return {
        kind: "accepted",
        code: "accepted",
        status: 201,
        requestId: request.requestId,
        dispatched: true,
        value: { firewallId: id, instanceId },
      };
    },
  );
  const double = {
    getInstance: vi.fn(async () => instance(providerInstance)),
    getFirewall,
    assignFirewall,
    rescue,
    restart,
  };
  return {
    rescue,
    restart,
    getFirewall,
    assignFirewall,
    firewall,
    settle: () => queued.splice(0).forEach(list),
    provider: double as unknown as InstallProvider,
  };
}
const parameters = (userData: string) => {
  const content = (path: string) =>
    Buffer.from(
      new RegExp(`path: ${path}\\n(?:.*\\n)*?\\s+content: (\\S+)`).exec(
        userData,
      )![1]!,
      "base64",
    ).toString("utf8");
  return {
    script: content("/run/pgcf-install/install.sh"),
    values: Object.fromEntries(
      content("/run/pgcf-install/params")
        .trim()
        .split("\n")
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    ) as Record<string, string>,
  };
};

describe("the install of an audited node", () => {
  it("issues the tokens and rescues the instance with an installer whose seed the agent accepts", async () => {
    const a = await auditedAddition();
    await release(a.f.region);
    const p = provider(a.instance);
    await driveNodeInstall(
      settings,
      a.addition.intent.operation_id,
      p.provider,
    );
    expect(p.rescue).toHaveBeenCalledTimes(1);
    const [target, input, request] = p.rescue.mock.calls[0]!;
    expect(target).toBe(a.instance);
    // The provider needs a key or a password with the rescue; the installer needs neither.
    expect(input).toMatchObject({ sshKeys: ["4711"] });
    expect(request).toMatchObject({
      accounting: {
        operation_id: a.addition.intent.operation_id,
        stage: "rescue",
      },
    });
    const { script, values } = parameters(input.userData);
    expect(script).toBe(INSTALLER_SCRIPT);
    expect(input.userData.startsWith("#cloud-config\n")).toBe(true);
    expect(values).toMatchObject({
      PGCF_NODE_ID: a.id,
      PGCF_REGION: a.f.region,
      PGCF_API_URL: API,
      PGCF_PROGRESS_URL: `${API}${INSTALLER_PROGRESS_PATH}`,
      PGCF_HOSTNAME: a.addition.intent.requested_hostname,
      PGCF_IMAGE_ZST_BYTES: String(400 * MIB),
      PGCF_IMAGE_RAW_BYTES: String(2048 * MIB),
      PGCF_IMAGE_ZST_SHA256: hex("1"),
      PGCF_IMAGE_RAW_SHA256: hex("2"),
      // The provider's disk, in bytes, and 90 % of its memory in KiB.
      PGCF_DISK_BYTES: String(307200 * MIB),
      PGCF_MEMORY_MIN_KIB: String(Math.floor(12288 * 1024 * 0.9)),
      PGCF_MAC: "00:50:56:aa:bb:cc",
      PGCF_IPV4: "192.0.2.10",
      PGCF_IPV4_PREFIX: "23",
      PGCF_IPV4_GATEWAY: "192.0.2.1",
      PGCF_IPV6: "2001:db8:1234:5678::10",
      PGCF_IPV6_PREFIX: "64",
      PGCF_IPV6_GATEWAY: "fe80::1",
      PGCF_DNS: "192.0.2.53 2001:db8::53",
    });
    expect(
      NodeEnrollmentSeed.safeParse({
        node_id: values.PGCF_NODE_ID,
        region: values.PGCF_REGION,
        api_url: values.PGCF_API_URL,
        enrollment_token: values.PGCF_ENROLLMENT_TOKEN,
      }).success,
    ).toBe(true);
    // The two tokens in the userData are the ones D1 holds the HMACs of, for the release's image.
    const row = await env.DB.prepare(
      "SELECT * FROM node_installs WHERE node_id=?",
    )
      .bind(a.id)
      .first<Record<string, string>>();
    expect(row).toMatchObject({
      image_version: "1.2.0",
      allowed_sources_json: JSON.stringify(["192.0.2.10"]),
      token_hash: await hashApiKey(
        env.API_KEY_PEPPER,
        values.PGCF_ENROLLMENT_TOKEN!,
      ),
      progress_hash: await hashApiKey(
        env.API_KEY_PEPPER,
        values.PGCF_PROGRESS_TOKEN!,
      ),
    });
    expect(row!.rescue_requested_at).not.toBeNull();
    expect(
      (await readNodeAddition(env.DB, a.addition.intent.operation_id)).status,
    ).toBe("bootstrapping");
  });

  it("rescues once, however often it is asked", async () => {
    const a = await auditedAddition();
    await release(a.f.region);
    const p = provider(a.instance);
    for (let i = 0; i < 3; i++)
      await driveNodeInstall(
        settings,
        a.addition.intent.operation_id,
        p.provider,
      );
    expect(p.rescue).toHaveBeenCalledTimes(1);
  });

  it("waits while its region has no release, and fails the addition when the provider rejects the rescue", async () => {
    const a = await auditedAddition();
    const p = provider(a.instance, "rejected");
    await driveNodeInstall(
      settings,
      a.addition.intent.operation_id,
      p.provider,
    );
    expect(p.rescue).not.toHaveBeenCalled();
    expect(
      (await readNodeAddition(env.DB, a.addition.intent.operation_id)).status,
    ).toBe("audited");
    await release(a.f.region);
    await driveNodeInstall(
      settings,
      a.addition.intent.operation_id,
      p.provider,
    );
    expect(p.rescue).toHaveBeenCalledTimes(1);
    expect(
      await readNodeAddition(env.DB, a.addition.intent.operation_id),
    ).toMatchObject({ status: "failed", failure_code: "bootstrap_failed" });
  });

  it("goes on with an answer it does not know: the installer's own report tells", async () => {
    const a = await auditedAddition();
    await release(a.f.region);
    const p = provider(a.instance, "unknown");
    await driveNodeInstall(
      settings,
      a.addition.intent.operation_id,
      p.provider,
    );
    expect(
      (await readNodeAddition(env.DB, a.addition.intent.operation_id)).status,
    ).toBe("bootstrapping");
    await driveNodeInstall(
      settings,
      a.addition.intent.operation_id,
      p.provider,
    );
    expect(p.rescue).toHaveBeenCalledTimes(1);
  });
});

describe("the node firewall before the rescue", () => {
  const started = async (
    ...options: [
      Parameters<typeof provider>[1]?,
      Parameters<typeof provider>[2]?,
    ]
  ) => {
    const a = await auditedAddition();
    await release(a.f.region);
    const p = provider(a.instance, ...options);
    const operation = a.addition.intent.operation_id;
    return {
      a,
      p,
      operation,
      drive: () => driveNodeInstall(settings, operation, p.provider),
      addition: () => readNodeAddition(env.DB, operation),
      accounting: {
        accounting: { operation_id: operation, stage: "firewall" },
      },
    };
  };
  const tokens = (nodeId: string) =>
    env.DB.prepare("SELECT 1 AS issued FROM node_installs WHERE node_id=?")
      .bind(nodeId)
      .first();

  it("sends no rescue while the firewall has an inbound rule that accepts, records it, and goes on when the rule is gone", async () => {
    const s = await started("accepted", { inbound: [rule("accept", "22")] });
    await s.drive();
    expect(s.p.getFirewall).toHaveBeenCalledWith(
      FIREWALL_ID,
      expect.objectContaining(s.accounting),
    );
    expect(s.p.rescue).not.toHaveBeenCalled();
    expect(await s.addition()).toMatchObject({
      status: "audited",
      install_blocker: "node_firewall_unconfirmed",
    });
    // The tokens' lifetime starts with the rescue, not with a firewall that is still open.
    expect(await tokens(s.a.id)).toBeNull();
    s.p.firewall.rules.inbound = [];
    await s.drive();
    expect(s.p.rescue).toHaveBeenCalledTimes(1);
    expect(await s.addition()).toMatchObject({
      status: "bootstrapping",
      install_blocker: null,
    });
  });

  it("assigns an instance the firewall does not hold, then rescues it", async () => {
    const s = await started("accepted", { held: false });
    await s.drive();
    expect(s.p.assignFirewall).toHaveBeenCalledTimes(1);
    const [firewall, instance, request] = s.p.assignFirewall.mock.calls[0]!;
    expect([firewall, instance]).toEqual([FIREWALL_ID, s.a.instance]);
    expect(request).toMatchObject(s.accounting);
    expect(s.p.rescue).toHaveBeenCalledTimes(1);
    expect(s.p.assignFirewall.mock.invocationCallOrder[0]).toBeLessThan(
      s.p.rescue.mock.invocationCallOrder[0]!,
    );
  });

  it("sends no rescue while the read after the assignment lacks the instance, and goes on once Contabo lists it", async () => {
    const s = await started("accepted", { held: false, applies: "later" });
    await s.drive();
    expect(s.p.assignFirewall).toHaveBeenCalledTimes(1);
    expect(s.p.rescue).not.toHaveBeenCalled();
    expect(await s.addition()).toMatchObject({
      status: "audited",
      install_blocker: "node_firewall_unconfirmed",
    });
    s.p.settle();
    await s.drive();
    expect(s.p.assignFirewall).toHaveBeenCalledTimes(1);
    expect(s.p.rescue).toHaveBeenCalledTimes(1);
  });

  it("sends no rescue while Contabo still applies the firewall to a listed instance, without assigning it again, and goes on once it reports ok", async () => {
    const s = await started();
    s.p.firewall.instanceStatus[0]!.status = "processing";
    await s.drive();
    expect(s.p.assignFirewall).not.toHaveBeenCalled();
    expect(s.p.rescue).not.toHaveBeenCalled();
    expect(await s.addition()).toMatchObject({
      status: "audited",
      install_blocker: "node_firewall_unconfirmed",
    });
    expect(await tokens(s.a.id)).toBeNull();
    s.p.firewall.instanceStatus[0]!.status = "ok";
    await s.drive();
    expect(s.p.rescue).toHaveBeenCalledTimes(1);
  });

  it("does not assign an instance the firewall already holds", async () => {
    const s = await started();
    await s.drive();
    expect(s.p.getFirewall).toHaveBeenCalledTimes(1);
    expect(s.p.assignFirewall).not.toHaveBeenCalled();
    expect(s.p.rescue).toHaveBeenCalledTimes(1);
  });

  it("shows no install blocker once the firewall is confirmed and the provider rejects the rescue", async () => {
    const s = await started("rejected", { inbound: [rule("accept", "22")] });
    await s.drive();
    expect(await s.addition()).toMatchObject({
      install_blocker: "node_firewall_unconfirmed",
    });
    s.p.firewall.rules.inbound = [];
    await s.drive();
    expect(await s.addition()).toMatchObject({
      status: "failed",
      failure_code: "bootstrap_failed",
      install_blocker: null,
    });
  });

  it("takes a rule that only drops traffic for Contabo's final deny", async () => {
    const s = await started("accepted", { inbound: [rule("drop")] });
    await s.drive();
    expect(s.p.getFirewall).toHaveBeenCalledTimes(1);
    expect(s.p.rescue).toHaveBeenCalledTimes(1);
  });

  it("treats a firewall it cannot read as unconfirmed, without failing the cycle", async () => {
    const s = await started();
    s.p.getFirewall.mockRejectedValue(new ContaboError("timeout"));
    await s.drive();
    expect(s.p.rescue).not.toHaveBeenCalled();
    expect(await s.addition()).toMatchObject({
      status: "audited",
      install_blocker: "node_firewall_unconfirmed",
    });
  });
});

describe("the install of a node that is being installed", () => {
  const started = async () => {
    const a = await auditedAddition();
    await release(a.f.region);
    const p = provider(a.instance);
    const operation = a.addition.intent.operation_id;
    await driveNodeInstall(settings, operation, p.provider);
    const checkpoints = async (list: [string, number][]) =>
      env.DB.prepare(
        "UPDATE node_installs SET checkpoints_json=? WHERE node_id=?",
      )
        .bind(
          JSON.stringify(
            list.map(([checkpoint, agoMs]) => ({
              checkpoint,
              detail: "",
              at: new Date(Date.now() - agoMs).toISOString(),
            })),
          ),
          a.id,
        )
        .run();
    const status = async () =>
      (await readNodeAddition(env.DB, operation)).status;
    return { a, p, operation, checkpoints, status };
  };

  it("fails with the installer's own failure", async () => {
    const s = await started();
    await s.checkpoints([
      ["started", 60_000],
      ["failed", 1_000],
    ]);
    await driveNodeInstall(settings, s.operation, s.p.provider);
    expect(await s.status()).toBe("failed");
  });

  it("restarts the instance once when the node does not enroll after the installer rebooted it", async () => {
    const s = await started();
    // The reboot came a minute ago: the first boot is still under way.
    await s.checkpoints([
      ["started", 300_000],
      ["rebooting", 60_000],
    ]);
    await driveNodeInstall(settings, s.operation, s.p.provider);
    expect(s.p.restart).not.toHaveBeenCalled();
    // It came 4 minutes ago and the node has not enrolled: Contabo may have booted rescue again.
    await s.checkpoints([
      ["started", 600_000],
      ["rebooting", 240_000],
    ]);
    await driveNodeInstall(settings, s.operation, s.p.provider);
    await driveNodeInstall(settings, s.operation, s.p.provider);
    expect(s.p.restart).toHaveBeenCalledTimes(1);
    expect(s.p.restart.mock.calls[0]![0]).toBe(s.a.instance);
    expect(await s.status()).toBe("bootstrapping");
  });

  it("fails when the tokens ran out before the node enrolled", async () => {
    const s = await started();
    await env.DB.prepare(
      "UPDATE node_installs SET issued_at=?,expires_at=? WHERE node_id=?",
    )
      .bind(
        new Date(Date.now() - 3_600_000).toISOString(),
        new Date(Date.now() - 1_800_000).toISOString(),
        s.a.id,
      )
      .run();
    await driveNodeInstall(settings, s.operation, s.p.provider);
    expect(await s.status()).toBe("failed");
  });
});

describe("the install of a node from a registered release, as the installer carries it out", () => {
  const sha256 = async (bytes: ArrayBuffer) =>
    bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));

  it("reads the image the release registered with the token of its userData, reports every checkpoint and enrolls", async () => {
    const a = await auditedAddition();
    const version = `installer-test-${crypto.randomUUID().slice(0, 8)}`;
    await assignRelease(a.f, version);
    const p = provider(a.instance);
    const operation = a.addition.intent.operation_id;
    await driveNodeInstall(settings, operation, p.provider);
    const { values } = parameters(p.rescue.mock.calls[0]![1].userData);
    // The userData names the Worker's route and carries no presigned URL and no bucket key.
    expect(values.PGCF_IMAGE_URL).toBe(
      releaseFileUrl(API, version, "pgcf-node.raw.zst"),
    );
    expect(p.rescue.mock.calls[0]![1].userData).not.toMatch(
      /X-Amz|r2\.cloudflarestorage|R2_/,
    );
    const image = new URL(values.PGCF_IMAGE_URL!).pathname;
    expect((await rawRequest(image)).status).toBe(401);
    const token = { Authorization: `Bearer ${values.PGCF_PROGRESS_TOKEN}` };
    const report = (checkpoint: string) =>
      progress(values.PGCF_PROGRESS_TOKEN!, checkpoint);

    expect((await report("started")).status).toBe(200);
    expect((await report("hardware_ok")).status).toBe(200);
    // The size by HEAD, then the bytes: what the installer verifies is what was registered.
    const head = await rawRequest(image, { method: "HEAD", headers: token });
    const download = await rawRequest(image, { headers: token });
    const bytes = await download.arrayBuffer();
    expect(head.headers.get("Content-Length")).toBe(String(bytes.byteLength));
    expect(String(bytes.byteLength)).toBe(values.PGCF_IMAGE_ZST_BYTES);
    expect(await sha256(bytes)).toBe(values.PGCF_IMAGE_ZST_SHA256);
    for (const checkpoint of [
      "image_verified",
      "disk_written",
      "configured",
      "rebooting",
    ])
      expect((await report(checkpoint)).status, checkpoint).toBe(200);

    // The installer is done: its token reads nothing and reports nothing any more.
    expect((await rawRequest(image, { headers: token })).status).toBe(401);
    expect((await report("failed")).status).toBe(401);

    // The first boot enrolls with the seed the installer wrote, from the instance's own address.
    const { publicKey } = await newKey();
    const enrolled = await enroll(
      {
        node_id: values.PGCF_NODE_ID,
        enrollment_token: values.PGCF_ENROLLMENT_TOKEN,
        public_key: publicKey,
        image_version: version,
      },
      v4,
    );
    expect(enrolled.status).toBe(200);
    expect(NodeEnrollmentResponse.parse(await enrolled.json())).toMatchObject({
      id: a.id,
      region_id: a.f.region,
    });
  });
});
