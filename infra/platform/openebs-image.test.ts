// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openEbsCgroupPostRenderers,
  openEbsDriverImage,
  openEbsDriverValues,
  selectedOpenEbsDriverImage,
} from "./openebs-image.ts";

test("the cgroup postrenderer patches Helm output before its release namespace is assigned", async () => {
  const client = process.env.PGCF_TEST_KUBECTL;
  assert.ok(client, "the locked kubectl test client is required");
  const dir = await mkdtemp(join(tmpdir(), "pgcf-openebs-render-"));
  try {
    // The pinned chart's lvm-node template omits metadata.namespace. Helm assigns
    // the target namespace after postrendering, so a namespace selector cannot match.
    await writeFile(join(dir, "daemonset.json"), JSON.stringify({
      apiVersion: "apps/v1", kind: "DaemonSet",
      metadata: { name: "openebs-lvm-localpv-node" },
      spec: { template: { spec: { containers: [{
        name: "openebs-lvm-plugin", image: "docker.io/openebs/lvm-driver:1.10.1",
        securityContext: { privileged: true },
      }] } } },
    }));
    await writeFile(join(dir, "kustomization.yaml"), JSON.stringify({
      apiVersion: "kustomize.config.k8s.io/v1beta1", kind: "Kustomization",
      resources: ["daemonset.json"],
      patches: openEbsCgroupPostRenderers()[0]!.kustomize.patches,
    }));
    const rendered = execFileSync(client, ["kustomize", dir], {
      encoding: "utf8", timeout: 30_000,
    });
    assert.match(rendered, /name: pgcf-host-cgroup/);
    assert.match(rendered, /mountPath: \/sys\/fs\/cgroup/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("selected driver references are authoritative despite a different repository basename", () => {
  const reference = `ghcr.io/amerged-org/pgcf-regional:lvm-thin-sha-${"a".repeat(40)}@sha256:${"b".repeat(64)}`;
  const chart = {
    name: "openebs",
    renderedImages: ["docker.io/openebs/lvm-driver:1.10.1"],
    enabledEngine: { driverImage: reference },
  };
  assert.equal(openEbsDriverImage({ charts: [chart] }), reference);
  assert.deepEqual(openEbsDriverValues(reference), {
    registry: "ghcr.io",
    repository: "amerged-org/pgcf-regional",
    tag: `lvm-thin-sha-${"a".repeat(40)}@sha256:${"b".repeat(64)}`,
  });
  assert.throws(() =>
    openEbsDriverImage({
      charts: [
        { ...chart, enabledEngine: { driverImage: "unqualified:latest" } },
      ],
    }),
  );
  const legacy = { charts: [{ ...chart, enabledEngine: {} }] };
  assert.equal(openEbsDriverImage(legacy), chart.renderedImages[0]);
  assert.equal(selectedOpenEbsDriverImage(legacy), undefined);
  assert.throws(() => openEbsDriverImage({ charts: [] }));
});
