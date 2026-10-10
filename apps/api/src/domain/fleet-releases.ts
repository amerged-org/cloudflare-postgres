// SPDX-License-Identifier: Apache-2.0
import { bytesToHex } from "@pgcf/contracts";
import {
  FleetRelease,
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
async function release(db: D1Database, id: string): Promise<FleetRelease> {
  const row = await db
    .prepare(
      "SELECT id,spec_json,spec_sha256,approved_at FROM fleet_releases WHERE id=?",
    )
    .bind(id)
    .first<{
      id: string;
      spec_json: string;
      spec_sha256: string;
      approved_at: string;
    }>();
  if (!row) throw new ApiError("not_found", "Fleet release not found");
  return FleetRelease.parse({
    id: row.id,
    spec: JSON.parse(row.spec_json),
    spec_sha256: row.spec_sha256,
    approved_at: row.approved_at,
  });
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
      const results = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO fleet_region_releases(region_id,release_id,revision,updated_at)
          SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM regions WHERE id=?)
            AND (?=0 OR EXISTS(SELECT 1 FROM fleet_region_releases WHERE region_id=? AND revision=?))
          ON CONFLICT(region_id) DO UPDATE SET release_id=excluded.release_id,
            revision=excluded.revision,updated_at=excluded.updated_at WHERE fleet_region_releases.revision=?`,
        ).bind(
          regionId,
          input.release_id,
          input.expected_revision + 1,
          new Date().toISOString(),
          regionId,
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
async function nodeRow(db: D1Database, id: string): Promise<NodeReleaseRow> {
  const row = await db
    .prepare(
      `SELECT n.id node_id,n.region_id,n.node_uid,n.lost_at,
    a.revision,a.release_id,a.role,a.node_uid assigned_uid,r.agent_key_hash,
    o.agent_key_hash observed_agent_key_hash,o.node_uid observed_uid,o.assignment_revision observed_revision,o.observed_at,o.facts_json
    FROM nodes n JOIN regions r ON r.id=n.region_id LEFT JOIN fleet_node_releases a ON a.node_id=n.id
    LEFT JOIN fleet_node_release_observations o ON o.node_id=n.id WHERE n.id=?`,
    )
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
        `SELECT 1 current FROM node_host_configurations h JOIN regions r ON r.id=h.region_id JOIN node_compute_pool_policies p ON p.node_id=h.node_id JOIN node_compute_pool_observations o ON o.node_id=h.node_id WHERE h.node_id=? AND h.node_uid=? AND h.release_id=? AND h.material_revision=r.bootstrap_material_revision AND o.node_uid=h.node_uid AND o.policy_revision=p.revision AND o.material_revision=h.material_revision AND julianday(o.observed_at)>=julianday('now','-120 seconds') AND EXISTS(SELECT 1 FROM fleet_patch_operations f WHERE f.node_id=h.node_id AND f.node_uid=h.node_uid AND f.release_id=h.release_id AND f.assignment_revision=? AND f.material_revision=h.material_revision AND f.stage='complete' AND f.state='confirmed')`,
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
      storage = await readCurrentNodeThinStorage({ DB: db }, id);
    if (
      (desired?.spec.thin_storage_qualification || storage) &&
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
  await nodeRow(c.env.DB, id);
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
      const results = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO fleet_node_releases(node_id,node_uid,release_id,role,revision,updated_at)
          SELECT ?,?,?,?,?,? WHERE ${guard}
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
          input.expected_revision,
          id,
          input.expected_revision,
          input.expected_revision,
        ),
        lease.completeStatement(id, 200, { sql: "changes()=1", bindings: [] }),
      ]);
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
  const result = await c.env.DB.prepare(
    `INSERT INTO fleet_node_release_observations(node_id,node_uid,assignment_revision,agent_key_hash,facts_json,observed_at,received_at)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM nodes n JOIN regions r ON r.id=n.region_id JOIN fleet_node_releases a ON a.node_id=n.id
      WHERE n.id=? AND n.region_id=? AND n.node_uid=? AND n.lost_at IS NULL AND r.agent_key_hash=? AND a.node_uid=n.node_uid AND a.revision=?
        AND a.release_id=? AND a.role=? AND EXISTS(SELECT 1 FROM fleet_releases f WHERE f.id=a.release_id AND f.spec_sha256=?))
      AND julianday(?)>=julianday('now','-180 seconds') AND julianday(?)<=julianday('now','+5 seconds')
      AND (${previous.sql})
    ON CONFLICT(node_id) DO UPDATE SET node_uid=excluded.node_uid,assignment_revision=excluded.assignment_revision,
      agent_key_hash=excluded.agent_key_hash,facts_json=excluded.facts_json,observed_at=excluded.observed_at,received_at=excluded.received_at
      WHERE excluded.observed_at>fleet_node_release_observations.observed_at
        OR (excluded.observed_at=fleet_node_release_observations.observed_at AND excluded.node_uid=fleet_node_release_observations.node_uid
          AND excluded.assignment_revision=fleet_node_release_observations.assignment_revision AND excluded.agent_key_hash=fleet_node_release_observations.agent_key_hash
          AND excluded.facts_json=fleet_node_release_observations.facts_json)`,
  )
    .bind(
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
    )
    .run();
  if (result.meta.changes !== 1)
    return conflict("Fleet observation authority or node identity changed");
  return c.json({ accepted: true }, 200);
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
  // Provisioning-only artifacts are outside the runtime agent's inventory wire view.
  // Keep the assigned full-spec hash and the complete immutable DB/admin/AddNode record.
  const { talos_raw_image: provisioningImage, ...runtimeSpec } = selected.spec;
  void provisioningImage;
  return FleetDesiredRelease.parse({
    region_id: regionId,
    region_revision: state.revision,
    release: { ...selected, spec: runtimeSpec },
    nodes: nodes.results,
  });
}
