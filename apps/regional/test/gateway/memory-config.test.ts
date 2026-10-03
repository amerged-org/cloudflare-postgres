// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeRouteKeyring } from "@pgcf/contracts/route-token";
import { readGatewayConfiguration } from "../../src/gateway/config.ts";
import {
  DEFAULT_DATABASE_MEMORY_LIMIT_BYTES,
  DEFAULT_MEMORY_LIMIT_BYTES,
} from "../../src/gateway/frame-budget.ts";
import { derived, region } from "./helpers.ts";

test("gateway memory limits have bounded defaults and explicit validated installation overrides", () => {
  const env = {
    PGCF_REGION_ID: region,
    PGCF_ROUTE_KEY: serializeRouteKeyring(derived),
  };
  const defaults = readGatewayConfiguration(env);
  assert.equal(defaults.memoryLimitBytes, DEFAULT_MEMORY_LIMIT_BYTES);
  assert.equal(
    defaults.databaseMemoryLimitBytes,
    DEFAULT_DATABASE_MEMORY_LIMIT_BYTES,
  );
  const configured = readGatewayConfiguration({
    ...env,
    PGCF_GATEWAY_MEMORY_BYTES: "1048576",
    PGCF_GATEWAY_DATABASE_MEMORY_BYTES: "524288",
  });
  assert.equal(configured.memoryLimitBytes, 1048576);
  assert.equal(configured.databaseMemoryLimitBytes, 524288);
  assert.throws(
    () => readGatewayConfiguration({ ...env, PGCF_GATEWAY_MEMORY_BYTES: "-1" }),
    /PGCF_GATEWAY_MEMORY_BYTES/,
  );
  assert.throws(
    () =>
      readGatewayConfiguration({
        ...env,
        PGCF_GATEWAY_DATABASE_MEMORY_BYTES: "1.5",
      }),
    /PGCF_GATEWAY_DATABASE_MEMORY_BYTES/,
  );
  assert.throws(
    () =>
      readGatewayConfiguration({
        ...env,
        PGCF_GATEWAY_MEMORY_BYTES: "9007199254740992",
      }),
    /safe integer/,
  );
  assert.throws(
    () =>
      readGatewayConfiguration({
        ...env,
        PGCF_GATEWAY_DATABASE_MEMORY_BYTES: String(
          DEFAULT_MEMORY_LIMIT_BYTES + 1,
        ),
      }),
    /must not exceed/,
  );
});
