// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  bootstrapClientArchive,
  downloadBootstrapAssets,
  downloadBootstrapClients,
} from "../src/build-assets.ts";
import {
  BOOTSTRAP_CLIENTS,
  KUBERNETES_VERSION,
  PLATFORM_ARTIFACTS,
  TALOS_VERSION,
} from "../src/platform-artifacts.ts";
import { parse, parseAllDocuments } from "yaml";

test("bootstrap asset download rejects checksum changes and bounds streamed bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-assets-test-"));
  try {
    const wrongChecksum: typeof fetch = async (url) => {
      const response = new Response(new Uint8Array(1));
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    };
    await assert.rejects(
      downloadBootstrapAssets(directory, wrongChecksum),
      /bootstrap_asset_checksum_mismatch/,
    );
    let cancelled = false;
    const oversized: typeof fetch = async (url) => {
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2 * 1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
      Object.defineProperty(response, "url", { value: String(url) });
      return response;
    };
    await assert.rejects(
      downloadBootstrapAssets(directory, oversized),
      /bootstrap_asset_too_large/,
    );
    assert.equal(cancelled, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("every platform chart uses the reviewed immutable OCI source, including OpenEBS", async () => {
  const sources = parseAllDocuments(
    await readFile(
      new URL("../../../infra/platform/base/sources.yaml", import.meta.url),
      "utf8",
    ),
  ).map((document) => document.toJSON());
  const cilium = sources.find(
    (value) =>
      value.kind === "OCIRepository" && value.metadata.name === "cilium-chart",
  );
  assert.equal(PLATFORM_ARTIFACTS.cilium.oci_digest, cilium.spec.ref.digest);
  const lock = JSON.parse(
    await readFile(
      new URL("../../../infra/platform/versions.lock.json", import.meta.url),
      "utf8",
    ),
  );
  for (const chart of lock.charts) {
    const source = sources.find(
      (value) =>
        value.kind === "OCIRepository" &&
        value.metadata.name === `${chart.name}-chart`,
    );
    assert.ok(
      source,
      `${chart.name} must not follow a mutable HTTP chart index`,
    );
    assert.equal(source.spec.url, chart.source);
    assert.equal(source.spec.ref.digest, chart.ociManifestDigest);
    const release = parse(
      await readFile(
        new URL(
          `../../../infra/platform/base/releases/${chart.name}.yaml`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert.deepEqual(release.spec.chartRef, {
      kind: "OCIRepository",
      name: source.metadata.name,
      namespace: "flux-system",
    });
    assert.equal(release.spec.chart, undefined);
  }
});

test("Native regional readback pins the same cloudflared image as reviewed Kustomize and version lock", async () => {
  const kustomization = parse(
    await readFile(
      new URL(
        "../../../infra/platform/regional/kustomization.yaml",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const image = kustomization.images.find(
    (value: { name: string }) => value.name === "cloudflared",
  );
  const lock = JSON.parse(
    await readFile(
      new URL("../../../infra/platform/versions.lock.json", import.meta.url),
      "utf8",
    ),
  );
  const lockedImage = lock.regional.images.find(
    (value: { name: string }) => value.name === "cloudflared",
  );
  assert.equal(
    PLATFORM_ARTIFACTS.cloudflared.image,
    `${image.newName}@${image.digest}`,
  );
  assert.equal(
    PLATFORM_ARTIFACTS.cloudflared.image,
    `${lockedImage.reference}@${"manifestDigest" in lockedImage ? lockedImage.manifestDigest : lockedImage.indexDigest}`,
  );
});

test("deployed Helm values use the immutable workload images from the version lock", async () => {
  const lock = JSON.parse(
    await readFile(
      new URL("../../../infra/platform/versions.lock.json", import.meta.url),
      "utf8",
    ),
  );
  const paths: Record<string, Record<string, string[]>> = {
    cilium: {
      cilium: ["image"],
      "cilium-envoy": ["envoy", "image"],
      "operator-generic": ["operator", "image"],
    },
    openebs: {
      "lvm-driver": ["lvm-localpv", "lvmPlugin", "image"],
      "csi-node-driver-registrar": [
        "lvm-localpv",
        "lvmNode",
        "driverRegistrar",
        "image",
      ],
      "csi-provisioner": [
        "lvm-localpv",
        "lvmController",
        "provisioner",
        "image",
      ],
      "csi-resizer": ["lvm-localpv", "lvmController", "resizer", "image"],
      "csi-snapshotter": [
        "lvm-localpv",
        "lvmController",
        "snapshotter",
        "image",
      ],
      "snapshot-controller": [
        "lvm-localpv",
        "lvmController",
        "snapshotController",
        "image",
      ],
    },
    "cert-manager": {
      "cert-manager-controller": ["image"],
      "cert-manager-cainjector": ["cainjector", "image"],
      "cert-manager-webhook": ["webhook", "image"],
      "cert-manager-startupapicheck": ["startupapicheck", "image"],
    },
    "cloudnative-pg": { "cloudnative-pg": ["image"] },
    "plugin-barman-cloud": {
      "plugin-barman-cloud": ["image"],
      "plugin-barman-cloud-sidecar": ["sidecarImage"],
    },
  };
  for (const chart of lock.charts) {
    const values = parse(
      await readFile(
        new URL(
          `../../../infra/platform/base/values/${chart.name}.yaml`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    for (const reference of [
      ...chart.renderedImages,
      ...(chart.runtimeSidecarImage ? [chart.runtimeSidecarImage] : []),
    ] as string[]) {
      assert.match(
        reference,
        /@sha256:[0-9a-f]{64}$/,
        `${chart.name} has a mutable workload image`,
      );
      const tagged = reference.split("@")[0]!,
        leaf = tagged.split("/").at(-1)!.split(":")[0]!;
      const path = paths[chart.name]?.[leaf];
      assert.ok(path, `missing pinned chart value mapping for ${reference}`);
      const image = path.reduce((value, key) => value?.[key], values);
      assert.ok(image, `missing image override for ${reference}`);
      if (chart.name === "cilium") assert.equal(image.override, reference);
      else if (chart.name === "cert-manager") {
        assert.equal(
          image.repository,
          tagged.slice(0, tagged.lastIndexOf(":")),
        );
        assert.equal(image.tag, tagged.slice(tagged.lastIndexOf(":") + 1));
        assert.equal(image.digest, reference.split("@")[1]);
      } else {
        const registry =
          typeof image.registry === "string"
            ? image.registry.replace(/\/$/, "") + "/"
            : "";
        assert.equal(`${registry}${image.repository}:${image.tag}`, reference);
      }
    }
  }
  assert.deepEqual(
    Object.keys(lock.flux.images).sort(),
    [...lock.flux.components].sort(),
  );
  for (const reference of Object.values(lock.flux.images))
    assert.match(String(reference), /@sha256:[0-9a-f]{64}$/);
});

test("bootstrap client and platform downloads have a single version-lock authority", async () => {
  const lock = JSON.parse(
    await readFile(
      new URL("../../../infra/platform/versions.lock.json", import.meta.url),
      "utf8",
    ),
  );
  const dockerfile = await readFile(
    new URL("../Dockerfile", import.meta.url),
    "utf8",
  );
  assert.equal(BOOTSTRAP_CLIENTS.talos.version, lock.target.talosVersion);
  assert.equal(
    BOOTSTRAP_CLIENTS.kubectl.version,
    lock.target.kubernetesVersion,
  );
  assert.equal(TALOS_VERSION, lock.target.talosVersion);
  assert.equal(KUBERNETES_VERSION, lock.target.kubernetesVersion);
  for (const name of ["talos", "kubectl", "helm"])
    assert.deepEqual(
      lock.bootstrapClients[name].archives.map(
        (value: { architecture: string }) => value.architecture,
      ),
      ["amd64", "arm64"],
    );
  assert.ok(!dockerfile.includes("talos_sum="));
  assert.ok(!dockerfile.includes("kube_sum="));
  assert.ok(!dockerfile.includes("helm_sum="));
  assert.equal(
    PLATFORM_ARTIFACTS.cilium.url,
    lock.charts.find((value: { name: string }) => value.name === "cilium")
      .archiveURL,
  );
  assert.equal(
    PLATFORM_ARTIFACTS.cilium_values.sha256,
    lock.bootstrapValues.cilium.sha256,
  );
});

test("client download uses the locked architecture archive and rejects changed bytes before execution", async () => {
  assert.throws(
    () => bootstrapClientArchive("talos", "../amd64"),
    /bootstrap_client_architecture_invalid/,
  );
  const directory = await mkdtemp(join(tmpdir(), "pgcf-clients-test-"));
  try {
    let requested: string | undefined;
    const changed: typeof fetch = async (url) => {
      requested = String(url);
      const response = new Response(new Uint8Array([1]));
      Object.defineProperty(response, "url", { value: requested });
      return response;
    };
    await assert.rejects(
      downloadBootstrapClients(directory, "arm64", changed),
      /bootstrap_asset_checksum_mismatch/,
    );
    assert.equal(requested, bootstrapClientArchive("talos", "arm64").url);
    await assert.rejects(readFile(join(directory, "talosctl")), {
      code: "ENOENT",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
