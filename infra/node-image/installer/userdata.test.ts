// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installerParameters, renderUserData, userDataLimit, type InstallerParameters } from "./userdata.ts";

const template = readFileSync(new URL("cloud-config.yaml", import.meta.url), "utf8");
const script = readFileSync(new URL("install.sh", import.meta.url), "utf8");

// Stage 1 (plan 11.1): the Contabo rescue system is Debian 12. It carries sgdisk, curl, dd, zstd,
// sha256sum and lsblk (probed) and the Debian base tools below, but no xz.
const rescueTools = new Set(
  "awk blkid blockdev curl dd ip lsblk mount mountpoint passwd sgdisk sha256sum stat udevadm umount zstd".split(" "),
);

// The longest values the API can pass: presigned URLs and tokens at their limits.
const longest: InstallerParameters = {
  imageUrl: `https://example.r2.cloudflarestorage.com/node-images/${"a".repeat(40)}/pgcf-node.raw.zst?${"X-Amz-Signature=0123456789abcdef&".repeat(30)}x=1`,
  imageZstSha256: "1".repeat(64),
  imageZstBytes: 400 * 1024 ** 2,
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

function fileEntry(userData: string, path: string): string {
  const entry = userData.split("  - path: ").find((part) => part.startsWith(`${path}\n`));
  assert.ok(entry, `${path} is in the userData`);
  return entry;
}

function decodedFile(userData: string, path: string): string {
  const encoded = /content: (\S+)/.exec(fileEntry(userData, path))?.[1];
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

function toolPath(name: string): string {
  const found = spawnSync("sh", ["-c", 'command -v "$0"', name], { encoding: "utf8" }).stdout.trim();
  assert.ok(found, `${name} is available`);
  return found;
}

test("a failed install reports it, leaves a 0700 work directory and removes both token files", () => {
  const root = mkdtempSync(join(tmpdir(), "pgcf-installer-"));
  try {
    // cloud-init's write_files creates the directory that holds install.sh and the parameters with
    // its default mode; `mkdir -p -m 0700` does not change an existing directory.
    const work = join(root, "work");
    mkdirSync(work);
    chmodSync(work, 0o755);
    const params = join(work, "params");
    writeFileSync(params, decodedFile(renderUserData(template, script, longest), "/run/pgcf-install/params"), {
      mode: 0o600,
    });
    // A PATH without awk fails the tool check, the first step after the token files exist.
    const bin = join(root, "bin");
    mkdirSync(bin);
    for (const name of ["chmod", "mkdir", "rm"]) symlinkSync(toolPath(name), join(bin, name));
    const curlLog = join(root, "curl.log");
    writeFileSync(join(bin, "curl"), `#!/bin/sh\necho "$@" >>"${curlLog}"\n`, { mode: 0o755 });

    const result = spawnSync(toolPath("bash"), [new URL("install.sh", import.meta.url).pathname, params], {
      encoding: "utf8",
      env: { PATH: bin },
    });

    assert.equal(result.status, 1, result.stderr);
    const requests = readFileSync(curlLog, "utf8");
    assert.match(requests, /"checkpoint":"failed","detail":"tools"/, "the failure is reported with its step");
    assert.doesNotMatch(requests, /t{16}/, "the progress token is never on a command line");
    assert.equal(statSync(work).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(work), [], "no token file is left behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refused parameters file is removed and its directory is made 0700, except under --validate-only", () => {
  const root = mkdtempSync(join(tmpdir(), "pgcf-installer-"));
  try {
    const valid = installerParameters(longest);
    const refusals: Record<string, string> = {
      "an unknown name": `${valid}PGCF_EXTRA=1\n`,
      "an invalid value": valid.replace(/^PGCF_IMAGE_URL=https:/m, "PGCF_IMAGE_URL=http:"),
      "a short token": valid.replace(/^PGCF_ENROLLMENT_TOKEN=.*$/m, "PGCF_ENROLLMENT_TOKEN=short"),
      "an incomplete IPv6 address": valid.replace(/^PGCF_IPV6_GATEWAY=.*$/m, "PGCF_IPV6_GATEWAY="),
    };
    for (const [name, text] of Object.entries(refusals)) {
      const work = join(root, name.replaceAll(" ", "-"));
      mkdirSync(work);
      chmodSync(work, 0o755);
      const params = join(work, "params");
      writeFileSync(params, text, { mode: 0o600 });
      const run = (...flags: string[]) =>
        spawnSync(toolPath("bash"), [new URL("install.sh", import.meta.url).pathname, params, ...flags], {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin" },
        });

      const validated = run("--validate-only");
      assert.equal(validated.status, 2, `${name}: ${validated.stderr}`);
      assert.deepEqual(readdirSync(work), ["params"], `${name}: --validate-only leaves the file in place`);
      assert.equal(statSync(work).mode & 0o777, 0o755, `${name}: --validate-only leaves the mode alone`);

      const installed = run();
      assert.equal(installed.status, 2, `${name}: ${installed.stderr}`);
      assert.doesNotMatch(installed.stderr, /e{16}|t{16}/, `${name}: no token in the error output`);
      assert.equal(statSync(work).mode & 0o777, 0o700, `${name}: the directory is 0700`);
      assert.deepEqual(readdirSync(work), [], `${name}: no token file is left behind`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install.sh needs only tools the Contabo rescue system carries", () => {
  const tools = /^for tool in ([a-z0-9 ]+); do$/m.exec(script)?.[1]?.split(" ");
  assert.ok(tools, "install.sh checks its tools before it starts");
  assert.deepEqual(tools.filter((tool) => !rescueTools.has(tool)), [], "tools the rescue system lacks");
});

test("the installer turns off the password login that Contabo's rescue configuration turns on", () => {
  const dropIn = fileEntry(renderUserData(template, script, longest), "/etc/ssh/sshd_config.d/00-pgcf-install.conf");
  assert.match(dropIn, /^ +PasswordAuthentication no$/m);
  assert.match(dropIn, /^ +KbdInteractiveAuthentication no$/m);
  assert.match(script, /^passwd --lock root\b/m, "install.sh locks the root password Contabo sets");
});

test("values that could break out of a KEY=value line or a file are refused", () => {
  assert.throws(() => installerParameters({ ...longest, hostname: "eu1\nPGCF_DISK_BYTES=1" }), /invalid hostname/);
  assert.throws(() => installerParameters({ ...longest, apiUrl: 'https://api.example.org/"x' }), /invalid apiUrl/);
  assert.throws(() => installerParameters({ ...longest, imageUrl: "http://example.org/image" }), /invalid imageUrl/);
  assert.throws(() => installerParameters({ ...longest, imageRawBytes: longest.diskBytes }), /does not fit/);
  assert.throws(() => installerParameters({ ...longest, enrollmentToken: "short" }), /invalid enrollmentToken/);
});
