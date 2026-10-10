// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  assertSameCarrier,
  selectVerifiedCiliumPod,
  snapshotFileLimit,
} from "../src/talos-operator.ts";

test("a live Cilium index representation resolves to the approved AMD64 child while retaining exact carrier identities", async () => {
  const child = "c".repeat(64),
    index = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          digest: `sha256:${child}`,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          size: 100,
          platform: { os: "linux", architecture: "amd64" },
        },
      ],
    }),
    parent = createHash("sha256").update(index).digest("hex"),
    reference = `quay.io/cilium/cilium:v1.20.2@sha256:${child}`,
    configured = `quay.io/cilium/cilium:v1.20.2@sha256:${parent}`,
    runtime = `quay.io/cilium/cilium@sha256:${parent}`,
    node = {
      nodeName: "node",
      address: "192.0.2.1",
      systemUuid: "system",
      bootId: "boot",
    },
    daemon = {
      metadata: {
        name: "cilium",
        namespace: "kube-system",
        uid: "11111111-1111-4111-8111-111111111111",
      },
      spec: {
        template: {
          spec: {
            hostNetwork: true,
            containers: [{ name: "cilium-agent", image: configured }],
          },
        },
      },
    },
    pod = {
      metadata: {
        name: "cilium-pod",
        namespace: "kube-system",
        uid: "22222222-2222-4222-8222-222222222222",
        labels: { "k8s-app": "cilium" },
        ownerReferences: [
          {
            name: "cilium",
            kind: "DaemonSet",
            controller: true,
            uid: daemon.metadata.uid,
          },
        ],
      },
      spec: {
        nodeName: "node",
        hostNetwork: true,
        containers: [{ name: "cilium-agent", image: configured }],
      },
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: "True" }],
        containerStatuses: [
          {
            name: "cilium-agent",
            ready: true,
            imageID: runtime,
            state: { running: {} },
          },
        ],
      },
    },
    options = {
      architecture: "amd64",
      operatingSystem: "linux",
      request: (async () =>
        new Response(index, {
          headers: {
            "content-type": "application/vnd.oci.image.index.v1+json",
            "docker-content-digest": `sha256:${parent}`,
          },
        })) as typeof fetch,
    };
  const selected = await selectVerifiedCiliumPod(
    { items: [pod] },
    daemon,
    node,
    reference,
    runtime,
    options,
  );
  assert.equal(selected.image, configured);
  assert.equal(selected.imageID, runtime);
  assert.equal(selected.uid, pod.metadata.uid);
  assert.equal(selected.ownerUid, daemon.metadata.uid);
  const changedDaemon = structuredClone(daemon),
    changedPod = structuredClone(pod);
  changedDaemon.spec.template.spec.containers[0]!.image = reference;
  changedPod.spec.containers[0]!.image = reference;
  const changed = await selectVerifiedCiliumPod(
    { items: [changedPod] },
    changedDaemon,
    node,
    reference,
    runtime,
    options,
  );
  assert.throws(
    () => assertSameCarrier(selected, changed),
    /operator_carrier_changed/,
  );
  await assert.rejects(
    selectVerifiedCiliumPod(
      { items: [pod] },
      daemon,
      node,
      reference,
      runtime,
      { ...options, architecture: "arm64" },
    ),
    /operator_cilium_architecture_mismatch/,
  );
});

test("the actual snapshot child has a kernel file limit before writing its private snapshot", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pgcf-snapshot-limit-")),
    file = join(directory, "snapshot");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = snapshotFileLimit(
    process.execPath,
    [
      "--eval",
      `const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'wx',0o600);for(let i=0;i<1000;i++)fs.writeSync(fd,Buffer.alloc(1024));`,
      file,
    ],
    16 * 1024,
  );
  const child = spawn(command.program, command.args, {
    stdio: "ignore",
    cwd: directory,
  });
  const code = await new Promise<number | null>((resolve) =>
    child.once("close", resolve),
  );
  assert.notEqual(code, 0);
  const snapshot = await stat(file);
  assert.ok(snapshot.size > 0 && snapshot.size <= 16 * 1024);
  assert.equal(snapshot.mode & 0o777, 0o600);
  assert.throws(
    () => snapshotFileLimit(process.execPath, [], NaN),
    /snapshot_limit_invalid/,
  );
});

test("the extracted operator bundles with the actual Bootstrap banner without duplicate module bindings", async () => {
  const metadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: { build: string } };
  const banner = /--banner:js="([^"]+)"/.exec(metadata.scripts.build)?.[1];
  assert.ok(banner);
  const result = await build({
    entryPoints: [
      fileURLToPath(
        new URL("../src/infrastructure-backup.ts", import.meta.url),
      ),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["ws"],
    banner: { js: banner },
    write: false,
    logLevel: "silent",
  });
  const checked = spawnSync(
    process.execPath,
    ["--check", "--input-type=module"],
    {
      input: result.outputFiles[0]!.text,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  assert.equal(checked.status, 0, checked.stderr);
});
