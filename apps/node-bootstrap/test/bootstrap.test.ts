// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { parse, parseAllDocuments } from "yaml";
import { zstdDecompressSync } from "node:zlib";
import {
  NodeBootstrapCallback,
  NodeBootstrapAuthority,
  NodeBootstrapInput,
  NodeBootstrapCheckpoint,
  NodeBootstrapSpec,
  NodeJoinBundle,
} from "@pgcf/contracts/node-bootstrap";
import {
  AuthorityClient,
  BootstrapJob,
  BootstrapError,
  assertAuthority,
  canonical,
  inputHash,
  jsonRecords,
  networkKernelArg,
  partitions,
  runCommand,
  shellQuote,
  validateInput,
  verifyRescue,
} from "../src/bootstrap.ts";

import { authority, fixture, platformFixture } from "./fixture.ts";
import { storageCapacityFixture } from "./storage-capacity.fixture.ts";

test("Talos maintenance flags follow command arguments and authenticated calls preserve talosconfig", async () => {
  const input = fixture();
  const directory = join(tmpdir(), `pgcf-talos-flags-${randomUUID()}`);
  const calls: string[][] = [];
  const job = new BootstrapJob(input, {
    run: async (command) => {
      assert.equal(command.executable, "talosctl");
      calls.push(command.args);
      return { exit_code: 0, stdout: "" };
    },
  });
  Reflect.set(job, "directory", directory);
  const talos = Reflect.get(job, "talos").bind(job);
  const config = join(directory, "controlplane.yaml");
  await talos(["get", "disks", "--output", "json"], true);
  await talos(["version", "--json"], true);
  await talos(["apply-config", "--file", config], true, true);
  await talos(["version", "--json"]);
  const target = [
    "--nodes",
    input.spec.hardware.ipv4,
    "--endpoints",
    input.spec.hardware.ipv4,
  ];
  assert.deepEqual(calls, [
    [...target, "get", "disks", "--output", "json", "--insecure"],
    [...target, "version", "--json", "--insecure"],
    [...target, "apply-config", "--file", config, "--insecure"],
    [
      ...target,
      "--talosconfig",
      join(directory, "talosconfig"),
      "version",
      "--json",
    ],
  ]);
});

test("native failures expose only a known executable and bounded exit code", async () => {
  const input = fixture();
  const sensitive = input.rescue.ssh_private_key;
  let exit_code = 255;
  const job = new BootstrapJob(input, {
    run: async () => ({ exit_code, stdout: sensitive }),
  });
  Reflect.set(job, "env", { PRIVATE_KEY: sensitive });
  const execute = (executable: string, permit_failure = false) =>
    Reflect.get(job, "execute").call(
      job,
      executable,
      [sensitive],
      sensitive,
      permit_failure,
    );
  await assert.rejects(execute("ssh"), (error: unknown) => {
    assert.ok(error instanceof BootstrapError);
    assert.equal(error.code, "native_command_failed_ssh_255");
    assert.equal(error.message, error.code);
    assert.ok(!JSON.stringify(error).includes(sensitive));
    assert.equal(
      NodeBootstrapCheckpoint.parse({
        ...authority(input).checkpoint,
        error_code: error.code,
      }).error_code,
      error.code,
    );
    return true;
  });
  exit_code = 1;
  await assert.rejects(execute("ssh"), {
    code: "native_command_failed_ssh_1",
  });
  await assert.rejects(execute("ssh-keygen"), {
    code: "native_command_failed_ssh_keygen_1",
  });
  await assert.rejects(execute(sensitive), {
    code: "native_command_failed",
  });
  exit_code = 256;
  await assert.rejects(execute("ssh"), { code: "native_command_failed" });
  assert.deepEqual(await execute("ssh", true), {
    exit_code,
    stdout: sensitive,
  });
});

