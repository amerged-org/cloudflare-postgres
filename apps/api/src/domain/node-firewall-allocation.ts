// SPDX-License-Identifier: Apache-2.0
import type { NodeAddition } from "@pgcf/contracts/nodes";
import { z } from "zod";
import { ApiError } from "../app.ts";
import type { Env } from "../env.ts";
import {
  ContaboError,
  hasAllocatedContaboHardware,
  type ContaboClient,
  type ContaboFirewall,
  type ContaboInstance,
  type ContaboMutationResult,
} from "../providers/contabo.ts";
import { contaboClient } from "./bootstrap-relay.ts";
import { assertNodeRecoveryAuthority, readNodeAddition } from "./node-state.ts";

type Provider = Pick<
  ContaboClient,
  "getInstance" | "getFirewall" | "listFirewalls" | "createFirewall"
>;
interface Allocation {
  operation_id: string;
  node_id: string;
  region_id: string;
  provider_instance_id: string;
  provider_region: string;
  product_id: string;
  image_id: string;
  intent_hash: string;
  inventory_revision: number;
  tenant_id: string;
  customer_id: string;
  request_id: string;
  name: string;
  description: string;
  state:
    | "claimed"
    | "dispatching"
    | "accepted"
    | "unknown"
    | "rejected"
    | "confirmed"
    | "blocked";
  firewall_id: string | null;
  failure_code: string | null;
}
const refuse = (message: string): never => {
  throw new ApiError("conflict", message);
};
const readClaim = (db: D1Database, operationId: string) =>
  db
    .prepare("SELECT * FROM node_firewall_allocations WHERE operation_id=?")
    .bind(operationId)
    .first<Allocation>();
// The same authority snapshot guards each dispatch/confirmation, including the regional provider.
const authority = `EXISTS(SELECT 1 FROM node_additions a JOIN regions r ON r.id=a.region_id
  WHERE a.operation_id=? AND a.revision=? AND a.node_id=? AND a.region_id=? AND a.intent_hash=?
    AND a.provider_instance_id=? AND a.slot_held=1 AND a.status IN('audited','bootstrapping','ready')
    AND json_extract(a.audit_json,'$.provider_instance_id')=? AND json_extract(a.audit_json,'$.provider_region')=?
    AND json_extract(a.audit_json,'$.product_id')=? AND json_extract(a.audit_json,'$.image_id')=?
    AND r.provider='contabo' AND r.provider_region=?)`;
const authorityBindings = (addition: NodeAddition) => [
  addition.intent.operation_id,
  addition.revision,
  addition.intent.node_id,
  addition.intent.request.region_id,
  addition.intent_hash,
  addition.provider_instance_id,
  addition.provider_instance_id,
  addition.audit!.provider_region,
  addition.audit!.product_id,
  addition.audit!.image_id,
  addition.audit!.provider_region,
];
const current = async (db: D1Database, addition: NodeAddition) =>
  Boolean(
    await db
      .prepare(`SELECT 1 AS present WHERE ${authority}`)
      .bind(...authorityBindings(addition))
      .first(),
  );
