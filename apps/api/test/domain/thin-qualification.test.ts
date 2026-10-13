// SPDX-License-Identifier: Apache-2.0
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  introspectWorkflowInstance,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import {
  DesiredResponse,
  ThinStorageProfile,
  newOperationId,
} from "@pgcf/contracts";
import { NodeStorageHeadroomResponse } from "@pgcf/contracts/node-thin-storage";
import {
  FleetReleaseSpec,
  type FleetReleaseComponent,
} from "@pgcf/contracts/releases";
import {
  THIN_QUALIFICATION_SAMPLE_WINDOWS,
  THIN_QUALIFICATION_STEPS,
  thinQualificationGatePass,
  thinQualificationReceiptMaterial,
  thinStorageQualificationFromRun,
  type ThinQualificationGates,
  type ThinQualificationRun,
  type ThinQualificationSetup,
} from "@pgcf/contracts/thin-qualification";
import { createApp } from "../../src/app.ts";
import { NodeBootstrap } from "../../src/bootstrap-container.ts";
import type { Env } from "../../src/env.ts";
import { cleanupFixtures, fixture, request } from "./fixtures.ts";
import { insertCompletedThinQualification } from "./thin-qualification-fixture.ts";
import { thinQualificationFixture } from "../../../../packages/contracts/test/thin-qualification.fixture.ts";
import {
  canonicalInstallation,
  installationHash,
} from "../../src/domain/node-installation.ts";
import { storageAuthorityPublicKeys } from "../../src/domain/storage-authority.ts";
import {
  joinBundleReference,
  storeRegionJoinBundle,
} from "../../src/crypto/bootstrap-credentials.ts";
import { configureNodeRegionPolicy } from "../../src/domain/node-state.ts";
import {
  completeThinQualification,
  failThinQualificationTurn,
  prepareThinQualificationTurn,
  recordThinQualificationCheckpoint,
  recordThinQualificationReport,
  thinQualificationInput,
} from "../../src/domain/thin-qualification.ts";

