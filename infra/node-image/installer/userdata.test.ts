// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installerParameters, renderUserData, userDataLimit, type InstallerParameters } from "./userdata.ts";

const template = readFileSync(new URL("cloud-config.yaml", import.meta.url), "utf8");
const script = readFileSync(new URL("install.sh", import.meta.url), "utf8");

// The longest values the API can pass: presigned URLs and tokens at their limits.
const longest: InstallerParameters = {
  imageUrl: `https://example.r2.cloudflarestorage.com/node-images/${"a".repeat(40)}/pgcf-node.raw.xz?${"X-Amz-Signature=0123456789abcdef&".repeat(30)}x=1`,
  imageXzSha256: "1".repeat(64),
  imageXzBytes: 400 * 1024 ** 2,
  imageRawSha256: "2".repeat(64),
  imageRawBytes: 2 * 1024 ** 3,
  diskBytes: 150 * 1000 ** 3,
  memoryMinKib: 11_000_000,
  mac: "00:50:56:aa:bb:cc",
  ipv4: "192.0.2.10",
  ipv4Prefix: 20,
  ipv4Gateway: "192.0.2.1",
  ipv6: { address: "2001:db8:1234:5678:0000:0000:0000:0001", prefix: 64, gateway: "fe80::1" },
  dns: ["192.0.2.53", "198.51.100.53", "2001:db8::53"],
  hostname: "eu1",
  progressUrl: `https://api.example.org/v1/compute/install-progress/${"p".repeat(64)}`,
  progressToken: "t".repeat(512),
  nodeId: "n".repeat(64),
  region: "eu",
  apiUrl: "https://api.example.org",
  enrollmentToken: "e".repeat(512),
};

function decodedFile(userData: string, path: string): string {
  const block = userData.split("  - path: ").find((part) => part.startsWith(path));
  const encoded = /content: (\S+)/.exec(block ?? "")?.[1];
  assert.ok(encoded, `${path} is in the userData`);
  return Buffer.from(encoded, "base64").toString("utf8");
}

test("the rendered installer stays below Contabo's 32 KiB userData limit", () => {
  const userData = renderUserData(template, script, longest);
  assert.ok(Buffer.byteLength(userData) < userDataLimit, `${Buffer.byteLength(userData)} bytes`);
  assert.equal(decodedFile(userData, "/run/pgcf-install/install.sh"), script);
});

test("install.sh accepts exactly what the renderer produces", () => {
  const directory = mkdtempSync(join(tmpdir(), "pgcf-installer-"));
  try {
    for (const parameters of [longest, { ...longest, ipv6: undefined }]) {
      const file = join(directory, "params");
      writeFileSync(file, decodedFile(renderUserData(template, script, parameters), "/run/pgcf-install/params"), {
        mode: 0o600,
      });
      const result = spawnSync("bash", [new URL("install.sh", import.meta.url).pathname, file, "--validate-only"], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const unknown = join(directory, "unknown");
    writeFileSync(unknown, `${installerParameters(longest)}PGCF_EXTRA=1\n`, { mode: 0o600 });
    const refused = spawnSync("bash", [new URL("install.sh", import.meta.url).pathname, unknown, "--validate-only"], {
      encoding: "utf8",
    });
    assert.equal(refused.status, 2);
    assert.doesNotMatch(refused.stderr, /e{16}|t{16}/, "no token in the error output");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("values that could break out of a KEY=value line or a file are refused", () => {
  assert.throws(() => installerParameters({ ...longest, hostname: "eu1\nPGCF_DISK_BYTES=1" }), /invalid hostname/);
  assert.throws(() => installerParameters({ ...longest, apiUrl: 'https://api.example.org/"x' }), /invalid apiUrl/);
  assert.throws(() => installerParameters({ ...longest, imageUrl: "http://example.org/image" }), /invalid imageUrl/);
  assert.throws(() => installerParameters({ ...longest, imageRawBytes: longest.diskBytes }), /does not fit/);
  assert.throws(() => installerParameters({ ...longest, enrollmentToken: "short" }), /invalid enrollmentToken/);
});
