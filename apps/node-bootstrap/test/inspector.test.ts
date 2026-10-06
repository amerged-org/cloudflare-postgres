// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newNodeId, newOperationId } from "@pgcf/contracts";
import {
  createNodeRescueHostIdentity,
  type NodeInspectionInput,
} from "@pgcf/contracts/node-installation";
import { digest, runCommand, type Command } from "../src/bootstrap.ts";
import { inspectNode, runInspection } from "../src/inspector.ts";

const separator = "\n__PGCF_INSPECTION_RECORD__\n";
async function input(): Promise<NodeInspectionInput> {
  const host = await createNodeRescueHostIdentity();
  const client = await createNodeRescueHostIdentity();
  const operation = newOperationId();
  const base = `https://inspection.invalid/internal/v1/node-installation/${operation}`;
  return {
    version: 1,
    operation_id: operation,
    node_id: newNodeId(),
    region_id: "region-dev",
    provider_instance_id: "123456",
    profile_sha256: digest(randomBytes(32)),
    binding_sha256: digest(randomBytes(32)),
    network_plan_sha256: digest(randomBytes(32)),
    expected_generation: 0,
    deadline_at: new Date(Date.now() + 120_000).toISOString(),
    expected_network: {
      mac: "02:00:00:00:00:17",
      ipv4: "192.0.2.17",
      prefix_length: 24,
      gateway: "192.0.2.1",
    },
    dns: ["192.0.2.53"],
    peer_ipv4: ["192.0.2.18"],
    rescue: {
      ssh_private_key: JSON.parse(client.user_data.split("\n")[1]!).ssh_keys
        .ed25519_private,
      ssh_host_key: host.ssh_host_key,
      ssh_host_fingerprint: host.ssh_host_fingerprint,
    },
    callback: {
      url: `${base}/inspection`,
      bearer: randomBytes(32).toString("base64url"),
    },
    transport_url: `${base}/transport`,
    relay_url: base.replace("https:", "wss:") + "/relay",
  };
}
function hardware(
  value: NodeInspectionInput,
  changes: Record<string, unknown> = {},
) {
  const fields = {
    blocks: {
      blockdevices: [
        {
          path: "/dev/vda",
          type: "disk",
          size: 160 * 1024 ** 3,
          mountpoints: [null],
        },
      ],
    },
    links: [
      {
        link_type: "ether",
        ifname: "eth0",
        address: value.expected_network.mac,
      },
    ],
    addresses: [
      {
        ifname: "eth0",
        addr_info: [
          {
            family: "inet",
            local: value.expected_network.ipv4,
            prefixlen: value.expected_network.prefix_length,
          },
        ],
      },
    ],
    routes: [{ gateway: value.expected_network.gateway, dev: "eth0" }],
    root: {
      filesystems: [
        { target: "/", source: "rootfs", fstype: "rootfs", options: "rw" },
      ],
    },
    swaps: "",
    ram: 8 * 1024 ** 3,
    available: 7 * 1024 ** 3,
    run: {
      filesystems: [
        { target: "/run", source: "tmpfs", fstype: "tmpfs", options: "rw" },
      ],
    },
    ...changes,
  };
  return Object.values(fields)
    .map((field, index) =>
      index >= 5 && index <= 7 ? String(field) : JSON.stringify(field),
    )
    .join(separator);
}
function scenario(value: NodeInspectionInput) {
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: `sha256:${digest(randomBytes(32))}`,
        size: 1000,
        platform: { architecture: "amd64", os: "linux" },
      },
    ],
  });
  let cleaned = false,
    hardwareReads = 0,
    reports = 0;
  const commands: Command[] = [];
  const run = async (command: Command) => {
    commands.push(command);
    command.signal.throwIfAborted();
    assert.ok(command.timeout_ms > 0 && command.timeout_ms <= 600_000);
    if (command.executable === "ssh-keygen") return runCommand(command);
    assert.equal(command.executable, "ssh");
    assert.ok(command.args.includes("StrictHostKeyChecking=yes"));
    assert.ok(command.args.includes("ConnectionAttempts=1"));
    const hostFile = command.args
      .find((arg) => arg.startsWith("UserKnownHostsFile="))!
      .split("=")[1]!;
    assert.equal(
      (await readFile(hostFile, "utf8")).trim(),
      `${value.operation_id} ${value.rescue.ssh_host_key}`,
    );
    const script = command.stdin!;
    assert.ok(
      !/sgdisk\s+--(?:zap|move)|dd\s|mkfs|reboot|of=\/dev\//.test(script),
    );
    if (script.includes("__PGCF_INSPECTION_HARDWARE__")) {
      hardwareReads++;
      return { exit_code: 0, stdout: hardware(value) };
    }
    if (script.includes("__PGCF_INSPECTION_SCRATCH__"))
      return { exit_code: 0, stdout: String(6 * 1024 ** 3) };
    if (script.includes("__PGCF_INSPECTION_IMAGE__"))
      return {
        exit_code: 0,
        stdout: JSON.stringify({
          compressed_sha256: digest(randomBytes(32)),
          compressed_bytes: 1024 ** 2,
          raw_sha256: digest(randomBytes(32)),
          raw_bytes: 4 * 1024 ** 2,
        }),
      };
    if (script.includes("sfdisk --json"))
      return {
        exit_code: 0,
        stdout: JSON.stringify({
          partitiontable: {
            partitions: [34, 134, 234, 334].map((start) => ({
              start,
              size: 100,
              type: "type",
              uuid: "uuid",
            })),
          },
        }),
      };
    if (script.includes("sgdisk --verify"))
      return {
        exit_code: 0,
        stdout: "No problems found. 100 free sectors available.",
      };
    if (script.includes("__PGCF_INSPECTION_CLEANUP__")) {
      cleaned = true;
      return { exit_code: 0, stdout: "pgcf_inspection_clean" };
    }
    throw new Error("unexpected inspection command");
  };
  const request: typeof fetch = async (url, options) => {
    if (String(url) === "https://factory.talos.dev/schematics")
      return Response.json({ id: digest(randomBytes(32)) });
    if (String(url).includes("/v2/metal-installer/"))
      return new Response(manifest, {
        headers: {
          "docker-content-digest": `sha256:${digest(manifest)}`,
          "content-type": "application/vnd.oci.image.index.v1+json",
        },
      });
    assert.equal(String(url), value.callback.url);
    assert.equal(options?.method, "POST");
    assert.equal(
      new Headers(options?.headers).get("authorization"),
      `Bearer ${value.callback.bearer}`,
    );
    assert.equal(cleaned, true);
    assert.equal(hardwareReads, 2);
    reports++;
    const report = JSON.parse(String(options?.body));
    assert.equal(report.expected_generation, value.expected_generation);
    assert.equal(report.inspection.hardware.disk_bytes, 160 * 1024 ** 3);
    return Response.json({ ok: true });
  };
  return {
    run,
    request,
    commands,
    cleaned: () => cleaned,
    hardwareReads: () => hardwareReads,
    reports: () => reports,
  };
}

