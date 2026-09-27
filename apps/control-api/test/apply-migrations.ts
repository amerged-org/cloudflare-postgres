import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll } from "vitest";

const testEnv = env as typeof env & {
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);
});
