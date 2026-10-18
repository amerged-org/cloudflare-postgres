// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INSTALLER_PROGRESS_PATH,
  NodeEnrollmentSeed,
  hashApiKey,
} from "@pgcf/contracts";
import { INSTALLER_SCRIPT } from "@pgcf/contracts/node-installer";
import {
  driveNodeInstall,
  type InstallProvider,
} from "../../src/domain/node-installer.ts";
import { readNodeAddition } from "../../src/domain/node-state.ts";
import type { Instance } from "../../src/providers/contabo.ts";
import { cleanupFixtures } from "./fixtures.ts";
import { auditedAddition, forgetInstalls } from "./node-fixtures.ts";

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
const API = "https://api.example.org";
const settings = {
  ...env,
  NODE_API_ORIGIN: API,
  NODE_DNS_SERVERS: JSON.stringify(["192.0.2.53", "2001:db8::53"]),
  CONTABO_ORDER_SSH_KEY_IDS: JSON.stringify(["4711"]),
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
  },
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
function provider(
  providerInstance: string,
  answer: "accepted" | "rejected" | "unknown" = "accepted",
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
  const double = {
    getInstance: vi.fn(async () => instance(providerInstance)),
    rescue,
    restart,
  };
  return { rescue, restart, provider: double as unknown as InstallProvider };
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
