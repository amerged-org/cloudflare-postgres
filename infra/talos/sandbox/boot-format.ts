// SPDX-License-Identifier: Apache-2.0
import { open, stat } from "node:fs/promises";
function fail(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
export function safeBootPath(value: string) {
  fail(
    value.length > 0 &&
      value.length <= 4096 &&
      !value.startsWith("/") &&
      !/[\\\p{C}]/u.test(value) &&
      value.split("/").every((p) => p && p !== "." && p !== ".."),
    "boot_payload_path_invalid",
  );
  return value;
}
export interface UkiSection {
  name: string;
  offset: number;
  size: number;
  raw_size: number;
}
/** The observed Talos UKI has multiple named .profile/.cmdline sections; Linux/initrd remain unique. */
export function ukiSections(bytes: Buffer): UkiSection[] {
  fail(
    bytes.length >= 64 && bytes.subarray(0, 2).toString() === "MZ",
    "boot_uki_dos_invalid",
  );
  const pe = bytes.readUInt32LE(60);
  fail(
    pe >= 64 &&
      pe + 24 <= bytes.length &&
      bytes.subarray(pe, pe + 4).equals(Buffer.from([80, 69, 0, 0])) &&
      bytes.readUInt16LE(pe + 4) === 0x8664,
    "boot_uki_pe_invalid",
  );
  const count = bytes.readUInt16LE(pe + 6),
    start = pe + 24 + bytes.readUInt16LE(pe + 20);
  fail(
    count > 0 && count <= 96 && start + count * 40 <= bytes.length,
    "boot_uki_sections_invalid",
  );
  const sections: UkiSection[] = [];
  for (let i = 0; i < count; i++) {
    const at = start + i * 40,
      name = bytes
        .subarray(at, at + 8)
        .toString("ascii")
        .replace(/\0.*$/s, ""),
      size = bytes.readUInt32LE(at + 8),
      raw_size = bytes.readUInt32LE(at + 16),
      offset = bytes.readUInt32LE(at + 20);
    fail(
      /^[A-Za-z0-9._-]+$/.test(name) &&
        size <= raw_size &&
        offset >= start + count * 40 &&
        offset + raw_size <= bytes.length,
      "boot_uki_section_bounds",
    );
    sections.push({ name, size, raw_size, offset });
  }
  const sorted = [...sections].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < sorted.length; i++)
    fail(
      sorted[i]!.offset >= sorted[i - 1]!.offset + sorted[i - 1]!.raw_size,
      "boot_uki_sections_overlap",
    );
  for (const name of [".linux", ".initrd"]) {
    const found = sections.filter((s) => s.name === name);
    fail(found.length === 1 && found[0]!.size > 0, "boot_uki_payload_missing");
  }
  return sections;
}
export interface CpioEntry {
  archive: number;
  index: number;
  name: string;
  mode: number;
  offset: number;
  size: number;
  kind: "file" | "directory" | "symlink" | "special";
}
/** Decode newc framing without creating archive paths, links or device nodes on the inspector host. */
export function cpioEntries(bytes: Buffer): CpioEntry[] {
  let at = 0,
    archive = 0,
    index = 0,
    openArchive = false;
  const out: CpioEntry[] = [];
  while (at < bytes.length) {
    if (bytes[at] === 0) {
      fail(!openArchive, "boot_cpio_truncated");
      while (at < bytes.length && bytes[at] === 0) at++;
      if (at === bytes.length) break;
      fail(at % 4 === 0, "boot_cpio_alignment");
    }
    fail(at + 110 <= bytes.length, "boot_cpio_header_truncated");
    const h = bytes.subarray(at, at + 110).toString("ascii"),
      magic = h.slice(0, 6);
    fail(
      ["070701", "070702"].includes(magic) &&
        /^[0-9a-fA-F]{104}$/.test(h.slice(6)),
      "boot_cpio_header_invalid",
    );
    const n = (i: number) => parseInt(h.slice(6 + i * 8, 14 + i * 8), 16),
      size = n(6),
      nameSize = n(11),
      mode = n(1);
    fail(
      nameSize > 0 && nameSize <= 4097 && at + 110 + nameSize <= bytes.length,
      "boot_cpio_name_bounds",
    );
    const nameBytes = bytes.subarray(at + 110, at + 110 + nameSize);
    fail(nameBytes.at(-1) === 0, "boot_cpio_name_terminator");
    const name = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      }).decode(nameBytes.subarray(0, -1)),
      offset = Math.ceil((at + 110 + nameSize) / 4) * 4;
    fail(offset + size <= bytes.length, "boot_cpio_body_bounds");
    if (name === "TRAILER!!!") {
      fail(size === 0, "boot_cpio_trailer_invalid");
      openArchive = false;
      archive++;
    } else {
      openArchive = true;
      fail(out.length < 200000, "boot_cpio_entry_limit");
      if (name !== ".") safeBootPath(name.replace(/^\.\//, ""));
      const type = mode & 0xf000,
        kind =
          type === 0x8000
            ? "file"
            : type === 0x4000
              ? "directory"
              : type === 0xa000
                ? "symlink"
                : "special";
      if (magic === "070702") {
        let sum = 0;
        for (const byte of bytes.subarray(offset, offset + size))
          sum = (sum + byte) >>> 0;
        fail(sum === n(12), "boot_cpio_crc_invalid");
      }
      out.push({
        archive,
        index: index++,
        name: name === "." ? "." : name.replace(/^\.\//, ""),
        mode,
        offset,
        size,
        kind,
      });
    }
    at = Math.ceil((offset + size) / 4) * 4;
  }
  fail(!openArchive && archive > 0, "boot_cpio_trailer_missing");
  return out;
}
export function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export interface BootPartition {
  number: number;
  name: string;
  first_lba: number;
  last_lba: number;
  offset: number;
  size: number;
  type_guid: string;
}
function integer(bytes: Buffer, at: number) {
  const n = bytes.readBigUInt64LE(at);
  fail(n <= BigInt(Number.MAX_SAFE_INTEGER), "boot_gpt_integer_invalid");
  return Number(n);
}
function header(bytes: Buffer, lba: number, last: number) {
  fail(
    bytes.length === 512 &&
      bytes.subarray(0, 8).toString() === "EFI PART" &&
      bytes.readUInt32LE(8) === 0x10000,
    "boot_gpt_header_invalid",
  );
  const size = bytes.readUInt32LE(12);
  fail(
    size >= 92 &&
      size <= 512 &&
      integer(bytes, 24) === lba &&
      integer(bytes, 32) === (lba === 1 ? last : 1),
    "boot_gpt_header_location",
  );
  const copy = Buffer.from(bytes.subarray(0, size));
  copy.fill(0, 16, 20);
  fail(crc32(copy) === bytes.readUInt32LE(16), "boot_gpt_header_crc");
  return {
    first: integer(bytes, 40),
    last: integer(bytes, 48),
    entries: integer(bytes, 72),
    count: bytes.readUInt32LE(80),
    entrySize: bytes.readUInt32LE(84),
    arrayCrc: bytes.readUInt32LE(88),
    guid: bytes.subarray(56, 72).toString("hex"),
  };
}
export async function readBootGpt(
  path: string,
): Promise<{ bytes: number; partitions: BootPartition[] }> {
  const file = await open(path, "r");
  try {
    const info = await stat(path);
    fail(
      info.isFile() &&
        info.size >= 4 * 1024 ** 2 &&
        info.size <= 32 * 1024 ** 3 &&
        info.size % 512 === 0,
      "boot_raw_size_invalid",
    );
    const read = async (at: number, size: number) => {
      const b = Buffer.alloc(size),
        r = await file.read(b, 0, size, at);
      fail(r.bytesRead === size, "boot_raw_short_read");
      return b;
    };
    const mbr = await read(0, 512);
    fail(
      mbr[510] === 0x55 && mbr[511] === 0xaa && mbr[450] === 0xee,
      "boot_gpt_protective_mbr",
    );
    const last = info.size / 512 - 1,
      a = header(await read(512, 512), 1, last),
      b = header(await read(last * 512, 512), last, last);
    fail(
      a.guid === b.guid &&
        a.first === b.first &&
        a.last === b.last &&
        a.count === b.count &&
        a.entrySize === b.entrySize &&
        a.arrayCrc === b.arrayCrc &&
        a.count > 0 &&
        a.count <= 4096 &&
        a.entrySize >= 128 &&
        a.entrySize <= 4096 &&
        a.entrySize % 8 === 0,
      "boot_gpt_headers_disagree",
    );
    const length = a.count * a.entrySize;
    fail(
      a.entries >= 2 &&
        a.entries * 512 + length <= a.first * 512 &&
        b.entries * 512 >= (a.last + 1) * 512 &&
        b.entries * 512 + length <= last * 512,
      "boot_gpt_array_bounds",
    );
    const entries = await read(a.entries * 512, length),
      backup = await read(b.entries * 512, length);
    fail(
      crc32(entries) === a.arrayCrc && entries.equals(backup),
      "boot_gpt_array_crc",
    );
    const partitions: BootPartition[] = [];
    for (let i = 0; i < a.count; i++) {
      const x = entries.subarray(i * a.entrySize, (i + 1) * a.entrySize);
      if (x.subarray(0, 16).every((v) => v === 0)) continue;
      const first = integer(x, 32),
        end = integer(x, 40),
        name = x.subarray(56, 128).toString("utf16le").replace(/\0.*$/s, "");
      fail(
        first >= a.first &&
          end <= a.last &&
          end >= first &&
          /^[A-Za-z0-9_-]{1,36}$/.test(name),
        "boot_gpt_partition_invalid",
      );
      partitions.push({
        number: i + 1,
        name,
        first_lba: first,
        last_lba: end,
        offset: first * 512,
        size: (end - first + 1) * 512,
        type_guid: x.subarray(0, 16).toString("hex"),
      });
    }
    const sorted = [...partitions].sort((x, y) => x.first_lba - y.first_lba);
    for (let i = 1; i < sorted.length; i++)
      fail(
        sorted[i]!.first_lba > sorted[i - 1]!.last_lba,
        "boot_gpt_partition_overlap",
      );
    fail(
      partitions.length > 0 &&
        new Set(partitions.map((p) => p.name)).size === partitions.length,
      "boot_gpt_partitions_invalid",
    );
    return { bytes: info.size, partitions };
  } finally {
    await file.close();
  }
}

/** Unsquashfs4.6 pseudo records preserve all xattrs without installing security labels on the inspector. */
export function squashfsXattrs(pseudo: Buffer): Buffer[] {
  const marker = pseudo.indexOf(Buffer.from("# START OF DATA"));
  fail(marker >= 0 && marker <= 16 * 1024 ** 2, "boot_squashfs_pseudo_invalid");
  const header = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(pseudo.subarray(0, marker)),
    out: Buffer[] = [];
  for (const line of header.split("\n")) {
    const m = /^.* x [^=\s]+=(0[tsx])(.*)$/.exec(line);
    if (!m) continue;
    const mode = m[1],
      value = m[2]!;
    let decoded: Buffer;
    if (mode === "0s") {
      fail(/^[A-Za-z0-9+/]*={0,2}$/.test(value), "boot_xattr_base64_invalid");
      decoded = Buffer.from(value, "base64");
      fail(decoded.toString("base64") === value, "boot_xattr_base64_invalid");
    } else if (mode === "0x") {
      fail(/^(?:[0-9a-fA-F]{2})*$/.test(value), "boot_xattr_hex_invalid");
      decoded = Buffer.from(value, "hex");
    } else {
      const chunks: Buffer[] = [];
      let at = 0;
      while (at < value.length) {
        if (value[at] === "\\") {
          fail(
            /^\\[0-7]{3}/.test(value.slice(at)),
            "boot_xattr_escape_invalid",
          );
          chunks.push(Buffer.from([parseInt(value.slice(at + 1, at + 4), 8)]));
          at += 4;
        } else {
          let end = value.indexOf("\\", at);
          if (end < 0) end = value.length;
          chunks.push(Buffer.from(value.slice(at, end)));
          at = end;
        }
      }
      decoded = Buffer.concat(chunks);
    }
    fail(
      out.length < 200000 && decoded.length <= 1024 ** 2,
      "boot_xattr_size_limit",
    );
    out.push(decoded);
  }
  return out;
}
