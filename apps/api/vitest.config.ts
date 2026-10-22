// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        // The key CI's signer holds has no private half to sign test releases with: the tests
        // verify with a key of their own (test/release-key.ts), at the same import.
        find: /^@pgcf\/contracts\/release-key$/,
        replacement: join(import.meta.dirname, "test/release-key.ts"),
      },
    ],
  },
  plugins: [
    cloudflareTest(async () => ({
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          API_KEY_PEPPER: randomBytes(32).toString("base64url"),
          BOOTSTRAP_TOKEN: randomUUID(),
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
