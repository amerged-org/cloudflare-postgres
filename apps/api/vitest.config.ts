// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const reclaimPair = generateKeyPairSync("ed25519"),
  reclaimPrivate = reclaimPair.privateKey
    .export({ type: "pkcs8", format: "der" })
    .toString("base64url"),
  reclaimPublic = reclaimPair.publicKey
    .export({ type: "spki", format: "der" })
    .subarray(12)
    .toString("base64url");
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          API_KEY_PEPPER: randomBytes(32).toString("base64url"),
          BOOTSTRAP_TOKEN: randomUUID(),
          BOOTSTRAP_RELAY_SIGNING_KEYS: JSON.stringify({
            active: "test-cf",
            keys: { "test-cf": reclaimPrivate },
          }),
          BOOTSTRAP_VERIFIER_KEYS: JSON.stringify({ "test-cf": reclaimPublic }),
          CREDENTIAL_KEYS: JSON.stringify({
            active: "v1",
            keys: { v1: randomBytes(32).toString("base64url") },
          }),
          ROUTE_MASTER_KEYS: JSON.stringify({
            active: "v1",
            keys: { v1: randomBytes(32).toString("base64url") },
          }),
          TEST_MIGRATIONS: await readD1Migrations(
            join(import.meta.dirname, "migrations"),
          ),
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
    maxWorkers: 2,
  },
});
