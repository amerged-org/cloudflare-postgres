// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
