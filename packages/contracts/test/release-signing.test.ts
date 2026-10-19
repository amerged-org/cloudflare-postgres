// SPDX-License-Identifier: Apache-2.0
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { base64urlToBytes, bytesToHex } from "../src/encoding.ts";
import {
  FleetReleaseRegistration,
  FleetReleaseSpec,
  RELEASE_FILES,
  RELEASE_MANIFEST_DOMAIN,
  RELEASE_REFUSALS,
  RELEASE_SIGNATURE_FILE,
  ReleaseManifestFields,
  type HostFile,
  fleetReleaseSpec,
  releaseManifestFields,
  releaseSignatureVerifies,
  signedReleaseManifest,
} from "../src/releases.ts";
import { RELEASE_PUBLIC_KEY } from "../src/release-key.generated.ts";

const digest = (letter: string, size_bytes: number) => ({
  sha256: letter.repeat(64),
  size_bytes,
});
function registration() {
  return {
    image: {
      ...digest("a", 512_000_000),
      raw_sha256: "b".repeat(64),
      raw_bytes: 2_147_483_648,
    },
    binaries: {
      "pgcf-agent": digest("1", 11_000_000),
      "pgcf-native-gateway": digest("2", 12_000_000),
      "pgcf-archive": digest("3", 5_000_000),
      "pgcf-wal-fetch": digest("4", 5_100_000),
    },
    os: {
      debian_snapshot: "20261016T000000Z",
      package_lock: digest("5", 90_000),
      packages_sha256: "6".repeat(64),
      kernel_release: "6.12.113+deb13-amd64",
      host_files: [
        {
          path: "/etc/systemd/system/modprobe@loop.service",
          kind: "symlink-to-dev-null",
          apply: "daemon_reload",
        },
        {
          path: "/usr/lib/systemd/system/pgcf-gateway.service",
          kind: "file",
          mode: "0644",
          sha256: "8".repeat(64),
          size_bytes: 1200,
          apply: "restart_unit:pgcf-gateway.service",
        },
      ] as HostFile[],
      host_files_sha256: "9".repeat(64),
    },
    signature: "7".repeat(128),
  };
}
const release = () => ({ id: "sha-0123456789ab", ...registration() });

it("the signed manifest is one fixed byte string: a domain line, the release id, the image and every digest a node executes or installs", () => {
  expect(RELEASE_MANIFEST_DOMAIN).toBe("pgcf-release-manifest/v3\n");
  expect(signedReleaseManifest(release())).toBe(
    [
      "pgcf-release-manifest/v3",
      "release=sha-0123456789ab",
      `image.zst=${"a".repeat(64)}:512000000`,
      `image.raw=${"b".repeat(64)}:2147483648`,
      `binary.pgcf-agent=${"1".repeat(64)}:11000000`,
      `binary.pgcf-native-gateway=${"2".repeat(64)}:12000000`,
      `binary.pgcf-archive=${"3".repeat(64)}:5000000`,
      `binary.pgcf-wal-fetch=${"4".repeat(64)}:5100000`,
      "os.debian_snapshot=20261016T000000Z",
      `os.package_lock=${"5".repeat(64)}:90000`,
      "os.host_file=/etc/systemd/system/modprobe@loop.service symlink-to-dev-null - - daemon_reload",
      `os.host_file=/usr/lib/systemd/system/pgcf-gateway.service file 0644 ${"8".repeat(64)}:1200 restart_unit:pgcf-gateway.service`,
      "",
    ].join("\n"),
  );
});

it("a signature covers the release id, the image, each binary, the snapshot and the lock, and nothing a node does not install", () => {
  const signed = signedReleaseManifest(release());
  const changes: ((value: ReturnType<typeof release>) => void)[] = [
    (value) => (value.id = "sha-0123456789ac"),
    (value) => (value.image.sha256 = "9".repeat(64)),
    (value) => (value.image.size_bytes += 1),
    (value) => (value.image.raw_sha256 = "9".repeat(64)),
    (value) => (value.image.raw_bytes += 512),
    (value) => (value.binaries["pgcf-agent"].sha256 = "9".repeat(64)),
    (value) => (value.binaries["pgcf-native-gateway"].size_bytes += 1),
    (value) => (value.binaries["pgcf-archive"].sha256 = "9".repeat(64)),
    (value) => (value.binaries["pgcf-wal-fetch"].size_bytes += 1),
    (value) => (value.os.debian_snapshot = "20261017T000000Z"),
    (value) => (value.os.package_lock.sha256 = "9".repeat(64)),
    (value) => (value.os.package_lock.size_bytes += 1),
  ];
  for (const change of changes) {
    const other = release();
    change(other);
    expect(signedReleaseManifest(other)).not.toBe(signed);
  }
  // The node's reports are the API's to compare: the package lock, which the manifest pins, names
  // every package and every download they come from.
  const unsigned = release();
  unsigned.os.packages_sha256 = "9".repeat(64);
  unsigned.os.kernel_release = "6.12.999+deb13-amd64";
  unsigned.signature = "9".repeat(128);
  expect(signedReleaseManifest(unsigned)).toBe(signed);
});

