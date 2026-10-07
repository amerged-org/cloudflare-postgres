// SPDX-License-Identifier: Apache-2.0
import { base64urlToBytes, bytesToHex } from "@pgcf/contracts";
import { importBootstrapVerificationKeys } from "@pgcf/contracts/bootstrap-relay";
import {
  NodeBootstrapCheckpoint,
  NodeBootstrapStage,
} from "@pgcf/contracts/node-bootstrap";
import {
  NodeProofReport,
  canonicalNodeProof,
  type NodeProofClaims,
  type NodeProofMeasurement,
} from "@pgcf/contracts/node-proof";
import { z } from "zod";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
import {
  joinBundleReference,
  loadRegionJoinBundle,
} from "../crypto/bootstrap-credentials.ts";
import {
  canonicalNodeVerificationProof,
  nodeVerificationProofSchema,
  verifyNodeProofArtifact,
} from "../platform/nodes.ts";
import { bootstrapJobInput, readBootstrapJob } from "./bootstrap-jobs.ts";
import { installationHash } from "./node-installation.ts";
import {
  NODE_PREPARATION_SIGNATURE_DOMAIN,
  canonicalNodePreparationProof,
  ensureNodeNetwork,
  ip,
  nodePreparationProofSchema,
} from "./node-network.ts";
import {
  nodeProofSourceOutsidePlan,
  nodeProofSourcePlanSchema,
} from "./node-proof-source.ts";
import {
  authenticateNodeProofSession,
  signNodeProofDocument,
} from "./node-proof-session.ts";
import { readNodeAddition } from "./node-state.ts";

const VERIFICATION_DOMAIN = "pgcf-node-verification/v1\n";
const encoder = new TextEncoder();
const Envelope = z.strictObject({
  kid: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/),
  payload: z.union([nodePreparationProofSchema, nodeVerificationProofSchema]),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
type Payload = z.infer<typeof Envelope>["payload"];
type Document = z.infer<typeof Envelope>;
type Plan = z.infer<typeof nodeProofSourcePlanSchema>;
type Scan = Extract<NodeProofMeasurement, { kind: "scan" }>;
const deny = (): never => {
  throw new ApiError(
    "conflict",
    "Network proof report is incomplete or differs from current authority",
  );
};
const hash = async (bytes: Uint8Array) =>
  bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
const family = (value: string) =>
  z.ipv4().safeParse(value).success ? "ipv4" : "ipv6";
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return deny();
  return value as Record<string, unknown>;
}
function list(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 1024) return deny();
  return value.map(object);
}
function fresh(at: string, floor: string, now: number, age = 120000) {
  const time = Date.parse(at);
  if (
    !Number.isFinite(time) ||
    time < Date.parse(floor) ||
    time < now - age ||
    time > now + 5000
  )
    return deny();
}
function canonical(mode: NodeProofClaims["mode"], payload: Payload) {
  return mode === "preparation"
    ? canonicalNodePreparationProof(nodePreparationProofSchema.parse(payload))
    : canonicalNodeVerificationProof(
        nodeVerificationProofSchema.parse(payload),
      );
}
const domain = (mode: NodeProofClaims["mode"]) =>
  mode === "preparation"
    ? NODE_PREPARATION_SIGNATURE_DOMAIN
    : VERIFICATION_DOMAIN;

