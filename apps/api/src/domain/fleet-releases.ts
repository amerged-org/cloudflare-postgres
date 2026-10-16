// SPDX-License-Identifier: Apache-2.0
import { bytesToHex } from "@pgcf/contracts";
import {
  FleetRelease,
  FleetReleaseId,
  FleetDesiredRelease,
  FleetReleaseSpec,
  FleetNodeReleaseObservation,
  FleetNodeReleaseStatus,
  FleetRegionReleaseStatus,
  type FleetNodeReleaseUpdate,
  type FleetRegionReleaseUpdate,
} from "@pgcf/contracts/releases";
import { ApiError } from "../app.ts";
import type { ApiContext } from "../env.ts";
import { requireScope } from "../middleware/auth.ts";
import { withIdempotency } from "../middleware/idempotency.ts";
import { agentRegion } from "./agent-auth.ts";
import { normalizeRuntimeImageManifest } from "../../../../infra/platform/image-manifest.ts";
import { assertThinQualificationReceipt } from "./thin-qualification.ts";
import { page } from "../platform/pagination.ts";
import {
  withAdmissionMutation,
  type AdmissionMutation,
} from "./admission-mutations.ts";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}
async function sha256(text: string): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  );
}
const conflict = (message: string): never => {
  throw new ApiError("conflict", message);
};
interface ReleaseRow {
  id: string;
  spec_json: string;
  spec_sha256: string;
  approved_at: string;
}
function releaseRow(row: ReleaseRow): FleetRelease {
  return FleetRelease.parse({
    id: row.id,
    spec: JSON.parse(row.spec_json),
    spec_sha256: row.spec_sha256,
    approved_at: row.approved_at,
  });
}
async function release(db: D1Database, id: string): Promise<FleetRelease> {
  const row = await db
    .prepare(
      "SELECT id,spec_json,spec_sha256,approved_at FROM fleet_releases WHERE id=?",
    )
    .bind(id)
    .first<ReleaseRow>();
  if (!row) throw new ApiError("not_found", "Fleet release not found");
  return releaseRow(row);
}
export async function listFleetReleases(c: ApiContext): Promise<Response> {
  await requireScope(c, "admin");
  const pagination = page(
      c,
      c.req.query(),
      (id) => FleetReleaseId.safeParse(id).success,
    ),
    where = pagination.where("approved_at", "id"),
    rows = await c.env.DB.prepare(
      `SELECT id,spec_json,spec_sha256,approved_at FROM fleet_releases WHERE ${where.sql} ORDER BY approved_at DESC,id DESC LIMIT ?`,
    )
      .bind(...where.bindings, pagination.limit + 1)
      .all<ReleaseRow>(),
    envelope = pagination.envelope(
      rows.results.map((row) => ({ ...row, created_at: row.approved_at })),
    );
  return c.json({ ...envelope, data: envelope.data.map(releaseRow) });
}
export async function getFleetRelease(
  c: ApiContext,
  id: string,
): Promise<Response> {
  await requireScope(c, "admin");
  return c.json(await release(c.env.DB, id), 200);
}
export async function approveFleetRelease(
  c: ApiContext,
  id: string,
  raw: FleetReleaseSpec,
): Promise<Response> {
  await requireScope(c, "admin");
  const spec = FleetReleaseSpec.parse(raw),
    specJson = canonical(spec),
    hash = await sha256(specJson);
  // Gate flags are never typed by hand: only a completed qualification run's receipt is accepted.
  if (spec.thin_storage_qualification)
    await assertThinQualificationReceipt(
      c.env.DB,
      spec.thin_storage_qualification,
    );
  const read = async () => {
    const current = await release(c.env.DB, id);
    if (current.spec_sha256 !== hash || canonical(current.spec) !== specJson)
      return conflict("An approved fleet release is immutable");
    return c.json(current, 200);
  };
  return withIdempotency(c, {
    replay: read,
    execute: async (lease) => {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO fleet_releases(id,spec_json,spec_sha256,approved_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING",
        ).bind(id, specJson, hash, new Date().toISOString()),
        lease.completeStatement(id, 200, {
          sql: "EXISTS(SELECT 1 FROM fleet_releases WHERE id=? AND spec_sha256=? AND spec_json=?)",
          bindings: [id, hash, specJson],
        }),
      ]);
      return read();
    },
  });
}
export async function readFleetRegionRelease(db: D1Database, regionId: string) {
  const row = await db
    .prepare(
      "SELECT r.id region_id,f.revision,f.release_id desired_release_id,f.updated_at FROM regions r LEFT JOIN fleet_region_releases f ON f.region_id=r.id WHERE r.id=?",
    )
    .bind(regionId)
    .first();
  if (!row) throw new ApiError("not_found", "Region not found");
  return FleetRegionReleaseStatus.parse({
    ...row,
    revision: row.revision ?? 0,
  });
}
export async function getFleetRegionRelease(
  c: ApiContext,
  regionId: string,
): Promise<Response> {
  await requireScope(c, "admin");
  return c.json(await readFleetRegionRelease(c.env.DB, regionId), 200);
}
export async function assignFleetRegionRelease(
  c: ApiContext,
  regionId: string,
  input: FleetRegionReleaseUpdate,
): Promise<Response> {
  await requireScope(c, "admin");
  await release(c.env.DB, input.release_id);
  await readFleetRegionRelease(c.env.DB, regionId);
  const read = async () => {
    const result = await readFleetRegionRelease(c.env.DB, regionId);
    if (
      result.revision !== input.expected_revision + 1 ||
      result.desired_release_id !== input.release_id
    )
      return conflict("Region release assignment changed");
    return c.json(result, 200);
  };
  return withIdempotency(c, {
    replay: read,
    execute: async (lease) => {
      const results = await withAdmissionMutation(
        c.env,
        [],
        async (mutation) => {
          const guard = mutation.scopeGuard();
          return mutation.batch([
            c.env.DB.prepare(
              `INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at)
          SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM regions WHERE id=?)
            AND ${guard.sql}
            AND (?=0 OR EXISTS(SELECT 1 FROM fleet_region_releases WHERE region_id=? AND revision=?))
          ON CONFLICT(region_id) DO UPDATE SET release_id=excluded.release_id,
            revision=excluded.revision,updated_at=excluded.updated_at WHERE fleet_region_releases.revision=?`,
            ).bind(
              regionId,
              input.release_id,
              input.expected_revision + 1,
              new Date().toISOString(),
              regionId,
              ...guard.bindings,
              input.expected_revision,
              regionId,
              input.expected_revision,
              input.expected_revision,
            ),
            lease.completeStatement(regionId, 200, {
              sql: "changes()=1",
              bindings: [],
            }),
          ]);
        },
        { kind: "region", id: regionId },
      );
      if (results[0]!.meta.changes !== 1)
        return conflict("Region release assignment changed");
      return read();
    },
  });
}
interface NodeReleaseRow {
  node_id: string;
  region_id: string;
  node_uid: string | null;
  lost_at: string | null;
  database_placement_enabled: number;
  revision: number | null;
  release_id: string | null;
  role: "control_relay" | "customer" | null;
  assigned_uid: string | null;
  agent_key_hash: string;
  observed_agent_key_hash: string | null;
  observed_uid: string | null;
  observed_revision: number | null;
  observed_at: string | null;
  facts_json: string | null;
}
const nodeReleaseSelect = `SELECT n.id node_id,n.region_id,n.node_uid,n.lost_at,n.database_placement_enabled,
    a.revision,a.release_id,a.role,a.node_uid assigned_uid,r.agent_key_hash,
    o.agent_key_hash observed_agent_key_hash,o.node_uid observed_uid,o.assignment_revision observed_revision,o.observed_at,o.facts_json
    FROM nodes n JOIN regions r ON r.id=n.region_id LEFT JOIN fleet_node_releases a ON a.node_id=n.id
    LEFT JOIN fleet_node_release_observations o ON o.node_id=n.id`;
