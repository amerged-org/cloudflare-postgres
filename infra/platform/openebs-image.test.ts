// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  openEbsDriverImage,
  openEbsDriverValues,
  selectedOpenEbsDriverImage,
} from "./openebs-image.ts";

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