async function currentPlan(
  env: Env,
  claims: NodeProofClaims,
  report: NodeProofReport,
) {
  const saved = await env.DB.prepare(
    "SELECT plan_json,plan_sha256,status,readback_at FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(claims.operation_id)
    .first<{
      plan_json: string;
      plan_sha256: string;
      status: string;
      readback_at: string | null;
    }>();
  if (
    !saved?.readback_at ||
    saved.status === "blocked" ||
    saved.plan_json.length > 512 * 1024
  )
    return deny();
  const raw: unknown = JSON.parse(saved.plan_json),
    plan = nodeProofSourcePlanSchema.parse(raw);
  const addition = await readNodeAddition(env.DB, claims.operation_id);
  if (
    saved.plan_sha256 !== claims.plan_sha256 ||
    report.binding.plan_sha256 !== claims.plan_sha256 ||
    report.binding.readback_at !== saved.readback_at ||
    (await installationHash(raw)) !== claims.plan_sha256 ||
    plan.operation_id !== claims.operation_id ||
    plan.node_id !== claims.node_id ||
    plan.region_id !== claims.region_id ||
    plan.provider_instance_id !== claims.provider_instance_id ||
    plan.intent_hash !== addition.intent_hash ||
    plan.relay.provider_instance_id !== env.BOOTSTRAP_RELAY_PROVIDER_INSTANCE_ID
  )
    return deny();
  if (claims.mode === "preparation") {
    if (report.binding.verification !== null || report.postjoin !== null)
      return deny();
  } else if (
    !report.postjoin ||
    !report.binding.verification ||
    report.binding.verification.input_hash !== claims.input_hash ||
    report.binding.verification.checkpoint_reference !==
      claims.checkpoint_reference ||
    addition.checkpoint?.reference !== claims.checkpoint_reference ||
    addition.checkpoint.stage !== "joined"
  )
    return deny();
  return { plan, raw, addition };
}

async function validateMeasurements(
  report: NodeProofReport,
  plan: Plan,
  rawPlan: unknown,
  claims: NodeProofClaims,
) {
  const now = Date.now(),
    scope = await hash(encoder.encode(canonicalNodeProof(report.binding)));
  const scans = new Map<"ipv4" | "ipv6", Scan>();
  const access = report.measurements.filter((m) => m.kind === "access");
  if (access.length !== (claims.mode === "preparation" ? 1 : 0)) return deny();
  const nonces = new Set<string>();
  for (const measurement of report.measurements) {
    if (measurement.binding_sha256 !== scope) return deny();
    fresh(measurement.observed_at, report.binding.readback_at, now);
    if (measurement.kind === "access") {
      if (
        measurement.access.length !== plan.members.length ||
        new Set(measurement.access.map((a) => a.provider_instance_id)).size !==
          plan.members.length
      )
        return deny();
      for (const observed of measurement.access) {
        const member = plan.members.find(
            (m) => m.provider_instance_id === observed.provider_instance_id,
          ),
          kind = family(observed.address);
        if (
          !member ||
          !member.addresses[kind].map(ip).includes(ip(observed.address)) ||
          family(observed.relay_source) !== kind ||
          !plan.relay.addresses[kind]
            .map(ip)
            .includes(ip(observed.relay_source)) ||
          new Set(observed.checks.map((c) => c.port)).size !== 3 ||
          !observed.checks.some((c) => c.outcome === "connected") ||
          observed.observed_at > measurement.observed_at
        )
          return deny();
        fresh(observed.observed_at, report.binding.readback_at, now);
        if (
          observed.talos_maintenance ||
          observed.checks.some((c) => c.outcome === "timed_out")
        ) {
          const maintenance = observed.talos_maintenance;
          if (
            !maintenance ||
            !report.binding.maintenance ||
            member.provider_instance_id !== claims.provider_instance_id ||
            observed.checks.find((c) => c.port === 50000)?.outcome !==
              "connected" ||
            observed.checks.some(
              (c) =>
                c.outcome === "timed_out" && c.port !== 22 && c.port !== 6443,
            ) ||
            maintenance.observed_at > observed.observed_at
          )
            return deny();
          const { observed_at, ...binding } = maintenance;
          if (
            canonicalNodeProof(binding) !==
            canonicalNodeProof(report.binding.maintenance)
          )
            return deny();
          fresh(observed_at, report.binding.readback_at, now);
        }
      }
      continue;
    }
    if (
      scans.has(measurement.family) ||
      family(measurement.source) !== measurement.family ||
      !nodeProofSourceOutsidePlan(rawPlan, measurement.source)
    )
      return deny();
    scans.set(measurement.family, measurement);
    const targets = plan.members
      .filter(
        (m) =>
          claims.mode === "preparation" ||
          m.provider_instance_id === claims.provider_instance_id,
      )
      .flatMap((m) =>
        m.addresses[measurement.family].map(
          (value) => `${m.provider_instance_id}:${ip(value)}`,
        ),
      );
    if (
      measurement.scans.length !== targets.length ||
      !targets.length ||
      new Set(
        measurement.scans.map(
          (s) => `${s.provider_instance_id}:${ip(s.address)}`,
        ),
      ).size !== targets.length
    )
      return deny();
    for (const scan of measurement.scans) {
      if (
        !targets.includes(`${scan.provider_instance_id}:${ip(scan.address)}`) ||
        family(scan.address) !== measurement.family ||
        scan.open_ports.length ||
        scan.observed_at !== scan.after.observed_at ||
        scan.observed_at > measurement.observed_at ||
        scan.before.observed_at > scan.started_at ||
        Date.parse(scan.started_at) - Date.parse(scan.before.observed_at) >
          10000 ||
        scan.before.nonce === scan.after.nonce
      )
        return deny();
      // Historical scan boundaries age with the completed scan, not with the
      // later report after owned cleanup. Completion remains fresh at admission.
      fresh(
        scan.started_at,
        report.binding.readback_at,
        Date.parse(scan.observed_at),
      );
      fresh(scan.observed_at, scan.started_at, now);
      for (const control of [scan.before, scan.after]) {
        if (
          family(control.source) !== measurement.family ||
          ip(control.source) !== ip(measurement.source) ||
          ip(control.address) !== ip(plan.scan_control[measurement.family]) ||
          control.port !== plan.scan_control.port ||
          nonces.has(control.nonce)
        )
          return deny();
        nonces.add(control.nonce);
        fresh(
          control.observed_at,
          report.binding.readback_at,
          control === scan.before ? Date.parse(scan.observed_at) : now,
        );
      }
    }
  }
  for (const kind of ["ipv4", "ipv6"] as const) {
    const assigned = plan.members.some(
      (m) =>
        (claims.mode === "preparation" ||
          m.provider_instance_id === claims.provider_instance_id) &&
        m.addresses[kind].length,
    );
    if (assigned !== scans.has(kind)) return deny();
  }
  return { scans, access: access[0]?.access ?? [] };
}

async function validateMaintenance(
  env: Env,
  claims: NodeProofClaims,
  report: NodeProofReport,
) {
  if (!report.binding.maintenance) return;
  if (!claims.input_hash) return deny();
  const row = await readBootstrapJob(env.DB, claims.operation_id),
    input = await bootstrapJobInput(env, row),
    checkpoint = NodeBootstrapCheckpoint.parse(JSON.parse(row.checkpoint_json)),
    supplied = report.binding.maintenance;
  if (
    row.input_hash !== claims.input_hash ||
    supplied.input_hash !== claims.input_hash ||
    supplied.checkpoint_revision > row.revision ||
    NodeBootstrapStage.options.indexOf(supplied.checkpoint_stage) >
      NodeBootstrapStage.options.indexOf(checkpoint.stage) ||
    supplied.raw_bytes !== input.spec.image.raw_bytes ||
    supplied.raw_bytes !== checkpoint.written_bytes ||
    supplied.disk_bytes !== input.spec.hardware.disk_bytes ||
    supplied.install_disk !== input.spec.hardware.install_disk ||
    ["failed", "cancelled", "released"].includes(checkpoint.status)
  )
    return deny();
}

async function postjoinPayload(
  env: Env,
  claims: NodeProofClaims,
  report: NodeProofReport,
  plan: Plan,
  scans: Map<"ipv4" | "ipv6", Scan>,
) {
  const facts = report.postjoin!,
    binding = report.binding.verification!,
    row = await readBootstrapJob(env.DB, claims.operation_id),
    input = await bootstrapJobInput(env, row),
    checkpoint = NodeBootstrapCheckpoint.parse(JSON.parse(row.checkpoint_json)),
    protectedCluster = await loadRegionJoinBundle(
      env.DB,
      env.CREDENTIAL_KEYS,
      joinBundleReference(claims.region_id, 1),
    );
  const namespace = object(facts.kube_system),
    afterNamespace = object(facts.kube_system_after),
    node = object(facts.node),
    afterNode = object(facts.node_after),
    meta = object(node.metadata),
    afterMeta = object(afterNode.metadata),
    labels = object(meta.labels),
    annotations = object(meta.annotations),
    trial = checkpoint.storage_trial,
    run = trial?.runs.at(-1);
  if (
    !trial ||
    !run ||
    run.stage !== "published" ||
    !run.allocated ||
    !run.after ||
    !run.published_at ||
    trial.input_hash !== claims.input_hash ||
    trial.node_uid !== binding.node_uid ||
    trial.cluster_uid !== binding.cluster_uid ||
    trial.cluster_uid !== protectedCluster.kube_system_uid ||
    protectedCluster.cluster_endpoint !== input.spec.cluster_endpoint ||
    run.after.free !== run.before.free ||
    run.before.free - run.allocated.free < run.volume_bytes ||
    Date.parse(run.published_at) > Date.now() + 5000
  )
    return deny();
  for (const ns of [namespace, afterNamespace]) {
    const metadata = object(ns.metadata);
    if (
      ns.kind !== "Namespace" ||
      ns.apiVersion !== "v1" ||
      metadata.name !== "kube-system" ||
      metadata.uid !== binding.cluster_uid ||
      metadata.deletionTimestamp ||
      object(ns.status).phase !== "Active"
    )
      return deny();
  }
  for (const current of [node, afterNode]) {
    const metadata = object(current.metadata),
      spec = object(current.spec),
      status = object(current.status),
      currentLabels = object(metadata.labels),
      ready = list(status.conditions).filter((c) => c.type === "Ready"),
      quarantine = list(spec.taints).filter(
        (t) => t.key === "pgcf.io/quarantine",
      );
    if (
      current.kind !== "Node" ||
      current.apiVersion !== "v1" ||
      metadata.uid !== binding.node_uid ||
      metadata.name !== binding.hostname ||
      metadata.name !== input.spec.hostname ||
      metadata.deletionTimestamp ||
      !z
        .string()
        .regex(/^[0-9]{1,128}$/)
        .safeParse(metadata.resourceVersion).success ||
      currentLabels["pgcf.io/node-id"] !== claims.node_id ||
      currentLabels["pgcf.io/region"] !== claims.region_id ||
      currentLabels["pgcf.io/provider-instance-id"] !==
        claims.provider_instance_id ||
      (spec.unschedulable !== undefined && spec.unschedulable !== false) ||
      ready.length !== 1 ||
      ready[0]!.status !== "True" ||
      quarantine.length !== 1 ||
      quarantine[0]!.value !== "bootstrap" ||
      quarantine[0]!.effect !== "NoSchedule" ||
      !list(status.addresses).some(
        (a) =>
          a.type === "InternalIP" && a.address === input.spec.hardware.ipv4,
      )
    )
      return deny();
  }
  if (
    meta.resourceVersion !== afterMeta.resourceVersion ||
    canonicalNodeProof(labels) !==
      canonicalNodeProof(object(afterMeta.labels)) ||
    canonicalNodeProof(annotations) !==
      canonicalNodeProof(object(afterMeta.annotations))
  )
    return deny();
  const publication = await installationHash({
    trial: run.trial_sha256,
    before: run.before,
    allocated: run.allocated,
    after: run.after,
    data: run.data_sha256,
  });
  const observed = await env.DB.prepare(
    `SELECT storage_gib_total,allocatable_memory_mib,allocatable_cpu_millicores,platform_reserved_memory_mib,platform_reserved_cpu_millicores,last_observed_at
     FROM nodes WHERE id=? AND region_id=? AND provider_instance_id=? AND node_uid=? AND k8s_node_name=? AND ready=1 AND lost_at IS NULL`,
  )
    .bind(
      claims.node_id,
      claims.region_id,
      claims.provider_instance_id,
      binding.node_uid,
      binding.hostname,
    )
    .first<{
      storage_gib_total: number | null;
      allocatable_memory_mib: number;
      allocatable_cpu_millicores: number;
      platform_reserved_memory_mib: number;
      platform_reserved_cpu_millicores: number | null;
      last_observed_at: string;
    }>();
  if (
    !observed ||
    observed.storage_gib_total === null ||
    observed.storage_gib_total < 1 ||
    observed.platform_reserved_cpu_millicores === null ||
    observed.allocatable_cpu_millicores <=
      observed.platform_reserved_cpu_millicores ||
    observed.allocatable_memory_mib <= observed.platform_reserved_memory_mib ||
    annotations["pgcf.io/storage-gib-total"] !==
      String(observed.storage_gib_total) ||
    annotations["pgcf.io/storage-proof"] !== publication
  )
    return deny();
  fresh(
    observed.last_observed_at,
    report.binding.readback_at,
    Date.now(),
    180000,
  );
  const peers = await env.DB.prepare(
    "SELECT id,provider_instance_id FROM nodes WHERE region_id=? AND id<>? AND lost_at IS NULL",
  )
    .bind(claims.region_id, claims.node_id)
    .all<{ id: string; provider_instance_id: string | null }>();
  if (
    facts.wireguard.peers.length !== peers.results.length ||
    new Set(facts.wireguard.peers.map((p) => p.node_id)).size !==
      peers.results.length
  )
    return deny();
  const at = new Date().toISOString();
  for (const peer of peers.results) {
    const actual = facts.wireguard.peers.find((p) => p.node_id === peer.id),
      member = plan.members.find((m) => m.node_id === peer.id);
    if (
      !actual ||
      !member ||
      actual.provider_instance_id !== peer.provider_instance_id ||
      !member.addresses[family(actual.address)]
        .map(ip)
        .includes(ip(actual.address))
    )
      return deny();
    fresh(
      actual.last_handshake_at,
      report.binding.readback_at,
      Date.now(),
      180000,
    );
    if (
      !facts.wireguard.packet_observations.some(
        (p) =>
          [p.source_node_id, p.destination_node_id].includes(peer.id) &&
          [p.source_node_id, p.destination_node_id].includes(claims.node_id) &&
          p.source_node_id !== p.destination_node_id &&
          Date.parse(p.captured_at) >= Date.parse(report.binding.readback_at) &&
          Date.parse(p.captured_at) >= Date.now() - 180000 &&
          Date.parse(p.captured_at) <= Date.now() + 5000,
      )
    )
      return deny();
  }
  if (
    facts.wireguard.packet_observations.some(
      (p) =>
        p.source_node_id === p.destination_node_id ||
        ![p.source_node_id, p.destination_node_id].includes(claims.node_id) ||
        !peers.results.some((peer) =>
          [p.source_node_id, p.destination_node_id].includes(peer.id),
        ),
    )
  )
    return deny();
  const target = plan.members.find(
    (m) => m.provider_instance_id === claims.provider_instance_id,
  );
  if (
    !target ||
    target.addresses.ipv4.length !== 1 ||
    target.addresses.ipv6.length > 1
  )
    return deny();
  return nodeVerificationProofSchema.parse({
    purpose: "pgcf-node-verification/v1",
    operation_id: claims.operation_id,
    node_id: claims.node_id,
    region_id: claims.region_id,
    provider_instance_id: claims.provider_instance_id,
    intent_hash: plan.intent_hash,
    input_hash: claims.input_hash,
    checkpoint_reference: claims.checkpoint_reference,
    cluster_uid: binding.cluster_uid,
    node_uid: binding.node_uid,
    node_resource_version: meta.resourceVersion,
    observed_at: at,
    expires_at: new Date(
      Math.min(Date.parse(claims.expires_at), Date.parse(at) + 120000),
    ).toISOString(),
    addresses: {
      ipv4: target.addresses.ipv4[0],
      ipv6: target.addresses.ipv6[0] ?? null,
    },
    wireguard: facts.wireguard,
    scans: [...scans.values()].flatMap((m) =>
      m.scans.map((scan) => ({
        family: m.family,
        address: ip(scan.address),
        source: ip(m.source),
        observed_at: scan.observed_at,
        scanned_ports: scan.scanned_ports,
        open_ports: scan.open_ports,
        control: {
          address: scan.after.address,
          port: scan.after.port,
          connected: true,
        },
      })),
    ),
  });
}

function preparationPayload(
  claims: NodeProofClaims,
  plan: Plan,
  measurements: Awaited<ReturnType<typeof validateMeasurements>>,
) {
  const at = new Date().toISOString();
  return nodePreparationProofSchema.parse({
    version: 1,
    operation_id: claims.operation_id,
    node_id: claims.node_id,
    region_id: claims.region_id,
    provider_instance_id: claims.provider_instance_id,
    intent_hash: plan.intent_hash,
    plan_sha256: claims.plan_sha256,
    observed_at: at,
    expires_at: new Date(
      Math.min(Date.parse(claims.expires_at), Date.parse(at) + 120000),
    ).toISOString(),
    relay_provider_instance_id: plan.relay.provider_instance_id,
    access: measurements.access,
    firewalls: plan.members.map((m) => ({
      firewall_id: m.firewall_id,
      provider_instance_id: m.provider_instance_id,
      rules_sha256: m.rules_sha256,
    })),
    external: Object.fromEntries(
      (["ipv4", "ipv6"] as const).map((kind) => {
        const m = measurements.scans.get(kind),
          last = m?.scans.at(-1);
        return [
          kind,
          m && last
            ? {
                source: m.source,
                positive_control: {
                  address: last.after.address,
                  port: last.after.port,
                  outcome: "connected",
                  observed_at: last.after.observed_at,
                },
                scans: m.scans.map((scan) => ({
                  provider_instance_id: scan.provider_instance_id,
                  address: scan.address,
                  protocol: scan.protocol,
                  first_port: scan.first_port,
                  last_port: scan.last_port,
                  scanned_ports: scan.scanned_ports,
                  open_ports: scan.open_ports,
                  started_at: scan.started_at,
                  observed_at: scan.observed_at,
                })),
              }
            : null,
        ];
      }),
    ),
  });
}

function sameScope(mode: NodeProofClaims["mode"], old: Payload, next: Payload) {
  if (
    old.operation_id !== next.operation_id ||
    old.node_id !== next.node_id ||
    old.region_id !== next.region_id ||
    old.provider_instance_id !== next.provider_instance_id ||
    old.intent_hash !== next.intent_hash
  )
    return false;
  if (mode === "preparation") {
    const a = nodePreparationProofSchema.safeParse(old),
      b = nodePreparationProofSchema.safeParse(next);
    return (
      a.success &&
      b.success &&
      a.data.plan_sha256 === b.data.plan_sha256 &&
      a.data.relay_provider_instance_id === b.data.relay_provider_instance_id
    );
  }
  const a = nodeVerificationProofSchema.safeParse(old),
    b = nodeVerificationProofSchema.safeParse(next);
  return (
    a.success &&
    b.success &&
    a.data.input_hash === b.data.input_hash &&
    a.data.checkpoint_reference === b.data.checkpoint_reference &&
    a.data.cluster_uid === b.data.cluster_uid &&
    a.data.node_uid === b.data.node_uid &&
    canonicalNodeProof(a.data.addresses) ===
      canonicalNodeProof(b.data.addresses)
  );
}
async function knownDocument(
  env: Env,
  object: R2ObjectBody,
  claims: NodeProofClaims,
  payload: Payload,
  notBefore: string,
) {
  const limit = claims.mode === "preparation" ? 65536 : 256 * 1024;
  if (object.size > limit) return deny();
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length > limit) return deny();
  let doc: Document;
  try {
    doc = Envelope.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes,
        ),
      ),
    );
  } catch {
    return deny();
  }
  if (!sameScope(claims.mode, doc.payload, payload)) return deny();
  const key = (
      await importBootstrapVerificationKeys(
        JSON.parse(env.BOOTSTRAP_VERIFIER_KEYS),
      )
    ).get(doc.kid),
    signature = base64urlToBytes(doc.signature);
  if (
    !key ||
    !signature ||
    !(await crypto.subtle.verify(
      "Ed25519",
      key,
      Uint8Array.from(signature),
      encoder.encode(domain(claims.mode) + canonical(claims.mode, doc.payload)),
    ))
  )
    return deny();
  const at = Date.parse(doc.payload.observed_at),
    expires = Date.parse(doc.payload.expires_at),
    now = Date.now();
  if (
    at < Date.parse(notBefore) ||
    at > now + 5000 ||
    expires <= at ||
    expires - at > (claims.mode === "preparation" ? 300000 : 600000)
  )
    return deny();
  return {
    document: doc,
    bytes,
    sha256: await hash(bytes),
    etag: object.etag,
    expired: expires <= now,
  };
}

