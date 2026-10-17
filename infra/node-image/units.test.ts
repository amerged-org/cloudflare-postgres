// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const units = new URL("mkosi.extra/usr/lib/systemd/system/", import.meta.url);

test("every slice is top-level: a dash in a slice name nests it inside the slice before the dash", () => {
  const slices = readdirSync(units).filter((name) => name.endsWith(".slice"));
  assert.ok(slices.length > 0, "the image carries slices");
  assert.deepEqual(
    slices.filter((name) => name.slice(0, -".slice".length).includes("-")),
    [],
    "barman-cloud jobs would run under the databases' memory ceiling",
  );
});

test("a database starts with its postgres process alone: the agent creates the socket directory", () => {
  const unit = readFileSync(new URL("pgcf-pg@.service", units), "utf8");
  assert.doesNotMatch(unit, /^ExecStart(Pre|Post)=/m, "every extra process adds to the wake");
});