const releases: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupFixtures();
  for (const id of releases.splice(0).reverse())
    await env.DB.prepare("DELETE FROM fleet_releases WHERE id=?")
      .bind(id)
      .run();
});
const hostImage = `ghcr.io/amerged-org/pgcf-regional:sandbox-extension-sha-${"c".repeat(40)}@sha256:${"c".repeat(64)}`;
const profile = ThinStorageProfile.parse({
  version: 1,
  driver_image: `ghcr.io/amerged-org/pgcf-regional:lvm-thin-sha-${"a".repeat(40)}@sha256:${"b".repeat(64)}`,
  initial_data_bytes: 1024 ** 3,
  growth_bytes: 1024 ** 3,
  maximum_data_bytes: 8 * 1024 ** 3,
  metadata_bytes: 128 * 1024 ** 2,
  vg_reserve_bytes: 512 * 1024 ** 2,
  data_reserve_bytes: 256 * 1024 ** 2,
  metadata_reserve_bytes: 32 * 1024 ** 2,
  startup_reserve_bytes: 128 * 1024 ** 2,
  write_bytes_per_second: 1024 ** 2,
  write_iops_per_second: 100,
  guard_seconds: 10,
  drain_seconds: 10,
  maximum_volumes: 128,
  maximum_quota_gib: 7,
});
/** A release pinning the thin guard, native controller and gateway, driver, host extension and PostgreSQL. */
function guardedSpec(
  keys: string,
  driverImage = profile.driver_image,
  sampling = true,
) {
  const names = [
    "api",
    "edge",
    "node-bootstrap",
    "native-controller",
    "native-gateway",
    "postgres",
    "barman",
    "cloudflared",
    "cilium",
    "flux-source",
    "flux-kustomize",
    "flux-helm",
    "flux-notification",
    "cert-manager",
    "cloudnative-pg",
    "openebs-lvm",
    "pgcf-sandbox-controller",
    "schematic",
  ];
  const components: FleetReleaseComponent[] = names.map((name) => ({
    name,
    kind: ["api", "edge"].includes(name) ? "worker_bundle" : "image",
    version: name === "schematic" ? "d".repeat(64) : "1.0.0",
    reference:
      name === "openebs-lvm"
        ? driverImage
        : name === "pgcf-sandbox-controller"
          ? hostImage
          : `registry.example/${name}@sha256:${"d".repeat(64)}`,
    sha256:
      name === "openebs-lvm"
        ? driverImage.split("@sha256:")[1]!
        : name === "pgcf-sandbox-controller"
          ? "c".repeat(64)
          : "d".repeat(64),
  }));
  const role = {
    host_configuration_required: true,
    talos_version: "1.14.1",
    talos_installer: `registry.example/talos@sha256:${"d".repeat(64)}`,
    talos_schematic_sha256: "d".repeat(64),
    talos_extensions: ["pgcf-sandbox-controller", "schematic"],
    kubernetes_version: "1.36.5",
    components: names.filter(
      (name) =>
        ![
          "api",
          "edge",
          "node-bootstrap",
          "postgres",
          "barman",
          "pgcf-sandbox-controller",
          "schematic",
        ].includes(name),
    ),
  };
  return FleetReleaseSpec.parse({
    version: 1,
    versions_lock_sha256: "f".repeat(64),
    configuration_schema_revision: 1,
    ...(sampling ? { thin_storage_sampling_version: 1 } : {}),
    storage_authority_keys_sha256: keys,
    components,
    roles: { control_relay: role, customer: structuredClone(role) },
  });
}
/** A current customer node with closed placement, assigned to a guard-pinned release with sealed region material. */
async function qualificationSetup(sampling = true) {
  const f = await fixture(),
    at = new Date().toISOString(),
    uid = (await env.DB.prepare("SELECT node_uid FROM nodes WHERE id=?")
      .bind(f.node)
      .first<string>("node_uid"))!,
    release = `qualified-base-${crypto.randomUUID()}`,
    spec = guardedSpec(
      (await storageAuthorityPublicKeys(env)).sha256,
      profile.driver_image,
      sampling,
    ),
    specSha = await installationHash(spec),
    clusterUid = crypto.randomUUID();
  releases.push(release);
  await configureNodeRegionPolicy(env.DB, {
    region_id: f.region,
    max_nodes: 2,
    purchases_enabled: false,
    order: null,
    placement_mode: "actual_ram",
    maximum_database_memory_mib: 4096,
    postgres_memory_request_mib: 128,
  });
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE nodes SET provider_instance_id='qualification-instance',database_placement_enabled=0,database_placement_closed_at=? WHERE id=?",
    ).bind(at, f.node),
    env.DB.prepare(
      "UPDATE regions SET bootstrap_material_revision=1 WHERE id=?",
    ).bind(f.region),
    env.DB.prepare(
      "UPDATE node_region_policies SET compute_pool_json='{}' WHERE region_id=?",
    ).bind(f.region),
    env.DB.prepare(
      "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?)",
    ).bind(release, canonicalInstallation(spec), specSha, at),
    env.DB.prepare(
      "INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at) VALUES(?,?,1,?)",
    ).bind(f.region, release, at),
    env.DB.prepare(
      "INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at) VALUES(?,?,?,'customer',1,?)",
    ).bind(f.node, uid, release, at),
    env.DB.prepare(
      "INSERT INTO fleet_patch_operations(operation_id,node_id,region_id,node_uid,cluster_uid,release_id,spec_sha256,assignment_revision,region_revision,material_revision,address,cluster_nodes_json,revision,stage,state,created_at,updated_at,deadline_at) VALUES(?,?,?,?,?,?,?,1,1,1,'192.0.2.18','[]',1,'complete','confirmed',?,?,?)",
    ).bind(
      newOperationId(),
      f.node,
      f.region,
      uid,
      clusterUid,
      release,
      specSha,
      at,
      at,
      at,
    ),
  ]);
  await storeRegionJoinBundle(
    env.DB,
    env.CREDENTIAL_KEYS,
    joinBundleReference(f.region, 1),
    {
      version: 1,
      cluster_name: "qualification-fixture",
      cluster_endpoint: "https://192.0.2.18:6443/",
      talos_version: "1.14.1",
      kubernetes_version: "1.36.5",
      talos_machine_secrets_yaml: "test-only-machine",
      talos_admin_config: "test-only-admin",
      kube_system_uid: clusterUid,
      kubeconfig: "test-only-kube",
    },
  );
  const created: string[] = [];
  let unavailable = 0;
  // The Workflow scheduling boundary; a transient create failure leaves no instance.
  const workflows = {
    async create(options: { id: string }) {
      if (unavailable > 0) {
        unavailable--;
        throw new Error("workflow_create_unavailable");
      }
      created.push(options.id);
      return {};
    },
    async get() {
      throw new Error("workflow_instance_not_found");
    },
  } as unknown as Env["THIN_QUALIFICATION"];
  const send = async (
    path: string,
    body?: unknown,
    idempotency?: string,
    binding = workflows,
    key = f.admin,
  ) => {
    const context = createExecutionContext(),
      headers = new Headers({ Authorization: `Bearer ${key}` });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (idempotency) headers.set("Idempotency-Key", idempotency);
    const response = await createApp().fetch(
      new Request(`https://api.invalid${path}`, {
        method: "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { ...env, THIN_QUALIFICATION: binding },
      context,
    );
    await waitOnExecutionContext(context);
    return response;
  };
  const start = (
    body: unknown,
    idempotency: string | undefined = crypto.randomUUID(),
  ) => send(`/v1/nodes/${f.node}/thin-qualifications`, body, idempotency);
  return {
    ...f,
    uid,
    release,
    spec,
    specSha,
    clusterUid,
    samplingRunId: null as string | null,
    created,
    start,
    send,
    unavailable: (count: number) => {
      unavailable = count;
    },
  };
}
it("refuses qualification and hides its targets before the sampling release converges", async () => {
  const f = await qualificationSetup(false);
  expect(
    (await f.start({ node_uid: f.uid, address: "192.0.2.18", profile })).status,
  ).toBe(409);
  const material = thinQualificationFixture(profile, {
    node_uid: f.uid,
    cluster_uid: f.clusterUid,
    host_extension_image: hostImage,
    kernel_version: "6.18.51-talos",
    at: new Date().toISOString(),
  });
  await insertRunning(f, "data_full", material.setup);
  await env.DB.prepare(
    "UPDATE node_region_policies SET compute_pool_json=NULL WHERE region_id=?",
  )
    .bind(f.region)
    .run();
  const old = DesiredResponse.parse(
    await (await request("/agent/v1/desired", f.agent)).json(),
  );
  expect(old.region).not.toHaveProperty("storage_samples");
});
async function insertRunning(
  f: Awaited<ReturnType<typeof qualificationSetup>>,
  step: ThinQualificationRun["step"],
  setup: unknown = null,
) {
  const id = newOperationId(),
    at = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO thin_storage_qualification_runs(id,node_id,region_id,node_uid,cluster_uid,address,release_id,spec_sha256,assignment_revision,region_revision,material_revision,profile_json,profile_sha256,driver_image,host_extension_image,postgres_image,kernel_version,setup_json,step,status,lease_id,lease_revision,lease_expires_at,created_at,updated_at)
    VALUES(?,?,?,?,?,'192.0.2.18',?,?,1,1,1,?,?,?,?,?,?,?,?,'running',?,1,?,?,?)`,
  )
    .bind(
      id,
      f.node,
      f.region,
      f.uid,
      f.clusterUid,
      f.release,
      f.specSha,
      canonicalInstallation(profile),
      await installationHash(profile),
      profile.driver_image,
      hostImage,
      `registry.example/postgres@sha256:${"d".repeat(64)}`,
      setup ? "6.18.51-talos" : null,
      setup ? JSON.stringify(setup) : null,
      step,
      newOperationId(),
      new Date(Date.now() + 600_000).toISOString(),
      at,
      at,
    )
    .run();
  f.samplingRunId = id;
  return id;
}
async function renewLease(id: string) {
  await env.DB.prepare(
    "UPDATE thin_storage_qualification_runs SET lease_id=?,lease_revision=lease_revision+1,lease_expires_at=? WHERE id=?",
  )
    .bind(newOperationId(), new Date(Date.now() + 600_000).toISOString(), id)
    .run();
}
async function run(id: string) {
  return (await env.DB.prepare(
    "SELECT * FROM thin_storage_qualification_runs WHERE id=?",
  )
    .bind(id)
    .first())!;
}
/** One NodeBootstrap turn against a container double; the real test DO has no container. */
async function containerTurn(
  id: string,
  step: string,
  fetch: (request: Request) => Promise<Response>,
) {
  const container = {
    running: true,
    start: vi.fn(),
    setInactivityTimeout: async () => {},
    getTcpPort: () => ({
      fetch: async (request: Request) =>
        new URL(request.url).pathname === "/"
          ? new Response(null, { status: 401 })
          : fetch(request),
    }),
  };
  const result = await runInDurableObject(
    env.NODE_BOOTSTRAP.get(
      env.NODE_BOOTSTRAP.idFromName(`thin-qualification:${id}`),
    ),
    async (_instance, state) => {
      Object.defineProperty(state, "container", {
        configurable: true,
        value: container,
      });
      try {
        return await new NodeBootstrap(state, env).thinQualification(id, step);
      } finally {
        delete (state as { container?: unknown }).container;
      }
    },
  );
  expect(container.start).not.toHaveBeenCalled();
  return result;
}
/** The executor's own part of the evidence; Cloudflare adds its sample measurements itself. */
function observedPart<T extends object>(
  evidence: T,
): Omit<T, "longest_sample_interval_milliseconds" | "suspended_samples"> {
  const copy = { ...evidence } as Record<string, unknown>;
  delete copy.longest_sample_interval_milliseconds;
  delete copy.suspended_samples;
  return copy as Omit<
    T,
    "longest_sample_interval_milliseconds" | "suspended_samples"
  >;
}
/** One confirmed journal entry of the current turn; Cloudflare stamps its receipt. */
async function journalConfirmed(id: string, key: string) {
  const current = JSON.parse(String((await run(id)).journal_json)) as {
    revision: number;
  };
  await recordThinQualificationCheckpoint(env, id, {
    expected_revision: current.revision,
    entry: {
      key,
      state: "confirmed",
      nonce: newOperationId(),
      at: new Date().toISOString(),
      facts: null,
    },
  });
}
/** The controller's headroom sample of the run's node, witnessed by the run's setup identity. */
function qualificationSample(
  f: Awaited<ReturnType<typeof qualificationSetup>>,
  setup: ThinQualificationSetup,
  nonce: string | null,
  witnesses: object = {},
) {
  return {
    nonce,
    qualification_run: f.samplingRunId,
    node_uid: f.uid,
    captured_at: new Date().toISOString(),
    physical: {
      volume_group_uuid: setup.identity.volume_group_uuid,
      total_bytes: setup.identity.volume_group_bytes,
      free_bytes: setup.volume_group_free_bytes,
      thick_allocated_bytes: setup.thick.thick_allocated_bytes,
      thin_pool: null,
    },
    lvs: [],
    lv_count: 0,
    witnesses: {
      cluster_uid: setup.identity.cluster_uid,
      boot_id: setup.identity.boot_id,
      volume_group_uuid: setup.identity.volume_group_uuid,
      driver_pod_uid: setup.identity.driver_pod_uid,
      driver_image: setup.identity.driver_image,
      ...witnesses,
    },
    scrape_milliseconds: 250,
  };
}
async function postSample(
  f: Awaited<ReturnType<typeof qualificationSetup>>,
  body: unknown,
) {
  const response = await request(
    `/agent/v1/nodes/${f.node}/storage-headroom`,
    f.agent,
    "POST",
    body,
  );
  expect(response.status).toBe(200);
  return NodeStorageHeadroomResponse.parse(await response.json());
}
it("refuses an implicit product sample during qualification before handing out a qualification nonce", async () => {
  const f = await qualificationSetup(),
    setup = thinQualificationFixture(profile, {
      node_uid: f.uid,
      cluster_uid: f.clusterUid,
      host_extension_image: hostImage,
      kernel_version: "6.18.51-talos",
      at: new Date().toISOString(),
    }).setup,
    id = await insertRunning(f, "noflush_quiescence", setup);
  const before = await run(id);
  const { qualification_run: context, ...legacy } = qualificationSample(
    f,
    setup,
    null,
  );
  expect(context).toBe(id);
  const response = await request(
    `/agent/v1/nodes/${f.node}/storage-headroom`,
    f.agent,
    "POST",
    legacy,
  );
  expect(response.status).toBe(409);
  expect(await run(id)).toEqual(before);
  const product = await request(
    `/agent/v1/nodes/${f.node}/storage-headroom`,
    f.agent,
    "POST",
    { ...legacy, qualification_run: null },
  );
  expect(product.status).toBe(409);
  expect(await run(id)).toEqual(before);
  const stale = await request(
    `/agent/v1/nodes/${f.node}/storage-headroom`,
    f.agent,
    "POST",
    {
      ...qualificationSample(f, setup, null),
      qualification_run: `op_${"q".repeat(20)}`,
    },
  );
  expect(stale.status).toBe(409);
  expect(await run(id)).toEqual(before);
});
/** One accepted sample: a first nonce, then the scrape that answers it. */
async function sampled(
  f: Awaited<ReturnType<typeof qualificationSetup>>,
  setup: ThinQualificationSetup,
) {
  const first = await postSample(f, qualificationSample(f, setup, null));
  const accepted = await postSample(
    f,
    qualificationSample(f, setup, first.nonce),
  );
  expect(accepted).toMatchObject({ accepted: true, authority: null });
  return accepted;
}
async function unleased(f: Awaited<ReturnType<typeof qualificationSetup>>) {
  const id = await insertRunning(f, "setup");
  await env.DB.prepare(
    "UPDATE thin_storage_qualification_runs SET lease_id=NULL,lease_expires_at=NULL WHERE id=?",
  )
    .bind(id)
    .run();
  return id;
}

it("ends the lease of a turn a freshly started container never received instead of holding it for 11 minutes", async () => {
  const f = await qualificationSetup(),
    id = await unleased(f),
    requests: string[] = [];
  const result = await containerTurn(id, "setup", async (request) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    // Live on Dev: the POST threw within 5 s and the executor never made a callback.
    if (request.method === "POST") throw new Error("Network connection lost.");
    return Response.json({ state: "idle" });
  });
  expect(result).toEqual({ waiting: true });
  expect(requests).toEqual(["POST /v1/thin-qualification", "GET /v1/turn"]);
  // The next Workflow check starts the next turn; the step and its evidence stay unchanged.
  expect(await run(id)).toMatchObject({
    status: "running",
    step: "setup",
    error_code: null,
    lease_id: null,
    lease_expires_at: null,
    lease_revision: 2,
  });
});

it("keeps the lease while the container may still run the turn and then applies the outcome it retained", async () => {
  const f = await qualificationSetup(),
    id = await unleased(f),
    held: unknown[] = [];
  let turn: Record<string, unknown> = {},
    posts = 0;
  const records = [
    { state: "receiving" },
    // An executor without the turn record proves nothing either.
    { error_code: "route_unknown" },
    { state: "running", error_code: null },
    { state: "failed", error_code: "thin_qualification_write_unconfirmed" },
  ];
  const result = await containerTurn(id, "setup", async (request) => {
    if (request.method === "POST") {
      posts++;
      const { lease } = (
        (await request.json()) as {
          run: { lease: { operation_id: string; revision: number } };
        }
      ).run;
      turn = {
        kind: "thin_qualification",
        operation_id: lease.operation_id,
        revision: lease.revision,
      };
      // Live run 7: the request failed early while the executor kept running its turn.
      throw new Error("Network connection lost.");
    }
    held.push((await run(id)).lease_id);
    const next = records.shift()!;
    return Response.json(
      "state" in next && next.state !== "receiving"
        ? { ...next, ...turn }
        : next,
      { status: "state" in next ? 200 : 404 },
    );
  });
  // No second turn and no release while the executor may still hold the lease.
  expect(posts).toBe(1);
  expect(held).toEqual(Array(4).fill(turn.operation_id));
  expect(result).toEqual({ failed: "thin_qualification_write_unconfirmed" });
  expect(await run(id)).toMatchObject({
    step: "cleanup",
    error_code: "thin_qualification_write_unconfirmed",
    lease_id: null,
  });
}, 30_000);

it("release approval refuses hand-typed thin gate flags and accepts only a completed run's exact receipt", async () => {
  const f = await qualificationSetup(),
    id = `thin-receipt-${crypto.randomUUID()}`;
  releases.push(id);
  const fabricated = {
    ...f.spec,
    thin_storage_qualification: {
      profile_sha256: await installationHash(profile),
      driver_image: profile.driver_image,
      host_extension_image: hostImage,
      kernel_version: "6.18.51-talos",
      receipt_sha256: "e".repeat(64),
      qualified_at: new Date().toISOString(),
      gates: {
        data_full: true,
        metadata_full: true,
        noflush_quiescence: true,
        resume_marker: true,
        startup_bound: true,
        trim_delete_recreate: true,
        retained_thick_preservation: true,
      },
    },
  };
  expect(
    (await request(`/v1/fleet/releases/${id}`, f.admin, "PUT", fabricated))
      .status,
  ).toBe(409);
  const qualification = await insertCompletedThinQualification(env.DB, {
    node_id: f.node,
    region_id: f.region,
    node_uid: f.uid,
    release_id: id,
    spec: f.spec,
    profile,
    host_extension_image: hostImage,
    kernel_version: "6.18.51-talos",
  });
  releases.push(`${id}-base`);
  const changed = `thin-receipt-${crypto.randomUUID()}`;
  releases.push(changed);
  expect(
    (
      await request(`/v1/fleet/releases/${changed}`, f.admin, "PUT", {
        ...f.spec,
        thin_storage_qualification: {
          ...qualification,
          kernel_version: "6.18.54-talos",
        },
      })
    ).status,
  ).toBe(409);
  const approved = await request(`/v1/fleet/releases/${id}`, f.admin, "PUT", {
    ...f.spec,
    thin_storage_qualification: qualification,
  });
  expect(approved.status).toBe(200);
  expect(
    ((await approved.json()) as { spec: FleetReleaseSpec }).spec
      .thin_storage_qualification,
  ).toEqual(qualification);
});

it("starts an actual scratch Workflow on a current control relay without enabling placement or selecting thin storage", async () => {
  const f = await qualificationSetup();
  await env.DB.prepare(
    "UPDATE fleet_node_releases SET role='control_relay' WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  // Use the real Workerd Workflow binding, not this file's scheduling-boundary substitute.
  const response = await request(
    `/v1/nodes/${f.node}/thin-qualifications`,
    f.admin,
    "POST",
    { node_uid: f.uid, address: "192.0.2.18", profile },
    crypto.randomUUID(),
  );
  expect(response.status).toBe(202);
  const value = (await response.json()) as ThinQualificationRun;
  const instance = await introspectWorkflowInstance(
    env.THIN_QUALIFICATION,
    value.id,
  );
  try {
    expect(value).toMatchObject({
      node_id: f.node,
      node_uid: f.uid,
      release_id: f.release,
    });
    expect(
      await env.DB.prepare(
        "SELECT database_placement_enabled FROM nodes WHERE id=?",
      )
        .bind(f.node)
        .first("database_placement_enabled"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT count(*) n FROM node_thin_storage WHERE node_id=?",
      )
        .bind(f.node)
        .first("n"),
    ).toBe(0);
    expect(f.created).toEqual([]);
  } finally {
    await instance.dispose();
  }
});

it("starts one scratch run only on a fresh node with closed placement, a guard-pinned release and the region pool on", async () => {
  const f = await qualificationSetup(),
    body = { node_uid: f.uid, address: "192.0.2.18", profile };
  expect((await f.start(body, "")).status).toBe(400);
  await env.DB.prepare(
    "UPDATE node_region_policies SET compute_pool_json=NULL WHERE region_id=?",
  )
    .bind(f.region)
    .run();
  expect((await f.start(body)).status).toBe(409);
  await env.DB.prepare(
    "UPDATE node_region_policies SET compute_pool_json='{}' WHERE region_id=?",
  )
    .bind(f.region)
    .run();
  // Thick placement does not see the scratch pool, so an open node is refused.
  await env.DB.prepare(
    "UPDATE nodes SET database_placement_enabled=1,database_placement_closed_at=NULL WHERE id=?",
  )
    .bind(f.node)
    .run();
  expect((await f.start(body)).status).toBe(409);
  await env.DB.prepare(
    "UPDATE nodes SET database_placement_enabled=0,database_placement_closed_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), f.node)
    .run();
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(new Date(Date.now() - 600_000).toISOString(), f.node)
    .run();
  expect((await f.start(body)).status).toBe(409);
  await env.DB.prepare("UPDATE nodes SET last_observed_at=? WHERE id=?")
    .bind(new Date().toISOString(), f.node)
    .run();
  expect(
    (
      await f.start({
        ...body,
        profile: {
          ...profile,
          driver_image: `registry.example/other@sha256:${"9".repeat(64)}`,
        },
      })
    ).status,
  ).toBe(409);
  const started = await f.start(body);
  expect(started.status).toBe(202);
  const value = (await started.json()) as ThinQualificationRun;
  expect(value).toMatchObject({
    node_id: f.node,
    node_uid: f.uid,
    release_id: f.release,
    status: "running",
    step: "setup",
    profile_sha256: await installationHash(profile),
    driver_image: profile.driver_image,
    host_extension_image: hostImage,
    qualification: null,
  });
  expect(f.created).toEqual([value.id]);
  expect((await f.start(body)).status).toBe(409);
  // Thin selection waits until the scratch pool and namespace are gone.
  await expect(
    env.DB.prepare(
      `INSERT INTO node_thin_storage(node_id,node_uid,cluster_uid,address,volume_group_uuid,profile_revision,profile_sha256,profile_json,material_revision,status,created_at,updated_at)
      VALUES(?,?,?,'192.0.2.18','abcdef-abcd-abcd-abcd-abcd-abcd-abcdef',1,?,'{}',1,'selected',?,?)`,
    )
      .bind(
        f.node,
        f.uid,
        f.clusterUid,
        "a".repeat(64),
        new Date().toISOString(),
        new Date().toISOString(),
      )
      .run(),
  ).rejects.toThrow("thin_storage_qualification_running");
  // The admin selection is refused as a conflict, not as a server fault.
  const selection = await request(
    `/v1/nodes/${f.node}/storage-profile`,
    f.admin,
    "PUT",
    {
      expected_revision: 0,
      node_uid: f.uid,
      address: "192.0.2.18",
      volume_group_uuid: "abcdef-abcd-abcd-abcd-abcd-abcd-abcdef",
      profile,
      allow_new_databases: false,
    },
    crypto.randomUUID(),
  );
  expect(selection.status).toBe(409);
  expect(await selection.json()).toMatchObject({
    error: { message: expect.stringContaining("qualification is running") },
  });
  expect(
    await env.DB.prepare("SELECT 1 FROM node_thin_storage WHERE node_id=?")
      .bind(f.node)
      .first(),
  ).toBeNull();
  expect(
    (await request(`/v1/thin-qualifications/${value.id}`, f.integrator)).status,
  ).toBe(403);
});

it("journals each dispatched write once and refuses rewritten, stale or unleased checkpoints", async () => {
  const f = await qualificationSetup(),
    id = await insertRunning(f, "setup"),
    nonce = newOperationId(),
    entry = {
      key: "setup:pool",
      state: "dispatched" as const,
      nonce,
      at: new Date().toISOString(),
      facts: null,
    };
  expect(
    await recordThinQualificationCheckpoint(env, id, {
      expected_revision: 0,
      entry,
    }),
  ).toEqual({ revision: 1 });
  // An uncertain write cannot be dispatched again under a new nonce.
  await expect(
    recordThinQualificationCheckpoint(env, id, {
      expected_revision: 1,
      entry: { ...entry, nonce: newOperationId() },
    }),
  ).rejects.toThrow("cannot be rewritten");
  await expect(
    recordThinQualificationCheckpoint(env, id, {
      expected_revision: 1,
      entry: { ...entry, state: "confirmed", nonce: newOperationId() },
    }),
  ).rejects.toThrow("cannot be rewritten");
  await expect(
    recordThinQualificationCheckpoint(env, id, {
      expected_revision: 0,
      entry: { ...entry, key: "setup:namespace" },
    }),
  ).rejects.toThrow("lease or identity changed");
  expect(
    await recordThinQualificationCheckpoint(env, id, {
      expected_revision: 1,
      entry: { ...entry, state: "confirmed", facts: { pool_uuid: "x" } },
    }),
  ).toEqual({ revision: 2 });
  await expect(
    recordThinQualificationCheckpoint(env, id, {
      expected_revision: 2,
      entry: { ...entry, state: "confirmed", facts: { pool_uuid: "y" } },
    }),
  ).rejects.toThrow("cannot be rewritten");
  // An active lease is never shared with a second turn.
  expect(await prepareThinQualificationTurn(env, id, "setup")).toBeNull();
  await env.DB.prepare(
    "UPDATE thin_storage_qualification_runs SET lease_expires_at=? WHERE id=?",
  )
    .bind(new Date(Date.now() - 1000).toISOString(), id)
    .run();
  await expect(
    recordThinQualificationCheckpoint(env, id, {
      expected_revision: 2,
      entry: { ...entry, key: "setup:quota" },
    }),
  ).rejects.toThrow("lease or identity changed");
  // A failed gate turn ends the measurements; a failed cleanup turn keeps converging.
  await renewLease(id);
  const leased = await run(id);
  await failThinQualificationTurn(
    env,
    id,
    String(leased.lease_id),
    "thin_qualification_write_unconfirmed",
  );
  expect(await run(id)).toMatchObject({
    step: "cleanup",
    error_code: "thin_qualification_write_unconfirmed",
    lease_id: null,
  });
  await renewLease(id);
  await failThinQualificationTurn(
    env,
    id,
    String((await run(id)).lease_id),
    "thin_storage_command_failed",
  );
  expect(await run(id)).toMatchObject({
    step: "cleanup",
    error_code: "thin_qualification_write_unconfirmed",
  });
});

it("decides every gate from its evidence and seals the receipt only after verified cleanup", async () => {
  const f = await qualificationSetup(),
    sample = thinQualificationFixture(profile, {
      node_uid: f.uid,
      cluster_uid: f.clusterUid,
      host_extension_image: hostImage,
      kernel_version: "6.18.51-talos",
      at: new Date().toISOString(),
    });
  // A failing measurement closes the run even when the executor would call it a pass.
  const failing = await insertRunning(f, "data_full", sample.setup);
  expect(
    await recordThinQualificationReport(env, failing, {
      step: "data_full",
      evidence: {
        ...sample.evidence.data_full,
        probe: { ...sample.evidence.data_full.probe, milliseconds: 10_001 },
      },
    }),
  ).toMatchObject({ step: "cleanup" });
  const failed = await run(failing);
  expect(failed.error_code).toBe("thin_qualification_data_full_failed");
  expect(
    (JSON.parse(String(failed.gates_json)) as ThinQualificationGates).data_full
      ?.pass,
  ).toBe(false);
  await env.DB.prepare(
    "UPDATE thin_storage_qualification_runs SET status='failed',step='complete',lease_id=NULL,lease_expires_at=NULL,completed_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), failing)
    .run();
  // A complete passing run, step by step, through the same report path.
  const id = await insertRunning(f, "setup");
  expect(
    await recordThinQualificationReport(env, id, {
      step: "setup",
      setup: sample.setup,
    }),
  ).toMatchObject({ step: "data_full" });
  for (const gate of [
    "data_full",
    "metadata_full",
    "noflush_quiescence",
    "resume_marker",
    "startup_bound",
    "trim_delete_recreate",
  ] as const) {
    await renewLease(id);
    if (gate === "noflush_quiescence" || gate === "startup_bound") {
      // Cloudflare measures its own accepted samples inside the journaled window.
      const [from, to] = THIN_QUALIFICATION_SAMPLE_WINDOWS[gate];
      await journalConfirmed(id, from);
      await sampled(f, sample.setup);
      await sampled(f, sample.setup);
      await journalConfirmed(id, to);
    }
    await recordThinQualificationReport(env, id, {
      step: gate,
      evidence: observedPart(sample.evidence[gate]),
    } as never);
  }
  await renewLease(id);
  // Cloudflare, not the executor, supplies the node's thin placement count.
  expect(
    await recordThinQualificationReport(env, id, {
      step: "retained_thick_preservation",
      evidence: {
        baseline: sample.evidence.retained_thick_preservation.baseline,
        after: sample.evidence.retained_thick_preservation.after,
      },
    }),
  ).toMatchObject({ step: "cleanup" });
  expect(await completeThinQualification(env, id)).toMatchObject({
    status: "running",
  });
  await renewLease(id);
  await recordThinQualificationReport(env, id, {
    step: "cleanup",
    cleanup: sample.cleanup,
  });
  expect(await completeThinQualification(env, id)).toMatchObject({
    status: "completed",
  });
  const response = await request(`/v1/thin-qualifications/${id}`, f.admin);
  expect(response.status).toBe(200);
  const value = (await response.json()) as ThinQualificationRun;
  expect(value.gates.noflush_quiescence?.evidence.suspended_samples).toBe(2);
  expect(
    value.gates.startup_bound?.evidence.longest_sample_interval_milliseconds,
  ).toBeLessThan(profile.guard_seconds * 500);
  for (const [gate, decided] of Object.entries(value.gates))
    expect(
      decided &&
        thinQualificationGatePass(
          gate as never,
          decided.evidence as never,
          profile,
        ),
    ).toBe(true);
  expect(value.receipt_sha256).toBe(
    await installationHash(thinQualificationReceiptMaterial(value)),
  );
  expect(value.qualification).toEqual(thinStorageQualificationFromRun(value));
  // Produced evidence is immutable.
  await expect(
    env.DB.prepare(
      "UPDATE thin_storage_qualification_runs SET kernel_version='6.18.54-talos' WHERE id=?",
    )
      .bind(id)
      .run(),
  ).rejects.toThrow("thin_storage_qualification_terminal");
});

it("waits out a turn lease an unanswered executor still holds before the next turn or the step deadline", async () => {
  const f = await qualificationSetup(),
    id = await insertRunning(f, "cleanup"),
    expires = Date.now() + 2500;
  // The previous turn's executor stopped answering; its lease still runs.
  await env.DB.prepare(
    "UPDATE thin_storage_qualification_runs SET lease_expires_at=? WHERE id=?",
  )
    .bind(new Date(expires).toISOString(), id)
    .run();
  const instance = await introspectWorkflowInstance(env.THIN_QUALIFICATION, id);
  try {
    // Only the fixed turn cadence is skipped; a lease wait really elapses.
    await instance.modify((m) =>
      m.disableSleeps(
        [...THIN_QUALIFICATION_STEPS, "complete"].flatMap((name) =>
          Array.from({ length: 64 }, (_, turn) => ({
            name: `${name}-wait-${turn}`,
          })),
        ),
      ),
    );
    // The real test DO has no container, so every turn ends before it can take a lease.
    await env.THIN_QUALIFICATION.create({ id, params: { run_id: id } });
    expect(await instance.waitForStepResult({ name: "setup-0" })).toMatchObject(
      { step: "cleanup", status: "running" },
    );
    expect((await run(id)).step).toBe("cleanup");
    await instance.waitForStatus("complete");
    const ended = await run(id);
    expect(ended).toMatchObject({
      status: "failed",
      step: "complete",
      error_code: "thin_qualification_cleanup_deadline",
    });
    // Cleanup expired only after the held lease ended, never under it.
    expect(Date.parse(String(ended.completed_at))).toBeGreaterThanOrEqual(
      expires,
    );
  } finally {
    await instance.dispose();
  }
}, 15_000);

it("continues as soon as an executor releases its lease early instead of sleeping out the whole lease", async () => {
  const f = await qualificationSetup(),
    id = await insertRunning(f, "cleanup");
  // The executor's RPC answered early, while its ten-minute lease still ran; it ends the turn soon.
  await env.DB.prepare(
    "UPDATE thin_storage_qualification_runs SET lease_expires_at=? WHERE id=?",
  )
    .bind(new Date(Date.now() + 600_000).toISOString(), id)
    .run();
  const instance = await introspectWorkflowInstance(env.THIN_QUALIFICATION, id);
  try {
    await instance.modify((m) =>
      m.disableSleeps(
        [...THIN_QUALIFICATION_STEPS, "complete"].flatMap((name) =>
          Array.from({ length: 64 }, (_, turn) => ({
            name: `${name}-wait-${turn}`,
          })),
        ),
      ),
    );
    await env.THIN_QUALIFICATION.create({ id, params: { run_id: id } });
    expect(await instance.waitForStepResult({ name: "setup-0" })).toMatchObject(
      { step: "cleanup", status: "running" },
    );
    await env.DB.prepare(
      "UPDATE thin_storage_qualification_runs SET lease_id=NULL,lease_expires_at=NULL WHERE id=?",
    )
      .bind(id)
      .run();
    await instance.waitForStatus("complete");
    expect(await run(id)).toMatchObject({
      status: "failed",
      step: "complete",
      error_code: "thin_qualification_cleanup_deadline",
    });
  } finally {
    await instance.dispose();
  }
}, 90_000);

it("reports a lost Workflow start and drives the committed run again on replay", async () => {
  const f = await qualificationSetup(),
    body = { node_uid: f.uid, address: "192.0.2.18", profile },
    key = crypto.randomUUID();
  f.unavailable(1);
  // The run is committed before its Workflow starts; a failed start is reported, not dropped.
  expect((await f.start(body, key)).status).toBe(500);
  expect(f.created).toEqual([]);
  const replay = await f.start(body, key);
  expect(replay.status).toBe(202);
  const value = (await replay.json()) as ThinQualificationRun;
  expect(value).toMatchObject({ status: "running", step: "setup" });
  expect(f.created).toEqual([value.id]);
  // A refused start names the running run, so it can be resumed or cancelled.
  const refused = await f.start(body);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    error: { details: { run_id: value.id } },
  });
});

it("resumes a running run's stopped Workflow and never reopens an ended run", async () => {
  const f = await qualificationSetup(),
    id = await insertRunning(f, "data_full"),
    restarted: string[] = [];
  const stopped = {
    async create() {
      throw new Error("workflow_instance_exists");
    },
    async get(instance: string) {
      return {
        status: async () => ({ status: "errored" }),
        restart: async () => {
          restarted.push(instance);
        },
      };
    },
  } as unknown as Env["THIN_QUALIFICATION"];
  const path = `/v1/thin-qualifications/${id}/resume`;
  expect(
    (await f.send(path, undefined, undefined, stopped, f.integrator)).status,
  ).toBe(403);
  const resumed = await f.send(path, undefined, undefined, stopped);
  expect(resumed.status).toBe(200);
  expect(await resumed.json()).toMatchObject({
    id,
    status: "running",
    step: "data_full",
  });
  expect(restarted).toEqual([id]);
  await env.DB.prepare(
    "UPDATE thin_storage_qualification_runs SET status='failed',step='complete',error_code='thin_qualification_data_full_failed',lease_id=NULL,lease_expires_at=NULL,completed_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), id)
    .run();
  expect((await f.send(path, undefined, undefined, stopped)).status).toBe(409);
  expect(restarted).toEqual([id]);
});

it("cancels the measurements of a running run, still runs cleanup and then fails it", async () => {
  const f = await qualificationSetup(),
    id = await insertRunning(f, "data_full");
  await env.DB.prepare(
    "UPDATE thin_storage_qualification_runs SET lease_id=NULL,lease_expires_at=NULL WHERE id=?",
  )
    .bind(id)
    .run();
  const instance = await introspectWorkflowInstance(env.THIN_QUALIFICATION, id);
  try {
    await instance.modify(async (m) => {
      await m.disableSleeps();
      await m.disableRetryDelays();
      // A transient failure of one turn is retried instead of stopping the Workflow.
      await m.mockStepError({ name: "setup-0" }, new Error("D1_ERROR"), 1);
    });
    const path = `/v1/thin-qualifications/${id}/cancel`;
    expect((await request(path, f.integrator, "POST")).status).toBe(403);
    // The cancel drives the run's Workflow through the real binding.
    const cancelled = await request(path, f.admin, "POST");
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      status: "running",
      step: "cleanup",
      error_code: "thin_qualification_cancelled",
    });
    await instance.waitForStatus("complete");
    expect(
      await instance.waitForStepResult({ name: "cleanup-0" }),
    ).toMatchObject({ step: "cleanup", status: "running" });
    expect(await run(id)).toMatchObject({
      status: "failed",
      step: "complete",
      error_code: "thin_qualification_cancelled",
      receipt_sha256: null,
    });
    expect((await request(path, f.admin, "POST")).status).toBe(409);
  } finally {
    await instance.dispose();
  }
});

it("ends the measurements when database placement reopens during a run and still runs cleanup", async () => {
  const f = await qualificationSetup(),
    id = await insertRunning(f, "data_full");
  await env.DB.prepare(
    "UPDATE thin_storage_qualification_runs SET lease_id=NULL,lease_expires_at=NULL WHERE id=?",
  )
    .bind(id)
    .run();
  await env.DB.prepare(
    "UPDATE nodes SET database_placement_enabled=1,database_placement_closed_at=NULL WHERE id=?",
  )
    .bind(f.node)
    .run();
  await expect(
    prepareThinQualificationTurn(env, id, "data_full"),
  ).rejects.toThrow("lease or identity changed");
  expect(await run(id)).toMatchObject({
    step: "cleanup",
    error_code: "thin_qualification_authority_changed",
    lease_id: null,
  });
  expect(await prepareThinQualificationTurn(env, id, "cleanup")).toMatchObject({
    run: { id, step: "cleanup" },
  });
});

it("records a running qualification's samples against its setup identity and renews nothing", async () => {
  const observation = vi.spyOn(console, "log").mockImplementation(() => {});
  const f = await qualificationSetup(),
    setup = thinQualificationFixture(profile, {
      node_uid: f.uid,
      cluster_uid: f.clusterUid,
      host_extension_image: hostImage,
      kernel_version: "6.18.51-talos",
      at: new Date().toISOString(),
    }).setup;
  // Desired state serializes a real pool template or none; the fixture's placeholder is neither.
  await env.DB.prepare(
    "UPDATE node_region_policies SET compute_pool_json=NULL WHERE region_id=?",
  )
    .bind(f.region)
    .run();
  // Before setup there is no identity to check samples against.
  const pending = await insertRunning(f, "setup");
  const desired = async () =>
    DesiredResponse.parse(
      await (await request("/agent/v1/desired", f.agent)).json(),
    ).region.storage_samples;
  expect(await desired()).toBeUndefined();
  await env.DB.prepare(
    "UPDATE thin_storage_qualification_runs SET status='failed',step='complete',lease_id=NULL,lease_expires_at=NULL,completed_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), pending)
    .run();
  const id = await insertRunning(f, "noflush_quiescence", setup);
  expect(await desired()).toEqual([
    {
      node_id: f.node,
      name: f.nodeName,
      node_uid: f.uid,
      period_milliseconds: profile.guard_seconds * 200,
      qualification_run: id,
    },
  ]);
  await journalConfirmed(id, "noflush_quiescence:suspend");
  const first = await postSample(f, qualificationSample(f, setup, null));
  expect(first).toMatchObject({
    accepted: false,
    reason: "thin_storage_sample_nonce_invalid",
    period_milliseconds: profile.guard_seconds * 200,
  });
  const issued = String((await run(id)).sample_nonce_issued_at);
  const accepted = await postSample(
    f,
    qualificationSample(f, setup, first.nonce),
  );
  expect(accepted).toMatchObject({
    accepted: true,
    reason: null,
    authority: null,
    tokens: [],
  });
  const recorded = await env.DB.prepare(
    "SELECT nonce,observed_at,received_at,scrape_milliseconds FROM thin_storage_qualification_samples WHERE run_id=?",
  )
    .bind(id)
    .all<{
      nonce: string;
      observed_at: string;
      received_at: string;
      scrape_milliseconds: number;
    }>();
  expect(recorded.results).toHaveLength(1);
  expect(recorded.results[0]).toMatchObject({
    nonce: first.nonce,
    observed_at: issued,
    scrape_milliseconds: 250,
  });
  expect(recorded.results[0]!.received_at >= issued).toBe(true);
  // A witness the setup did not read, or a reused nonce, records nothing.
  expect(
    await postSample(
      f,
      qualificationSample(f, setup, accepted.nonce, {
        driver_pod_uid: crypto.randomUUID(),
      }),
    ),
  ).toMatchObject({
    accepted: false,
    reason: "thin_storage_sample_witness_changed",
  });
  expect(
    await postSample(f, qualificationSample(f, setup, first.nonce)),
  ).toMatchObject({
    accepted: false,
    reason: "thin_storage_sample_nonce_invalid",
  });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM thin_storage_qualification_samples WHERE run_id=?",
    )
      .bind(id)
      .first<number>("n"),
  ).toBe(1);
  // An ended run's evidence never changes.
  await env.DB.prepare(
    "UPDATE thin_storage_qualification_runs SET status='failed',step='complete',lease_id=NULL,lease_expires_at=NULL,completed_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), id)
    .run();
  await expect(
    env.DB.prepare(
      "INSERT INTO thin_storage_qualification_samples(run_id,nonce,observed_at,received_at,scrape_milliseconds) VALUES(?,?,?,?,1)",
    )
      .bind(id, "f".repeat(32), issued, issued)
      .run(),
  ).rejects.toThrow("thin_storage_qualification_terminal");
  expect(
    observation.mock.calls.some(([value]) => {
      if (typeof value !== "string") return false;
      const event = JSON.parse(value) as Record<string, unknown>;
      return (
        event.event === "thin_storage_sample_accepted" &&
        event.node_id === f.node
      );
    }),
  ).toBe(false);
});

it("records qualification samples only inside a journaled window with an active turn lease", async () => {
  const f = await qualificationSetup(),
    setup = thinQualificationFixture(profile, {
      node_uid: f.uid,
      cluster_uid: f.clusterUid,
      host_extension_image: hostImage,
      kernel_version: "6.18.51-talos",
      at: new Date().toISOString(),
    }).setup,
    id = await insertRunning(f, "noflush_quiescence", setup);
  const count = () =>
    env.DB.prepare(
      "SELECT COUNT(*) n FROM thin_storage_qualification_samples WHERE run_id=?",
    )
      .bind(id)
      .first<number>("n");

  await sampled(f, setup);
  expect(await count()).toBe(0);
  await journalConfirmed(id, "noflush_quiescence:suspend");
  await sampled(f, setup);
  expect(await count()).toBe(1);

  await env.DB.prepare(
    "UPDATE thin_storage_qualification_runs SET lease_expires_at=? WHERE id=?",
  )
    .bind(new Date(Date.now() - 1000).toISOString(), id)
    .run();
  await sampled(f, setup);
  expect(await count()).toBe(1);

  await renewLease(id);
  await journalConfirmed(id, "noflush_quiescence:frozen");
  await sampled(f, setup);
  expect(await count()).toBe(1);
});

it("does not judge a startup sample answered after the bulk load as evidence during the load", async () => {
  const f = await qualificationSetup(),
    evidence = thinQualificationFixture(profile, {
      node_uid: f.uid,
      cluster_uid: f.clusterUid,
      host_extension_image: hostImage,
      kernel_version: "6.18.51-talos",
      at: new Date().toISOString(),
    }),
    id = await insertRunning(f, "startup_bound", evidence.setup);
  await journalConfirmed(id, "startup_bound:ready");
  const first = await postSample(
      f,
      qualificationSample(f, evidence.setup, null),
    ),
    issued = String((await run(id)).sample_nonce_issued_at);
  await journalConfirmed(id, "startup_bound:loaded");
  expect(
    await postSample(f, qualificationSample(f, evidence.setup, first.nonce)),
  ).toMatchObject({ accepted: true, authority: null, tokens: [] });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM thin_storage_qualification_samples WHERE run_id=?",
    )
      .bind(id)
      .first<number>("n"),
  ).toBe(0);

  // Existing evidence from before the window fix is filtered in the gate's SQL read too.
  const journal = JSON.parse(String((await run(id)).journal_json)) as {
    entries: { key: string; received_at: string }[];
  };
  const loaded = journal.entries.find(
    (entry) => entry.key === "startup_bound:loaded",
  )!;
  await env.DB.prepare(
    "INSERT INTO thin_storage_qualification_samples(run_id,nonce,observed_at,received_at,scrape_milliseconds) VALUES(?,?,?,?,1)",
  )
    .bind(
      id,
      "d".repeat(32),
      issued,
      new Date(Date.parse(loaded.received_at) + 1).toISOString(),
    )
    .run();
  await recordThinQualificationReport(env, id, {
    step: "startup_bound",
    evidence: observedPart(evidence.evidence.startup_bound),
  });
  const failed = await run(id);
  expect(failed.error_code).toBe("thin_qualification_startup_bound_failed");
  expect(
    (JSON.parse(String(failed.gates_json)) as ThinQualificationGates)
      .startup_bound?.evidence,
  ).not.toHaveProperty("longest_sample_interval_milliseconds");
});

it("stops qualification sampling and measurement custody when its sampling release loses confirmation", async () => {
  const f = await qualificationSetup(),
    setup = thinQualificationFixture(profile, {
      node_uid: f.uid,
      cluster_uid: f.clusterUid,
      host_extension_image: hostImage,
      kernel_version: "6.18.51-talos",
      at: new Date().toISOString(),
    }).setup,
    id = await insertRunning(f, "noflush_quiescence", setup);
  await journalConfirmed(id, "noflush_quiescence:suspend");
  const first = await postSample(f, qualificationSample(f, setup, null));
  await env.DB.prepare(
    "UPDATE fleet_patch_operations SET state='halted',error_code='patch_command_failed' WHERE node_id=?",
  )
    .bind(f.node)
    .run();
  const refusal = await thinQualificationInput(env, id).then(
    () => null,
    (error: Error) => error.message,
  );
  expect(refusal).toContain("lease or identity changed");
  const response = await request(
    `/agent/v1/nodes/${f.node}/storage-headroom`,
    f.agent,
    "POST",
    qualificationSample(f, setup, first.nonce),
  );
  expect(response.status).toBe(404);
  expect(await run(id)).toMatchObject({ sample_nonce: first.nonce });
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) n FROM thin_storage_qualification_samples WHERE run_id=?",
    )
      .bind(id)
      .first<number>("n"),
  ).toBe(0);

  await env.DB.prepare(
    "UPDATE thin_storage_qualification_runs SET step='cleanup' WHERE id=?",
  )
    .bind(id)
    .run();
  expect(await thinQualificationInput(env, id)).toMatchObject({
    run: { id, step: "cleanup" },
  });
});

it("fails startup_bound without an accepted sample during the bulk load and judges noflush only while suspended", async () => {
  const f = await qualificationSetup(),
    evidence = thinQualificationFixture(profile, {
      node_uid: f.uid,
      cluster_uid: f.clusterUid,
      host_extension_image: hostImage,
      kernel_version: "6.18.51-talos",
      at: new Date().toISOString(),
    });
  const id = await insertRunning(f, "noflush_quiescence", evidence.setup);
  // A sample before the writer was suspended does not count.
  await sampled(f, evidence.setup);
  await journalConfirmed(id, "noflush_quiescence:suspend");
  await journalConfirmed(id, "noflush_quiescence:frozen");
  // Real D1 checkpoints may arrive in the same millisecond; give this empty window a
  // deterministic positive duration without changing the product clock or waiting.
  const journal = JSON.parse(String((await run(id)).journal_json)) as {
    entries: { key: string; received_at: string }[];
  };
  const suspended = journal.entries.find(
    (entry) => entry.key === "noflush_quiescence:suspend",
  )!;
  journal.entries.find(
    (entry) => entry.key === "noflush_quiescence:frozen",
  )!.received_at = new Date(
    Date.parse(suspended.received_at) + 1,
  ).toISOString();
  await env.DB.prepare(
    "UPDATE thin_storage_qualification_runs SET journal_json=? WHERE id=?",
  )
    .bind(JSON.stringify(journal), id)
    .run();
  const noflush = observedPart(evidence.evidence.noflush_quiescence);
  expect(
    await recordThinQualificationReport(env, id, {
      step: "noflush_quiescence",
      evidence: noflush,
    }),
  ).toMatchObject({ step: "cleanup" });
  const ended = await run(id);
  expect(ended.error_code).toBe("thin_qualification_noflush_quiescence_failed");
  expect(
    (JSON.parse(String(ended.gates_json)) as ThinQualificationGates)
      .noflush_quiescence?.evidence.suspended_samples,
  ).toBe(0);
  await env.DB.prepare(
    "UPDATE thin_storage_qualification_runs SET status='failed',step='complete',lease_id=NULL,lease_expires_at=NULL,completed_at=? WHERE id=?",
  )
    .bind(new Date().toISOString(), id)
    .run();
  const startup = await insertRunning(f, "startup_bound", evidence.setup);
  await journalConfirmed(startup, "startup_bound:ready");
  await journalConfirmed(startup, "startup_bound:loaded");
  const observed = observedPart(evidence.evidence.startup_bound);
  expect(
    await recordThinQualificationReport(env, startup, {
      step: "startup_bound",
      evidence: observed,
    }),
  ).toMatchObject({ step: "cleanup" });
  const failed = await run(startup);
  expect(failed.error_code).toBe("thin_qualification_startup_bound_failed");
  expect(
    (JSON.parse(String(failed.gates_json)) as ThinQualificationGates)
      .startup_bound?.evidence,
  ).not.toHaveProperty("longest_sample_interval_milliseconds");
});
