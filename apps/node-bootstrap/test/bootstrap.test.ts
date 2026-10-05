// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  NodeBootstrapCallback,
  NodeBootstrapAuthority,
  NodeBootstrapInput,
  NodeBootstrapSpec,
  NodeJoinBundle,
} from "@pgcf/contracts/node-bootstrap";
import {
  AuthorityClient,
  BootstrapJob,
  assertAuthority,
  canonical,
  inputHash,
  jsonRecords,
  networkKernelArg,
  partitions,
  shellQuote,
  validateInput,
  verifyRescue,
} from "../src/bootstrap.ts";

import { authority, fixture } from "./fixture.ts";

function rescueOutput(
  input: NodeBootstrapInput,
  override: Record<string, unknown> = {},
) {
  const nic = "eth0";
  const values = {
    disk: {
      blockdevices: [
        {
          path: input.spec.hardware.install_disk,
          type: "disk",
          size: input.spec.hardware.disk_bytes,
          mountpoints: [null],
          children: [],
        },
      ],
    },
    links: [
      { link_type: "ether", ifname: nic, address: input.spec.hardware.mac },
    ],
    addresses: [
      {
        ifname: nic,
        addr_info: [
          {
            family: "inet",
            local: input.spec.hardware.ipv4,
            prefixlen: input.spec.hardware.prefix_length,
          },
        ],
      },
    ],
    routes: [{ gateway: input.spec.hardware.gateway, dev: nic }],
    root: { filesystems: [{ fstype: "tmpfs" }] },
    swaps: { swapdevices: [] },
    ram: input.spec.hardware.rescue_ram_min_bytes,
    ...override,
  };
  return [
    values.disk,
    values.links,
    values.addresses,
    values.routes,
    values.root,
    values.swaps,
  ]
    .map((value) => JSON.stringify(value))
    .concat(String(values.ram))
    .join("\n__PGCF_RECORD__\n");
}

test("job identity binds hardware and rejects missing SSH host evidence", () => {
  const input = fixture();
  assert.equal(validateInput(input).input_hash, input.input_hash);
  assert.throws(
    () =>
      validateInput({
        ...input,
        spec: { ...input.spec, inventory_revision: 2 },
      }),
    /input_hash_mismatch/,
  );
  assert.throws(
    () =>
      validateInput({
        ...input,
        rescue: {
          ...input.rescue,
          ssh_host_fingerprint: `SHA256:${randomBytes(32).toString("base64").replaceAll("=", "")}`,
        },
      }),
    /rescue_host_key_mismatch/,
  );
  assert.throws(() =>
    NodeBootstrapInput.parse({
      ...input,
      rescue: { ssh_private_key: input.rescue.ssh_private_key },
    }),
  );
  assert.throws(
    () => validateInput({ ...input, rescue: fixture().rescue }),
    /rescue_host_key_mismatch/,
  );
  assert.equal(
    inputHash({ ...input.spec, hardware: { ...input.spec.hardware } }),
    input.input_hash,
  );
});

test("rescue permits only the exact single unmounted disk, network and RAM root", () => {
  const input = fixture();
  verifyRescue(input.spec, rescueOutput(input));
  assert.throws(
    () =>
      verifyRescue(
        input.spec,
        rescueOutput(input, {
          disk: {
            blockdevices: [
              {
                type: "disk",
                path: input.spec.hardware.install_disk,
                size: input.spec.hardware.disk_bytes + 512,
              },
            ],
          },
        }),
      ),
    /rescue_disk_mismatch/,
  );
  assert.throws(
    () =>
      verifyRescue(
        input.spec,
        rescueOutput(input, {
          disk: {
            blockdevices: [
              {
                type: "disk",
                path: input.spec.hardware.install_disk,
                size: input.spec.hardware.disk_bytes,
                children: [{ mountpoints: ["/target"] }],
              },
            ],
          },
        }),
      ),
    /rescue_disk_mounted/,
  );
  assert.throws(
    () =>
      verifyRescue(
        input.spec,
        rescueOutput(input, { root: { filesystems: [{ fstype: "ext4" }] } }),
      ),
    /rescue_root_not_ram/,
  );
  assert.throws(
    () =>
      verifyRescue(
        input.spec,
        rescueOutput(input, {
          swaps: {
            swapdevices: [{ filename: input.spec.hardware.install_disk }],
          },
        }),
      ),
    /rescue_swap_active/,
  );
  assert.throws(
    () =>
      verifyRescue(
        input.spec,
        rescueOutput(input, {
          routes: [{ gateway: [192, 0, 2, 99].join("."), dev: "eth0" }],
        }),
      ),
    /rescue_gateway_mismatch/,
  );
  assert.throws(
    () => verifyRescue(input.spec, rescueOutput(input, { ram: 0 })),
    /rescue_ram_insufficient/,
  );
});