async function nodeRow(db: D1Database, id: string): Promise<NodeReleaseRow> {
  const row = await db
    .prepare(`${nodeReleaseSelect} WHERE n.id=?`)
    .bind(id)
    .first<NodeReleaseRow>();
  if (!row) throw new ApiError("not_found", "Node not found");
  return row;
}
export function mismatches(
  spec: FleetReleaseSpec,
  roleName: "control_relay" | "customer",
  facts: FleetNodeReleaseObservation["facts"],
): string[] {
  const role = spec.roles[roleName],
    result: string[] = [];
  for (const key of [
    "talos_version",
    "talos_installer",
    "talos_schematic_sha256",
    "kubernetes_version",
  ] as const) {
    const actual = facts[key],
      wanted = role[key];
    if (actual === undefined) result.push(`unobserved/${key}`);
    else if (
      (key.endsWith("_version") ? actual.replace(/^v/, "") : actual) !==
      (key.endsWith("_version") ? wanted.replace(/^v/, "") : wanted)
    )
      result.push(key);
  }
  if (facts.configuration_schema_revision === undefined)
    result.push("unobserved/configuration_schema_revision");
  else if (
    facts.configuration_schema_revision !== spec.configuration_schema_revision
  )
    result.push("configuration_schema_revision");
  if (spec.platform_source_commit) {
    if (facts.platform_source_commit === undefined)
      result.push("unobserved/platform_source_commit");
    else if (facts.platform_source_commit !== spec.platform_source_commit)
      result.push("platform_source_commit");
  }
  if (role.kubernetes_images) {
    const proof = facts.kubernetes_image_provenance,
      keys = proof?.control_plane
        ? (["kubelet", "apiServer", "controllerManager", "scheduler"] as const)
        : (["kubelet"] as const);
    if (!proof) result.push("unobserved/kubernetes_images");
    else {
      if (
        facts.kubernetes_control_plane !== proof.control_plane ||
        facts.kubelet_version?.replace(/^v/, "") !==
          proof.kubelet_version.replace(/^v/, "")
      )
        result.push("kubernetes_images/identity");
      for (const key of keys) {
        const value = proof.images[key],
          expected = role.kubernetes_images[key];
        if (!value) result.push(`unobserved/kubernetes_images/${key}`);
        else if (
          value.configuration !== expected ||
          value.runtime_sha256 !== expected.slice(-64)
        )
          result.push(`kubernetes_images/${key}`);
        if (key !== "kubelet") {
          if (facts.kubernetes_static_images?.[key] === undefined)
            result.push(`unobserved/kubernetes_static_images/${key}`);
          else if (facts.kubernetes_static_images[key] !== expected.slice(-64))
            result.push(`kubernetes_static_images/${key}`);
        }
      }
    }
  }
  const wantedNames = new Set([...role.components, ...role.talos_extensions]);
  const observed = new Map(
    facts.components.map((value) => [value.name, value]),
  );
  for (const component of spec.components.filter((value) =>
    wantedNames.has(value.name),
  )) {
    const actual = observed.get(component.name);
    if (!actual || actual.version === undefined || actual.sha256 === undefined)
      result.push(`unobserved/components/${component.name}`);
    else if (
      actual.version !== component.version ||
      actual.sha256 !== component.sha256
    )
      result.push(`components/${component.name}`);
  }
  for (const name of observed.keys())
    if (!wantedNames.has(name)) result.push(`components/${name}/unexpected`);
  return result.sort();
}
export async function readFleetNodeRelease(
  db: D1Database,
  id: string,
): Promise<FleetNodeReleaseStatus> {
  const row = await nodeRow(db, id),
    desired = row.release_id ? await release(db, row.release_id) : null;
  return nodeReleaseStatus(db, row, desired);
}
async function nodeReleaseStatus(
  db: D1Database,
  row: NodeReleaseRow,
  desired: FleetRelease | null,
): Promise<FleetNodeReleaseStatus> {
  let state: FleetNodeReleaseStatus["state"] = "unassigned";
  let differences: string[] = [];
  if (desired) {
    if (row.lost_at || row.node_uid !== row.assigned_uid)
      state = "identity_changed";
    else if (
      !row.facts_json ||
      row.observed_uid !== row.node_uid ||
      row.observed_revision !== row.revision ||
      row.observed_agent_key_hash !== row.agent_key_hash
    )
      state = "pending";
    else if (
      Date.parse(row.observed_at!) < Date.now() - 180000 ||
      Date.parse(row.observed_at!) > Date.now() + 5000
    )
      state = "stale";
    else {
      differences = mismatches(
        desired.spec,
        row.role!,
        FleetNodeReleaseObservation.shape.facts.parse(
          JSON.parse(row.facts_json),
        ),
      );
      state = differences.some((value) => !value.startsWith("unobserved/"))
        ? "drifted"
        : differences.length
          ? "pending"
          : "converged";
    }
  }
  if (
    state === "converged" &&
    (await db
      .prepare(
        `SELECT 1 waiting FROM fleet_patch_operations h WHERE h.node_id=? AND h.node_uid=? AND h.release_id=? AND h.assignment_revision=? AND h.stage='host_ready' AND NOT EXISTS(SELECT 1 FROM fleet_patch_operations f WHERE f.finalization_of=h.operation_id AND f.stage='complete' AND f.state='confirmed') LIMIT 1`,
      )
      .bind(row.node_id, row.node_uid, row.release_id, row.revision)
      .first())
  ) {
    state = "pending";
    differences.push("unobserved/regional_runtime_activation");
  }
  if (
    state === "converged" &&
    desired?.spec.roles[row.role!].host_configuration_required &&
    !(await db
      .prepare(
        `SELECT 1 current FROM node_host_configurations h JOIN regions r ON r.id=h.region_id WHERE h.node_id=? AND h.node_uid=? AND h.release_id=? AND h.material_revision=r.bootstrap_material_revision AND EXISTS(SELECT 1 FROM fleet_patch_operations f WHERE f.node_id=h.node_id AND f.node_uid=h.node_uid AND f.release_id=h.release_id AND f.assignment_revision=? AND f.material_revision=h.material_revision AND f.stage='complete' AND f.state='confirmed' AND CASE WHEN EXISTS(SELECT 1 FROM node_region_policies x WHERE x.region_id=h.region_id AND x.compute_pool_json IS NOT NULL) THEN EXISTS(SELECT 1 FROM node_compute_pool_policies p JOIN node_compute_pool_observations o ON o.node_id=p.node_id WHERE p.node_id=h.node_id AND o.node_uid=h.node_uid AND o.policy_revision=p.revision AND o.material_revision=h.material_revision AND julianday(o.observed_at)>=julianday('now','-120 seconds')) ELSE json_extract(f.observed_json,'$.host_configuration_sha256')=h.sha256 END)`,
      )
      .bind(row.node_id, row.node_uid, row.release_id, row.revision)
      .first())
  ) {
    state = "pending";
    differences.push("unobserved/current_material_runtime");
  }
  if (state === "converged") {
    const { readCurrentNodeThinStorage } =
        await import("./node-thin-storage.ts"),
      storage = await readCurrentNodeThinStorage({ DB: db }, row.node_id);
    // A receipt binds members that take databases; control/relay without placement stays thick.
    if (
      ((desired?.spec.thin_storage_qualification &&
        row.database_placement_enabled === 1) ||
        storage) &&
      !storage?.authority?.write_allowed
    ) {
      state = "pending";
      differences.push("unobserved/current_material_storage");
    }
  }
  return FleetNodeReleaseStatus.parse({
    node_id: row.node_id,
    region_id: row.region_id,
    node_uid: row.node_uid,
    revision: row.revision ?? 0,
    role: row.role,
    desired_release_id: row.release_id,
    desired_spec_sha256: desired?.spec_sha256 ?? null,
    state,
    observed_at: row.observed_at,
    observed_facts: row.facts_json
      ? FleetNodeReleaseObservation.shape.facts.parse(
          JSON.parse(row.facts_json),
        )
      : null,
    mismatches: differences,
  });
}

