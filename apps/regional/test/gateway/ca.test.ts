// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { newDatabaseId } from "@pgcf/contracts";
import { serializeRouteKeyring } from "@pgcf/contracts/route-token";
import { DatabaseCaCache } from "../../src/gateway/ca.ts";
import { readGatewayConfiguration } from "../../src/gateway/config.ts";
import { database, derived, region, validCertificate } from "./helpers.ts";

test("reads only the database CA ConfigMap in the system namespace, caches, refreshes and bounds storage", async () => {
  const reads: string[] = [];
  let now = 0;
  const cache = new DatabaseCaCache(
    async (name, namespace) => {
      reads.push(`${namespace}/${name}`);
      return validCertificate.cert;
    },
    { now: () => now, maximum: 1 },
  );
  assert.equal(await cache.get(database), validCertificate.cert);
  await cache.get(database);
  assert.deepEqual(reads, [`pgcf-system/ca-${database}`]);
  now = 300_000;
  await cache.get(database);
  await cache.get(database, true);
  assert.equal(reads.length, 3);
  await cache.get(newDatabaseId());
  assert.equal(cache.size, 1);
  await assert.rejects(cache.get("../invalid"), /invalid database ID/);
});

test("shares concurrent CA reads and never caches malformed certificates", async () => {
  let reads = 0;
  const cache = new DatabaseCaCache(async () => {
    reads++;
    return validCertificate.cert;
  });
  const results = await Promise.all([
    cache.get(database),
    cache.get(database),
    cache.get(database),
  ]);
  assert.equal(reads, 1);
  assert.deepEqual(results, Array(3).fill(validCertificate.cert));
  const invalid = new DatabaseCaCache(async () => "invalid");
  await assert.rejects(invalid.get(database), /invalid database CA/);
  assert.equal(invalid.size, 0);
});

test("loads the deployed derived region keyring variable and validates configuration", () => {
  const configured = readGatewayConfiguration({
    PGCF_REGION_ID: region,
    PGCF_ROUTE_KEY: serializeRouteKeyring(derived),
    PGCF_GATEWAY_PORT: "8080",
  });
  assert.equal(configured.region, region);
  assert.equal(configured.port, 8080);
  assert.deepEqual(configured.keyring.keys, derived.keys);
  assert.throws(() => readGatewayConfiguration({}), /PGCF_REGION_ID/);
  assert.throws(
    () => readGatewayConfiguration({ PGCF_REGION_ID: region }),
    /PGCF_ROUTE_KEY/,
  );
  assert.throws(
    () =>
      readGatewayConfiguration({
        PGCF_REGION_ID: region,
        PGCF_ROUTE_KEY: serializeRouteKeyring(derived),
        PGCF_GATEWAY_PORT: "0",
      }),
    /PGCF_GATEWAY_PORT/,
  );
});