async function publish(
  env: Env,
  token: string,
  claims: NodeProofClaims,
  payload: Payload,
  notBefore: string,
) {
  const doc = await signNodeProofDocument(
      env,
      domain(claims.mode),
      payload,
      (value) => canonical(claims.mode, value),
    ),
    bytes = encoder.encode(JSON.stringify(doc)),
    sha256 = await hash(bytes),
    key =
      claims.mode === "preparation"
        ? `node-preparation/${claims.operation_id}/proof.json`
        : `node-verification/${claims.operation_id}/${claims.checkpoint_reference}/proof.json`,
    history = (digest: string) =>
      `node-proof-history/${claims.operation_id}/${claims.mode}/${claims.session_id}/${digest}.json`;
  if (bytes.length > (claims.mode === "preparation" ? 65536 : 256 * 1024))
    return deny();
  const previous = await env.ARCHIVE.get(key),
    known = previous
      ? await knownDocument(env, previous, claims, payload, notBefore)
      : null;
  if (known && !known.expired) {
    fresh(
      known.document.payload.observed_at,
      new Date(Date.now() - 120000).toISOString(),
      Date.now(),
    );
    return { sha256: known.sha256, key };
  }
  const archive = async (body: Uint8Array, digest: string) => {
    await authenticateNodeProofSession(env, token, claims.operation_id);
    const key = history(digest);
    const archived = await env.ARCHIVE.put(key, body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
    });
    if (!archived) {
      const existing = await env.ARCHIVE.get(key);
      if (
        !existing ||
        existing.size !== body.length ||
        (await hash(new Uint8Array(await existing.arrayBuffer()))) !== digest
      )
        return deny();
    }
    await authenticateNodeProofSession(env, token, claims.operation_id);
  };
  if (known) await archive(known.bytes, known.sha256);
  await archive(bytes, sha256);
  await authenticateNodeProofSession(env, token, claims.operation_id);
  const updated = await env.ARCHIVE.put(key, bytes, {
    onlyIf: known ? { etagMatches: known.etag } : { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });
  await authenticateNodeProofSession(env, token, claims.operation_id);
  const current = await env.ARCHIVE.get(key);
  if (!current) return deny();
  const accepted = await knownDocument(
    env,
    current,
    claims,
    payload,
    notBefore,
  );
  if (
    accepted.expired ||
    (!updated &&
      accepted.sha256 !== sha256 &&
      Date.parse(accepted.document.payload.observed_at) < Date.now() - 120000)
  )
    return deny();
  return { sha256: accepted.sha256, key };
}

