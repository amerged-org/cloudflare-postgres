// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import {
  DatabaseRegionRoute,
  DatabaseAdmission,
} from "../src/database-admission.ts";
import {
  ROUTE_TOKEN_HEADER,
  ROUTE_TOKEN_KEY_DOMAIN,
  ROUTE_TOKEN_SIGN_TTL_SECONDS,
  parseRouteKeyring,
  signRouteToken,
} from "../src/route-token.ts";
import {
  ADMISSION_DEADLINE_MS,
  connectionRateKey,
} from "../../../apps/edge/src/session-policy.ts";
import {
  DECOY_AUTH_MAX_BYTES,
  DECOY_DEADLINE_MS,
  DECOY_MAX_BYTES,
  DECOY_MAX_FRAMES,
  DECOY_SALT_DOMAIN,
  DECOY_SCRAM_ITERATIONS,
  decoySalt,
} from "../src/edge-policy.ts";

export function edgeContract() {
  return {
    constants: {
      ROUTE_TOKEN_SIGN_TTL_SECONDS,
      ADMISSION_DEADLINE_MS,
      DECOY_AUTH_MAX_BYTES,
      DECOY_DEADLINE_MS,
      DECOY_MAX_BYTES,
      DECOY_MAX_FRAMES,
      DECOY_SCRAM_ITERATIONS,
    },
    wire: {
      routeKeyDomain: ROUTE_TOKEN_KEY_DOMAIN,
      routeHeader: ROUTE_TOKEN_HEADER,
      decoySaltDomain: DECOY_SALT_DOMAIN,
    },
    gatewayRegion: z.toJSONSchema(DatabaseRegionRoute),
    databaseAdmission: z.toJSONSchema(DatabaseAdmission),
  };
}
export async function edgeVectors() {
  const ips = [
    null,
    "",
    "1",
    "192.0.2.1",
    "192.000.2.1",
    "256.0.0.1",
    "127.0.0.1",
    "::",
    "::1",
    "2001:DB8::1",
    "2001:db8:0:0:ffff:ffff:ffff:ffff",
    "2001:db8:0:1::1",
    "::ffff:192.0.2.128",
    "::ffff:192.000.2.1",
    "2001::db8::1",
    "1:2:3:4:5:6:7:8",
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:192.0.2.1",
    "[::1]",
    "fe80::1%eth0",
    " 192.0.2.1",
    "2001:db8::1 ",
    "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
    "f".repeat(46),
  ];
  const keyring = parseRouteKeyring(
    JSON.stringify({
      active: "fixture",
      keys: { fixture: Buffer.alloc(32, 7).toString("base64url") },
    }),
  );
  const signing = [];
  for (const input of [
    {
      region: "eu-test",
      db: "a".repeat(20),
      user: "app",
      cid: "01234567-89ab-4def-8123-0123456789ab",
      now: 1000000,
      ttlSeconds: 30,
    },
    {
      region: "us-test",
      db: "b".repeat(20),
      user: "another",
      cid: "01234567-89ab-4def-8123-0123456789ac",
      now: 1000999,
      ttlSeconds: 1,
    },
  ])
    signing.push({
      ...input,
      active: keyring.active,
      key: [...keyring.keys.get(keyring.active)!],
      expected: await signRouteToken({ keyring, ...input }),
    });
  return {
    ips: ips.map((ip) => ({ ip, expected: connectionRateKey(ip) })),
    signing,
    salts: await Promise.all(
      signing.map(async (row) => ({
        database: row.db,
        user: row.user,
        active: keyring.active,
        key: [...keyring.keys.get(keyring.active)!],
        expected: await decoySalt(
          JSON.stringify({
            active: keyring.active,
            keys: {
              [keyring.active]: Buffer.from(
                keyring.keys.get(keyring.active)!,
              ).toString("base64url"),
            },
          }),
          row.db,
          row.user,
        ),
      })),
    ),
  };
}