function owned(firewall: ContaboFirewall, actual: ContaboInstance) {
  return (
    z.uuid().safeParse(firewall.firewallId).success &&
    firewall.tenantId === actual.tenantId &&
    firewall.customerId === actual.customerId &&
    firewall.status === "active" &&
    firewall.instances.every(
      (instance) =>
        instance.instanceId === actual.id &&
        instance.regionSlug === actual.region &&
        instance.productId === actual.productId,
    ) &&
    firewall.instanceStatus.every(
      (instance) => instance.instanceId === actual.id,
    )
  );
}
function empty(firewall: ContaboFirewall) {
  const rules = firewall.rules.inbound;
  // The provider may include its implicit final deny rule in an otherwise empty definition.
  return (
    firewall.instances.length === 0 &&
    firewall.instanceStatus.length === 0 &&
    (rules.length === 0 ||
      (rules.length === 1 &&
        rules[0]!.action === "drop" &&
        rules[0]!.protocol === "" &&
        rules[0]!.status === "active" &&
        rules[0]!.destPorts.length === 0 &&
        (rules[0]!.srcCidr.ipv4?.length ?? 0) === 0 &&
        (rules[0]!.srcCidr.ipv6?.length ?? 0) === 0))
  );
}
function sameClaim(
  claim: Allocation,
  addition: NodeAddition,
  actual: ContaboInstance,
) {
  if (
    claim.operation_id !== addition.intent.operation_id ||
    claim.node_id !== addition.intent.node_id ||
    claim.region_id !== addition.intent.request.region_id ||
    claim.provider_instance_id !== actual.id ||
    claim.provider_region !== actual.region ||
    claim.product_id !== actual.productId ||
    claim.image_id !== actual.imageId ||
    claim.intent_hash !== addition.intent_hash ||
    claim.tenant_id !== actual.tenantId ||
    claim.customer_id !== actual.customerId ||
    claim.inventory_revision > addition.revision
  )
    refuse(
      "Installation firewall claim differs from current provider authority",
    );
}
async function blocked(db: D1Database, claim: Allocation, code: string) {
  await db
    .prepare(
      "UPDATE node_firewall_allocations SET state='blocked',failure_code=?,updated_at=? WHERE operation_id=? AND request_id=? AND state=?",
    )
    .bind(
      code,
      new Date().toISOString(),
      claim.operation_id,
      claim.request_id,
      claim.state,
    )
    .run();
}
async function readFailure(db: D1Database, claim: Allocation, error: unknown) {
  if (
    error instanceof ContaboError &&
    (error.code === "invalid_response" ||
      error.code === "pagination_incomplete" ||
      (error.code === "unexpected_status" &&
        [400, 402, 403, 404, 405].includes(error.status ?? 0)))
  )
    // Preserve the dispatch boundary: claimed can still make its first POST; later phases only read.
    await db
      .prepare(
        `UPDATE node_firewall_allocations SET failure_code='readback_unavailable',updated_at=?
         WHERE operation_id=? AND request_id=? AND state=?
           AND state IN('claimed','dispatching','accepted','unknown')`,
      )
      .bind(
        new Date().toISOString(),
        claim.operation_id,
        claim.request_id,
        claim.state,
      )
      .run();
}

