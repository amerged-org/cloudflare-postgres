// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.ts";
import { readNodeAddition } from "../../src/domain/node-state.ts";
import type { Env } from "../../src/env.ts";
import { ContaboClient } from "../../src/providers/contabo.ts";
import { cleanupFixtures } from "./fixtures.ts";
import {
  auditedRescueConfiguration,
  generateRescueHostIdentity,
} from "./rescue-fixtures.ts";

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
});
async function configure(
  f: Awaited<ReturnType<typeof auditedRescueConfiguration>>,
  bindings: Env,
) {
  const context = createExecutionContext();
  const response = await createApp().fetch(
    new Request(
      `https://api.invalid/v1/nodes/additions/${f.addition.intent.operation_id}/bootstrap`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.fixture.admin}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(f.body),
      },
    ),
    bindings,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}
describe("private rescue identity at the bootstrap endpoint", () => {
  it("rejects a configured host identity mismatch before provider access or sealing", async () => {
    const f = await auditedRescueConfiguration(),
      configured = await generateRescueHostIdentity(),
      provider = vi
        .spyOn(ContaboClient.prototype, "getInstance")
        .mockRejectedValue(new Error("unexpected_provider_request")),
      seal = vi.spyOn(crypto.subtle, "encrypt");
    const response = await configure(f, {
      ...env,
      CONTABO_RESCUE_CONFIGURATION: JSON.stringify({
        [f.providerId]: {
          ssh_host_key: configured.ssh_host_key,
          ssh_host_fingerprint: configured.ssh_host_fingerprint,
          user_data: "#cloud-config\n",
        },
      }),
    } as Env);
    expect(response.status).toBe(409);
    expect(provider).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
    const error = (await response.json()) as {
      error: { code: string; details?: unknown };
    };
    expect(error.error.code).toBe("conflict");
    expect(error.error.details).toBeUndefined();
    expect(
      await env.DB.prepare(
        "SELECT 1 present FROM node_bootstrap_jobs WHERE operation_id=?",
      )
        .bind(f.addition.intent.operation_id)
        .first(),
    ).toBeNull();
    expect(
      (await readNodeAddition(env.DB, f.addition.intent.operation_id)).revision,
    ).toBe(f.addition.revision);
  });

  it("rejects rescue material that differs while the configured spec fingerprint matches", async () => {
    const f = await auditedRescueConfiguration(),
      configured = f.body.rescue;
    f.body.rescue = await generateRescueHostIdentity();
    const provider = vi
        .spyOn(ContaboClient.prototype, "getInstance")
        .mockRejectedValue(new Error("unexpected_provider_request")),
      seal = vi.spyOn(crypto.subtle, "encrypt");
    const response = await configure(f, {
      ...env,
      CONTABO_RESCUE_CONFIGURATION: JSON.stringify({
        [f.providerId]: {
          ssh_host_key: configured.ssh_host_key,
          ssh_host_fingerprint: configured.ssh_host_fingerprint,
          user_data: "#cloud-config\n",
        },
      }),
    } as Env);
    expect(response.status).toBe(409);
    expect(provider).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT 1 present FROM node_bootstrap_jobs WHERE operation_id=?",
      )
        .bind(f.addition.intent.operation_id)
        .first(),
    ).toBeNull();
  });
});