test("measures unknown hardware and image in RAM, cleans up and rereads identity before its single report", async () => {
  const value = await input(),
    state = scenario(value);
  const report = await runInspection(value, state);
  assert.equal(report.hardware.ram_bytes, 8 * 1024 ** 3);
  assert.equal(
    report.rescue_host_fingerprint,
    value.rescue.ssh_host_fingerprint,
  );
  assert.equal(state.reports(), 1);
  const image = state.commands.find((command) =>
    command.stdin?.includes("__PGCF_INSPECTION_IMAGE__"),
  )!.stdin!;
  assert.ok(image.includes("nocloud-amd64.raw.xz"));
  assert.ok(image.includes("--retry 0"));
  assert.ok(!image.includes("--continue-at"));
});

test("rejects a mounted install disk before image download or scratch allocation", async () => {
  const value = await input(),
    state = scenario(value);
  await assert.rejects(
    inspectNode(value, {
      ...state,
      run: async (command) =>
        command.stdin?.includes("__PGCF_INSPECTION_HARDWARE__")
          ? {
              exit_code: 0,
              stdout: hardware(value, {
                blocks: {
                  blockdevices: [
                    {
                      path: "/dev/vda",
                      type: "disk",
                      size: 160 * 1024 ** 3,
                      mountpoints: ["/data"],
                    },
                  ],
                },
              }),
            }
          : state.run(command),
    }),
    /inspection_disk_mounted/,
  );
  assert.ok(
    !state.commands.some((command) =>
      command.stdin?.includes("__PGCF_INSPECTION_SCRATCH__"),
    ),
  );
  assert.equal(state.reports(), 0);
});

