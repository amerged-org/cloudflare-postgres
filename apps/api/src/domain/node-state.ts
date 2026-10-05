// SPDX-License-Identifier: Apache-2.0
import {
  bytesToHex,
  newNodeId,
  newOperationId,
  OperationId,
} from "@pgcf/contracts";
import {
  NodeAddition,
  NodeAdditionIntent,
  NodeAdditionRequest,
  NodeRegionPolicy,
  CostedNodeApproval,
  NodeProviderReceipt,
  NodeProviderAudit,
  NodeBootstrapCheckpoint,
  NodeNetworkVerification,
  NodeCapacityVerification,
  nodeAdditionHostname,
} from "@pgcf/contracts/nodes";

export class NodeStateError extends Error {
  readonly code:
    | "not_found"
    | "conflict"
    | "capacity_unavailable"
    | "approval_required"
    | "configuration_required";
  constructor(
    code:
      | "not_found"
      | "conflict"
      | "capacity_unavailable"
      | "approval_required"
      | "configuration_required",
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}
interface AdditionRow {
  operation_id: string;
  node_id: string;
  region_id: string;
  request_key: string;
  request_hash: string;
  intent_hash: string;
  intent_json: string;
  revision: number;
  status: NodeAddition["status"];
  slot_held: number;
  dispatch_request_id: string | null;
  provider_instance_id: string | null;
  approval_json: string | null;
  receipt_json: string | null;
  audit_json: string | null;
  checkpoint_json: string | null;
  network_json: string | null;
  capacity_json: string | null;
  failure_code: NodeAddition["failure_code"];
  created_at: string;
  updated_at: string;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}
async function digest(value: unknown): Promise<string> {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonical(value)),
      ),
    ),
  );
}
const json = (value: string | null): unknown =>
  value === null ? null : JSON.parse(value);