/** Authenticate first; publish actual complete observations, then use the existing independent gates. */
export async function acceptNodeProofReport(
  env: Env,
  token: string,
  raw: NodeProofReport,
): Promise<{
  sha256: string;
  operation_id: string;
  mode: NodeProofClaims["mode"];
  verified: boolean;
}> {
  const claims = await authenticateNodeProofSession(env, token);
  if (encoder.encode(JSON.stringify(raw)).length > 512 * 1024) return deny();
  const parsed = NodeProofReport.safeParse(raw);
  if (!parsed.success) return deny();
  const report = parsed.data,
    state = await currentPlan(env, claims, report),
    measurements = await validateMeasurements(
      report,
      state.plan,
      state.raw,
      claims,
    );
  await validateMaintenance(env, claims, report);
  const payload =
    claims.mode === "preparation"
      ? preparationPayload(claims, state.plan, measurements)
      : await postjoinPayload(
          env,
          claims,
          report,
          state.plan,
          measurements.scans,
        );
  await authenticateNodeProofSession(env, token, claims.operation_id);
  const artifact = await publish(
    env,
    token,
    claims,
    payload,
    claims.mode === "postjoin" && state.addition.checkpoint
      ? new Date(
          Math.max(
            Date.parse(report.binding.readback_at),
            Date.parse(state.addition.checkpoint.saved_at),
          ),
        ).toISOString()
      : report.binding.readback_at,
  );
  await authenticateNodeProofSession(env, token, claims.operation_id);
  let verified: boolean;
  if (claims.mode === "preparation")
    verified = await ensureNodeNetwork(env, claims.operation_id);
  else {
    const addition = await readNodeAddition(env.DB, claims.operation_id);
    await verifyNodeProofArtifact(env, claims.operation_id, {
      expected_revision: addition.revision,
      sha256: artifact.sha256,
    });
    verified = true;
  }
  return {
    sha256: artifact.sha256,
    operation_id: claims.operation_id,
    mode: claims.mode,
    verified,
  };
}