test("IPv6 inspection binds the provider address and prefix to the same MAC interface and measures its actual default gateway", async () => {
  const value = await input();
  const ipv6 = { address: "2001:db8:7::17", prefix_length: 64 };
  const configured = {
    ...value,
    expected_network: { ...value.expected_network, ipv6 },
  };
  const state = scenario(configured);
  const options = {
    ...state,
    run: async (command: Command) => {
      if (command.stdin?.includes("__PGCF_INSPECTION_HARDWARE__")) {
        await state.run(command);
        return {
          exit_code: 0,
          stdout:
            hardware(configured) +
            separator +
            JSON.stringify([
              {
                ifname: "eth0",
                addr_info: [
                  {
                    family: "inet6",
                    local: ipv6.address,
                    prefixlen: 64,
                    scope: "global",
                  },
                ],
              },
            ]) +
            separator +
            JSON.stringify([{ gateway: "fe80::1", dev: "eth0" }]),
        };
      }
      return state.run(command);
    },
  };
  const observation = await inspectNode(configured, options);
  assert.deepEqual(observation.hardware.ipv6, { ...ipv6, gateway: "fe80::1" });
  assert.ok(
    state.commands.some((command) =>
      command.stdin?.includes("ip -json -6 address"),
    ),
  );
  assert.ok(
    state.commands.some((command) =>
      command.stdin?.includes("ip -json -6 route show default"),
    ),
  );
  const absent = scenario(configured);
  await assert.rejects(
    inspectNode(configured, {
      ...absent,
      run: async (command) =>
        command.stdin?.includes("__PGCF_INSPECTION_HARDWARE__")
          ? {
              exit_code: 0,
              stdout:
                hardware(configured) + separator + "[]" + separator + "[]",
            }
          : absent.run(command),
    }),
    /inspection_ipv6_unavailable/,
  );
});

test("unproven overlay backing stops before allocating scratch or downloading an image", async () => {
  const value = await input(),
    state = scenario(value);
  await assert.rejects(
    inspectNode(value, {
      ...state,
      run: async (command) => {
        if (command.stdin?.includes("__PGCF_INSPECTION_HARDWARE__"))
          return {
            exit_code: 0,
            stdout: hardware(value, {
              root: {
                filesystems: [
                  {
                    target: "/",
                    source: "overlay",
                    fstype: "overlay",
                    options:
                      "rw,upperdir=/run/overlay/upper,workdir=/run/overlay/work",
                  },
                ],
              },
            }),
          };
        if (
          command.stdin?.includes(
            "findmnt --json --target '/run/overlay/upper'",
          )
        )
          return {
            exit_code: 0,
            stdout: ["upper", "work"]
              .map((name) =>
                JSON.stringify({
                  filesystems: [
                    {
                      target: `/run/overlay/${name}`,
                      source: "unproven",
                      fstype: name === "upper" ? "tmpfs" : "ext4",
                    },
                  ],
                }),
              )
              .join(separator),
          };
        return state.run(command);
      },
    }),
    /inspection_ram_backing_unproven/,
  );
  assert.ok(
    !state.commands.some((command) =>
      command.stdin?.includes("__PGCF_INSPECTION_SCRATCH__"),
    ),
  );
});