it("a manifest is never built of a value that could read as another", () => {
  const broken: ((value: ReturnType<typeof release>) => void)[] = [
    (value) => (value.id = "sha-1\nrelease=sha-2"),
    (value) => (value.id = "Upper"),
    (value) => (value.image.sha256 = "A".repeat(64)),
    (value) => (value.image.size_bytes = 0),
    (value) => (value.image.raw_sha256 = "b".repeat(63)),
    (value) => (value.image.raw_bytes = 2_147_483_649),
    (value) => (value.binaries["pgcf-agent"].sha256 = "A".repeat(64)),
    (value) => (value.binaries["pgcf-archive"].sha256 = "1".repeat(63)),
    (value) => (value.binaries["pgcf-wal-fetch"].size_bytes = 1.5),
    (value) => (value.os.debian_snapshot = "20261016\nT000000Z"),
    (value) => (value.os.package_lock.size_bytes = 0),
    (value) => (value.os.host_files[1]!.path = "/etc/passwd"),
  ];
  for (const change of broken) {
    const other = release();
    change(other);
    expect(() => signedReleaseManifest(other)).toThrow();
  }
});

it("a release is registered with a signature of 64 bytes in hex and no other", () => {
  const signed = (signature: unknown) => ({ ...registration(), signature });
  expect(
    FleetReleaseRegistration.safeParse(signed("a".repeat(128))).success,
  ).toBe(true);
  const unsigned: Partial<ReturnType<typeof registration>> = registration();
  delete unsigned.signature;
  expect(FleetReleaseRegistration.safeParse(unsigned).success).toBe(false);
  for (const signature of [
    undefined,
    null,
    "",
    "a".repeat(127),
    "a".repeat(129),
    "A".repeat(128),
    `${"a".repeat(127)}g`,
    `${"a".repeat(128)}\n`,
    Array.from({ length: 64 }, () => 0),
  ])
    expect(FleetReleaseRegistration.safeParse(signed(signature)).success).toBe(
      false,
    );
});

it("the spec the API stores and serves carries the signature, which a node reads beside the binaries", () => {
  const spec = fleetReleaseSpec(
    "https://api.example.org",
    "v1",
    registration(),
  );
  expect(spec.signature).toBe("7".repeat(128));
  expect(
    FleetReleaseSpec.safeParse({ ...spec, signature: undefined }).success,
  ).toBe(false);
  // The signature is no uploaded file: the API answers for its name from the stored spec.
  expect(RELEASE_SIGNATURE_FILE).toBe("release.sig");
  expect(RELEASE_FILES).not.toContain(RELEASE_SIGNATURE_FILE);
  expect(
    spec.binaries["pgcf-agent"].url.replace(/[^/]+$/, RELEASE_SIGNATURE_FILE),
  ).toBe("https://api.example.org/node/v1/releases/v1/release.sig");
});

it("a node that refuses a release names one of these classes, which are the contract's", () => {
  expect(RELEASE_REFUSALS).toEqual([
    "release_signature_missing",
    "release_signature_invalid",
    "host_file_path_refused",
    "host_file_mode_refused",
    "host_file_apply_refused",
    "host_files_invalid",
  ]);
  // An event field is a token of lowercase letters, digits and underscores.
  for (const code of RELEASE_REFUSALS)
    expect(code).toMatch(/^[a-z0-9_]{1,64}$/);
});

/** A copy of `value` with the value at `path` set to `to`, or removed when `to` is undefined. */
function tweak(value: object, path: string[], to?: unknown): unknown {
  const copy = structuredClone(value) as Record<string, unknown>;
  let at = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string, unknown>;
  if (to === undefined) delete at[path.at(-1)!];
  else at[path.at(-1)!] = to;
  return copy;
}

it("the fields a signer accepts are the manifest's facts and no key beyond them, at any level", () => {
  const whole = release();
  const fields = releaseManifestFields(whole);
  expect(fields).toEqual({
    id: whole.id,
    image: whole.image,
    binaries: whole.binaries,
    os: {
      debian_snapshot: whole.os.debian_snapshot,
      package_lock: whole.os.package_lock,
      host_files: whole.os.host_files,
    },
  });
  expect(ReleaseManifestFields.safeParse(fields).success).toBe(true);
  // The text a signer signs from the fields is the text of the whole release: nothing else is in it.
  expect(signedReleaseManifest(fields)).toBe(signedReleaseManifest(whole));
  const extras: [string[], unknown][] = [
    [["image", "url"], "https://x.example/i"],
    [["image", "format"], "raw.zst"],
    [["signature"], "7".repeat(128)],
    [["binaries", "pgcf-agent", "url"], "https://x.example/a"],
    [["binaries", "other"], whole.binaries["pgcf-agent"]],
    [["os", "kernel_release"], "6.12.113+deb13-amd64"],
    [["os", "host_files_sha256"], "9".repeat(64)],
    [["os", "host_files", "0", "url"], "https://x.example/f"],
    [["os", "package_lock", "url"], "https://x.example/lock"],
    [["extra"], 1],
  ];
  for (const [path, value] of extras)
    expect(
      ReleaseManifestFields.safeParse(tweak(fields, path, value)).success,
      path.join("."),
    ).toBe(false);
  for (const path of [
    ["id"],
    ["image"],
    ["image", "raw_sha256"],
    ["image", "raw_bytes"],
    ["binaries", "pgcf-wal-fetch"],
    ["os", "package_lock"],
  ])
    expect(
      ReleaseManifestFields.safeParse(tweak(fields, path)).success,
      path.join("."),
    ).toBe(false);
});

