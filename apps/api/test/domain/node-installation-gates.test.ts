// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { bytesToBase64url, bytesToHex } from "@pgcf/contracts";
import {
  NodeBootstrapAuthority,
  NodeBootstrapCheckpoint,
} from "@pgcf/contracts/node-bootstrap";
import { createApp } from "../../src/app.ts";
import {
  bootstrapJobInput,
  configureBootstrapJob,
  readBootstrapJob,
} from "../../src/domain/bootstrap-jobs.ts";
import {
  canonicalNodePreparationProof,
  NODE_PREPARATION_SIGNATURE_DOMAIN,
  nodePreparationProofSchema,
} from "../../src/domain/node-network.ts";
import type { Env } from "../../src/env.ts";
import { cleanupFixtures } from "./fixtures.ts";
import { auditedRescueConfiguration } from "./rescue-fixtures.ts";

const artifacts: string[] = [];
afterEach(async () => {
  for (const key of artifacts.splice(0)) await env.ARCHIVE.delete(key);
  await cleanupFixtures();
});
const canonical = (value: unknown): string =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
          )
          .join(",")}}`;
const digest = async (value: unknown) =>
  bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical(value)),
      ),
    ),
  );
async function sealedRescueJob() {
  const f = await auditedRescueConfiguration(),
    bindings = {
      ...env,
      NODE_BOOTSTRAP_CALLBACK_URL: "https://api.invalid/",
    } as Env;
  await configureBootstrapJob(bindings, f.addition.intent.operation_id, f.body);
  const configured = await readBootstrapJob(
      env.DB,
      f.addition.intent.operation_id,
    ),
    checkpoint = NodeBootstrapCheckpoint.parse({
      ...JSON.parse(configured.checkpoint_json),
      stage: "image_verified",
      downloaded_bytes: f.body.spec.image.compressed_bytes,
    });
  await env.DB.prepare(
    "UPDATE node_bootstrap_jobs SET rescue_active=1,checkpoint_json=? WHERE operation_id=?",
  )
    .bind(JSON.stringify(checkpoint), configured.operation_id)
    .run();
  const job = await readBootstrapJob(env.DB, configured.operation_id),
    input = await bootstrapJobInput(bindings, job),
    identity = {
      version: 1,
      operation_id: job.operation_id,
      node_id: job.node_id,
      region_id: job.region_id,
      input_hash: job.input_hash,
      request_id: crypto.randomUUID(),
    };
  return { ...f, bindings, job, input, identity, checkpoint };
}
type Job = Awaited<ReturnType<typeof sealedRescueJob>>;
async function callback(f: Job, fields: Record<string, unknown>) {
  const context = createExecutionContext();
  const response = await createApp().fetch(
    new Request(f.input.callback.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${f.input.callback.bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...f.identity, ...fields }),
    }),
    f.bindings,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}
const diskWrite = (f: Job) => ({
  kind: "checkpoint",
  expected_revision: f.job.revision,
  payload: {
    ...f.checkpoint,
    stage: "disk_write_intent",
    write_intent_offset: 0,
    destructive_intent: true,
  },
});
async function expectBlocked(response: Response) {
  expect(response.status).toBe(403);
  const error = (await response.json()) as {
    error: { code: string; message: string; details?: unknown };
  };
  expect(error.error.code).toBe("forbidden");
  expect(error.error.message).toBe(
    "Verified network preparation is required for native installation",
  );
  expect(error.error.details).toBeUndefined();
}
async function expectJobPreserved(f: Job) {
  const persisted = await readBootstrapJob(env.DB, f.job.operation_id);
  expect(persisted.revision).toBe(f.job.revision);
  expect(persisted.rescue_active).toBe(1);
  expect(persisted.checkpoint_json === f.job.checkpoint_json).toBe(true);
  expect(persisted.input_ciphertext === f.job.input_ciphertext).toBe(true);
}
async function networkPreparation(
  f: Job,
  options: { status?: string; expired?: boolean; foreignIntent?: boolean } = {},
) {
  const now = Date.now(),
    observedAt = new Date(now - (options.expired ? 60000 : 100)).toISOString(),
    readbackAt = new Date(Date.parse(observedAt) - 100).toISOString(),
    expiresAt = new Date(now + (options.expired ? -1 : 60000)).toISOString(),
    intentHash = options.foreignIntent
      ? bytesToHex(crypto.getRandomValues(new Uint8Array(32)))
      : f.addition.intent_hash,
    firewallId = crypto.randomUUID(),
    relayId = String(BigInt(f.providerId) + 1n),
    rulesSha256 = await digest([]),
    plan = {
      version: 1,
      operation_id: f.job.operation_id,
      node_id: f.job.node_id,
      region_id: f.job.region_id,
      provider_instance_id: f.providerId,
      intent_hash: intentHash,
      operators: { ipv4: ["203.0.113.1/32"], ipv6: [] },
      relay: {
        provider_instance_id: relayId,
        addresses: { ipv4: ["192.0.2.2"], ipv6: [] },
      },
      scan_control: { ipv4: "203.0.113.2", ipv6: "2001:db8::2", port: 443 },
      members: [
        {
          node_id: f.job.node_id,
          provider_instance_id: f.providerId,
          firewall_id: firewallId,
          addresses: { ipv4: [f.body.spec.hardware.ipv4], ipv6: [] },
          primary: { ipv4: [f.body.spec.hardware.ipv4], ipv6: [] },
          ownership_sha256: await digest([
            crypto.randomUUID(),
            crypto.randomUUID(),
          ]),
          rules: { rules: { inbound: [] } },
          rules_sha256: rulesSha256,
        },
      ],
    },
    planSha256 = await digest(plan),
    payload = nodePreparationProofSchema.parse({
      version: 1,
      operation_id: f.job.operation_id,
      node_id: f.job.node_id,
      region_id: f.job.region_id,
      provider_instance_id: f.providerId,
      intent_hash: intentHash,
      plan_sha256: planSha256,
      observed_at: observedAt,
      expires_at: expiresAt,
      relay_provider_instance_id: relayId,
      access: [
        {
          provider_instance_id: f.providerId,
          address: f.body.spec.hardware.ipv4,
          relay_source: "192.0.2.2",
          observed_at: observedAt,
          checks: [
            { port: 22, outcome: "connected" },
            { port: 50000, outcome: "refused" },
            { port: 6443, outcome: "refused" },
          ],
        },
      ],
      firewalls: [
        {
          firewall_id: firewallId,
          provider_instance_id: f.providerId,
          rules_sha256: rulesSha256,
        },
      ],
      external: {
        ipv4: {
          source: "203.0.113.3",
          positive_control: {
            address: "203.0.113.2",
            port: 443,
            outcome: "connected",
            observed_at: observedAt,
          },
          scans: [
            {
              provider_instance_id: f.providerId,
              address: f.body.spec.hardware.ipv4,
              protocol: "tcp",
              first_port: 1,
              last_port: 65535,
              scanned_ports: 65535,
              open_ports: [],
              started_at: readbackAt,
              observed_at: observedAt,
            },
          ],
        },
        ipv6: null,
      },
    }),
    pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  if (!("privateKey" in pair)) throw new Error("test_key_pair_invalid");
  const publicKey = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(publicKey instanceof ArrayBuffer))
    throw new Error("test_key_export_invalid");
  f.bindings.BOOTSTRAP_VERIFIER_KEYS = JSON.stringify({
    fixture: bytesToBase64url(new Uint8Array(publicKey)),
  });
  const envelope = {
      kid: "fixture",
      payload,
      signature: bytesToBase64url(
        new Uint8Array(
          await crypto.subtle.sign(
            "Ed25519",
            pair.privateKey,
            new TextEncoder().encode(
              NODE_PREPARATION_SIGNATURE_DOMAIN +
                canonicalNodePreparationProof(payload),
            ),
          ),
        ),
      ),
    },
    key = `node-preparation/${f.job.operation_id}/proof.json`;
  await env.ARCHIVE.put(key, JSON.stringify(envelope));
  artifacts.push(key);
  await env.DB.prepare(
    "INSERT INTO node_network_preparations(operation_id,intent_hash,plan_sha256,plan_json,status,readback_at,proof_sha256,proof_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      f.job.operation_id,
      intentHash,
      planSha256,
      canonical(plan),
      options.status ?? "verified",
      readbackAt,
      await digest(envelope),
      expiresAt,
      readbackAt,
      new Date(now).toISOString(),
    )
    .run();
}
describe("verified network gate for native installation", () => {
  it("refuses direct Container start before Container availability when rescue is active without preparation", async () => {
    const f = await sealedRescueJob(),
      failure = await runInDurableObject(
        env.NODE_BOOTSTRAP.get(
          env.NODE_BOOTSTRAP.idFromName(f.job.operation_id),
        ),
        async (instance) => {
          try {
            await instance.start(f.job.operation_id);
            return null;
          } catch (error) {
            return error instanceof Error ? error.message : "unexpected_error";
          }
        },
      );
    expect(failure).toBe("bootstrap_network_preparation_required");
    await expectJobPreserved(f);
  });

  it("refuses authority, transport and disk-write intent without network preparation", async () => {
    const f = await sealedRescueJob();
    await expectBlocked(await callback(f, { kind: "read" }));
    await expectBlocked(
      await callback(f, {
        kind: "transport",
        payload: { capability: "rescue_ssh" },
      }),
    );
    await expectBlocked(await callback(f, diskWrite(f)));
    await expectJobPreserved(f);
  });

  it("does not treat firewall readback awaiting proof as installation authority", async () => {
    const f = await sealedRescueJob();
    await networkPreparation(f, { status: "awaiting_proof" });
    await expectBlocked(await callback(f, { kind: "read" }));
    await expectBlocked(
      await callback(f, {
        kind: "transport",
        payload: { capability: "rescue_ssh" },
      }),
    );
    await expectBlocked(await callback(f, diskWrite(f)));
    await expectJobPreserved(f);
  });

  it("refuses expired verified preparation before renewing transport or disk progress", async () => {
    const f = await sealedRescueJob();
    await networkPreparation(f, { expired: true });
    await expectBlocked(await callback(f, { kind: "read" }));
    await expectBlocked(
      await callback(f, {
        kind: "transport",
        payload: { capability: "rescue_ssh" },
      }),
    );
    await expectBlocked(await callback(f, diskWrite(f)));
    await expectJobPreserved(f);
  });

  it("refuses a current verified preparation bound to a different immutable intent", async () => {
    const f = await sealedRescueJob();
    await networkPreparation(f, { foreignIntent: true });
    await expectBlocked(await callback(f, { kind: "read" }));
    await expectBlocked(
      await callback(f, {
        kind: "transport",
        payload: { capability: "rescue_ssh" },
      }),
    );
    await expectBlocked(await callback(f, diskWrite(f)));
    await expectJobPreserved(f);
  });

  it("allows current bound proof to read authority without replacing input or checkpoint", async () => {
    const f = await sealedRescueJob();
    await networkPreparation(f);
    const response = await callback(f, { kind: "read" });
    expect(response.status).toBe(200);
    const authority = NodeBootstrapAuthority.parse(await response.json());
    expect(authority.input_hash).toBe(f.job.input_hash);
    expect(authority.rescue_active).toBe(true);
    expect(authority.checkpoint).toEqual(f.checkpoint);
    await expectJobPreserved(f);
    expect(
      JSON.stringify(
        await bootstrapJobInput(
          f.bindings,
          await readBootstrapJob(env.DB, f.job.operation_id),
        ),
      ) === JSON.stringify(f.input),
    ).toBe(true);
  });
});