test("authoritative admission and cancellation fence every destructive stage", () => {
  const input = fixture();
  const current = authority(input);
  assertAuthority(input, current);
  assert.throws(
    () => assertAuthority(input, { ...current, admitted: true }),
    /node_already_admitted/,
  );
  assert.throws(
    () => assertAuthority(input, { ...current, cancelled: true }),
    /job_cancelled/,
  );
  assert.throws(
    () => assertAuthority(input, { ...current, authorized: false }),
    /job_unauthorized/,
  );
  assert.throws(
    () =>
      assertAuthority(input, {
        ...current,
        provider_instance_id: String(Number(current.provider_instance_id) + 1),
      }),
    /authority_identity_mismatch/,
  );
  assert.throws(
    () =>
      assertAuthority(input, {
        ...current,
        checkpoint: { ...current.checkpoint, written_bytes: 512 },
      }),
    /checkpoint_invalid/,
  );
});

test("lost checkpoint response is reconciled by readback without a duplicate mutation", async () => {
  const input = fixture();
  let current = authority(input);
  let writes = 0;
  const desired = {
    ...current.checkpoint,
    stage: "disk_write_intent" as const,
    destructive_intent: true,
    write_intent_offset: 0,
  };
  const request: typeof fetch = async (_url, init) => {
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${input.callback.bearer}`,
    );
    const envelope = NodeBootstrapCallback.parse(
      JSON.parse(String(init?.body)),
    );
    if (envelope.kind === "checkpoint") {
      writes++;
      assert.equal(envelope.expected_revision, current.revision);
      current = {
        ...current,
        revision: current.revision + 1,
        checkpoint: envelope.payload,
      };
      throw new Error(randomBytes(32).toString("base64url"));
    }
    assert.equal(envelope.kind, "read");
    return Response.json(current);
  };
  const client = new AuthorityClient(input, request);
  const readback = await client.checkpoint(
    current,
    desired,
    AbortSignal.timeout(1000),
  );
  assert.equal(writes, 1);
  assert.equal(readback.revision, 1);
  assert.deepEqual(readback.checkpoint, desired);
});

test("a rejected checkpoint cannot manufacture acknowledged progress", async () => {
  const input = fixture();
  const current = authority(input);
  const request: typeof fetch = async (_url, init) => {
    const envelope = NodeBootstrapCallback.parse(
      JSON.parse(String(init?.body)),
    );
    return envelope.kind === "read"
      ? Response.json(current)
      : new Response(null, { status: 409 });
  };
  await assert.rejects(
    new AuthorityClient(input, request).checkpoint(
      current,
      { ...current.checkpoint, destructive_intent: true },
      AbortSignal.timeout(1000),
    ),
    /checkpoint_not_committed/,
  );
});

test("native record parsing preserves object boundaries and refuses garbage", () => {
  assert.deepEqual(
    jsonRecords(' {"spec":{"message":"} {"}}\n{"metadata":{"id":"STATE"}} '),
    [{ spec: { message: "} {" } }, { metadata: { id: "STATE" } }],
  );
  assert.throws(() => jsonRecords('{"spec":{}}\nnot-json'), /readback_invalid/);
  assert.throws(() => jsonRecords('{"spec":{'), /readback_invalid/);
  const layout = {
    partitiontable: {
      partitions: Array.from({ length: 4 }, (_, index) => ({
        start: index + 1,
        size: 1,
        type: randomUUID(),
        uuid: randomUUID(),
      })),
    },
  };
  assert.equal(partitions(JSON.stringify(layout)).length, 4);
  assert.throws(
    () => partitions(JSON.stringify({ partitiontable: { partitions: [] } })),
    /image_partition_count/,
  );
});

test("operator direct transport is explicit and worker join needs actual protected identity", () => {
  const input = fixture();
  const spec = {
    ...input.spec,
    transport: {
      mode: "operator_direct" as const,
      authorization_id: randomUUID(),
    },
  };
  assert.throws(
    () => new BootstrapJob({ ...input, spec, input_hash: inputHash(spec) }),
    /operator_transport_not_enabled/,
  );
  assert.throws(() => NodeBootstrapSpec.parse({ ...spec, role: "worker" }));
  assert.throws(() =>
    NodeJoinBundle.parse({
      version: 1,
      cluster_name: spec.cluster_name,
      cluster_endpoint: spec.cluster_endpoint,
      talos_version: "1.14.1",
      kubernetes_version: "1.36.3",
      talos_machine_secrets_yaml: randomUUID(),
      talos_admin_config: randomUUID(),
      kubeconfig: null,
      kube_system_uid: null,
    }),
  );
  assert.ok(networkKernelArg(spec).includes(spec.hardware.gateway));
  assert.equal(shellQuote("a'b"), `'a'"'"'b'`);
  assert.equal(canonical({ b: 2, a: 1 }), '{"a":1,"b":2}');
});

test("authenticated readback uses the pinned Talos JSON flag and real writable LVM fields", async () => {
  const input = fixture();
  const calls: string[][] = [];
  const job = new BootstrapJob(input, {
    run: async (command) => {
      calls.push(command.args);
      const args = command.args.join(" ");
      if (args.includes(" version "))
        return {
          exit_code: 0,
          stdout: JSON.stringify({ version: { tag: "v1.14.1" } }),
        };
      if (args.includes("get disks"))
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            metadata: { id: "vda" },
            spec: {
              dev_path: input.spec.hardware.install_disk,
              size: input.spec.hardware.disk_bytes,
            },
          }),
        };
      if (args.includes("get volumestatus"))
        return {
          exit_code: 0,
          stdout: [
            {
              metadata: { id: "EPHEMERAL" },
              spec: {
                phase: "ready",
                size: input.spec.storage.ephemeral_gib * 1024 ** 3,
              },
            },
            {
              metadata: { id: "r-pgcf-lvm" },
              spec: {
                phase: "ready",
                size: input.spec.storage.lvm_gib * 1024 ** 3,
              },
            },
            { metadata: { id: "STATE" }, spec: { phase: "ready" } },
          ]
            .map((value) => JSON.stringify(value))
            .join("\n"),
        };
      if (args.includes("get lvmvolumegroupstatus"))
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            metadata: { id: "pgcf" },
            spec: {
              name: "pgcf",
              permissions: "writeable",
              missingPVCount: "0",
              pvCount: "1",
              free: String(
                input.spec.storage.lvm_gib * 1024 ** 3 - 4 * 1024 ** 2,
              ),
            },
          }),
        };
      throw new Error("unexpected command");
    },
  });
  await Reflect.get(job, "authenticatedReadback").call(job);
  assert.ok(calls.find((args) => args.includes("version"))!.includes("--json"));
  assert.ok(
    !calls.find((args) => args.includes("version"))!.includes("--output"),
  );
});

test("clean reboot verification refuses the old boot ID and accepts an observed new boot", async () => {
  const input = fixture();
  const boot = randomUUID();
  let observed = boot;
  const job = new BootstrapJob(input, {
    run: async (command) => {
      assert.ok(command.args.includes("read"));
      assert.ok(command.args.includes("/proc/sys/kernel/random/boot_id"));
      return { exit_code: 0, stdout: `${observed}\n` };
    },
  });
  await assert.rejects(
    async () => Reflect.get(job, "confirmReboot").call(job, boot),
    /talos_reboot_unconfirmed/,
  );
  observed = randomUUID();
  await Reflect.get(job, "confirmReboot").call(job, boot);
});

test("an uncertain GPT relocation resumes with partition readback and never repeats the destructive command", async () => {
  const input = fixture();
  let current = authority(input);
  current.checkpoint = {
    ...current.checkpoint,
    stage: "gpt_relocation_intent",
    destructive_intent: true,
    written_bytes: input.spec.image.raw_bytes,
    downloaded_bytes: input.spec.image.compressed_bytes,
  };
  const layout = {
    partitiontable: {
      partitions: Array.from({ length: 4 }, (_, index) => ({
        start: 2048 + index * 2048,
        size: 1024,
        type: randomUUID(),
        uuid: randomUUID(),
      })),
    },
  };
  const scripts: string[] = [];
  const job = new BootstrapJob(input, {
    request: async (url, init) => {
      if (String(url).endsWith("/schematics"))
        return Response.json({ id: input.spec.image.schematic_id });
      const message = NodeBootstrapCallback.parse(
        JSON.parse(String(init?.body)),
      );
      if (message.kind === "checkpoint")
        current = {
          ...current,
          revision: current.revision + 1,
          checkpoint: message.payload,
        };
      return Response.json(current);
    },
    run: async (command) => {
      if (command.executable === "ssh-keygen")
        return { exit_code: 0, stdout: "" };
      if (command.executable === "talosctl")
        return { exit_code: 1, stdout: "" };
      const script = command.stdin ?? "";
      scripts.push(script);
      if (script.includes("lsblk --bytes --json"))
        return { exit_code: 0, stdout: rescueOutput(input) };
      if (script.includes("if test -f") && script.includes("stat --format=%s"))
        return {
          exit_code: 0,
          stdout: String(input.spec.image.compressed_bytes),
        };
      if (script.includes("sfdisk --json"))
        return { exit_code: 0, stdout: JSON.stringify(layout) };
      if (script.includes("sgdisk --verify"))
        return { exit_code: 0, stdout: "No problems found." };
      return { exit_code: 0, stdout: "" };
    },
  });
  await assert.rejects(job.start(), /native_command_failed/);
  assert.ok(
    !scripts.some(
      (script) =>
        script.includes("sgdisk --move-second-header") ||
        script.includes("sgdisk --zap-all") ||
        script.includes("dd if="),
    ),
  );
  assert.ok(
    scripts.filter((script) => script.includes("cmp --bytes=")).length === 4,
  );
  assert.equal(current.checkpoint.stage, "rescue_reboot_intent");
  assert.equal(current.checkpoint.status, "waiting");
});

test("restart after uncertain Kubernetes bootstrap recovers the sealed seed and reads back without another bootstrap", async () => {
  const input = fixture();
  let current = authority(input);
  const uid = randomUUID();
  const oldBoot = randomUUID();
  const newBoot = randomUUID();
  const admin = stringify({
    context: input.spec.cluster_name,
    contexts: {
      [input.spec.cluster_name]: {
        ca: randomBytes(32).toString("base64"),
        crt: randomBytes(32).toString("base64"),
        key: randomBytes(32).toString("base64"),
      },
    },
  });
  current.protected_material = {
    purpose: "region_seed",
    material: {
      version: 1,
      cluster_name: input.spec.cluster_name,
      cluster_endpoint: input.spec.cluster_endpoint,
      talos_version: "1.14.1",
      kubernetes_version: "1.36.3",
      talos_machine_secrets_yaml: randomUUID(),
      talos_admin_config: admin,
    },
  };
  current.checkpoint = {
    ...current.checkpoint,
    stage: "kubernetes_bootstrap_intent",
    destructive_intent: true,
    written_bytes: input.spec.image.raw_bytes,
    downloaded_bytes: input.spec.image.compressed_bytes,
    pre_reboot_boot_id: oldBoot,
    sealed_ref: randomUUID(),
  };
  const kubeconfig = stringify({
    apiVersion: "v1",
    kind: "Config",
    clusters: [
      {
        name: input.spec.cluster_name,
        cluster: {
          server: input.spec.cluster_endpoint,
          "certificate-authority-data": randomBytes(32).toString("base64"),
        },
      },
    ],
    users: [
      {
        name: "admin",
        user: {
          "client-certificate-data": randomBytes(32).toString("base64"),
          "client-key-data": randomBytes(32).toString("base64"),
        },
      },
    ],
    contexts: [
      {
        name: input.spec.cluster_name,
        context: { cluster: input.spec.cluster_name, user: "admin" },
      },
    ],
    "current-context": input.spec.cluster_name,
  });
  const calls: string[][] = [];
  const job = new BootstrapJob(input, {
    request: async (_url, init) => {
      const message = NodeBootstrapCallback.parse(
        JSON.parse(String(init?.body)),
      );
      if (message.kind === "checkpoint")
        current = {
          ...current,
          revision: current.revision + 1,
          checkpoint: message.payload,
        };
      if (message.kind === "seal")
        current = {
          ...current,
          revision: current.revision + 1,
          protected_material: message.payload,
        };
      return Response.json(current);
    },
    run: async (command) => {
      calls.push(command.args);
      const args = command.args;
      if (command.executable === "ssh-keygen")
        return { exit_code: 0, stdout: "" };
      if (args[0] === "gen" && args[1] === "config") {
        const directory = args[args.indexOf("--output") + 1]!;
        for (const name of ["controlplane.yaml", "worker.yaml", "talosconfig"])
          await writeFile(join(directory, name), admin, { mode: 0o600 });
        return { exit_code: 0, stdout: "" };
      }
      if (args[0] === "validate") return { exit_code: 0, stdout: "" };
      if (
        args.includes("bootstrap") ||
        (args[0] === "gen" && args[1] === "secrets")
      )
        throw new Error("uncertain mutation repeated");
      if (args.includes("read")) return { exit_code: 0, stdout: newBoot };
      if (args.includes("version"))
        return {
          exit_code: 0,
          stdout: JSON.stringify({ version: { tag: "v1.14.1" } }),
        };
      if (args.includes("disks"))
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            metadata: { id: "vda" },
            spec: {
              dev_path: input.spec.hardware.install_disk,
              size: input.spec.hardware.disk_bytes,
            },
          }),
        };
      if (args.includes("volumestatus"))
        return {
          exit_code: 0,
          stdout: [
            {
              metadata: { id: "EPHEMERAL" },
              spec: {
                phase: "ready",
                size: input.spec.storage.ephemeral_gib * 1024 ** 3,
              },
            },
            {
              metadata: { id: "r-pgcf-lvm" },
              spec: {
                phase: "ready",
                size: input.spec.storage.lvm_gib * 1024 ** 3,
              },
            },
            { metadata: { id: "STATE" }, spec: { phase: "ready" } },
          ]
            .map((value) => JSON.stringify(value))
            .join("\n"),
        };
      if (args.includes("lvmvolumegroupstatus"))
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            metadata: { id: "pgcf" },
            spec: {
              name: "pgcf",
              permissions: "writeable",
              pvCount: "1",
              missingPVCount: "0",
              free: "1",
            },
          }),
        };
      if (args.includes("kubeconfig")) {
        await writeFile(args[args.indexOf("kubeconfig") + 1]!, kubeconfig, {
          mode: 0o600,
        });
        return { exit_code: 0, stdout: "" };
      }
      if (command.executable === "kubectl" && args.includes("namespace"))
        return { exit_code: 0, stdout: JSON.stringify({ metadata: { uid } }) };
      if (command.executable === "kubectl" && args.includes("node"))
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            metadata: {
              labels: {
                "pgcf.io/node-id": input.spec.node_id,
                "pgcf.io/region": input.spec.region_id,
                "pgcf.io/provider-instance-id": input.spec.provider_instance_id,
              },
            },
            spec: {
              taints: [
                {
                  key: "pgcf.io/quarantine",
                  value: "bootstrap",
                  effect: "NoSchedule",
                },
              ],
            },
            status: {
              nodeInfo: { kubeletVersion: "v1.36.3" },
              addresses: [
                { type: "InternalIP", address: input.spec.hardware.ipv4 },
              ],
            },
          }),
        };
      throw new Error("unexpected command");
    },
  });
  await job.start();
  assert.ok(
    !calls.some(
      (args) =>
        args.includes("bootstrap") ||
        (args[0] === "gen" && args[1] === "secrets"),
    ),
  );
  assert.equal(current.checkpoint.status, "awaiting_verification");
  assert.equal(current.admitted, false);
  const observed = NodeBootstrapAuthority.parse(current);
  assert.equal(observed.protected_material?.purpose, "join_bundle");
  assert.ok(
    observed.protected_material?.purpose === "join_bundle" &&
      observed.protected_material.material.kube_system_uid === uid,
  );
});
