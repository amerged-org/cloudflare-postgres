// SPDX-License-Identifier: Apache-2.0
import { expect, it } from "vitest";
import {
  FleetReleaseRegistration,
  FleetReleaseSpec,
  RELEASE_FILES,
  RELEASE_MANIFEST_DOMAIN,
  RELEASE_REFUSALS,
  RELEASE_SIGNATURE_FILE,
  RELEASE_SIGNING_SECRET,
  RELEASE_SIGN_PATH,
  ReleaseManifestFields,
  fleetReleaseSpec,
  releaseManifestFields,
  signedReleaseManifest,
} from "../src/releases.ts";

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
    },
    signature: "7".repeat(128),
  };
}
const release = () => ({ id: "sha-0123456789ab", ...registration() });

it("the signed manifest is one fixed byte string: a domain line, the release id and every digest a node executes or installs", () => {
  expect(RELEASE_MANIFEST_DOMAIN).toBe("pgcf-release-manifest/v1\n");
  expect(signedReleaseManifest(release())).toBe(
    [
      "pgcf-release-manifest/v1",
      "release=sha-0123456789ab",
      `binary.pgcf-agent=${"1".repeat(64)}:11000000`,
      `binary.pgcf-native-gateway=${"2".repeat(64)}:12000000`,
      `binary.pgcf-archive=${"3".repeat(64)}:5000000`,
      `binary.pgcf-wal-fetch=${"4".repeat(64)}:5100000`,
      "os.debian_snapshot=20261016T000000Z",
      `os.package_lock=${"5".repeat(64)}:90000`,
      "",
    ].join("\n"),
  );
});

it("a signature covers the release id, each binary, the snapshot and the lock, and nothing a node does not install", () => {
  const signed = signedReleaseManifest(release());
  const changes: ((value: ReturnType<typeof release>) => void)[] = [
    (value) => (value.id = "sha-0123456789ac"),
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
  // The image goes to the installer and the node's reports are the API's to compare: the package
  // lock, which the manifest pins, names every package and every download they come from.
  const unsigned = release();
  unsigned.image.sha256 = "9".repeat(64);
  unsigned.os.packages_sha256 = "9".repeat(64);
  unsigned.os.kernel_release = "6.12.999+deb13-amd64";
  unsigned.signature = "9".repeat(128);
  expect(signedReleaseManifest(unsigned)).toBe(signed);
});

it("a manifest is never built of a value that could read as another", () => {
  const broken: ((value: ReturnType<typeof release>) => void)[] = [
    (value) => (value.id = "sha-1\nrelease=sha-2"),
    (value) => (value.id = "Upper"),
    (value) => (value.binaries["pgcf-agent"].sha256 = "A".repeat(64)),
    (value) => (value.binaries["pgcf-archive"].sha256 = "1".repeat(63)),
    (value) => (value.binaries["pgcf-wal-fetch"].size_bytes = 1.5),
    (value) => (value.os.debian_snapshot = "20261016\nT000000Z"),
    (value) => (value.os.package_lock.size_bytes = 0),
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

it("a node that refuses a release names one of two classes, which are the contract's", () => {
  expect(RELEASE_REFUSALS).toEqual([
    "release_signature_missing",
    "release_signature_invalid",
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
    binaries: whole.binaries,
    os: {
      debian_snapshot: whole.os.debian_snapshot,
      package_lock: whole.os.package_lock,
    },
  });
  expect(ReleaseManifestFields.safeParse(fields).success).toBe(true);
  // The text a signer signs from the fields is the text of the whole release: nothing else is in it.
  expect(signedReleaseManifest(fields)).toBe(signedReleaseManifest(whole));
  const extras: [string[], unknown][] = [
    [["image"], whole.image],
    [["signature"], "7".repeat(128)],
    [["binaries", "pgcf-agent", "url"], "https://x.example/a"],
    [["binaries", "other"], whole.binaries["pgcf-agent"]],
    [["os", "kernel_release"], "6.12.113+deb13-amd64"],
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
    ["binaries", "pgcf-wal-fetch"],
    ["os", "package_lock"],
  ])
    expect(
      ReleaseManifestFields.safeParse(tweak(fields, path)).success,
      path.join("."),
    ).toBe(false);
});

it("the signer's route and the name of its secret are the contract's", () => {
  expect(RELEASE_SIGN_PATH).toBe("/sign");
  expect(RELEASE_SIGNING_SECRET).toBe("RELEASE_SIGNING_KEY");
});
