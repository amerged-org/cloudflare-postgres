// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFleetLegacyStorage } from "../src/fleet-legacy-storage.ts";
import { patchFixture } from "./fleet-patch.fixture.ts";
import { legacyStorageFixture } from "./fleet-legacy-storage.fixture.ts";
function retained() {
  const { input } = patchFixture();
  return { input, ...legacyStorageFixture(input) };
}
test("only the CF-scoped retained thick cohort receives freshly proved exact physical/storage identities", async () => {
  const f = retained();
  assert.deepEqual(await readFleetLegacyStorage(f.input, f.kube), [f.expected]);
  f.pv.metadata.uid = randomUUID();
  await assert.rejects(
    readFleetLegacyStorage(f.input, f.kube),
    /patch_legacy_storage_volume_changed/,
  );
  const changed = retained();
  changed.input.retained_thick_storage![0]!.node_uid = randomUUID();
  await assert.rejects(
    readFleetLegacyStorage(changed.input, changed.kube),
    /patch_legacy_storage_assignment_changed/,
  );
  const forged = retained();
  forged.fence.data["power.json"] = JSON.stringify({
    anchor: { ...forged.expected, physicalGeneration: 2 },
  });
  await assert.rejects(
    readFleetLegacyStorage(forged.input, forged.kube),
    /patch_legacy_storage_anchor_changed/,
  );
});
