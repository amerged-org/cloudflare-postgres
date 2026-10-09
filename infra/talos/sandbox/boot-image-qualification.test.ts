// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, open, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { zstdCompressSync } from "node:zlib";
import {
  crc32,
  ukiSections,
  cpioEntries,
  readBootGpt,
  squashfsXattrs,
} from "./boot-format.ts";
import {
  validateBootFacts,
  inspectBootBaseImage,
  expandBootInitrd,
} from "./boot-image-qualification.ts";
test(
  "actual loaded base inspection preserves AMD64 image ID and diffID binding",
  { skip: !process.env.PGCF_TEST_BOOT_BASE_IMAGE },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pgcf-boot-base-test-"));
    try {
      const actual = await inspectBootBaseImage(
        process.env.PGCF_TEST_BOOT_BASE_IMAGE!,
        directory,
      );
      const independently = spawnSync(
        "docker",
        [
          "image",
          "inspect",
          ...(process.env.PGCF_TEST_BOOT_BASE_PLAIN_INSPECT
            ? []
            : ["--platform", "linux/amd64"]),
          process.env.PGCF_TEST_BOOT_BASE_IMAGE!,
          "--format",
          "{{json .}}",
        ],
        { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024 },
      );
      assert.equal(
        independently.status,
        0,
        independently.stderr.slice(0, 4096),
      );
      const bound = JSON.parse(independently.stdout);
      assert.equal(actual.Id, bound.Id);
      assert.equal(actual.Os, "linux");
      assert.equal(actual.Architecture, "amd64");
      assert.deepEqual(actual.RootFS.Layers, bound.RootFS.Layers);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
function uki(
  names = [".linux", ".initrd", ".profile", ".cmdline", ".profile", ".cmdline"],
) {
  const b = Buffer.alloc(4096),
    pe = 128,
    start = pe + 24 + 240;
  b.write("MZ");
  b.writeUInt32LE(pe, 60);
  b.write("PE\0\0", pe);
  b.writeUInt16LE(0x8664, pe + 4);
  b.writeUInt16LE(names.length, pe + 6);
  b.writeUInt16LE(240, pe + 20);
  for (const [i, name] of names.entries()) {
    const at = start + i * 40;
    b.write(name, at);
    b.writeUInt32LE(16, at + 8);
    b.writeUInt32LE(512, at + 16);
    b.writeUInt32LE(1024 + i * 512, at + 20);
  }
  return b;
}
function cpio(files: { name: string; body: string; mode?: number }[]) {
  const blocks: Buffer[] = [];
  let length = 0;
  for (const [i, f] of [
    ...files,
    { name: "TRAILER!!!", body: "", mode: 0 },
  ].entries()) {
    const name = Buffer.from(f.name + "\0"),
      body = Buffer.from(f.body),
      fields = [
        i,
        f.mode ?? 0x81a4,
        0,
        0,
        1,
        0,
        body.length,
        0,
        0,
        0,
        0,
        name.length,
        0,
      ],
      header = Buffer.from(
        "070701" + fields.map((v) => v.toString(16).padStart(8, "0")).join(""),
      );
    blocks.push(header, name);
    length += header.length + name.length;
    const pad = (4 - (length % 4)) % 4;
    blocks.push(Buffer.alloc(pad), body);
    length += pad + body.length;
    const end = (4 - (length % 4)) % 4;
    blocks.push(Buffer.alloc(end));
    length += end;
  }
  return Buffer.concat(blocks);
}
test("initrd expansion consumes both actual Zstd frames and keeps one aggregate expansion bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-zstd-initrd-"));
  try {
    const base = cpio([{ name: "rootfs.sqsh", body: "hsqs-base" }]),
      extension = cpio([{ name: "0.sqsh", body: "hsqs-extension" }]),
      input = join(directory, "initrd.zstd"),
      output = join(directory, "initrd.cpio"),
      compressed = Buffer.concat([
        zstdCompressSync(base),
        zstdCompressSync(extension),
      ]);
    await writeFile(input, compressed, { mode: 0o600 });
    await expandBootInitrd(input, output);
    assert.deepEqual(await readFile(output), Buffer.concat([base, extension]));
    assert.deepEqual(
      cpioEntries(await readFile(output)).map((value) => [
        value.archive,
        value.name,
      ]),
      [
        [0, "rootfs.sqsh"],
        [1, "0.sqsh"],
      ],
    );
    await assert.rejects(
      expandBootInitrd(
        input,
        join(directory, "too-large.cpio"),
        base.length + extension.length - 1,
      ),
      /boot_initrd_expansion_limit/,
    );
    await writeFile(
      join(directory, "invalid.zstd"),
      Buffer.concat([zstdCompressSync(base), Buffer.from("invalid frame")]),
      { mode: 0o600 },
    );
    await assert.rejects(
      expandBootInitrd(
        join(directory, "invalid.zstd"),
        join(directory, "invalid.cpio"),
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("observed UKI multiple profiles are valid while duplicate boot payloads, wrong architecture and overlapping sections refuse", () => {
  assert.equal(
    ukiSections(uki()).filter((s) => s.name === ".profile").length,
    2,
  );
  assert.throws(
    () => ukiSections(uki([".linux", ".initrd", ".initrd"])),
    /payload_missing/,
  );
  const wrong = uki();
  wrong.writeUInt16LE(0xaa64, 132);
  assert.throws(() => ukiSections(wrong), /pe_invalid/);
  const overlap = uki();
  overlap.writeUInt32LE(1024, 128 + 24 + 240 + 40 + 20);
  assert.throws(() => ukiSections(overlap), /overlap/);
});
test("newc parsing preserves every concatenated archive payload without following links and refuses truncation/traversal", () => {
  const one = cpio([
      { name: "init", body: "ELF" },
      { name: "rootfs.sqsh", body: "hsqs" },
      { name: "link", body: "/etc/elsewhere", mode: 0xa1ff },
    ]),
    two = cpio([{ name: "rootfs.sqsh", body: "second" }]),
    records = cpioEntries(Buffer.concat([one, two]));
  assert.equal(records.length, 4);
  assert.equal(records[2]!.kind, "symlink");
  assert.equal(records[3]!.archive, 1);
  assert.throws(
    () => cpioEntries(one.subarray(0, -20)),
    /truncated|bounds|trailer/,
  );
  assert.throws(
    () => cpioEntries(cpio([{ name: "../outside", body: "x" }])),
    /path_invalid/,
  );
});
async function gpt(path: string) {
  const size = 4 * 1024 ** 2,
    last = size / 512 - 1,
    entries = Buffer.alloc(512);
  entries[0] = 1;
  entries[16] = 2;
  entries.writeBigUInt64LE(2048n, 32);
  entries.writeBigUInt64LE(4095n, 40);
  entries.write("EFI", 56, "utf16le");
  const head = (current: number, other: number, array: number) => {
      const h = Buffer.alloc(512);
      h.write("EFI PART");
      h.writeUInt32LE(0x10000, 8);
      h.writeUInt32LE(92, 12);
      h.writeBigUInt64LE(BigInt(current), 24);
      h.writeBigUInt64LE(BigInt(other), 32);
      h.writeBigUInt64LE(34n, 40);
      h.writeBigUInt64LE(BigInt(last - 2), 48);
      h[56] = 42;
      h.writeBigUInt64LE(BigInt(array), 72);
      h.writeUInt32LE(4, 80);
      h.writeUInt32LE(128, 84);
      h.writeUInt32LE(crc32(entries), 88);
      h.writeUInt32LE(crc32(h.subarray(0, 92)), 16);
      return h;
    },
    mbr = Buffer.alloc(512);
  mbr[450] = 0xee;
  mbr[510] = 0x55;
  mbr[511] = 0xaa;
  const f = await open(path, "wx", 0o600);
  try {
    await f.truncate(size);
    await f.write(mbr, 0, 512, 0);
    await f.write(head(1, last, 2), 0, 512, 512);
    await f.write(entries, 0, 512, 1024);
    await f.write(entries, 0, 512, (last - 1) * 512);
    await f.write(head(last, 1, last - 1), 0, 512, last * 512);
  } finally {
    await f.close();
  }
}
test("GPT checks both CRCs, backup array and actual file size before granting partition ranges", async () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const d = await mkdtemp(join(tmpdir(), "pgcf-gpt-test-")),
    p = join(d, "disk.raw");
  try {
    await gpt(p);
    assert.deepEqual(
      (await readBootGpt(p)).partitions.map((p) => ({
        name: p.name,
        offset: p.offset,
        size: p.size,
      })),
      [{ name: "EFI", offset: 1024 ** 2, size: 1024 ** 2 }],
    );
    const f = await open(p, "r+");
    try {
      await f.write(Buffer.from([99]), 0, 1, 1024);
    } finally {
      await f.close();
    }
    await assert.rejects(readBootGpt(p), /array_crc/);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});
test("runtime version alone cannot qualify an assembled OS without healthy maintenance, both actual extensions and recipe identity", () => {
  const sha = "a".repeat(64),
    source = "b".repeat(40),
    record = (spec: unknown) => JSON.stringify({ metadata: {}, spec }),
    r = {
      elapsed_ms: 1234,
      facts: {
        version: {
          version: { tag: "v1.14.1", arch: "amd64" },
          platform: { name: "nocloud" },
        },
        machine: {
          code: 0,
          stdout: record({
            stage: "maintenance",
            status: { ready: true, unmetConditions: [] },
          }),
        },
        extensions: {
          code: 0,
          stdout:
            record({
              metadata: {
                name: "pgcf-sandbox-controller",
                version: "0.1.0-" + source,
              },
            }) +
            "\n" +
            record({ metadata: { name: "schematic", version: sha } }),
        },
        schematic: {
          code: 0,
          stdout: record({ schematicId: sha, flavor: "PGCF imager" }),
        },
      },
    },
    expected = {
      talosVersion: "1.14.1",
      recipeSha256: sha,
      sourceCommit: source,
    };
  assert.equal(validateBootFacts(r, expected).machine_stage, "maintenance");
  assert.throws(
    () =>
      validateBootFacts(
        {
          ...r,
          facts: {
            ...r.facts,
            extensions: {
              code: 0,
              stdout: record({ metadata: { name: "schematic", version: sha } }),
            },
          },
        },
        expected,
      ),
    /extension_identity/,
  );
  assert.throws(
    () =>
      validateBootFacts(
        {
          ...r,
          facts: {
            ...r.facts,
            machine: {
              code: 0,
              stdout: record({
                stage: "maintenance",
                status: { ready: false, unmetConditions: ["x"] },
              }),
            },
          },
        },
        expected,
      ),
    /healthy_maintenance/,
  );
});

test("actual SquashFS pseudo xattr encodings are decoded before scanning without installing SELinux labels", () => {
  const header = Buffer.from(
    "/ x security.selinux=0tsystem_u:object_r:rootfs_t:s0\\000\n/bin x security.capability=0sAQID\n/file x user.value=0x4142\n# START OF DATA\nignored raw body",
  );
  const values = squashfsXattrs(header);
  assert.equal(values[0]!.at(-1), 0);
  assert.deepEqual(values[1], Buffer.from([1, 2, 3]));
  assert.equal(values[2]!.toString(), "AB");
  assert.throws(
    () =>
      squashfsXattrs(Buffer.from("/ x user.value=0tbad\\q\n# START OF DATA")),
    /escape_invalid/,
  );
});