async function installationMustRemainReadOnly(
  stage: "quarantine_release_intent" | "quarantine_released",
) {
  const input = fixture();
  const current = authority(input);
  current.checkpoint = { ...current.checkpoint, stage, status: "running" };
  let commands = 0;
  let writes = 0;
  const job = new BootstrapJob(input, {
    request: async (_url, init) => {
      const message = NodeBootstrapCallback.parse(
        JSON.parse(String(init?.body)),
      );
      if (message.kind !== "read") writes++;
      return Response.json(current);
    },
    run: async () => {
      commands++;
      throw new Error("installation resumed after admission");
    },
  });
  await job.start();
  assert.equal(commands, 0);
  assert.equal(writes, 0);
}

test("installation remains read-only when a restarted Container has a persisted quarantine release intent", async () => {
  await installationMustRemainReadOnly("quarantine_release_intent");
});

test("installation remains read-only after quarantine release even if its status was later changed", async () => {
  await installationMustRemainReadOnly("quarantine_released");
});

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
    swaps: "",
    ram: input.spec.hardware.rescue_ram_min_bytes,
    ...override,
  };
  return [
    values.disk,
    values.links,
    values.addresses,
    values.routes,
    values.root,
  ]
    .map((value) => JSON.stringify(value))
    .concat(String(values.swaps), String(values.ram))
    .join("\n__PGCF_RECORD__\n");
}
function ramMount(path: string, fstype = "tmpfs") {
  return JSON.stringify({
    filesystems: [{ target: path, source: fstype, fstype, options: "rw" }],
  });
}
function overlayOutput(
  input: NodeBootstrapInput,
  upper = "/run/overlay/upper",
  work = "/run/overlay/work",
) {
  return rescueOutput(input, {
    root: {
      filesystems: [
        {
          target: "/",
          source: "overlay",
          fstype: "overlay",
          options: `rw,lowerdir=/run/lower,upperdir=${upper},workdir=${work}`,
        },
      ],
    },
  });
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

test("peer routes retain legacy input identity and refuse the node's own address", () => {
  const input = fixture();
  assert.deepEqual(NodeBootstrapSpec.parse(input.spec), input.spec);
  assert.throws(() =>
    NodeBootstrapSpec.parse({
      ...input.spec,
      peer_ipv4: [input.spec.hardware.ipv4],
    }),
  );
});

test("schematic verification puts only approved same-prefix peer routes in nonsecret early config", async () => {
  const input = fixture();
  const peer = [192, 0, 3, 42].join(".");
  const outside = [192, 0, 4, 42].join(".");
  const spec = {
    ...input.spec,
    peer_ipv4: [outside, peer],
    hardware: { ...input.spec.hardware, prefix_length: 23 },
  };
  Object.assign(input, { spec, input_hash: inputHash(spec) });
  let sent: { customization: { extraKernelArgs: string[] } } | undefined;
  const job = new BootstrapJob(input, {
    request: async (url, init) => {
      assert.equal(String(url), "https://factory.talos.dev/schematics");
      sent = JSON.parse(String(init?.body));
      return Response.json({ id: input.spec.image.schematic_id });
    },
  });
  await Reflect.get(job, "verifySchematic").call(job);
  assert.equal(sent!.customization.extraKernelArgs[0], networkKernelArg(spec));
  const early = sent!.customization.extraKernelArgs.find((argument) =>
    argument.startsWith("talos.config.early="),
  );
  assert.ok(early, "same-prefix peers need a first-boot return route");
  const document = parse(
    zstdDecompressSync(
      Buffer.from(early.slice("talos.config.early=".length), "base64"),
    ).toString("utf8"),
  );
  assert.deepEqual(document, {
    apiVersion: "v1alpha1",
    kind: "LinkConfig",
    name: "eth0",
    routes: [{ destination: `${peer}/32`, gateway: spec.hardware.gateway }],
  });
  assert.ok(!JSON.stringify(sent).includes(input.rescue.ssh_private_key));
});

test("legacy schematic verification preserves the exact ip-only request", async () => {
  const input = fixture();
  let sent: unknown;
  const job = new BootstrapJob(input, {
    request: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ id: input.spec.image.schematic_id });
    },
  });
  await Reflect.get(job, "verifySchematic").call(job);
  assert.deepEqual(sent, {
    customization: { extraKernelArgs: [networkKernelArg(input.spec)] },
  });
});

