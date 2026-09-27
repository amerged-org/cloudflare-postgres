import * as path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          INSTALLATION_BOOTSTRAP_TOKEN: "test-installation-token",
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(import.meta.dirname, "migrations"),
          ),
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    include: ["test/**/*.test.ts"],
  },
});
