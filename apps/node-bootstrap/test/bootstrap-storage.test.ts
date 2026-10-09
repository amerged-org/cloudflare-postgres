// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./fixture.ts";
import { bootstrapStorageDocuments } from "../src/bootstrap.ts";
import { NodeBootstrapSpec } from "@pgcf/contracts/node-bootstrap";
test("future sealed thin installation loads the supported signed kernel module while preserving original disk and LVM geometry", () => {
  const original = fixture().spec,
    legacy = bootstrapStorageDocuments(original),
    future = NodeBootstrapSpec.parse({
      ...original,
      postjoin_release: {
        version: 1,
        release_id: "test-common",
        spec_sha256: "a".repeat(64),
        region_revision: 1,
        recipe_sha256: "b".repeat(64),
        pool_template_sha256: "c".repeat(64),
        storage_template_sha256: "d".repeat(64),
      },
    }),
    documents = bootstrapStorageDocuments(future);
  assert.deepEqual(documents.slice(0, legacy.length), legacy);
  assert.deepEqual(documents.slice(legacy.length), [
    {
      apiVersion: "v1alpha1",
      kind: "KernelModuleConfig",
      name: "dm_thin_pool",
    },
  ]);
  assert(!legacy.some((value) => value.kind === "KernelModuleConfig"));
  assert.deepEqual(future.hardware, original.hardware);
  assert.deepEqual(future.image, original.image);
});