/** An uncertain creation is reconciled only by reads; x-request-id is not an idempotency guarantee. */
export async function ensureNodeInstallationFirewall(
  env: Env,
  operationId: string,
  options: { provider?: Provider } = {},
): Promise<string | null> {
  const addition = await readNodeAddition(env.DB, operationId);
  await assertNodeRecoveryAuthority(env.DB, addition);
  if (
    !addition.slot_held ||
    !addition.audit ||
    !addition.provider_instance_id ||
    !["audited", "bootstrapping", "ready"].includes(addition.status)
  )
    return null;
  const provider = options.provider ?? contaboClient(env),
    deadline = Date.now() + 20_000,
    request = () => ({ requestId: crypto.randomUUID(), deadline });
  const actual = await provider.getInstance(
    addition.provider_instance_id,
    request(),
  );
  if (
    actual.id !== addition.provider_instance_id ||
    actual.region !== addition.audit.provider_region ||
    actual.productId !== addition.audit.product_id ||
    actual.imageId !== addition.audit.image_id ||
    (addition.intent.request.mode === "order" &&
      actual.displayName !== addition.intent.requested_hostname)
  )
    return refuse(
      "Installation provider inventory differs from the audited node",
    );
  if (
    !hasAllocatedContaboHardware(actual) ||
    !["running", "stopped", "uninstalled", "rescue"].includes(actual.status)
  )
    return null;
  const relay = await provider.getInstance(
    env.BOOTSTRAP_RELAY_PROVIDER_INSTANCE_ID,
    request(),
  );
  if (
    !hasAllocatedContaboHardware(relay) ||
    relay.id !== env.BOOTSTRAP_RELAY_PROVIDER_INSTANCE_ID ||
    relay.id === actual.id ||
    relay.tenantId !== actual.tenantId ||
    relay.customerId !== actual.customerId
  )
    return refuse(
      "Installation provider ownership differs from the configured relay",
    );
  let claim = await readClaim(env.DB, operationId);
  if (claim) sameClaim(claim, addition, actual);
  const confirmedFirewall = async (confirmed: Allocation) => {
    if (!confirmed.firewall_id)
      return refuse("Confirmed installation firewall has no provider identity");
    const firewall = await provider.getFirewall(
      confirmed.firewall_id,
      request(),
    );
    if (
      firewall.firewallId !== confirmed.firewall_id ||
      firewall.name !== confirmed.name ||
      firewall.description !== confirmed.description ||
      !owned(firewall, actual)
    ) {
      await blocked(env.DB, confirmed, "owned_readback_changed");
      return null;
    }
    return (await current(env.DB, addition)) ? confirmed.firewall_id : null;
  };
  let configured: string | undefined;
  try {
    const raw = env.BOOTSTRAP_FIREWALL_BINDINGS ?? "{}";
    if (raw.length > 65536)
      return refuse("Configured installation firewall bindings are invalid");
    configured = z
      .record(z.string().regex(/^[1-9][0-9]{0,18}$/), z.uuid())
      .parse(JSON.parse(raw))[actual.id];
  } catch {
    return refuse("Configured installation firewall bindings are invalid");
  }
  if (configured) {
    if (claim && claim.firewall_id !== configured)
      return refuse(
        "Configured firewall differs from the permanent allocation claim",
      );
    const firewall = await provider.getFirewall(configured, request());
    if (firewall.firewallId !== configured || !owned(firewall, actual))
      return refuse(
        "Configured installation firewall is not owned by this node",
      );
    return (await current(env.DB, addition)) ? configured : null;
  }
  if (!claim) {
    if (addition.status === "ready") return null;
    const requestId = crypto.randomUUID(),
      name = `pgcf-install-${addition.intent.node_id}-${requestId}`,
      description = `pgcf-node-installation/v1:${addition.intent_hash}:${requestId}`,
      now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO node_firewall_allocations(operation_id,node_id,region_id,provider_instance_id,provider_region,product_id,image_id,intent_hash,inventory_revision,tenant_id,customer_id,request_id,name,description,state,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,'claimed',?,? WHERE ${authority} AND EXISTS(SELECT 1 FROM node_additions WHERE operation_id=? AND status IN('audited','bootstrapping')) ON CONFLICT(operation_id) DO NOTHING`,
    )
      .bind(
        operationId,
        addition.intent.node_id,
        addition.intent.request.region_id,
        actual.id,
        actual.region,
        actual.productId,
        addition.audit.image_id,
        addition.intent_hash,
        addition.revision,
        actual.tenantId,
        actual.customerId,
        requestId,
        name,
        description,
        now,
        now,
        ...authorityBindings(addition),
        operationId,
      )
      .run();
    claim = await readClaim(env.DB, operationId);
    if (!claim) return null;
    sameClaim(claim, addition, actual);
  }
  if (
    claim.state === "rejected" ||
    (claim.state === "blocked" && claim.failure_code !== "readback_unavailable")
  )
    return null;
  if (claim.state === "confirmed") return confirmedFirewall(claim);
  if (claim.state === "claimed") {
    const name = claim.name;
    let matches: ContaboFirewall[];
    try {
      matches = (await provider.listFirewalls({ name }, request())).filter(
        (row) => row.name === name,
      );
    } catch (error) {
      await readFailure(env.DB, claim, error);
      return null;
    }
    if (matches.length) {
      await blocked(env.DB, claim, "controlled_name_conflict");
      return null;
    }
    const dispatched = await env.DB.prepare(
      `UPDATE node_firewall_allocations SET state='dispatching',updated_at=? WHERE operation_id=? AND request_id=? AND state='claimed' AND ${authority} AND EXISTS(SELECT 1 FROM node_additions WHERE operation_id=? AND status IN('audited','bootstrapping'))`,
    )
      .bind(
        new Date().toISOString(),
        operationId,
        claim.request_id,
        ...authorityBindings(addition),
        operationId,
      )
      .run();
    if (dispatched.meta.changes !== 1) return null;
    let result: ContaboMutationResult<ContaboFirewall>;
    try {
      result = await provider.createFirewall(
        {
          name: claim.name,
          description: claim.description,
          status: "active",
          rules: { inbound: [] },
        },
        { requestId: claim.request_id, deadline },
      );
    } catch (error) {
      result = {
        kind: "unknown",
        code: error instanceof ContaboError ? error.code : "network_error",
        requestId: claim.request_id,
        dispatched: true,
      };
    }
    if (result.requestId !== claim.request_id)
      result = {
        kind: "unknown",
        code: "invalid_response",
        requestId: claim.request_id,
        dispatched: true,
      };
    const firewallId =
      result.kind === "accepted" ? result.value.firewallId : null;
    if (firewallId !== null && !z.uuid().safeParse(firewallId).success)
      return refuse("Firewall creation returned an invalid provider identity");
    const captured = {
      kind: result.kind,
      code: result.code,
      requestId: claim.request_id,
      dispatched: result.dispatched,
      ...("status" in result ? { status: result.status } : {}),
      ...(firewallId ? { firewallId } : {}),
    };
    // Outcome recording survives an addition revision/cancellation after dispatch. It never authorizes attachment.
    await env.DB.prepare(
      `UPDATE node_firewall_allocations SET
        state=CASE WHEN firewall_id IS NOT NULL AND ? IS NOT NULL AND firewall_id<>? THEN 'blocked'
          WHEN state IN('confirmed','blocked') THEN state ELSE ? END,
        firewall_id=COALESCE(firewall_id,?),result_json=?,
        failure_code=CASE WHEN firewall_id IS NOT NULL AND ? IS NOT NULL AND firewall_id<>? THEN 'receipt_identity_changed'
          WHEN state IN('confirmed','blocked') THEN failure_code ELSE ? END,updated_at=?
        WHERE operation_id=? AND request_id=? AND result_json IS NULL AND state IN('dispatching','accepted','unknown','confirmed','blocked')`,
    )
      .bind(
        firewallId,
        firewallId,
        result.kind,
        firewallId,
        JSON.stringify(captured),
        firewallId,
        firewallId,
        result.kind === "accepted" ? null : result.code,
        new Date().toISOString(),
        operationId,
        claim.request_id,
      )
      .run();
    claim = (await readClaim(env.DB, operationId))!;
    if (["rejected", "blocked"].includes(claim.state)) return null;
    if (claim.state === "confirmed") return confirmedFirewall(claim);
  }
  try {
    const matches = (
      await provider.listFirewalls({ name: claim.name }, request())
    ).filter((row) => row.name === claim.name);
    if (!matches.length) return null;
    if (matches.length !== 1) {
      await blocked(env.DB, claim, "ambiguous_readback");
      return null;
    }
    const candidate = matches[0]!;
    if (
      !owned(candidate, actual) ||
      !empty(candidate) ||
      candidate.description !== claim.description ||
      (claim.firewall_id !== null && candidate.firewallId !== claim.firewall_id)
    ) {
      await blocked(env.DB, claim, "unowned_readback");
      return null;
    }
    const firewall = await provider.getFirewall(
      candidate.firewallId,
      request(),
    );
    if (
      firewall.firewallId !== candidate.firewallId ||
      firewall.name !== claim.name ||
      firewall.description !== claim.description ||
      !owned(firewall, actual) ||
      !empty(firewall)
    ) {
      await blocked(env.DB, claim, "unowned_readback");
      return null;
    }
    const confirmed = await env.DB.prepare(
      `UPDATE node_firewall_allocations SET state='confirmed',firewall_id=?,failure_code=NULL,updated_at=? WHERE operation_id=? AND request_id=?
        AND (state IN('dispatching','accepted','unknown') OR (state='blocked' AND failure_code='readback_unavailable'))
        AND (firewall_id IS NULL OR firewall_id=?) AND ${authority}`,
    )
      .bind(
        firewall.firewallId,
        new Date().toISOString(),
        operationId,
        claim.request_id,
        firewall.firewallId,
        ...authorityBindings(addition),
      )
      .run();
    return confirmed.meta.changes === 1 ? firewall.firewallId : null;
  } catch (error) {
    await readFailure(env.DB, claim, error);
    return null;
  }
}
