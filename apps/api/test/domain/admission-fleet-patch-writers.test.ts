// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { DatabaseWithOperation } from "@pgcf/contracts";
import { thinExecutionFixture } from "./thin-execution-fixture.ts";
import { identityProof, gib } from "./thin-proof-fixture.ts";
import { cleanupFixtures, request } from "./fixtures.ts";
import { withAdmissionMutation } from "../../src/domain/admission-mutations.ts";
import { prepareNodeHostConfiguration } from "../../src/domain/node-host-configuration.ts";
import type { Env } from "../../src/env.ts";
import { auditedRescueConfiguration } from "./rescue-fixtures.ts";
import { standingPostjoinFixture } from "./postjoin-fixture.ts";
import {
  prepareNodePostjoinRuntime,
  readNodePostjoinRelease,
} from "../../src/domain/node-postjoin-release.ts";
import {
  sealBootstrapInput,
  bootstrapSpecHash,
} from "../../src/crypto/bootstrap-tickets.ts";
import { NodeBootstrapInput } from "@pgcf/contracts/node-bootstrap";
import {
  importRegionAgentKey,
  loadRegionJoinBundle,
  joinBundleReference,
} from "../../src/crypto/bootstrap-credentials.ts";
const releases: string[] = [];
afterEach(async () => {
  await cleanupFixtures();
  for (const id of releases.splice(0))
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
it("closes regional Actor admission before creating a physical Fleet patch through the real Workflow binding", async () => {
  const f = await thinExecutionFixture(releases);
  await identityProof(f, {
    physical: {
      ...f.authority.physical,
      free_bytes: 80 * gib,
      thin_pool: {
        ...f.authority.physical.thin_pool!,
        data_total_bytes: 16 * gib,
      },
    },
  });
  const db = DatabaseWithOperation.parse(
    await (await f.create()).json(),
  ).database;
  await env.DB.exec(
    `CREATE TRIGGER admission_patch_insert BEFORE INSERT ON fleet_patch_operations WHEN NEW.node_id='${f.node}' AND NOT EXISTS(SELECT 1 FROM admission_scope_fences s WHERE s.kind='region' AND s.scope_id=NEW.region_id AND s.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'patch has no admission fence'); END`,
  );
  let id: string | undefined;
  try {
    const response = await request(
      `/v1/nodes/${f.node}/patches`,
      f.admin,
      "POST",
      {
        node_uid: f.uid,
        assignment_revision: 1,
        release_id: f.qualified.releaseId,
        address: "192.0.2.18",
        maintenance_acknowledged: true,
      },
      crypto.randomUUID(),
    );
    if (response.status === 202)
      id = ((await response.clone().json()) as { operation_id: string })
        .operation_id;
    expect(response.status).toBe(202);
    expect(
      await env.DB.prepare(
        "SELECT admission_revision FROM database_admission_epochs WHERE database_id=?",
      )
        .bind(db.id)
        .first("admission_revision"),
    ).toBeGreaterThan(1);
  } finally {
    await env.DB.exec("DROP TRIGGER admission_patch_insert");
    if (id)
      await (await introspectWorkflowInstance(env.PATCH_NODE, id)).dispose();
  }
});
it("fences new member assignment and compute authority from an accepted sealed postjoin journal", async () => {
  const f = await auditedRescueConfiguration(),
    region = f.fixture.region,
    local = {
      ...env,
      NODE_BOOTSTRAP_CALLBACK_URL: "https://api.invalid/",
    } as Env;
  const selected = await standingPostjoinFixture(region);
  releases.push(selected.id);
  const standing = await readNodePostjoinRelease(local, region),
    bundle = await loadRegionJoinBundle(
      env.DB,
      env.CREDENTIAL_KEYS,
      joinBundleReference(region, 2),
    );
  const spec = { ...f.body.spec, postjoin_release: standing.reference },
    hash = await bootstrapSpecHash(spec),
    now = new Date().toISOString(),
    node = f.addition.intent.node_id,
    uid = crypto.randomUUID(),
    operation = f.addition.intent.operation_id;
  const input = NodeBootstrapInput.parse({
    spec,
    input_hash: hash,
    rescue: f.body.rescue,
    platform: f.body.platform,
    join_bundle: null,
    callback: {
      url: `https://api.invalid/internal/v1/node-bootstrap/${operation}`,
      bearer: crypto.randomUUID().repeat(2),
    },
  });
  const sealed = await sealBootstrapInput(env.CREDENTIAL_KEYS, input),
    reference = hash + ":1",
    proof = {
      operation_id: operation,
      node_id: node,
      intent_hash: f.addition.intent_hash,
      checkpoint_reference: reference,
      proof_reference: crypto.randomUUID(),
      revision: 1,
    };
  // Controlled accepted local journal/physical metadata: actual AEAD and D1, no transport mocks or live join claim.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE node_additions SET status='bootstrapping',checkpoint_json=?,network_json=?,capacity_json=? WHERE operation_id=?",
    ).bind(
      JSON.stringify({
        stage: "joined",
        reference,
        saved_at: now,
        revision: 1,
      }),
      JSON.stringify({ ...proof, verified_at: now }),
      JSON.stringify({
        ...proof,
        observed_at: now,
        allocatable_memory_mib: 8192,
        allocatable_cpu_millicores: 8000,
        storage_gib_total: 32,
        platform_reserved_memory_mib: 128,
        platform_reserved_cpu_millicores: 100,
      }),
      operation,
    ),
    env.DB.prepare(
      "INSERT INTO nodes(id,region_id,k8s_node_name,node_uid,provider_instance_id,ready,schedulable,allocatable_memory_mib,allocatable_cpu_millicores,storage_gib_total,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at,created_at,updated_at) VALUES(?,?,?,?,?,1,0,8192,8000,32,128,100,?,?,?)",
    ).bind(
      node,
      region,
      f.addition.intent.requested_hostname,
      uid,
      f.providerId,
      now,
      now,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO node_bootstrap_jobs(operation_id,node_id,region_id,input_hash,inventory_revision,sealed_revision,input_ciphertext,input_iv,input_kid,callback_hash,checkpoint_json,admission_authorized,admission_binding_json,admission_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'{}',1,?,?,?,?)",
    ).bind(
      operation,
      node,
      region,
      hash,
      spec.inventory_revision,
      sealed.revision,
      sealed.ciphertext,
      sealed.iv,
      sealed.kid,
      "a".repeat(64),
      JSON.stringify({
        checkpoint_revision: 1,
        node_uid: uid,
        resource_version: "1",
        kube_system_uid: bundle.kube_system_uid,
        quarantine: {
          key: "pgcf.io/quarantine",
          value: "bootstrap",
          effect: "NoSchedule",
        },
      }),
      new Date(Date.now() + 60000).toISOString(),
      now,
      now,
    ),
  ]);
  await importRegionAgentKey(env.DB, local, region, f.fixture.agent);
  await env.DB.exec(
    `CREATE TRIGGER admission_postjoin BEFORE INSERT ON fleet_node_releases WHEN NEW.node_id='${node}' AND NOT EXISTS(SELECT 1 FROM admission_scope_fences s WHERE s.kind='region' AND s.scope_id='${region}' AND s.mutation_status='pending') BEGIN SELECT RAISE(ABORT,'postjoin has no admission fence'); END`,
  );
  try {
    expect((await prepareNodePostjoinRuntime(local, operation)).node_uid).toBe(
      uid,
    );
  } finally {
    await env.DB.exec("DROP TRIGGER admission_postjoin");
  }
});
it("fences sealed host custody in the same Fleet transaction and rejects a delayed statement after a real abort", async () => {
  const f = await thinExecutionFixture(releases),
    local = {
      ...env,
      NODE_BOOTSTRAP_CALLBACK_URL: "https://api.invalid/",
    } as Env;
  await env.DB.prepare("DELETE FROM node_host_configurations WHERE node_id=?")
    .bind(f.node)
    .run();
  await env.DB.exec(
    `CREATE TRIGGER admission_host_abort BEFORE INSERT ON node_host_configurations WHEN NEW.node_id='${f.node}' BEGIN SELECT RAISE(ABORT,'controlled host failure'); END`,
  );
  let delayed: D1PreparedStatement | undefined;
  try {
    await expect(
      withAdmissionMutation(
        local,
        [],
        async (mutation) => {
          const prepared = await prepareNodeHostConfiguration(
            local,
            { node_id: f.node, node_uid: f.uid },
            mutation,
          );
          delayed = prepared.statement!;
          await mutation.batch([delayed]);
        },
        { kind: "region", id: f.region },
      ),
    ).rejects.toThrow("controlled host failure");
  } finally {
    await env.DB.exec("DROP TRIGGER admission_host_abort");
  }
  expect((await delayed!.run()).meta.changes).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT revision FROM node_host_configurations WHERE node_id=?",
    )
      .bind(f.node)
      .first(),
  ).toBeNull();
});
