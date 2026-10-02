// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeAll } from "vitest";

const testEnv = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };

beforeAll(async () => {
  await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
});
