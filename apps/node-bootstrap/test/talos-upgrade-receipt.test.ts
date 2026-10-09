// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { patchFixture } from "./fleet-patch.fixture.ts";
import { readTalosLifecycleCompletion } from "../src/talos-upgrade-receipt.ts";

test("actual Talos machined console framing requires lifecycle service, exact installer and successful completion", () => {
  const { input, facts } = patchFixture();
  input.status.observed = facts;
  const now = Date.now(),
    timestamp = new Date(now).toISOString(),
    installer = input.spec.roles.customer.talos_installer;
  const line = (msg: string, fields: object) =>
    `${input.address}: ${timestamp} \u001b[34mINFO\u001b[0m ${msg} ${JSON.stringify(fields)}`;
  const start = line("starting upgrade", {
    component: "machined",
    service: "lifecycle",
    installer_image: installer,
  });
  const end = line("upgrade completed", {
    component: "machined",
    service: "lifecycle",
    exit_code: 0,
  });
  assert.equal(
    readTalosLifecycleCompletion(start + "\n" + end, input, facts, now)?.source,
    "lifecycle_log_exit_0",
  );
  for (const text of [
    end,
    start + "\n" + end.replace('"lifecycle"', '"other"'),
    start + "\n" + end.replace('"exit_code":0', '"exit_code":1'),
    start.replace(installer, "other@sha256:" + "a".repeat(64)) + "\n" + end,
    start +
      "\n" +
      end +
      "\n" +
      line("starting upgrade", {
        service: "lifecycle",
        installer_image: "other",
      }),
  ])
    assert.equal(readTalosLifecycleCompletion(text, input, facts, now), null);
  assert.equal(
    readTalosLifecycleCompletion(
      start + "\n" + end,
      input,
      { ...facts, boot_id: crypto.randomUUID() },
      now,
    ),
    null,
  );
});
