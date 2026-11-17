// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  validateExtensionObservation,
  validateManagedExtensionObservation,
} from "../src/extension-acceptance.ts";

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

function managedObservation() {
  return {
    results: [
      { rows: [["180007", "t"]] },
      {
        rows: [
          [
            "pg_jsonschema",
            "0.3.4",
            "pgcf_extensions",
            "postgres",
            "postgres",
            "t",
            "f",
          ],
          [
            "postgis",
            "3.7.0",
            "pgcf_extensions",
            "postgres",
            "postgres",
            "t",
            "f",
          ],
        ],
      },
      { rows: [["1", "3", "f"]] },
      { rows: [] },
      { rows: [["Index Scan using managed_store_radius on managed_stores"]] },
    ],
  };
}

test("managed evidence requires agent-owned catalog entries, an indexed radius match and JSON type rejection", () => {
  assert.deepEqual(validateManagedExtensionObservation(managedObservation()), {
    serverVersion: 180007,
    versions: ["0.3.4", "3.7.0"],
  });
  const wrongOwner = managedObservation();
  wrongOwner.results[1]!.rows[0]![3] = "app";
  assert.throws(
    () => validateManagedExtensionObservation(wrongOwner),
    /managed_extension_catalog/,
  );
  const writableSchema = managedObservation();
  writableSchema.results[1]!.rows[0]![6] = "t";
  assert.throws(
    () => validateManagedExtensionObservation(writableSchema),
    /managed_extension_catalog/,
  );
  const wrongVersion = managedObservation();
  wrongVersion.results[1]!.rows[1]![1] = "3.6.1";
  assert.throws(
    () => validateManagedExtensionObservation(wrongVersion),
    /managed_extension_catalog/,
  );
  const acceptsWrongType = managedObservation();
  acceptsWrongType.results[2]!.rows[0]![2] = "t";
  assert.throws(
    () => validateManagedExtensionObservation(acceptsWrongType),
    /managed_extension_results/,
  );
  const noIndex = managedObservation();
  noIndex.results[4]!.rows = [["Seq Scan on managed_stores"]];
  assert.throws(
    () => validateManagedExtensionObservation(noIndex),
    /postgis_radius_index_plan/,
  );
});