test("machine configuration adds measured IPv6 on the same MAC and only a known default gateway", async () => {
  for (const gateway of ["fe80::1", undefined]) {
    const input = fixture();
    input.spec.hardware.ipv6 = {
      address: "2001:db8:7::17",
      prefix_length: 64,
      ...(gateway ? { gateway } : {}),
    };
    input.input_hash = inputHash(input.spec);
    const directory = await mkdtemp(join(tmpdir(), "pgcf-ipv6-config-test-"));
    let network: Record<string, unknown>[] | undefined;
    const job = new BootstrapJob(input, {
      run: async (command) => {
        assert.equal(command.executable, "talosctl");
        if (command.args.includes("secrets")) {
          await writeFile(
            join(directory, "machine-secrets"),
            "test-only-runtime-seed\n",
          );
          return { exit_code: 0, stdout: "" };
        }
        network = parseAllDocuments(
          await readFile(join(directory, "network"), "utf8"),
        ).map((doc) => doc.toJSON());
        throw new BootstrapError("capture_network_config");
      },
    });
    Reflect.set(job, "directory", directory);
    try {
      await assert.rejects(
        Reflect.get(job, "prepareConfig").call(job, authority(input)),
        /capture_network_config/,
      );
      const machine = network![0]!.machine as Record<string, unknown>;
      const interfaces = (machine.network as Record<string, unknown>)
        .interfaces as Record<string, unknown>[];
      assert.deepEqual(interfaces[0]!.deviceSelector, {
        hardwareAddr: input.spec.hardware.mac,
      });
      assert.deepEqual(interfaces[0]!.addresses, [
        `${input.spec.hardware.ipv4}/${input.spec.hardware.prefix_length}`,
        "2001:db8:7::17/64",
      ]);
      const routes = interfaces[0]!.routes as Record<string, unknown>[];
      assert.deepEqual(
        routes.filter((route) => route.network === "::/0"),
        gateway ? [{ network: "::/0", gateway }] : [],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("rescue inspection uses portable plaintext swap output and stops on a failed query", async () => {
  const input = fixture();
  let calls = 0;
  const job = new BootstrapJob(input, {
    run: async (command) => {
      calls++;
      if (calls === 1) {
        assert.ok(
          command.stdin?.includes(
            "swapon --show --noheadings --raw --output NAME",
          ),
        );
        assert.ok(!command.stdin?.includes("swapon --show --json"));
        return { exit_code: 0, stdout: rescueOutput(input) };
      }
      return { exit_code: 0, stdout: ramMount("/run") };
    },
  });
  await Reflect.get(job, "inspectRescue").call(job);
  const unknown = new BootstrapJob(input, {
    run: async () => ({ exit_code: 1, stdout: rescueOutput(input) }),
  });
  await assert.rejects(
    Reflect.get(unknown, "inspectRescue").call(unknown),
    /native_command_failed/,
  );
  verifyRescue(input.spec, rescueOutput(input, { swaps: " \n\t " }));
  assert.throws(
    () =>
      verifyRescue(
        input.spec,
        rescueOutput(input, { swaps: "query result unknown" }),
      ),
    /rescue_swap_active/,
  );
});

test("overlay rescue requires actual RAM readbacks for both writable paths and scratch", async () => {
  const input = fixture();
  const base = overlayOutput(input);
  const proof = [
    base,
    ramMount("/run"),
    ramMount("/run/overlay"),
    ramMount("/run/overlay"),
  ].join("\n__PGCF_RECORD__\n");
  assert.throws(
    () => verifyRescue(input.spec, base),
    /rescue_overlay_unproven/,
  );
  verifyRescue(input.spec, proof);
  assert.throws(
    () =>
      verifyRescue(
        input.spec,
        [
          base,
          ramMount("/run"),
          ramMount("/run/overlay", "ext4"),
          ramMount("/run/overlay"),
        ].join("\n__PGCF_RECORD__\n"),
      ),
    /rescue_overlay_unproven/,
  );
  assert.throws(
    () =>
      verifyRescue(
        input.spec,
        [
          base,
          ramMount("/run"),
          ramMount("/run/other"),
          ramMount("/run/overlay"),
        ].join("\n__PGCF_RECORD__\n"),
      ),
    /rescue_overlay_unproven/,
  );
  assert.throws(
    () =>
      verifyRescue(
        input.spec,
        [
          base,
          ramMount("/run", "ext4"),
          ramMount("/run/overlay"),
          ramMount("/run/overlay"),
        ].join("\n__PGCF_RECORD__\n"),
      ),
    /rescue_scratch_not_ram/,
  );
  assert.throws(
    () =>
      verifyRescue(
        input.spec,
        [
          overlayOutput(
            input,
            "/run/overlay/upper",
            "/run/overlay/work,upperdir=/run/another",
          ),
          ramMount("/run"),
          ramMount("/run/overlay"),
          ramMount("/run/overlay"),
        ].join("\n__PGCF_RECORD__\n"),
      ),
    /rescue_overlay_unproven/,
  );
});

test("native overlay inspection queries the exact observed writable paths and retains seven hardware records", async () => {
  const input = fixture();
  let calls = 0;
  const job = new BootstrapJob(input, {
    run: async (command) => {
      calls++;
      if (calls === 1) return { exit_code: 0, stdout: overlayOutput(input) };
      assert.ok(command.stdin?.includes("--target '/run/overlay/upper'"));
      assert.ok(command.stdin?.includes("--target '/run/overlay/work'"));
      return {
        exit_code: 0,
        stdout: [
          ramMount("/run"),
          ramMount("/run/overlay"),
          ramMount("/run/overlay"),
        ].join("\n__PGCF_RECORD__\n"),
      };
    },
  });
  await Reflect.get(job, "inspectRescue").call(job);
  assert.equal(calls, 2);
});

test("image verification prepares bounded RAM scratch before staging files larger than the rescue parent", async () => {
  const input = fixture();
  const spec = {
    ...input.spec,
    hardware: { ...input.spec.hardware, rescue_ram_min_bytes: 8326418432 },
    image: {
      ...input.spec.image,
      compressed_bytes: 232142156,
      raw_bytes: 4453302272,
    },
  };
  Object.assign(input, { spec, input_hash: inputHash(spec) });
  const observedParentBytes = 832643072;
  assert.ok(
    spec.image.compressed_bytes + spec.image.raw_bytes > observedParentBytes,
  );
  let prepared = false;
  const job = new BootstrapJob(input, {
    request: async () => Response.json(authority(input)),
    run: async (command) => {
      const script = command.stdin ?? "";
      if (script.includes("mount -t tmpfs")) {
        assert.ok(script.includes(input.input_hash));
        assert.ok(script.includes("scratch_limit_bytes=5222315340"));
        prepared = true;
        return { exit_code: 0, stdout: "pgcf_scratch_ready\n" };
      }
      if (script.includes("command -v curl"))
        assert.ok(
          prepared,
          "832 MB /run cannot stage the 4.685 GB image files",
        );
      if (script.includes("stat --format=%s"))
        return { exit_code: 0, stdout: "0" };
      if (script.includes("curl --silent")) {
        assert.ok(prepared);
        throw new BootstrapError("probe_stopped_before_download");
      }
      return { exit_code: 0, stdout: "" };
    },
  });
  await assert.rejects(
    Reflect.get(job, "verifyImage").call(job),
    /probe_stopped_before_download/,
  );
  assert.ok(prepared);
});

test("disk guards refuse an unknown swap query instead of accepting empty failed output", async () => {
  const input = fixture();
  const job = new BootstrapJob(input);
  const script = Reflect.get(job, "guardScript").call(job);
  const result = await runCommand({
    executable: "bash",
    args: ["-se"],
    signal: AbortSignal.timeout(5000),
    timeout_ms: 5000,
    env: { PATH: process.env.PATH, LANG: "C" },
    stdin: `set -euo pipefail\nblockdev() { printf '%s\\n' ${input.spec.hardware.disk_bytes}; }\nlsblk() { case "$*" in *TYPE*) printf 'disk\\n';; *) :;; esac; }\nfindmnt() { printf 'tmpfs\\n'; }\nswapon() { return 1; }\n${script}\nprintf 'unsafe_write_guard_passed'\n`,
  });
  assert.notEqual(result.exit_code, 0);
  assert.equal(result.stdout, "");
});

test("image tool checks stop at an unavailable required tool rather than masking it", async () => {
  const job = new BootstrapJob(fixture());
  const script = Reflect.get(job, "imageToolsScript").call(job);
  const result = await runCommand({
    executable: "bash",
    args: ["-se"],
    signal: AbortSignal.timeout(5000),
    timeout_ms: 5000,
    env: { PATH: process.env.PATH, LANG: "C" },
    stdin: `set -euo pipefail\ncommand() { local status=0; shift; for tool; do if test "$tool" = sfdisk; then status=1; else status=0; fi; done; return "$status"; }\n${script}\nprintf 'unsafe_prerequisite_passed'\n`,
  });
  assert.notEqual(result.exit_code, 0);
  assert.equal(result.stdout, "");
});

test("missing xz uses actual Python stdlib streaming with exact raw bytes and bounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-python-lzma-"));
  try {
    const raw = Buffer.alloc(2 * 1024 ** 2 + 512, 0x6f);
    const compressed = execFileSync(
      "python3",
      [
        "-I",
        "-c",
        "import lzma,sys;sys.stdout.buffer.write(lzma.compress(sys.stdin.buffer.read()))",
      ],
      { input: raw, maxBuffer: 4 * 1024 ** 2 },
    );
    const input = fixture();
    const spec = {
      ...input.spec,
      image: {
        ...input.spec.image,
        compressed_bytes: compressed.length,
        raw_bytes: raw.length,
        compressed_sha256: createHash("sha256")
          .update(compressed)
          .digest("hex"),
        raw_sha256: createHash("sha256").update(raw).digest("hex"),
      },
    };
    Object.assign(input, { spec, input_hash: inputHash(spec) });
    await writeFile(join(directory, "image.raw.xz"), compressed, {
      mode: 0o600,
    });
    const job = new BootstrapJob(input);
    Reflect.set(job, "remotePath", (name: string) => join(directory, name));
    const script = Reflect.get(job, "imageDecompressScript").call(job);
    const run = (body: string) =>
      runCommand({
        executable: "bash",
        args: ["-se"],
        signal: AbortSignal.timeout(15000),
        timeout_ms: 15000,
        env: { PATH: process.env.PATH, LANG: "C" },
        stdin: `set -euo pipefail\numask 077\ncommand() { if test "$1" = -v && test "$2" = xz; then return 1; fi; builtin command "$@"; }\nxz() { return 127; }\n${body}\n`,
      });
    assert.equal((await run(script)).exit_code, 0);
    assert.deepEqual(await readFile(join(directory, "image.raw.partial")), raw);
    await rm(join(directory, "image.raw.partial"));
    const tooShort = {
      ...spec,
      image: { ...spec.image, raw_bytes: raw.length - 512 },
    };
    Object.assign(input, { spec: tooShort, input_hash: inputHash(tooShort) });
    const bounded = new BootstrapJob(input);
    Reflect.set(bounded, "remotePath", (name: string) => join(directory, name));
    assert.notEqual(
      (await run(Reflect.get(bounded, "imageDecompressScript").call(bounded)))
        .exit_code,
      0,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
          swaps: `${input.spec.hardware.install_disk}\n`,
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
      kubernetes_version: "1.36.5",
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

test("initial reboot returns without waiting for MachineReady and still verifies a changed boot before bootstrap", async () => {
  const input = platformFixture();
  let current = authority(input),
    boot = randomUUID();
  current.checkpoint = {
    ...current.checkpoint,
    stage: "config_applied",
    destructive_intent: true,
    written_bytes: input.spec.image.raw_bytes,
    downloaded_bytes: input.spec.image.compressed_bytes,
    sealed_ref: "region_seed:1",
  };
  let rebootRequests = 0,
    bootReads = 0,
    authenticatedReads = 0;
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
      return Response.json(current);
    },
    run: async (command) => {
      if (command.args.includes("read")) {
        bootReads++;
        return { exit_code: 0, stdout: boot };
      }
      if (command.args.includes("reboot")) {
        assert.ok(command.args.includes("--wait=false"));
        assert.equal(current.checkpoint.stage, "talos_reboot_intent");
        rebootRequests++;
        boot = randomUUID();
        return { exit_code: 0, stdout: "" };
      }
      if (command.args.includes("bootstrap")) {
        assert.equal(current.checkpoint.stage, "kubernetes_bootstrap_intent");
        assert.equal(bootReads, 2);
        assert.equal(authenticatedReads, 1);
        throw new BootstrapError("test_after_authenticated_reboot");
      }
      throw new Error("unexpected_test_command");
    },
  });
  Reflect.set(job, "setup", async () => {});
  Reflect.set(job, "prepareConfig", async () => {});
  Reflect.set(job, "authenticatedReadback", async () => {
    authenticatedReads++;
  });
  await assert.rejects(job.start(), /test_after_authenticated_reboot/);
  assert.equal(rebootRequests, 1);
});

function resumedDiskWrite(prefixExitCode = 0) {
  const chunkBytes = 16 * 1024 ** 2;
  const writtenBytes = 32 * chunkBytes;
  const original = fixture();
  const spec = {
    ...original.spec,
    image: { ...original.spec.image, raw_bytes: writtenBytes + chunkBytes },
  };
  const input = { ...original, spec, input_hash: inputHash(spec) };
  let current = authority(input);
  current.checkpoint = {
    ...current.checkpoint,
    stage: "disk_write_intent",
    destructive_intent: true,
    written_bytes: writtenBytes,
    downloaded_bytes: spec.image.compressed_bytes,
  };
  const scripts: string[] = [];
  const checkpoints: NodeBootstrapCheckpoint[] = [];
  const job = new BootstrapJob(input, {
    request: async (_url, init) => {
      const message = NodeBootstrapCallback.parse(
        JSON.parse(String(init?.body)),
      );
      if (message.kind === "checkpoint") {
        checkpoints.push(message.payload);
        current = {
          ...current,
          revision: current.revision + 1,
          checkpoint: message.payload,
        };
      }
      return Response.json(current);
    },
    run: async (command) => {
      scripts.push(command.stdin ?? "");
      return {
        exit_code:
          scripts.length === 1 ? prefixExitCode : scripts.length === 2 ? 1 : 0,
        stdout: "",
      };
    },
  });
  const raw = shellQuote(`/run/pgcf-bootstrap/${spec.operation_id}/image.raw`);
  const disk = shellQuote(spec.hardware.install_disk);
  return { job, scripts, checkpoints, chunkBytes, writtenBytes, raw, disk };
}

test("disk resume verifies the entire acknowledged prefix in one read before writing the next chunk", async () => {
  const { job, scripts, checkpoints, chunkBytes, writtenBytes, raw, disk } =
    resumedDiskWrite();
  await Reflect.get(job, "writeDisk").call(job);
  assert.equal(scripts.length, 3);
  assert.equal(
    scripts[0],
    `set -euo pipefail\ncmp --bytes=${writtenBytes} ${raw} ${disk}\n`,
  );
  assert.equal(
    scripts[1],
    `set -euo pipefail\ncmp --bytes=${chunkBytes} --ignore-initial=${writtenBytes}:${writtenBytes} ${raw} ${disk}\n`,
  );
  assert.ok(
    scripts[2]!.includes(
      `dd if=${raw} of=${disk} bs=512 skip=${writtenBytes / 512} seek=${writtenBytes / 512} count=${chunkBytes / 512} conv=notrunc,fsync status=none\ncmp --bytes=${chunkBytes} --ignore-initial=${writtenBytes}:${writtenBytes} ${raw} ${disk}`,
    ),
  );
  assert.equal(checkpoints[0]?.written_bytes, writtenBytes);
  assert.equal(checkpoints[0]?.write_intent_offset, writtenBytes);
  assert.equal(checkpoints[1]?.written_bytes, writtenBytes + chunkBytes);
  assert.equal(checkpoints[1]?.write_intent_offset, null);
  assert.equal(checkpoints[2]?.stage, "disk_written");
});

test("an acknowledged prefix mismatch blocks disk writes and checkpoint progress", async () => {
  const { job, scripts, checkpoints, writtenBytes, raw, disk } =
    resumedDiskWrite(1);
  await assert.rejects(async () => Reflect.get(job, "writeDisk").call(job), {
    code: "native_command_failed_ssh_1",
  });
  assert.deepEqual(scripts, [
    `set -euo pipefail\ncmp --bytes=${writtenBytes} ${raw} ${disk}\n`,
  ]);
  assert.deepEqual(checkpoints, []);
});

test("an uncertain GPT relocation resumes with partition readback and never repeats the destructive command", async () => {
  const input = platformFixture();
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
      if (script.includes("findmnt --json --target"))
        return { exit_code: 0, stdout: ramMount("/run") };
      if (script.includes("mount -t tmpfs"))
        return { exit_code: 0, stdout: "pgcf_scratch_ready\n" };
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

async function resumeKubernetesBootstrap(
  retainedJoinBundle = false,
  changedClusterUid = false,
) {
  const input = platformFixture();
  let current = authority(input);
  const uid = randomUUID();
  const storage = storageCapacityFixture({ input, clusterUid: uid });
  Object.assign(storage.node.status, {
    nodeInfo: { kubeletVersion: "v1.36.5" },
  });
  const immutableInput = canonical(input);
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
      kubernetes_version: "1.36.5",
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
  if (retainedJoinBundle) {
    const seed = current.protected_material!.material;
    current.protected_material = {
      purpose: "join_bundle",
      material: { ...seed, kube_system_uid: uid, kubeconfig },
    };
    current.checkpoint.sealed_ref = "join_bundle:1";
  }
  const initialMaterial = canonical(current.protected_material);
  const calls: string[][] = [];
  const job = new BootstrapJob(input, {
    request: async (_url, init) => {
      const message = NodeBootstrapCallback.parse(
        JSON.parse(String(init?.body)),
      );
      if (message.kind === "checkpoint") {
        current = {
          ...current,
          revision: current.revision + 1,
          checkpoint: message.payload,
        };
        if (message.payload.storage_trial)
          await storage.commands.saveTrial(message.payload.storage_trial);
      }
      if (message.kind === "seal" && retainedJoinBundle)
        return Response.json(
          { error: "immutable_join_custody" },
          { status: 409 },
        );
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
      if (
        command.executable === "talosctl" &&
        args.includes("get") &&
        args.includes("--namespace")
      ) {
        await storage.commands.authorize();
        return storage.commands.talos(args.slice(args.indexOf("get")));
      }
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
        const renewed = parse(kubeconfig);
        if (retainedJoinBundle)
          renewed.users[0].user["client-certificate-data"] =
            randomBytes(32).toString("base64");
        await writeFile(
          args[args.indexOf("kubeconfig") + 1]!,
          retainedJoinBundle ? stringify(renewed) : kubeconfig,
          {
            mode: 0o600,
          },
        );
        return { exit_code: 0, stdout: "" };
      }
      if (command.executable === "kubectl" && !args.includes("deployment")) {
        if (
          changedClusterUid &&
          args.includes("namespace") &&
          args.includes("kube-system")
        )
          return {
            exit_code: 0,
            stdout: JSON.stringify({ metadata: { uid: randomUUID() } }),
          };

        const action = args.findIndex((arg) =>
          ["get", "create", "patch", "delete", "logs"].includes(arg),
        );
        assert.ok(action >= 0);
        await storage.commands.authorize();
        return storage.commands.kube(args.slice(action), true, command.stdin);
      }
      if (command.executable === "kubectl" && args.includes("deployment"))
        return {
          exit_code: 0,
          stdout: JSON.stringify({
            apiVersion: "apps/v1",
            kind: "Deployment",
            metadata: {
              name: "coredns",
              namespace: "kube-system",
              uid: randomUUID(),
              resourceVersion: "41",
            },
            spec: {
              template: {
                spec: {
                  tolerations: [
                    {
                      key: "pgcf.io/quarantine",
                      operator: "Equal",
                      value: "bootstrap",
                      effect: "NoSchedule",
                    },
                  ],
                },
              },
            },
          }),
        };
      throw new Error("unexpected command");
    },
  });
  let installation_calls = 0;
  let retainedBundle: string | undefined;
  Reflect.set(job, "installPlatform", async () => {
    installation_calls++;
    assert.equal(current.checkpoint.stage, "kubernetes_joined");
    assert.equal(current.protected_material?.purpose, "join_bundle");
    assert.ok(
      current.protected_material?.purpose === "join_bundle" &&
        current.protected_material.material.kube_system_uid === uid,
    );
    retainedBundle = canonical(current.protected_material);
  });
  let trust_calls = 0;
  Reflect.set(job, "publishKubeletTrust", async () => {
    trust_calls++;
    assert.equal(installation_calls, 1);
    assert.equal(current.checkpoint.stage, "kubernetes_joined");
    assert.ok(
      current.protected_material?.purpose === "join_bundle" &&
        current.protected_material.material.kube_system_uid === uid,
    );
  });
  await job.start();
  assert.equal(installation_calls, 1);
  assert.equal(trust_calls, 1);
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
  assert.equal(canonical(current.protected_material), retainedBundle);
  if (retainedJoinBundle) {
    assert.equal(canonical(current.protected_material), initialMaterial);
    assert.ok(!calls.some((args) => args.includes("kubeconfig")));
  }
  assert.equal(canonical(input), immutableInput);
  const storageTrial = observed.checkpoint.storage_trial!;
  assert.equal(storageTrial.input_hash, input.input_hash);
  assert.equal(storageTrial.cluster_uid, uid);
  assert.equal(storageTrial.runs.at(-1)!.stage, "published");
  assert.equal(
    storageTrial.runs.at(-1)!.before.free -
      storageTrial.runs.at(-1)!.allocated!.free,
    1024 ** 3,
  );
  assert.equal(
    storageTrial.runs.at(-1)!.after!.free,
    storageTrial.runs.at(-1)!.before.free,
  );
  assert.equal(storage.logical_volumes.length, 0);
  assert.equal(storage.objects.size, 0);
}

test("restart after uncertain Kubernetes bootstrap recovers the sealed seed and reads back without another bootstrap", async () => {
  await resumeKubernetesBootstrap();
});
test("restart reuses an already sealed join bundle without generating replacement credentials", async () => {
  await resumeKubernetesBootstrap(true);
});
test("restart blocks a changed cluster UID before reusing sealed join custody", async () => {
  await assert.rejects(
    resumeKubernetesBootstrap(true, true),
    /cluster_uid_mismatch/,
  );
});
