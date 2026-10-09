// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import versions from "../../infra/platform/versions.lock.json" with { type: "json" };
import {
  imageProfile,
  isRustProfile,
  nativeArtifactPins,
  nodeBase,
  postgresBase,
  rustBuilder,
  rustVersion,
  selectOwnedFiles,
  storageBase,
  validateNativeProvenance,
  verifyNativeArtifacts,
} from "./image-profiles.ts";

const files = (...paths: string[]) =>
  paths.map((path, index) => ({ path, layer: 0, tarEntry: index }));
const regional = files(
  "app/agent.mjs",
  "app/gateway.mjs",
  "app/bootstrap-relay.mjs",
  "app/package.json",
  "app/LICENSE",
);
const bootstrap = files(
  "app/server.mjs",
  "app/proxy-command.mjs",
  "app/inspection-proxy-command.mjs",
  "app/outside-scan-command.mjs",
  "app/proof-proxy-command.mjs",
  "app/package.json",
  "app/LICENSE",
  "app/assets/cilium-values.yaml",
);

test("profile parsing rejects unknown modes and retains immutable upstream build inputs", () => {
  assert.equal(imageProfile(), "regional");
  assert.equal(imageProfile("sandbox-extension"), "sandbox-extension");
  assert.throws(() => imageProfile("talos-installer"), /profile/i);
  assert.throws(() => imageProfile(null), /profile/i);
  assert.equal(isRustProfile("sandbox-extension"), true);
  assert.equal(isRustProfile("native-controller"), true);
  assert.equal(isRustProfile("node-bootstrap"), false);
  assert.equal(isRustProfile("talos-recipe"), false);
  assert.match(nodeBase, /^node:24\.21\.0-slim@sha256:[a-f0-9]{64}$/);
  assert.match(postgresBase, /@sha256:[a-f0-9]{64}$/);
  assert.match(storageBase, /@sha256:[a-f0-9]{64}$/);
  assert.equal(rustBuilder, versions.nativeRuntime.testBuilderImage);
  assert.equal(rustVersion, versions.nativeRuntime.rustVersion);
});

test("regional scanning includes new owned app files while excluding upstream dependencies and notices", () => {
  const owned = [
    ...regional,
    ...files(
      "app/chunks/new-bundle.mjs",
      "app/config/runtime.json",
      "app/node_modules-metadata.json",
      "app/licenses-generated.json",
      "app/assets/flux-install.yaml",
    ),
  ];
  const input = [
    ...owned,
    ...files(
      "usr/local/bin/node",
      "app/node_modules/.pnpm/pg@8.16.3/node_modules/pg/lib/client.js",
      "app/licenses/pg/LICENSE",
    ),
  ];
  assert.deepEqual(selectOwnedFiles(input, "regional"), owned);
  assert.throws(
    () =>
      selectOwnedFiles(
        input.filter((file) => file.path !== "app/agent.mjs"),
        "regional",
      ),
    /First-party image output missing/,
  );
});

test("bootstrap scanning excludes only exact copied upstream assets and retains authored values and unknown assets", () => {
  const cilium = versions.charts.find((chart) => chart.name === "cilium");
  assert.ok(cilium);
  const owned = [
    ...bootstrap,
    ...files(
      "app/assets/pgcf-extra.yaml",
      "app/assets/cilium-unexpected.tgz",
      "app/assets/flux-install.yaml.sha256",
      "app/new-helper.mjs",
    ),
  ];
  const input = [
    ...owned,
    ...files(
      `app/assets/cilium-${cilium.chartVersion}.tgz`,
      "app/assets/flux-install.yaml",
      "app/licenses/talos/LICENSE",
      "app/node_modules/yaml/package.json",
      "usr/local/bin/talosctl",
      "usr/local/bin/kubectl",
      "usr/local/bin/helm",
    ),
  ];
  assert.deepEqual(selectOwnedFiles(input, "node-bootstrap"), owned);
  assert.throws(
    () =>
      selectOwnedFiles(
        input.filter((file) => file.path !== "app/assets/cilium-values.yaml"),
        "node-bootstrap",
      ),
    /First-party image output missing/,
  );
});

test("PostgreSQL scanning retains owned metadata even in flattened layer zero without selecting upstream binaries", () => {
  const owned = files(
    "usr/share/pgcf/postgres-sources.lock.json",
    "usr/share/pgcf/postgres-engine.sha256",
    "usr/share/pgcf/runtime-policy.json",
  );
  const input = [
    ...owned,
    ...files(
      "usr/lib/postgresql/18/bin/postgres",
      "usr/share/postgresql/18/postgresql.conf.sample",
      "usr/share/pgcf-other/upstream.json",
    ),
  ];
  assert.deepEqual(selectOwnedFiles(input, "postgres"), owned);
  assert.throws(
    () =>
      selectOwnedFiles(
        input.filter(
          (file) => file.path !== "usr/share/pgcf/postgres-engine.sha256",
        ),
        "postgres",
      ),
    /First-party image output missing/,
  );
});

test("storage scanning excludes the exact copied source archive and still selects other owned metadata", () => {
  const owned = files(
    "usr/share/pgcf/storage-sources.lock.json",
    "usr/share/pgcf/driver-policy.json",
    "usr/share/pgcf/thin-provisioning-tools-unexpected.tar.gz",
  );
  const input = [
    ...owned,
    ...files(
      "usr/share/pgcf/thin-provisioning-tools-1.1.0.tar.gz",
      "usr/local/bin/lvm-driver",
      "usr/sbin/pdata_tools",
      "usr/share/licenses/pgcf-thin-tools/COPYING",
    ),
  ];
  assert.deepEqual(selectOwnedFiles(input, "storage"), owned);
  assert.throws(
    () =>
      selectOwnedFiles(
        input.filter(
          (file) => file.path !== "usr/share/pgcf/storage-sources.lock.json",
        ),
        "storage",
      ),
    /First-party image output missing/,
  );
});