/** A throwaway Ed25519 key pair as the API's tests and the signer's tests make one. */
function throwaway() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: bytesToHex(
      base64urlToBytes(publicKey.export({ format: "jwk" }).x!)!,
    ),
    sign: (text: string) =>
      sign(null, Buffer.from(text), privateKey).toString("hex"),
  };
}

it("a signature verifies for the release it was made for with the key that made it, and for nothing else", async () => {
  const key = throwaway();
  const signature = key.sign(signedReleaseManifest(release()));
  expect(
    await releaseSignatureVerifies(key.publicKey, release(), signature),
  ).toBe(true);
  // The registration, the stored spec and a node's page carry more than the manifest holds (URLs,
  // the signature, what a node reports): the facts are taken from them and the rest is left out.
  const spec = fleetReleaseSpec("https://api.example.org", release().id, {
    ...registration(),
    signature,
  });
  expect(
    await releaseSignatureVerifies(
      key.publicKey,
      { id: release().id, ...spec },
      signature,
    ),
  ).toBe(true);

  // Another key, another release's signature and every fact of the release changed: the image's
  // four, a binary, the snapshot, the lock and a host file.
  expect(
    await releaseSignatureVerifies(throwaway().publicKey, release(), signature),
  ).toBe(false);
  const changes: ((value: ReturnType<typeof release>) => void)[] = [
    (value) => (value.id = "sha-0123456789ac"),
    (value) => (value.image.sha256 = "9".repeat(64)),
    (value) => (value.image.size_bytes += 1),
    (value) => (value.image.raw_sha256 = "9".repeat(64)),
    (value) => (value.image.raw_bytes += 512),
    (value) => (value.binaries["pgcf-agent"].sha256 = "9".repeat(64)),
    (value) => (value.os.debian_snapshot = "20261017T000000Z"),
    (value) => (value.os.package_lock.size_bytes += 1),
    (value) => (value.os.host_files[1]!.apply = "next_start"),
  ];
  for (const change of changes) {
    const other = release();
    change(other);
    expect(
      await releaseSignatureVerifies(key.publicKey, other, signature),
    ).toBe(false);
  }
});

it("a release without a signature, with one that is no signature, or checked by something that is no key, does not verify", async () => {
  const key = throwaway();
  const signature = key.sign(signedReleaseManifest(release()));
  for (const bad of [
    "",
    "\n",
    signature.slice(1),
    `${signature}00`,
    signature.toUpperCase(),
    "z".repeat(128),
    `${signature}\n`,
  ])
    expect(await releaseSignatureVerifies(key.publicKey, release(), bad)).toBe(
      false,
    );
  for (const bad of [
    "",
    key.publicKey.slice(1),
    key.publicKey.toUpperCase(),
    "0".repeat(64),
  ])
    expect(await releaseSignatureVerifies(bad, release(), signature)).toBe(
      false,
    );
  // A facts value that cannot be a manifest is no release: it is refused and never throws.
  const broken = release();
  broken.image.sha256 = "not a digest";
  expect(await releaseSignatureVerifies(key.publicKey, broken, signature)).toBe(
    false,
  );
});

it("a signature of the text without the image, or of the previous version of the format, does not verify", async () => {
  const key = throwaway();
  const text = signedReleaseManifest(release());
  const withoutImage = text
    .split("\n")
    .filter((line) => !line.startsWith("image."))
    .join("\n");
  for (const other of [
    withoutImage,
    text.replace("pgcf-release-manifest/v3", "pgcf-release-manifest/v2"),
    withoutImage.replace(
      "pgcf-release-manifest/v3",
      "pgcf-release-manifest/v2",
    ),
  ])
    expect(
      await releaseSignatureVerifies(key.publicKey, release(), key.sign(other)),
    ).toBe(false);
});

it("the key the Workers verify with is the key the agent trusts: the committed file, generated into a constant", () => {
  expect(RELEASE_PUBLIC_KEY).toBe(
    readFileSync(
      new URL("../../../apps/node-agent/release-signing.pub", import.meta.url),
      "utf8",
    ).trim(),
  );
  expect(RELEASE_PUBLIC_KEY).toMatch(/^[0-9a-f]{64}$/);
});
