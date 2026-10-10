// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  realpath,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCommand,
  BootstrapJob,
  inputHash,
  TALOS_VERSION,
} from "../src/bootstrap.ts";
import { fixture, authority } from "./fixture.ts";
import { GOLDEN_GRUB_NETWORK_PYTHON } from "../src/golden-boot-network.ts";
// The default and reset syntax is from the actual qualified NoCloud 1.14.2 raw BOOT readback.
const base = `set default="A - Talos v1.14.2"
set timeout=3
menuentry "A - Talos v1.14.2" {
  linux /A/vmlinuz talos.platform=nocloud console=ttyS0 net.ifnames=0 module.sig_enforce=1
  initrd /A/initramfs.xz
}
menuentry "Reset Talos installation and return to maintenance mode" {
  linux /A/vmlinuz talos.platform=nocloud net.ifnames=0 talos.experimental.wipe=system:EPHEMERAL,STATE
  initrd /A/initramfs.xz
}
`;
async function scenario() {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "pgcf-golden-network-")),
    ),
    reference = join(root, "reference"),
    live = join(root, "live");
  for (const directory of [reference, live]) {
    await mkdir(join(directory, "grub"), { recursive: true });
    await mkdir(join(directory, "A"));
    await writeFile(join(directory, "grub/grub.cfg"), base);
    await writeFile(join(directory, "A/vmlinuz"), "same-test-kernel");
    await writeFile(join(directory, "A/initramfs.xz"), "same-test-initramfs");
  }
  const args = [
    "ip=192.0.2.10::192.0.2.1:24::eth0:off:1.1.1.1",
    "talos.config.early=YWJjZA==",
  ];
  const run = () =>
    runCommand({
      executable: "python3",
      args: ["-", reference, live, JSON.stringify(args), "1.14.2"],
      stdin: GOLDEN_GRUB_NETWORK_PYTHON,
      env: { PATH: process.env.PATH, LANG: "C" },
      signal: AbortSignal.timeout(15000),
      timeout_ms: 15000,
    });
  return { root, reference, live, args, run };
}
test("real Python changes only the default boot entry and resolves a repeated committed file by readback", async () => {
  const f = await scenario();
  try {
    const first = await f.run();
    assert.equal(first.exit_code, 0);
    assert.match(first.stdout, /^[a-f0-9]{64}\s*$/);
    const path = join(f.live, "grub/grub.cfg"),
      actual = await readFile(path, "utf8");
    assert.equal(
      actual,
      base.replace(
        "module.sig_enforce=1\n",
        `module.sig_enforce=1 ${f.args.join(" ")}\n`,
      ),
    );
    const before = await stat(path, { bigint: true });
    const second = await f.run();
    assert.equal(second.exit_code, 0);
    assert.equal(second.stdout, first.stdout);
    assert.equal((await stat(path, { bigint: true })).mtimeNs, before.mtimeNs);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("unknown boot configuration or a changed kernel refuses replacement and leaves the live file intact", async () => {
  const f = await scenario();
  try {
    const path = join(f.live, "grub/grub.cfg"),
      changed = base.replace("module.sig_enforce=1", "module.sig_enforce=0");
    await writeFile(path, changed);
    assert.notEqual((await f.run()).exit_code, 0);
    assert.equal(await readFile(path, "utf8"), changed);
    await writeFile(path, base);
    await writeFile(join(f.live, "A/vmlinuz"), "different-test-kernel");
    assert.notEqual((await f.run()).exit_code, 0);
    assert.equal(await readFile(path, "utf8"), base);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("the actual remote boot-network command parses as Bash and keeps mounts outside rescue-image scratch", async () => {
  const input = fixture(),
    image = input.spec.image;
  image.golden_image = {
    release_id: "golden-fixture",
    spec_sha256: "e".repeat(64),
    region_revision: 1,
    talos_version: TALOS_VERSION,
    schematic_id: image.schematic_id,
    installer: `registry.example/installer@${image.installer_digest}`,
    raw: {
      url: `https://artifacts.example/raw/${image.compressed_sha256}`,
      sha256: image.compressed_sha256,
      format: "raw.xz",
      bytes: image.compressed_bytes,
      raw_sha256: image.raw_sha256,
      raw_bytes: image.raw_bytes,
    },
  };
  input.input_hash = inputHash(input.spec);
  let script = "";
  const job = new BootstrapJob(input, {
    run: async (command) => {
      script = command.stdin ?? "";
      return { exit_code: 0, stdout: "a".repeat(64) + "\n" };
    },
  });
  Reflect.set(job, "authority", { read: async () => authority(input) });
  await Reflect.get(job, "configureGoldenBootNetwork").call(job, [
    {
      name: "BOOT",
      start: 4306944,
      size: 4096000,
      type: "test-type",
      uuid: "test-uuid",
    },
  ]);
  assert.ok(
    script.includes(
      `/run/pgcf-boot-network/${input.spec.operation_id}-${input.input_hash}`,
    ),
  );
  assert.ok(script.includes("network_unmount_owned"));
  assert.ok(script.includes("offset=2205155328,sizelimit=2097152000"));
  const parsed = await runCommand({
    executable: "bash",
    args: ["--noprofile", "--norc", "-n"],
    stdin: script,
    env: { PATH: process.env.PATH, LANG: "C" },
    signal: AbortSignal.timeout(15000),
    timeout_ms: 15000,
  });
  assert.equal(parsed.exit_code, 0);
});
