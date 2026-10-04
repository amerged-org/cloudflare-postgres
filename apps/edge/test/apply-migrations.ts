// SPDX-License-Identifier: Apache-2.0
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";

const testEnv = env as typeof env & {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};
beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});
