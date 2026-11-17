// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { validateExtensionObservation } from "../src/extension-acceptance.ts";

const extensions = [
  ["btree_gist", "1.8", "extensions"],
  ["citext", "1.6", "extensions"],
  ["ltree", "1.3", "extensions"],
  ["pg_trgm", "1.6", "extensions"],
  ["pgcrypto", "1.4", "extensions"],
  ["unaccent", "1.1", "extensions"],
];

function observation() {
  return {
    results: [
      { rows: [["180007", "t"]] },
      { rows: extensions.map((row) => [...row]) },
      {
        rows: [
          [
            "1",
            "Garcia",
            "shop.hardware.drills",
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
          ],
        ],
      },
      { rows: [] },
      {
        rows: [
          ["Bitmap Heap Scan on products"],
          ["  -> Bitmap Index Scan on product_name_trgm"],
        ],
      },
    ],
  };
}

test("accepts a patched restricted database owner, all fixture results and the GIN query plan", () => {
  assert.deepEqual(validateExtensionObservation(observation()), {
    serverVersion: 180007,
    versions: extensions.map((row) => row[1]),
  });
  const oldServer = observation();
  oldServer.results[0]!.rows = [["180006", "t"]];
  assert.throws(
    () => validateExtensionObservation(oldServer),
    /postgresql_release_or_owner/,
  );
  const wrongSchema = observation();
  wrongSchema.results[1]!.rows[0]![2] = "public";
  assert.throws(
    () => validateExtensionObservation(wrongSchema),
    /extension_catalog/,
  );
  const noIndex = observation();
  noIndex.results[4]!.rows = [["Seq Scan on products"]];
  assert.throws(
    () => validateExtensionObservation(noIndex),
    /trigram_index_plan/,
  );
});
