// SPDX-License-Identifier: Apache-2.0
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The tests run in workerd, the runtime the Worker is deployed to: its WebCrypto is what signs.
export default defineConfig({
  plugins: [
    cloudflareTest(() => ({
      remoteBindings: false,
      wrangler: { configPath: "./wrangler.jsonc" },
    })),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
