// SPDX-License-Identifier: Apache-2.0
import { NodeBootstrapCheckpoint } from "@pgcf/contracts/node-bootstrap";
import type { NodeProofMode } from "@pgcf/contracts/node-proof";
import type { Env } from "../env.ts";
import { readNodeInstallationBinding } from "./node-installation.ts";
import { readNodeAddition, assertNodeRecoveryAuthority } from "./node-state.ts";
import { ensureNodeFirewall } from "./node-network.ts";

interface ProofDispatcher {
  prove(operationId: string, mode: NodeProofMode): Promise<{ status: string }>;
}
async function dispatch(env: Env, operationId: string, mode: NodeProofMode) {
  const dispatcher = env.NODE_BOOTSTRAP.get(
    env.NODE_BOOTSTRAP.idFromName(operationId),
  ) as unknown as ProofDispatcher;
  await dispatcher.prove(operationId, mode);
}
/** Refresh only measurements. Existing private/manual jobs retain their own accepted artifact path. */
export async function ensureNodePreparationProof(
  env: Env,
  operationId: string,
): Promise<boolean> {
  const binding = await readNodeInstallationBinding(env.DB, operationId);
  if (!binding) return true;
  const addition = await readNodeAddition(env.DB, operationId);
  await assertNodeRecoveryAuthority(env.DB, addition);
  if (addition.status === "ready") return true;
  if (
    !addition.slot_held ||
    !["audited", "bootstrapping"].includes(addition.status)
  )
    return false;
  const preparation = await env.DB.prepare(
    "SELECT status,proof_expires_at,intent_hash,readback_at FROM node_network_preparations WHERE operation_id=?",
  )
    .bind(operationId)
    .first<{
      status: string;
      proof_expires_at: string | null;
      intent_hash: string;
      readback_at: string | null;
    }>();
  const confirmed =
    preparation?.intent_hash === addition.intent_hash &&
    preparation.readback_at !== null &&
    preparation.status !== "blocked";
  if (
    confirmed &&
    preparation?.status === "verified" &&
    preparation.proof_expires_at &&
    Date.parse(preparation.proof_expires_at) > Date.now() + 60000
  )
    return true;
  if (!confirmed && !(await ensureNodeFirewall(env, operationId))) return false;
  await dispatch(env, operationId, "preparation");
  return false;
}
/** Native storage/quarantine progress must already be joined; proof never manufactures that checkpoint. */
export async function ensureNodeVerificationProof(
  env: Env,
  operationId: string,
): Promise<boolean> {
  const binding = await readNodeInstallationBinding(env.DB, operationId);
  if (!binding) return true;
  const addition = await readNodeAddition(env.DB, operationId);
  await assertNodeRecoveryAuthority(env.DB, addition);
  if (addition.status === "ready") return true;
  const row = await env.DB.prepare(
    "SELECT checkpoint_json,admitted,cancelled,authorized,admission_authorized,admission_expires_at FROM node_bootstrap_jobs WHERE operation_id=?",
  )
    .bind(operationId)
    .first<{
      checkpoint_json: string;
      admitted: number;
      cancelled: number;
      authorized: number;
      admission_authorized: number;
      admission_expires_at: string | null;
    }>();
  if (!row || row.cancelled || !row.authorized || !addition.slot_held)
    return false;
  if (row.admitted) return true;
  if (
    row.admission_authorized &&
    row.admission_expires_at &&
    Date.parse(row.admission_expires_at) > Date.now()
  )
    return true;
  const checkpoint = NodeBootstrapCheckpoint.parse(
    JSON.parse(row.checkpoint_json),
  );
  if (
    checkpoint.stage !== "awaiting_verification" ||
    addition.checkpoint?.stage !== "joined"
  )
    return false;
  await dispatch(env, operationId, "postjoin");
  return false;
}