test("cancelling after scratch allocation uses the remaining cleanup budget and sends no report", async () => {
  const value = await input(),
    state = scenario(value),
    abort = new AbortController();
  await assert.rejects(
    runInspection(value, {
      ...state,
      signal: abort.signal,
      run: async (command) => {
        const result = await state.run(command);
        if (command.stdin?.includes("__PGCF_INSPECTION_IMAGE__")) abort.abort();
        return result;
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(state.cleaned(), true);
  assert.equal(state.reports(), 0);
});

test("final MAC mismatch and uncertain callback response never produce an automatic second report", async () => {
  const value = await input(),
    state = scenario(value);
  let reads = 0;
  await assert.rejects(
    runInspection(value, {
      ...state,
      run: async (command) => {
        if (
          command.stdin?.includes("__PGCF_INSPECTION_HARDWARE__") &&
          ++reads === 2
        )
          return {
            exit_code: 0,
            stdout: hardware(value, {
              links: [
                {
                  link_type: "ether",
                  ifname: "eth0",
                  address: "02:00:00:00:00:18",
                },
              ],
            }),
          };
        return state.run(command);
      },
    }),
    /inspection_network_mismatch/,
  );
  assert.equal(state.cleaned(), true);
  assert.equal(state.reports(), 0);
  const lost = scenario(value);
  let attempts = 0;
  await assert.rejects(
    runInspection(value, {
      ...lost,
      request: async (url, options) => {
        if (String(url) === value.callback.url) {
          attempts++;
          throw new Error("lost callback response");
        }
        return lost.request(url, options);
      },
    }),
    /inspection_report_unknown/,
  );
  assert.equal(attempts, 1);
});

test("invalid host identity, deadline and cancellation fail before any rescue command", async () => {
  const value = await input();
  let commands = 0;
  const run = async () => {
    commands++;
    throw new Error("rescue must not be called");
  };
  await assert.rejects(
    inspectNode(
      {
        ...value,
        rescue: {
          ...value.rescue,
          ssh_host_fingerprint: (await createNodeRescueHostIdentity())
            .ssh_host_fingerprint,
        },
      },
      { run },
    ),
    /inspection_host_key_mismatch/,
  );
  await assert.rejects(
    inspectNode(
      { ...value, deadline_at: new Date(Date.now() + 601_000).toISOString() },
      { run },
    ),
    /inspection_deadline_invalid/,
  );
  await assert.rejects(
    inspectNode(value, { run, signal: AbortSignal.abort() }),
  );
  assert.equal(commands, 0);
});

test("follows the official Factory manifest redirect and authenticates an anonymous scoped GHCR pull without inspection credentials", async () => {
  const value = await input(),
    state = scenario(value),
    token = randomBytes(32).toString("base64url");
  let official = "",
    challenges = 0,
    tokens = 0;
  await inspectNode(value, {
    ...state,
    request: async (url, options) => {
      const target = new URL(String(url)),
        authorization = new Headers(options?.headers).get("authorization");
      if (
        target.hostname === "factory.talos.dev" &&
        target.pathname.includes("/v2/metal-installer/")
      ) {
        official = target.href;
        assert.equal(authorization, null);
        return new Response(null, {
          status: 307,
          headers: {
            location:
              "https://ghcr.io/v2/siderolabs/image-factory/installer/manifests/v1.14.1",
          },
        });
      }
      if (target.hostname === "ghcr.io" && target.pathname === "/token") {
        tokens++;
        assert.equal(authorization, null);
        assert.equal(
          target.searchParams.get("scope"),
          "repository:siderolabs/image-factory/installer:pull",
        );
        return Response.json({ token });
      }
      if (target.hostname === "ghcr.io") {
        assert.notEqual(authorization, `Bearer ${value.callback.bearer}`);
        if (!authorization) {
          challenges++;
          return new Response(null, {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:siderolabs/image-factory/installer:pull"',
            },
          });
        }
        assert.equal(authorization, `Bearer ${token}`);
        return state.request(official, options);
      }
      return state.request(url, options);
    },
  });
  assert.equal(challenges, 1);
  assert.equal(tokens, 1);
});

test("actual Python decoder verifies XZ integrity and byte hashes within measured bounds; generated scripts pass Bash parsing", async () => {
  const value = await input(),
    state = scenario(value);
  await inspectNode(value, state);
  const environment = { PATH: process.env.PATH, LANG: "C" };
  const commandOptions = {
    signal: AbortSignal.timeout(10_000),
    timeout_ms: 10_000,
    env: environment,
  };
  for (const command of state.commands.filter(
    (command) => command.executable === "ssh",
  )) {
    const parsed = await runCommand({
      ...commandOptions,
      executable: "bash",
      args: ["-n"],
      stdin: command.stdin,
    });
    assert.equal(parsed.exit_code, 0);
  }
  const script = state.commands
    .find((command) => command.stdin?.includes("__PGCF_INSPECTION_IMAGE__"))!
    .stdin!.match(
      /<<'PGCF_INSPECTION_IMAGE_PY'\n([\s\S]*?)\nPGCF_INSPECTION_IMAGE_PY/,
    )![1]!;
  const directory = await mkdtemp(join(tmpdir(), "pgcf-inspection-decoder-"));
  try {
    const compressed = join(directory, "image.raw.xz"),
      raw = join(directory, "image.raw"),
      bytes = randomBytes(5120);
    const encoded = await runCommand({
      ...commandOptions,
      executable: "python3",
      args: ["-", compressed, bytes.toString("hex")],
      stdin:
        "import lzma,sys\nwith open(sys.argv[1], 'xb') as target: target.write(lzma.compress(bytes.fromhex(sys.argv[2])))\n",
    });
    assert.equal(encoded.exit_code, 0);
    const decode = (source: string, target: string, disk = bytes.length) =>
      runCommand({
        ...commandOptions,
        executable: "python3",
        args: ["-", source, target, String(16 * 1024 ** 2), String(disk)],
        stdin: script,
      });
    const actual = await decode(compressed, raw);
    assert.equal(actual.exit_code, 0);
    assert.deepEqual(JSON.parse(actual.stdout), {
      compressed_sha256: digest(await readFile(compressed)),
      compressed_bytes: (await readFile(compressed)).length,
      raw_sha256: digest(bytes),
      raw_bytes: bytes.length,
    });
    assert.deepEqual(await readFile(raw), bytes);
    assert.notEqual(
      (
        await decode(
          compressed,
          join(directory, "oversized.raw"),
          bytes.length - 512,
        )
      ).exit_code,
      0,
    );
    const damaged = await readFile(compressed);
    damaged[Math.floor(damaged.length / 2)]! ^= 8;
    const bad = join(directory, "damaged.raw.xz");
    await writeFile(bad, damaged, { mode: 0o600 });
    assert.notEqual(
      (await decode(bad, join(directory, "damaged.raw"))).exit_code,
      0,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