/** The same release projection, with shared base/spec reads batched for a bounded admin page. */
export async function readFleetNodeReleaseInventories(
  db: D1Database,
  ids: string[],
): Promise<
  Map<
    string,
    {
      status: FleetNodeReleaseStatus;
      role: NodeReleaseRow["role"];
      observationState: "current" | "stale" | "unobserved";
    }
  >
> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .prepare(
      `${nodeReleaseSelect} WHERE n.id IN(SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(ids))
    .all<NodeReleaseRow>();
  const releaseIds = [
    ...new Set(
      rows.results.flatMap((row) => (row.release_id ? [row.release_id] : [])),
    ),
  ];
  const releases = new Map<string, FleetRelease>();
  if (releaseIds.length) {
    const specs = await db
      .prepare(
        "SELECT id,spec_json,spec_sha256,approved_at FROM fleet_releases WHERE id IN(SELECT value FROM json_each(?))",
      )
      .bind(JSON.stringify(releaseIds))
      .all<{
        id: string;
        spec_json: string;
        spec_sha256: string;
        approved_at: string;
      }>();
    for (const spec of specs.results)
      releases.set(
        spec.id,
        FleetRelease.parse({
          id: spec.id,
          spec: JSON.parse(spec.spec_json),
          spec_sha256: spec.spec_sha256,
          approved_at: spec.approved_at,
        }),
      );
  }
  return new Map(
    await Promise.all(
      rows.results.map(async (row) => {
        const desired = row.release_id ? releases.get(row.release_id) : null;
        if (desired === undefined)
          throw new ApiError("not_found", "Fleet release not found");
        const status = await nodeReleaseStatus(db, row, desired);
        const assigned =
          !row.lost_at &&
          row.node_uid !== null &&
          row.node_uid === row.assigned_uid;
        const bound =
          assigned &&
          row.facts_json !== null &&
          row.observed_uid === row.node_uid &&
          row.observed_revision === row.revision &&
          row.observed_agent_key_hash === row.agent_key_hash;
        const at =
          row.observed_at === null ? Number.NaN : Date.parse(row.observed_at);
        const observationState = !bound
          ? ("unobserved" as const)
          : at < Date.now() - 180_000 || at > Date.now() + 5_000
            ? ("stale" as const)
            : ("current" as const);
        return [
          row.node_id,
          { status, role: assigned ? row.role : null, observationState },
        ] as const;
      }),
    ),
  );
}
export async function getFleetNodeRelease(
  c: ApiContext,
  id: string,
): Promise<Response> {
  await requireScope(c, "admin");
  return c.json(await readFleetNodeRelease(c.env.DB, id), 200);
}
export async function assignFleetNodeRelease(
  c: ApiContext,
  id: string,
  input: FleetNodeReleaseUpdate,
): Promise<Response> {
  await requireScope(c, "admin");
  await release(c.env.DB, input.release_id);
  const node = await nodeRow(c.env.DB, id);
  const read = async () => {
    const row = await nodeRow(c.env.DB, id);
    if (
      row.revision !== input.expected_revision + 1 ||
      row.release_id !== input.release_id ||
      row.role !== input.role ||
      row.assigned_uid !== input.node_uid ||
      row.node_uid !== input.node_uid ||
      row.lost_at
    )
      return conflict("Node release assignment changed");
    return c.json(await readFleetNodeRelease(c.env.DB, id), 200);
  };
  return withIdempotency(c, {
    replay: read,
    execute: async (lease) => {
      const guard =
        "EXISTS(SELECT 1 FROM nodes n JOIN fleet_region_releases r ON r.region_id=n.region_id WHERE n.id=? AND n.node_uid=? AND n.lost_at IS NULL AND r.release_id=?)";
      const identity = [id, input.node_uid, input.release_id];
      const results = await withAdmissionMutation(
        c.env,
        [],
        async (mutation) => {
          const admission = mutation.scopeGuard();
          return mutation.batch([
            c.env.DB.prepare(
              `INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at)
          SELECT ?,?,?,?,?,? WHERE ${guard}
            AND ${admission.sql}
            AND (?=0 OR EXISTS(SELECT 1 FROM fleet_node_releases WHERE node_id=? AND revision=?))
          ON CONFLICT(node_id) DO UPDATE SET node_uid=excluded.node_uid,release_id=excluded.release_id,
            role=excluded.role,revision=excluded.revision,updated_at=excluded.updated_at WHERE fleet_node_releases.revision=?`,
            ).bind(
              id,
              input.node_uid,
              input.release_id,
              input.role,
              input.expected_revision + 1,
              new Date().toISOString(),
              ...identity,
              ...admission.bindings,
              input.expected_revision,
              id,
              input.expected_revision,
              input.expected_revision,
            ),
            lease.completeStatement(id, 200, {
              sql: "changes()=1",
              bindings: [],
            }),
          ]);
        },
        { kind: "region", id: node.region_id },
      );
      if (results[0]!.meta.changes !== 1)
        return conflict("Node release assignment changed");
      return read();
    },
  });
}
/** Authenticated inventory, not an independent cryptographic attestation or permission to patch. */
export async function observeFleetNodeRelease(
  c: ApiContext,
  raw: FleetNodeReleaseObservation,
): Promise<Response> {
  const region = await agentRegion(c),
    input = FleetNodeReleaseObservation.parse(raw),
    now = Date.now();
  if (
    Date.parse(input.observed_at) < now - 180000 ||
    Date.parse(input.observed_at) > now + 5000
  )
    return conflict("Fleet observation is not fresh");
  // Only the qualified Native patch completion writes a new deployment receipt.
  // Ordinary Regional inventory can retain that receipt, never create one.
  if (
    input.facts.talos_provenance !== undefined ||
    input.facts.kubernetes_image_provenance !== undefined
  )
    return conflict(
      "Deployment provenance is written by the qualified patch executor",
    );
  const before = await nodeRow(c.env.DB, input.node_id);
  if (before.region_id !== region.id || !before.release_id || !before.role)
    return conflict("Fleet observation authority or node identity changed");
  const selected = await release(c.env.DB, before.release_id),
    role = selected.spec.roles[before.role],
    old = before.facts_json
      ? FleetNodeReleaseObservation.shape.facts.parse(
          JSON.parse(before.facts_json),
        )
      : null,
    receipt = old?.talos_provenance,
    version = (value: string | undefined) => value?.replace(/^v/, "");
  if (
    input.facts.components.some((component) =>
      role.talos_extensions.includes(component.name),
    )
  )
    return conflict(
      "Loaded OS extension facts are written by the qualified patch executor",
    );
  const receiptCurrent = !!(
    receipt &&
    old &&
    before.node_uid === input.node_uid &&
    before.assigned_uid === input.node_uid &&
    before.observed_uid === input.node_uid &&
    before.lost_at === null &&
    before.revision === input.assignment_revision &&
    before.observed_revision === input.assignment_revision &&
    before.agent_key_hash === region.agent_key_hash &&
    before.observed_agent_key_hash === region.agent_key_hash &&
    receipt.node_uid === input.node_uid &&
    receipt.boot_id === old.boot_id &&
    receipt.installer === old.talos_installer &&
    receipt.installer === role.talos_installer &&
    old.talos_schematic_sha256 === role.talos_schematic_sha256 &&
    version(old.talos_version) === version(role.talos_version)
  );
  // Missing runtime identity cannot extend the lifetime of the previous proof.
  // Keep its original timestamp so a later valid report can recover or it becomes stale.
  if (receiptCurrent && (!input.facts.boot_id || !input.facts.talos_version))
    return conflict(
      "Fresh boot identity and Talos version are required for deployment provenance",
    );
  const preserve =
    receiptCurrent &&
    input.facts.boot_id === old!.boot_id &&
    version(input.facts.talos_version) === version(old!.talos_version) &&
    (input.facts.talos_installer === undefined ||
      input.facts.talos_installer === old!.talos_installer) &&
    (input.facts.talos_schematic_sha256 === undefined ||
      input.facts.talos_schematic_sha256 === old!.talos_schematic_sha256);
  const kubeProof = old?.kubernetes_image_provenance;
  const preserveKube =
    preserve &&
    !!kubeProof &&
    input.facts.kubernetes_control_plane === kubeProof.control_plane &&
    version(input.facts.kubelet_version) ===
      version(kubeProof.kubelet_version) &&
    version(input.facts.kubelet_version) === version(old?.kubelet_version) &&
    version(input.facts.kubelet_version) === version(role.kubernetes_version) &&
    !!role.kubernetes_images &&
    Object.entries(kubeProof.images).every(
      ([name, value]) =>
        value.configuration ===
          role.kubernetes_images?.[
            name as keyof typeof role.kubernetes_images
          ] && value.runtime_sha256 === value.configuration.slice(-64),
    );
  // Raw imageIDs may name the immutable OCI parent. Only fresh same-boot reports
  // may map that parent to the release's unique Linux/AMD64 manifest.
  const currentFacts = structuredClone(input.facts);
  const deadline = new AbortController(),
    timer = preserveKube
      ? setTimeout(() => deadline.abort(), 20_000)
      : undefined;
  const signal = deadline.signal;
  try {
    for (const actual of currentFacts.components) {
      const pin = selected.spec.components.find(
        (component) =>
          component.name === actual.name && component.kind === "image",
      );
      if (!pin || !actual.runtime_image_sha256) continue;
      const normalized =
        actual.runtime_image_sha256 === pin.sha256
          ? pin.sha256
          : preserveKube
            ? await normalizeRuntimeImageManifest(
                pin.reference,
                pin.sha256,
                actual.runtime_image_sha256,
                { signal },
              )
            : undefined;
      if (normalized) {
        actual.version ??= pin.version;
        actual.sha256 ??= normalized;
      } else if (actual.sha256 === pin.sha256) {
        // An unproved contradictory runtime cannot retain a claimed target pin.
        delete actual.sha256;
        if (actual.version === pin.version) delete actual.version;
      }
    }
    if (preserveKube) {
      for (const name of [
        "apiServer",
        "controllerManager",
        "scheduler",
      ] as const) {
        const reported = currentFacts.kubernetes_static_images?.[name],
          expected = role.kubernetes_images?.[name];
        if (!reported || !expected) continue;
        const normalized = await normalizeRuntimeImageManifest(
          expected,
          expected.slice(-64),
          reported,
          { signal },
        );
        if (normalized)
          currentFacts.kubernetes_static_images![name] = normalized;
      }
      if (Date.parse(input.observed_at) < Date.now() - 180_000)
        return conflict("Fleet observation is not fresh");
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const facts = preserve
    ? {
        ...currentFacts,
        talos_installer: old!.talos_installer,
        talos_schematic_sha256: old!.talos_schematic_sha256,
        talos_provenance: receipt,
        components: [
          ...currentFacts.components,
          ...old!.components.filter(
            (component) =>
              role.talos_extensions.includes(component.name) &&
              selected.spec.components.some(
                (pin) =>
                  pin.name === component.name &&
                  pin.version === component.version &&
                  pin.sha256 === component.sha256,
              ),
          ),
        ],
        ...(preserveKube ? { kubernetes_image_provenance: kubeProof } : {}),
      }
    : currentFacts;
  // Fence the exact prior observation. A concurrent Native receipt must win over
  // a partial merge prepared before that receipt was committed.
  const previous =
    before.facts_json === null
      ? {
          sql: "NOT EXISTS(SELECT 1 FROM fleet_node_release_observations o WHERE o.node_id=?)",
          bindings: [input.node_id],
        }
      : {
          sql: `EXISTS(SELECT 1 FROM fleet_node_release_observations o WHERE o.node_id=? AND o.node_uid=?
        AND o.assignment_revision=? AND o.agent_key_hash=? AND o.observed_at=? AND o.facts_json=?)`,
          bindings: [
            input.node_id,
            before.observed_uid,
            before.observed_revision,
            before.observed_agent_key_hash,
            before.observed_at,
            before.facts_json,
          ],
        };
  const identity = (value: typeof facts | null) =>
    value === null
      ? null
      : canonical({
          boot_id: value.boot_id,
          talos_version: value.talos_version,
          talos_installer: value.talos_installer,
          talos_schematic_sha256: value.talos_schematic_sha256,
          platform_source_commit: value.platform_source_commit,
          configuration_schema_revision: value.configuration_schema_revision,
          kubernetes_version: value.kubernetes_version,
          kubelet_version: value.kubelet_version,
          kubernetes_control_plane: value.kubernetes_control_plane,
          components: [...value.components].sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
          ),
        });
  const invalidates =
    selected.spec.admission_snapshot_version === 1 &&
    identity(old) !== identity(facts);
  const execute = async (mutation?: AdmissionMutation) => {
    const admission = mutation?.scopeGuard(),
      statement = c.env.DB.prepare(
        `INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM nodes n JOIN regions r ON r.id=n.region_id JOIN fleet_node_releases a ON a.node_id=n.id
      WHERE n.id=? AND n.region_id=? AND n.node_uid=? AND n.lost_at IS NULL AND r.agent_key_hash=? AND a.node_uid=n.node_uid AND a.revision=?
        AND a.release_id=? AND a.role=? AND EXISTS(SELECT 1 FROM fleet_releases f WHERE f.id=a.release_id AND f.spec_sha256=?))
      AND julianday(?)>=julianday('now','-180 seconds') AND julianday(?)<=julianday('now','+5 seconds')
      AND (${previous.sql})
      AND (${admission?.sql ?? "1=1"})
    ON CONFLICT(node_id) DO UPDATE SET node_uid=excluded.node_uid,assignment_revision=excluded.assignment_revision,
      agent_key_hash=excluded.agent_key_hash,facts_json=excluded.facts_json,observed_at=excluded.observed_at,received_at=excluded.received_at
      WHERE excluded.observed_at>fleet_node_release_observations.observed_at
        OR (excluded.observed_at=fleet_node_release_observations.observed_at AND excluded.node_uid=fleet_node_release_observations.node_uid
          AND excluded.assignment_revision=fleet_node_release_observations.assignment_revision AND excluded.agent_key_hash=fleet_node_release_observations.agent_key_hash
          AND excluded.facts_json=fleet_node_release_observations.facts_json)`,
      ).bind(
        input.node_id,
        input.node_uid,
        input.assignment_revision,
        region.agent_key_hash,
        canonical(facts),
        input.observed_at,
        new Date(now).toISOString(),
        input.node_id,
        region.id,
        input.node_uid,
        region.agent_key_hash,
        input.assignment_revision,
        before.release_id,
        before.role,
        selected.spec_sha256,
        input.observed_at,
        input.observed_at,
        ...previous.bindings,
        ...(admission?.bindings ?? []),
      );
    return mutation ? (await mutation.batch([statement]))[0]! : statement.run();
  };
  const result = invalidates
    ? await withAdmissionMutation(c.env, [], execute, {
        kind: "region",
        id: region.id,
      })
    : await execute();
  if (result.meta.changes !== 1)
    return conflict("Fleet observation authority or node identity changed");
  return c.json({ accepted: true }, 200);
}

/**
 * Every gateway of the region verifies route token v3: its assigned release declares v3 and every
 * current assigned member confirmed a patch of that release at its assignment and the region
 * revision. A patch confirms only once every gateway Pod runs the release's pinned image. A new
 * region or node assignment clears it before any patch can start an older gateway.
 */
export function routeTokenV3Sql(region: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(region))
    throw new Error("invalid_route_token_region_alias");
  return `EXISTS(SELECT 1 FROM fleet_region_releases vf JOIN fleet_releases vs ON vs.id=vf.release_id
    WHERE vf.region_id=${region}.id AND json_extract(vs.spec_json,'$.route_token_version') IN(3,4)
    AND EXISTS(SELECT 1 FROM nodes vn JOIN fleet_node_releases va ON va.node_id=vn.id WHERE vn.region_id=vf.region_id AND vn.lost_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM nodes vn JOIN fleet_node_releases va ON va.node_id=vn.id WHERE vn.region_id=vf.region_id AND vn.lost_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM fleet_patch_operations vp WHERE vp.node_id=vn.id AND vp.node_uid=vn.node_uid AND vp.release_id=vf.release_id
        AND vp.assignment_revision=va.revision AND vp.region_revision=vf.revision AND vp.stage='complete' AND vp.state='confirmed')))`;
}

/**
 * A qualification run or a thin selection needs the region at exactly the release it is made for:
 * the region's release declares the sampling protocol and every assigned member confirmed a patch
 * of that release at its assignment and the region revision.
 */
export function thinStorageSamplingSql(region: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(region))
    throw new Error("invalid_sampling_region_alias");
  return `EXISTS(SELECT 1 FROM fleet_region_releases sf JOIN fleet_releases ss ON ss.id=sf.release_id
    WHERE sf.region_id=${region}.id AND json_extract(ss.spec_json,'$.thin_storage_sampling_version')=1
    AND EXISTS(SELECT 1 FROM nodes sn JOIN fleet_node_releases sa ON sa.node_id=sn.id WHERE sn.region_id=sf.region_id AND sn.lost_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM nodes sn JOIN fleet_node_releases sa ON sa.node_id=sn.id WHERE sn.region_id=sf.region_id AND sn.lost_at IS NULL
      AND (sa.node_uid<>sn.node_uid OR sa.release_id<>sf.release_id OR NOT EXISTS(SELECT 1 FROM fleet_patch_operations sp
        WHERE sp.node_id=sn.id AND sp.node_uid=sn.node_uid AND sp.release_id=sf.release_id AND sp.spec_sha256=ss.spec_sha256
        AND sp.assignment_revision=sa.revision AND sp.region_revision=sf.revision AND sp.stage='complete' AND sp.state='confirmed' AND sp.error_code IS NULL))))`;
}
export async function thinStorageSamplingCapable(
  db: D1Database,
  regionId: string,
) {
  return Boolean(
    await db
      .prepare(
        `SELECT 1 FROM regions sr WHERE sr.id=? AND ${thinStorageSamplingSql("sr")}`,
      )
      .bind(regionId)
      .first(),
  );
}
/**
 * The strict desired schemas are served only to controllers that parse them: the region's release
 * declares the sampling protocol and the latest completed patch of every assigned member was of a
 * release that declares it. A rollout between two such releases changes no controller schema, so
 * it does not close the wire; a member last patched at a release without the protocol does.
 */
export function thinStorageSamplingProtocolSql(region: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(region))
    throw new Error("invalid_sampling_region_alias");
  return `EXISTS(SELECT 1 FROM fleet_region_releases pf JOIN fleet_releases ps ON ps.id=pf.release_id
    WHERE pf.region_id=${region}.id AND json_extract(ps.spec_json,'$.thin_storage_sampling_version')=1
    AND EXISTS(SELECT 1 FROM nodes pn JOIN fleet_node_releases pa ON pa.node_id=pn.id WHERE pn.region_id=pf.region_id AND pn.lost_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM nodes pn JOIN fleet_node_releases pa ON pa.node_id=pn.id WHERE pn.region_id=pf.region_id AND pn.lost_at IS NULL
      AND (pa.node_uid<>pn.node_uid OR pa.release_id<>pf.release_id OR NOT EXISTS(SELECT 1 FROM fleet_patch_operations pp JOIN fleet_releases pr ON pr.id=pp.release_id
        WHERE pp.operation_id=(SELECT x.operation_id FROM fleet_patch_operations x WHERE x.node_id=pn.id AND x.node_uid=pn.node_uid
          AND x.stage='complete' AND x.state='confirmed' AND x.error_code IS NULL ORDER BY x.updated_at DESC,x.rowid DESC LIMIT 1)
        AND json_extract(pr.spec_json,'$.thin_storage_sampling_version')=1))))`;
}
export async function thinStorageSamplingProtocolCapable(
  db: D1Database,
  regionId: string,
) {
  return Boolean(
    await db
      .prepare(
        `SELECT 1 FROM regions pr WHERE pr.id=? AND ${thinStorageSamplingProtocolSql("pr")}`,
      )
      .bind(regionId)
      .first(),
  );
}
/** Full snapshot wire fields require every current physical member's exact confirmed release. */
export function admissionSnapshotSql(region: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(region))
    throw new Error("invalid_admission_region_alias");
  return `EXISTS(SELECT 1 FROM fleet_region_releases af JOIN fleet_releases ars ON ars.id=af.release_id
    WHERE af.region_id=${region}.id AND json_extract(ars.spec_json,'$.route_token_version')=4
      AND json_extract(ars.spec_json,'$.runtime_attestation_version')=2 AND json_extract(ars.spec_json,'$.admission_snapshot_version')=1
      AND NOT EXISTS(SELECT 1 FROM fleet_patch_operations pending_patch WHERE pending_patch.region_id=af.region_id
        AND pending_patch.stage NOT IN('complete','host_ready')
        AND NOT(pending_patch.stage IN('flux','platform','regional') AND pending_patch.state='halted' AND pending_patch.error_code IS 'operator_hold_superseded'))
      AND EXISTS(SELECT 1 FROM nodes an WHERE an.region_id=af.region_id AND an.lost_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM nodes an LEFT JOIN fleet_node_releases aa ON aa.node_id=an.id
        WHERE an.region_id=af.region_id AND an.lost_at IS NULL
          AND (aa.node_id IS NULL OR aa.node_uid<>an.node_uid OR aa.release_id<>af.release_id
            OR NOT EXISTS(SELECT 1 FROM fleet_patch_operations ap WHERE ap.node_id=an.id AND ap.node_uid=an.node_uid
              AND ap.release_id=af.release_id AND ap.spec_sha256=ars.spec_sha256 AND ap.assignment_revision=aa.revision
              AND ap.region_revision=af.revision AND ap.stage='complete' AND ap.state='confirmed' AND ap.error_code IS NULL)
            OR EXISTS(SELECT 1 FROM fleet_node_release_observations ao WHERE ao.node_id=an.id AND (ao.node_uid<>an.node_uid OR ao.assignment_revision<>aa.revision OR ao.agent_key_hash<>${region}.agent_key_hash
              OR EXISTS(SELECT 1 FROM json_each(ars.spec_json,'$.components') ac WHERE json_extract(ac.value,'$.name') IN('native-controller','native-gateway') AND NOT EXISTS(SELECT 1 FROM json_each(ao.facts_json,'$.components') oc WHERE json_extract(oc.value,'$.name')=json_extract(ac.value,'$.name') AND json_extract(oc.value,'$.sha256')=json_extract(ac.value,'$.sha256'))))))))`;
}
export async function admissionSnapshotCapable(
  db: D1Database,
  regionId: string,
) {
  return Boolean(
    await db
      .prepare(
        `SELECT 1 FROM regions ar WHERE ar.id=? AND ${admissionSnapshotSql("ar")}`,
      )
      .bind(regionId)
      .first(),
  );
}
/** Only explicitly assigned, current physical nodes receive this release. No legacy wire change when unassigned. */
export async function readDesiredFleetRelease(
  db: D1Database,
  regionId: string,
): Promise<FleetDesiredRelease | undefined> {
  const state = await readFleetRegionRelease(db, regionId);
  if (state.desired_release_id === null) return undefined;
  const selected = await release(db, state.desired_release_id);
  const nodes = await db
    .prepare(
      `SELECT n.id node_id,n.node_uid,n.k8s_node_name,a.role,a.revision
    FROM nodes n JOIN fleet_node_releases a ON a.node_id=n.id
    WHERE n.region_id=? AND a.release_id=? AND n.lost_at IS NULL AND a.node_uid=n.node_uid ORDER BY n.id`,
    )
    .bind(regionId, selected.id)
    .all();
  const after = await readFleetRegionRelease(db, regionId);
  if (
    after.revision !== state.revision ||
    after.desired_release_id !== selected.id
  )
    return conflict("Region release changed during desired-state read");
  // Provisioning-only artifacts and the Cloudflare-side route-token capability are outside the
  // runtime agent's inventory wire view, which deployed strict agents parse.
  // Keep the assigned full-spec hash and the complete immutable DB/admin/AddNode record.
  const {
    talos_raw_image: provisioningImage,
    route_token_version: routeTokenVersion,
    thin_storage_sampling_version: samplingVersion,
    runtime_attestation_version: runtimeAttestationVersion,
    admission_snapshot_version: admissionSnapshotVersion,
    ...runtimeSpec
  } = selected.spec;
  void provisioningImage;
  void routeTokenVersion;
  void samplingVersion;
  void runtimeAttestationVersion;
  void admissionSnapshotVersion;
  return FleetDesiredRelease.parse({
    region_id: regionId,
    region_revision: state.revision,
    release: { ...selected, spec: runtimeSpec },
    nodes: nodes.results,
  });
}