test("scratch runtime selection scans all outputs and requires its executable and first-party license", () => {
  const input = files(
    "pgcf-native-controller",
    "licenses/pgcf/LICENSE",
    "licenses/provenance/controller.generated.json",
    "unexpected-output",
  );
  assert.deepEqual(selectOwnedFiles(input, "native-controller"), input);
  assert.throws(
    () => selectOwnedFiles(input.slice(1), "native-controller"),
    /First-party image output missing/,
  );
  assert.throws(
    () =>
      selectOwnedFiles(
        input.filter((file) => file.path !== "licenses/pgcf/LICENSE"),
        "native-controller",
      ),
    /First-party image output missing/,
  );
});

test("sandbox extension selection keeps both binaries and its service and CRI configuration in scan scope", () => {
  const input = files(
    "rootfs/usr/local/bin/pgcf-sandbox-controller",
    "rootfs/usr/local/bin/pgcf-node-runtime",
    "rootfs/usr/local/share/licenses/pgcf-sandbox/pgcf/LICENSE",
    "manifest.yaml",
    "rootfs/usr/local/etc/containers/pgcf-sandbox-controller.yaml",
    "rootfs/etc/cri/conf.d/20-pgcf-prestarted.part",
    "rootfs/usr/local/share/pgcf/extra.json",
  );
  assert.deepEqual(selectOwnedFiles(input, "sandbox-extension"), input);
  assert.throws(
    () =>
      selectOwnedFiles(
        input.filter(
          (file) => file.path !== "rootfs/usr/local/bin/pgcf-node-runtime",
        ),
        "sandbox-extension",
      ),
    /First-party image output missing/,
  );
  assert.throws(
    () =>
      selectOwnedFiles(
        input.filter(
          (file) =>
            file.path !== "rootfs/etc/cri/conf.d/20-pgcf-prestarted.part",
        ),
        "sandbox-extension",
      ),
    /First-party image output missing/,
  );
});

test("recipe scanning covers the whole authored artifact and refuses a missing recipe", () => {
  const input = files(
    "manifest.yaml",
    "rootfs/usr/local/share/pgcf/talos-recipe.json",
    "rootfs/usr/local/share/licenses/pgcf-recipe/LICENSE",
    "extra-build-output.json",
  );
  assert.deepEqual(selectOwnedFiles(input, "talos-recipe"), input);
  assert.throws(
    () =>
      selectOwnedFiles(
        input.filter(
          (file) =>
            file.path !== "rootfs/usr/local/share/pgcf/talos-recipe.json",
        ),
        "talos-recipe",
      ),
    /First-party image output missing/,
  );
});

test("native clients retain checksum and size verification outside the scanner, including every duplicate copy", () => {
  const pins = nativeArtifactPins();
  assert.deepEqual(pins.map((pin) => pin.path).sort(), [
    "usr/local/bin/helm",
    "usr/local/bin/kubectl",
    "usr/local/bin/talosctl",
  ]);
  const talos = versions.bootstrapClients.talos.archives.find(
      (archive) => archive.architecture === "amd64",
    ),
    helm = versions.bootstrapClients.helm.archives.find(
      (archive) => archive.architecture === "amd64",
    );
  assert.ok(talos && helm);
  assert.deepEqual(
    pins.find((pin) => pin.name === "talosctl"),
    {
      path: "usr/local/bin/talosctl",
      name: "talosctl",
      version: versions.target.talosVersion,
      architecture: "linux/amd64",
      releaseUrl: talos.url,
      checksumUrl: new URL("sha256sum.txt", talos.url).href,
      sha256: talos.sha256,
      size: talos.binaryBytes,
    },
  );
  assert.equal(
    pins.find((pin) => pin.name === "helm")?.sha256,
    helm.binarySha256,
  );
  assert.notEqual(helm.binarySha256, helm.sha256);
  const input = pins.map(({ path, sha256, size }) => ({ path, sha256, size }));
  assert.deepEqual(verifyNativeArtifacts(input, "node-bootstrap"), pins);
  assert.deepEqual(
    verifyNativeArtifacts([...input, { ...input[0]! }], "node-bootstrap"),
    pins,
  );
  assert.throws(() => verifyNativeArtifacts(input.slice(1), "node-bootstrap"));
  assert.throws(() =>
    verifyNativeArtifacts(
      [...input, { ...input[0]!, sha256: "0".repeat(64) }],
      "node-bootstrap",
    ),
  );
  assert.throws(() =>
    verifyNativeArtifacts(
      [{ ...input[0]!, size: input[0]!.size + 1 }, ...input.slice(1)],
      "node-bootstrap",
    ),
  );
});

test("native provenance validation rejects duplicate, omitted or altered release evidence", () => {
  const pins = nativeArtifactPins();
  assert.doesNotThrow(() => validateNativeProvenance(pins, "node-bootstrap"));
  assert.throws(() =>
    validateNativeProvenance([...pins, pins[0]!], "node-bootstrap"),
  );
  assert.throws(() =>
    validateNativeProvenance(pins.slice(1), "node-bootstrap"),
  );
  assert.throws(() =>
    validateNativeProvenance(
      [
        { ...pins[0]!, releaseUrl: "https://example.invalid/release" },
        ...pins.slice(1),
      ],
      "node-bootstrap",
    ),
  );
});
