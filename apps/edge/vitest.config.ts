// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
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
          ROUTE_MASTER_KEYS: JSON.stringify({
            active: "v1",
            keys: {
              v1: randomBytes(32).toString("base64url"),
            },
          }),
          TEST_MIGRATIONS: await readD1Migrations(
            join(import.meta.dirname, "../api/migrations"),
          ),
        },
        serviceBindings: { GATEWAY: "test-gateway" },
        outboundService: "test-gateway",
        ratelimits: {
          TEST_RATE_LIMITER: {
            namespace_id: "2",
            simple: { limit: 1, period: 60 },
          },
        },
        workers: [
          {
            name: "test-gateway",
            modules: true,
            scriptPath: join(import.meta.dirname, "test/gateway-fixture.js"),
            compatibilityDate: "2026-10-02",
          },
        ],
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
