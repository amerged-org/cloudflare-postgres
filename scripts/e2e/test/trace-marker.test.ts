// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { isTraceMarker } from "../src/trace-marker.ts";

test("marker validation accepts only the two exact formats", () => {
  const entropy = randomBytes(24).toString("hex");
  const marker = `${entropy.slice(0, 16)}.${entropy.slice(16, 32)}.${entropy.slice(32)}`;
  assert.equal(isTraceMarker(marker), true);
  assert.equal(isTraceMarker(entropy), true);
  assert.equal(isTraceMarker(undefined), false);
  assert.equal(isTraceMarker({ toString: () => entropy }), false);
  assert.equal(isTraceMarker(marker.replaceAll(".", "-")), false);
  assert.equal(isTraceMarker(marker.replaceAll(".", "_")), false);
  assert.equal(isTraceMarker(marker.slice(1)), false);
  assert.equal(isTraceMarker(marker + "."), false);
  assert.equal(isTraceMarker(marker + "\n"), false);
  assert.equal(isTraceMarker(entropy + "\n"), false);
  assert.equal(isTraceMarker("A" + marker.slice(1)), false);
});