async function view(row: AdditionRow): Promise<NodeAddition> {
  const intent = NodeAdditionIntent.parse(JSON.parse(row.intent_json));
  if (
    intent.operation_id !== row.operation_id ||
    intent.node_id !== row.node_id ||
    intent.request.region_id !== row.region_id ||
    (await digest(intent)) !== row.intent_hash ||
    (await digest(intent.request)) !== row.request_hash
  )
    throw new NodeStateError(
      "conflict",
      "Persisted node intent identity is invalid",
    );
  return NodeAddition.parse({
    intent,
    request_key: row.request_key,
    request_hash: row.request_hash,
    intent_hash: row.intent_hash,
    revision: row.revision,
    status: row.status,
    slot_held: row.slot_held === 1,
    dispatch_request_id: row.dispatch_request_id,
    provider_instance_id: row.provider_instance_id,
    approval: json(row.approval_json),
    receipt: json(row.receipt_json),
    audit: json(row.audit_json),
    checkpoint: json(row.checkpoint_json),
    network: json(row.network_json),
    capacity: json(row.capacity_json),
    failure_code: row.failure_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}
export async function readNodeAddition(
  db: D1Database,
  operationId: string,
): Promise<NodeAddition> {
  OperationId.parse(operationId);
  const row = await db
    .prepare("SELECT * FROM node_additions WHERE operation_id=?")
    .bind(operationId)
    .first<AdditionRow>();
  if (!row) throw new NodeStateError("not_found", "Node addition not found");
  return view(row);
}
export async function configureNodeRegionPolicy(
  db: D1Database,
  value: NodeRegionPolicy,
): Promise<void> {
  const policy = NodeRegionPolicy.parse(value);
  const result = await db
    .prepare(
      `INSERT INTO node_region_policies(region_id,max_nodes,purchases_enabled,order_config)
    SELECT id,?,?,? FROM regions WHERE id=? AND provider='contabo'
    ON CONFLICT(region_id) DO UPDATE SET max_nodes=excluded.max_nodes,purchases_enabled=excluded.purchases_enabled,order_config=excluded.order_config`,
    )
    .bind(
      policy.max_nodes,
      policy.purchases_enabled ? 1 : 0,
      policy.order === null ? null : canonical(policy.order),
      policy.region_id,
    )
    .run();
  if (result.meta.changes !== 1)
    throw new NodeStateError(
      "not_found",
      "Configured Contabo region not found",
    );
}
const slotCount = `(SELECT count(*) FROM nodes WHERE region_id=p.region_id)+
  (SELECT count(*) FROM node_additions a WHERE a.region_id=p.region_id AND a.slot_held=1 AND NOT EXISTS(
    SELECT 1 FROM nodes n WHERE n.id=a.node_id AND n.region_id=a.region_id AND n.k8s_node_name=json_extract(a.intent_json,'$.requested_hostname') AND n.provider_instance_id=a.provider_instance_id))`;
export async function nodeRegionOccupiedSlots(
  db: D1Database,
  regionId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT ${slotCount} occupied FROM node_region_policies p WHERE p.region_id=?`,
    )
    .bind(regionId)
    .first<{ occupied: number }>();
  if (!row)
    throw new NodeStateError(
      "configuration_required",
      "Region node cap has not been configured",
    );
  return row.occupied;
}
export async function reserveNodeAddition(
  db: D1Database,
  input: { request_key: string; request: NodeAdditionRequest },
): Promise<NodeAddition> {
  const request = NodeAdditionRequest.parse(input.request);
  if (!/^[A-Za-z0-9._~-]{1,128}$/.test(input.request_key))
    throw new NodeStateError("conflict", "Invalid node request key");
  const requestHash = await digest(request);
  const previous = async () =>
    db
      .prepare(
        "SELECT * FROM node_additions WHERE region_id=? AND request_key=?",
      )
      .bind(request.region_id, input.request_key)
      .first<AdditionRow>();
  const existing = await previous();
  if (existing) {
    if (existing.request_hash !== requestHash)
      throw new NodeStateError(
        "conflict",
        "Node request key already binds another intent",
      );
    return view(existing);
  }
  const policy = await db
    .prepare("SELECT order_config FROM node_region_policies WHERE region_id=?")
    .bind(request.region_id)
    .first<{ order_config: string | null }>();
  if (!policy)
    throw new NodeStateError(
      "configuration_required",
      "Region node cap has not been configured",
    );
  if (
    request.mode === "order" &&
    policy.order_config !== canonical(request.order)
  )
    throw new NodeStateError(
      "configuration_required",
      "Order must match the configured provider selection",
    );
  const nodeId = newNodeId(),
    operationId = newOperationId(),
    now = new Date().toISOString();
  const intent = NodeAdditionIntent.parse({
    node_id: nodeId,
    operation_id: operationId,
    requested_hostname: nodeAdditionHostname(nodeId),
    request,
  });
  let changed = 0;
  try {
    const result = await db
      .prepare(
        `INSERT INTO node_additions(operation_id,node_id,region_id,request_key,request_hash,intent_hash,intent_json,status,requested_instance_id,created_at,updated_at)
      SELECT ?,?,p.region_id,?,?,?,?,'reserved',?,?,? FROM node_region_policies p JOIN regions r ON r.id=p.region_id AND r.provider='contabo'
      WHERE p.region_id=? AND ${slotCount}<p.max_nodes AND (?='adopt' OR p.order_config=?)
      AND (? IS NULL OR (NOT EXISTS(SELECT 1 FROM nodes WHERE provider_instance_id=?) AND NOT EXISTS(SELECT 1 FROM node_additions WHERE slot_held=1 AND (requested_instance_id=? OR provider_instance_id=?))))
      ON CONFLICT(region_id,request_key) DO NOTHING`,
      )
      .bind(
        operationId,
        nodeId,
        input.request_key,
        requestHash,
        await digest(intent),
        canonical(intent),
        request.mode === "adopt" ? request.provider_instance_id : null,
        now,
        now,
        request.region_id,
        request.mode,
        request.mode === "order" ? canonical(request.order) : null,
        request.mode === "adopt" ? request.provider_instance_id : null,
        request.mode === "adopt" ? request.provider_instance_id : null,
        request.mode === "adopt" ? request.provider_instance_id : null,
        request.mode === "adopt" ? request.provider_instance_id : null,
      )
      .run();
    changed = result.meta.changes;
  } catch (error) {
    if (!(
      error instanceof Error && /UNIQUE constraint failed/.test(error.message)
    ))
      throw error;
  }
  const saved = await previous();
  if (saved) {
    if (saved.request_hash !== requestHash)
      throw new NodeStateError(
        "conflict",
        "Concurrent node request binds another intent",
      );
    return view(saved);
  }
  if (changed !== 1)
    throw new NodeStateError(
      "capacity_unavailable",
      "Region cap or existing provider reservation refuses another slot",
    );
  throw new NodeStateError("conflict", "Node reservation disappeared");
}
function revision(addition: NodeAddition, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected !== addition.revision)
    throw new NodeStateError("conflict", "Node state revision changed");
}
async function changed(
  db: D1Database,
  addition: NodeAddition,
  assignments: string,
  values: (string | number | null)[],
  extra = "",
  extraValues: (string | number | null)[] = [],
): Promise<NodeAddition> {
  const result = await db
    .prepare(
      `UPDATE node_additions SET ${assignments},revision=revision+1,updated_at=? WHERE operation_id=? AND revision=? ${extra}`,
    )
    .bind(
      ...values,
      new Date().toISOString(),
      addition.intent.operation_id,
      addition.revision,
      ...extraValues,
    )
    .run();
  if (result.meta.changes !== 1)
    throw new NodeStateError(
      "conflict",
      "Concurrent node transition or authority changed",
    );
  return readNodeAddition(db, addition.intent.operation_id);
}
export async function approveNodePurchase(
  db: D1Database,
  operationId: string,
  expectedRevision: number,
  value: CostedNodeApproval,
): Promise<NodeAddition> {
  const addition = await readNodeAddition(db, operationId),
    approval = CostedNodeApproval.parse(value),
    request = addition.intent.request;
  if (addition.approval !== null) {
    if (canonical(addition.approval) === canonical(approval)) return addition;
    throw new NodeStateError("conflict", "Cost approval is already bound");
  }
  revision(addition, expectedRevision);
  if (
    request.mode !== "order" ||
    addition.status !== "reserved" ||
    approval.intent_hash !== addition.intent_hash ||
    approval.term_months !== request.order.term_months ||
    approval.location !== request.order.location ||
    Date.parse(approval.approved_at) > Date.now() + 5000 ||
    Date.parse(approval.expires_at) <= Date.now()
  )
    throw new NodeStateError(
      "approval_required",
      "An exact unexpired owner cost approval is required",
    );
  return changed(db, addition, "approval_json=?", [canonical(approval)]);
}
export async function claimNodeDispatch(
  db: D1Database,
  operationId: string,
  expectedRevision: number,
): Promise<
  | { claimed: true; request_id: string; addition: NodeAddition }
  | { claimed: false; addition: NodeAddition }
> {
  const addition = await readNodeAddition(db, operationId),
    request = addition.intent.request;
  if (addition.dispatch_request_id !== null || addition.status !== "reserved")
    return { claimed: false, addition };
  revision(addition, expectedRevision);
  if (
    request.mode !== "order" ||
    !addition.approval ||
    addition.approval.intent_hash !== addition.intent_hash ||
    Date.parse(addition.approval.expires_at) <= Date.now()
  )
    throw new NodeStateError(
      "approval_required",
      "A configured order and exact owner cost approval are required before dispatch",
    );
  const requestId = crypto.randomUUID(),
    now = new Date().toISOString();
  const result = await db
    .prepare(
      `UPDATE node_additions SET status='dispatching',dispatch_request_id=?,revision=revision+1,updated_at=?
    WHERE operation_id=? AND revision=? AND status='reserved' AND slot_held=1 AND dispatch_request_id IS NULL AND approval_json IS NOT NULL
      AND json_extract(approval_json,'$.intent_hash')=intent_hash AND json_extract(approval_json,'$.expires_at')>?
      AND EXISTS(SELECT 1 FROM node_region_policies p WHERE p.region_id=node_additions.region_id AND p.purchases_enabled=1 AND p.order_config=? AND ${slotCount}<=p.max_nodes)`,
    )
    .bind(
      requestId,
      now,
      operationId,
      expectedRevision,
      now,
      canonical(request.order),
    )
    .run();
  const current = await readNodeAddition(db, operationId);
  if (result.meta.changes === 1)
    return { claimed: true, request_id: requestId, addition: current };
  if (current.dispatch_request_id !== null)
    return { claimed: false, addition: current };
  throw new NodeStateError(
    "approval_required",
    "Purchases are disabled or the bound approval/configuration or region cap changed",
  );
}
export async function markNodeDispatchUnknown(
  db: D1Database,
  operationId: string,
  expectedRevision: number,
): Promise<NodeAddition> {
  const addition = await readNodeAddition(db, operationId);
  if (addition.status === "unknown") return addition;
  revision(addition, expectedRevision);
  if (addition.status !== "dispatching" || !addition.dispatch_request_id)
    throw new NodeStateError(
      "conflict",
      "Unknown order requires a previously saved dispatch",
    );
  return changed(
    db,
    addition,
    "status='unknown',failure_code='provider_unknown'",
    [],
  );
}
export async function recordNodeReceipt(
  db: D1Database,
  operationId: string,
  expectedRevision: number,
  value: NodeProviderReceipt,
): Promise<NodeAddition> {
  const addition = await readNodeAddition(db, operationId),
    receipt = NodeProviderReceipt.parse(value),
    request = addition.intent.request;
  if (addition.receipt) {
    if (canonical(addition.receipt) === canonical(receipt)) return addition;
    throw new NodeStateError("conflict", "Provider receipt is already bound");
  }
  revision(addition, expectedRevision);
  if (
    request.mode === "adopt"
      ? addition.status !== "reserved" ||
        receipt.request_id !== null ||
        receipt.provider_instance_id !== request.provider_instance_id
      : !addition.dispatch_request_id ||
        receipt.request_id !== addition.dispatch_request_id ||
        !["dispatching", "unknown", "failed"].includes(addition.status)
  )
    throw new NodeStateError(
      "conflict",
      "Provider receipt does not match the original dispatch/adoption",
    );
  return changed(
    db,
    addition,
    "status='provider_bound',provider_instance_id=?,receipt_json=?,failure_code=NULL",
    [receipt.provider_instance_id, canonical(receipt)],
    "AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.provider_instance_id=? AND n.id<>node_additions.node_id)",
    [receipt.provider_instance_id],
  );
}
export async function recordNodeAudit(
  db: D1Database,
  operationId: string,
  expectedRevision: number,
  value: NodeProviderAudit,
): Promise<NodeAddition> {
  const addition = await readNodeAddition(db, operationId),
    audit = NodeProviderAudit.parse(value);
  if (addition.audit) {
    if (canonical(addition.audit) === canonical(audit)) return addition;
    throw new NodeStateError("conflict", "Provider audit is already bound");
  }
  revision(addition, expectedRevision);
  if (
    addition.status !== "provider_bound" ||
    audit.provider_instance_id !== addition.provider_instance_id
  )
    throw new NodeStateError(
      "conflict",
      "Provider audit must bind the saved instance receipt",
    );
  const request = addition.intent.request;
  const region = await db
    .prepare("SELECT provider_region FROM regions WHERE id=?")
    .bind(request.region_id)
    .first<{ provider_region: string }>();
  if (
    request.mode === "order"
      ? audit.provider_region !== request.order.provider_region ||
        audit.product_id !== request.order.product_id ||
        audit.image_id !== request.order.image_id
      : !region || audit.provider_region !== region.provider_region
  )
    throw new NodeStateError(
      "conflict",
      "Actual provider inventory does not match the target selection",
    );
  return changed(db, addition, "status='audited',audit_json=?", [
    canonical(audit),
  ]);
}
const stages = [
  "prepared",
  "rescue",
  "talos_installed",
  "network_protected",
  "joined",
];
export async function saveNodeBootstrapCheckpoint(
  db: D1Database,
  operationId: string,
  expectedRevision: number,
  value: NodeBootstrapCheckpoint,
): Promise<NodeAddition> {
  const addition = await readNodeAddition(db, operationId),
    checkpoint = NodeBootstrapCheckpoint.parse(value);
  if (
    addition.checkpoint &&
    canonical({
      stage: addition.checkpoint.stage,
      reference: addition.checkpoint.reference,
      saved_at: addition.checkpoint.saved_at,
    }) === canonical(checkpoint)
  )
    return addition;
  revision(addition, expectedRevision);
  if (
    !["audited", "bootstrapping", "failed"].includes(addition.status) ||
    !addition.audit ||
    (addition.checkpoint &&
      stages.indexOf(checkpoint.stage) <
        stages.indexOf(addition.checkpoint.stage))
  )
    throw new NodeStateError(
      "conflict",
      "Bootstrap cannot bypass provider audit or rewind a checkpoint",
    );
  return changed(
    db,
    addition,
    "status='bootstrapping',checkpoint_json=?,network_json=NULL,capacity_json=NULL,failure_code=NULL",
    [canonical({ ...checkpoint, revision: expectedRevision + 1 })],
  );
}
function proofScope(
  addition: NodeAddition,
  proof: NodeNetworkVerification | NodeCapacityVerification,
): void {
  if (
    addition.status !== "bootstrapping" ||
    addition.checkpoint?.stage !== "joined" ||
    proof.operation_id !== addition.intent.operation_id ||
    proof.node_id !== addition.intent.node_id ||
    proof.intent_hash !== addition.intent_hash ||
    proof.checkpoint_reference !== addition.checkpoint.reference
  )
    throw new NodeStateError(
      "conflict",
      "Verification must bind the joined checkpoint and immutable node intent",
    );
}
export async function verifyNodeNetwork(
  db: D1Database,
  operationId: string,
  expectedRevision: number,
  value: NodeNetworkVerification,
): Promise<NodeAddition> {
  const addition = await readNodeAddition(db, operationId),
    proof = NodeNetworkVerification.parse(value);
  revision(addition, expectedRevision);
  proofScope(addition, proof);
  return changed(db, addition, "network_json=?", [
    canonical({ ...proof, revision: expectedRevision }),
  ]);
}
interface ObservedNode {
  id: string;
  region_id: string;
  k8s_node_name: string;
  provider_instance_id: string | null;
  ready: number;
  last_observed_at: string | null;
  allocatable_memory_mib: number;
  allocatable_cpu_millicores: number;
  storage_gib_total: number | null;
  platform_reserved_memory_mib: number;
  platform_reserved_cpu_millicores: number | null;
}
const observedNode = (db: D1Database, addition: NodeAddition) =>
  db
    .prepare(
      "SELECT * FROM nodes WHERE id=? AND region_id=? AND k8s_node_name=? AND provider_instance_id=? AND ready=1",
    )
    .bind(
      addition.intent.node_id,
      addition.intent.request.region_id,
      addition.intent.requested_hostname,
      addition.provider_instance_id,
    )
    .first<ObservedNode>();
function matchesCapacity(
  node: ObservedNode | null,
  proof: NodeCapacityVerification,
): boolean {
  return (
    node !== null &&
    node.last_observed_at === proof.observed_at &&
    node.allocatable_memory_mib === proof.allocatable_memory_mib &&
    node.allocatable_cpu_millicores === proof.allocatable_cpu_millicores &&
    node.storage_gib_total === proof.storage_gib_total &&
    node.platform_reserved_memory_mib === proof.platform_reserved_memory_mib &&
    node.platform_reserved_cpu_millicores ===
      proof.platform_reserved_cpu_millicores
  );
}
export async function verifyNodeCapacity(
  db: D1Database,
  operationId: string,
  expectedRevision: number,
  value: NodeCapacityVerification,
): Promise<NodeAddition> {
  const addition = await readNodeAddition(db, operationId),
    proof = NodeCapacityVerification.parse(value);
  revision(addition, expectedRevision);
  proofScope(addition, proof);
  if (!matchesCapacity(await observedNode(db, addition), proof))
    throw new NodeStateError(
      "conflict",
      "Capacity proof requires the actual matching observed node values",
    );
  return changed(db, addition, "capacity_json=?", [
    canonical({ ...proof, revision: expectedRevision }),
  ]);
}
export async function completeNodeAddition(
  db: D1Database,
  operationId: string,
  expectedRevision: number,
): Promise<NodeAddition> {
  const addition = await readNodeAddition(db, operationId);
  if (addition.status === "ready") return addition;
  revision(addition, expectedRevision);
  if (
    !addition.network ||
    !addition.capacity ||
    addition.checkpoint?.stage !== "joined" ||
    addition.network.revision < addition.checkpoint.revision ||
    addition.capacity.revision < addition.checkpoint.revision
  )
    throw new NodeStateError(
      "conflict",
      "Ready requires current bound network and measured-capacity proofs",
    );
  proofScope(addition, addition.network);
  proofScope(addition, addition.capacity);
  const capacity = addition.capacity;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE nodes SET schedulable=1 WHERE id=? AND region_id=? AND k8s_node_name=? AND provider_instance_id=? AND ready=1
      AND last_observed_at=? AND allocatable_memory_mib=? AND allocatable_cpu_millicores=? AND storage_gib_total=? AND platform_reserved_memory_mib=? AND platform_reserved_cpu_millicores=?
      AND EXISTS(SELECT 1 FROM node_additions a WHERE a.operation_id=? AND a.node_id=nodes.id AND a.revision=? AND a.status='bootstrapping' AND a.network_json=? AND a.capacity_json=? AND a.checkpoint_json=?)`,
      )
      .bind(
        addition.intent.node_id,
        addition.intent.request.region_id,
        addition.intent.requested_hostname,
        addition.provider_instance_id,
        capacity.observed_at,
        capacity.allocatable_memory_mib,
        capacity.allocatable_cpu_millicores,
        capacity.storage_gib_total,
        capacity.platform_reserved_memory_mib,
        capacity.platform_reserved_cpu_millicores,
        operationId,
        expectedRevision,
        canonical(addition.network),
        canonical(capacity),
        canonical(addition.checkpoint),
      ),
    db
      .prepare(
        "UPDATE node_additions SET status='ready',revision=revision+1,updated_at=? WHERE changes()=1 AND operation_id=? AND revision=? AND status='bootstrapping'",
      )
      .bind(new Date().toISOString(), operationId, expectedRevision),
  ]);
  if (results[0]!.meta.changes !== 1 || results[1]!.meta.changes !== 1)
    throw new NodeStateError(
      "conflict",
      "Observed capacity or verification changed before readiness publication",
    );
  return readNodeAddition(db, operationId);
}
export async function markNodeAdditionFailed(
  db: D1Database,
  operationId: string,
  expectedRevision: number,
  code: NonNullable<NodeAddition["failure_code"]>,
): Promise<NodeAddition> {
  const addition = await readNodeAddition(db, operationId);
  revision(addition, expectedRevision);
  if (["ready", "cancelled"].includes(addition.status))
    throw new NodeStateError(
      "conflict",
      "Completed node state cannot be failed",
    );
  return changed(db, addition, "status='failed',failure_code=?", [code]);
}
export async function cancelUnattemptedNodeAddition(
  db: D1Database,
  operationId: string,
  expectedRevision: number,
): Promise<NodeAddition> {
  const addition = await readNodeAddition(db, operationId);
  if (addition.status === "cancelled") return addition;
  revision(addition, expectedRevision);
  if (
    !["reserved", "failed"].includes(addition.status) ||
    addition.dispatch_request_id !== null ||
    addition.provider_instance_id !== null ||
    addition.checkpoint !== null
  )
    throw new NodeStateError(
      "conflict",
      "An attempted or bound node can never release its slot by cancellation",
    );
  return changed(
    db,
    addition,
    "status='cancelled',slot_held=0",
    [],
    "AND dispatch_request_id IS NULL AND provider_instance_id IS NULL AND checkpoint_json IS NULL",
  );
}
