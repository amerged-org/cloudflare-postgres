// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from "cloudflare:workers";
import { OperationId } from "@pgcf/contracts";
import { z } from "zod";
import type { Env } from "./env.ts";
import { ApiError } from "./app.ts";
import {
  bootstrapJobInput,
  bootstrapJobStatus,
  readBootstrapJob,
  admissionAuthority,
} from "./domain/bootstrap-jobs.ts";
import { readNodeAddition } from "./domain/node-state.ts";
import { hasVerifiedNodePreparation } from "./domain/node-network.ts";
import {
  prepareNodeInspectionInput,
  assertNodeInspectionInputCurrent,
} from "./domain/node-inspection.ts";
import { loadNodeInstallationBinding } from "./domain/node-installation.ts";
import {
  NodeInstallationInspection,
  NodeInstallationInspectionStatus,
  NodeInspectionInput,
} from "@pgcf/contracts/node-installation";
import {
  NodeProofExecutionInput,
  NodeProofMode,
  NodeProofStatus,
  NodeProofJournalStatus,
  NodeProofJournalEntry,
} from "@pgcf/contracts/node-proof";
import {
  prepareNodeProofInput,
  NodeProofSourceBinding,
  proofSourceBinding,
} from "./domain/node-proof-execution.ts";
import { canonicalNodeProof } from "@pgcf/contracts/node-proof";
import { installationHash } from "./domain/node-installation.ts";

const nativeAdmissionCodes = new Set([
  "container_busy",
  "job_input_required",
  "job_identity_conflict",
  "request_invalid",
  "unauthorized",
  "route_unknown",
  "method_refused",
  "admission_not_authorized",
  "admission_checkpoint_mismatch",
  "admission_binding_changed",
  "admission_bundle_missing",
  "admission_precondition_changed",
  "admission_node_identity_mismatch",
  "quarantine_taint_mismatch",
  "quarantine_release_unconfirmed",
  "cluster_uid_mismatch",
  "join_bundle_identity_mismatch",
  "kubeconfig_cluster_invalid",
  "kubeconfig_identity_invalid",
  "kubeconfig_credentials_invalid",
  "checkpoint_conflict",
  "checkpoint_not_committed",
  "authority_refused",
  "authority_identity_mismatch",
  "authority_response_limit",
  "job_unauthorized",
  "node_already_admitted",
  "job_cancelled",
  "checkpoint_invalid",
  "readback_invalid",
]);
async function nativeAdmissionCode(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("native_admission_body_timeout"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      signal.throwIfAborted();
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 2048) return null;
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const code: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    )?.error_code;
    if (typeof code !== "string") return null;
    if (nativeAdmissionCodes.has(code)) return code;
    const command =
      /^native_command_failed_(?:ssh|ssh_keygen|talosctl|kubectl|helm)_([1-9][0-9]{0,2})$/.exec(
        code,
      );
    return command && Number(command[1]) <= 255 ? code : null;
  } catch {
    return null;
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}

const nativeInspectionStatus = NodeInstallationInspectionStatus.pick({
  operation_id: true,
  binding_sha256: true,
  error_code: true,
}).safeExtend({
  expected_generation:
    NodeInstallationInspectionStatus.shape.inspection_generation,
  network_plan_sha256:
    NodeInstallationInspectionStatus.shape.network_plan_sha256.unwrap(),
  status: z.enum(["running", "reported", "failed"]),
});
const nativeProofStatus = NodeProofStatus.pick({
  operation_id: true,
  mode: true,
  error_code: true,
}).safeExtend({
  session_id: NodeProofStatus.shape.session_id.unwrap(),
  status: z.enum(["running", "reported", "failed"]),
});
async function inspectionStatusBody(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("inspection_status_invalid");
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("inspection_status_unavailable"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      signal.throwIfAborted();
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 2048) throw new Error("inspection_status_invalid");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}

async function statusIdentifierHash(value: string) {
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export class NodeBootstrap extends DurableObject<Env> {
  private proofTurn: Promise<void> = Promise.resolve();
  async #registrationAuthority(operationId: string, admission: boolean) {
    const row = await readBootstrapJob(this.env.DB, operationId),
      addition = await readNodeAddition(this.env.DB, operationId);
    if (
      !row.authorized ||
      row.admitted ||
      row.cancelled ||
      !["audited", "bootstrapping"].includes(addition.status)
    )
      throw new Error("bootstrap_job_closed");
    if (admission) {
      if (!(await admissionAuthority(this.env, row)).admission_authorized)
        throw new Error("bootstrap_admission_not_authorized");
    } else if (
      !(await hasVerifiedNodePreparation(
        this.env.DB,
        operationId,
        addition.intent_hash,
      ))
    )
      throw new Error("bootstrap_network_preparation_required");
    return row;
  }
  async #waitForPort(container: NonNullable<DurableObjectState["container"]>) {
    const deadline = Date.now() + 30_000,
      signal = AbortSignal.timeout(30_000),
      port = container.getTcpPort(8080);
    while (!signal.aborted && Date.now() < deadline) {
      try {
        // An unauthenticated GET reaches the server without registering or running a job.
        const response = await port.fetch(
          new Request("http://localhost:8080/", { signal }),
        );
        await response.body?.cancel();
        if (!signal.aborted && Date.now() < deadline) return;
      } catch {
        // Only read-only probes may retry; registration POSTs retain their single attempt.
      }
      const remaining = deadline - Date.now();
      if (signal.aborted || remaining <= 0) break;
      try {
        await scheduler.wait(Math.min(200, remaining), { signal });
      } catch {
        break;
      }
    }
    throw new Error("bootstrap_container_port_timeout");
  }
  async #register(operationId: string, admission = false) {
    OperationId.parse(operationId);
    if (!this.ctx.id.equals(this.env.NODE_BOOTSTRAP.idFromName(operationId)))
      throw new Error("bootstrap_container_identity_mismatch");
    const row = await this.#registrationAuthority(operationId, admission);
    const input = await bootstrapJobInput(this.env, row),
      container = this.ctx.container;
    let serverBearer = input.callback.bearer;
    const inspectionMarker = await this.ctx.storage.get<string>(
      "inspection_server_binding_sha256",
    );
    if (inspectionMarker !== undefined) {
      const binding = await loadNodeInstallationBinding(this.env, operationId);
      if (!binding || binding.row.binding_sha256 !== inspectionMarker)
        throw new Error("inspection_server_identity_changed");
      serverBearer = binding.inspection_token;
    }
    if (!container) throw new Error("bootstrap_container_unavailable");
    if (!container.running)
      container.start({
        enableInternet: true,
        env: {
          PORT: "8080",
          PGCF_BOOTSTRAP_SERVER_BEARER: serverBearer,
        },
      });
    await container.setInactivityTimeout(600_000);
    await this.ctx.storage.setAlarm(Date.now() + 600_000);
    await this.#waitForPort(container);
    const current = await this.#registrationAuthority(operationId, admission);
    if (current.input_hash !== row.input_hash)
      throw new Error("bootstrap_container_input_changed");
    const response = await container.getTcpPort(8080).fetch(
      new Request("http://localhost:8080/v1/jobs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serverBearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(30_000),
      }),
    );
    await response.body?.cancel();
    if (!response.ok) throw new Error("bootstrap_container_refused");
    return { input, container, serverBearer };
  }
  async inspect(operationId: string) {
    OperationId.parse(operationId);
    if (!this.ctx.id.equals(this.env.NODE_BOOTSTRAP.idFromName(operationId)))
      throw new Error("bootstrap_container_identity_mismatch");
    const input = await prepareNodeInspectionInput(this.env, operationId);
    if (!input) return { operation_id: operationId, status: "waiting" };
    const container = this.ctx.container;
    if (!container) throw new Error("inspection_container_unavailable");
    const marker = await this.ctx.storage.get<string>(
      "inspection_server_binding_sha256",
    );
    if (
      (marker !== undefined && marker !== input.binding_sha256) ||
      (container.running && marker === undefined)
    )
      throw new Error("inspection_server_identity_changed");
    await this.ctx.storage.put(
      "inspection_server_binding_sha256",
      input.binding_sha256,
    );
    await this.ctx.storage.put("inspection_input", input);
    if (!container.running)
      container.start({
        enableInternet: true,
        env: {
          PORT: "8080",
          PGCF_BOOTSTRAP_SERVER_BEARER: input.callback.bearer,
        },
      });
    await container.setInactivityTimeout(600000);
    await this.ctx.storage.setAlarm(Date.now() + 600000);
    await this.#waitForPort(container);
    await assertNodeInspectionInputCurrent(this.env, operationId, input);
    const current = input;
    const response = await container.getTcpPort(8080).fetch(
      new Request("http://localhost:8080/v1/inspections", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.callback.bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(current),
        signal: AbortSignal.timeout(30000),
      }),
    );
    await response.body?.cancel();
    if (!response.ok) throw new Error("inspection_container_refused");
    return {
      operation_id: operationId,
      expected_generation: current.expected_generation,
      status: "running",
    };
  }
  /** Observe only the existing inspector; this never starts a Container or registers work. */
  async inspectionStatus(operationId: string) {
    OperationId.parse(operationId);
    if (!this.ctx.id.equals(this.env.NODE_BOOTSTRAP.idFromName(operationId)))
      throw new Error("bootstrap_container_identity_mismatch");
    const binding = await loadNodeInstallationBinding(this.env, operationId);
    if (!binding)
      throw new ApiError("not_found", "Installation binding unavailable");
    const { row } = binding,
      addition = await readNodeAddition(this.env.DB, operationId),
      plan = await this.env.DB.prepare(
        "SELECT intent_hash,plan_sha256,status FROM node_network_preparations WHERE operation_id=?",
      )
        .bind(operationId)
        .first<{ intent_hash: string; plan_sha256: string; status: string }>();
    const base = {
      operation_id: operationId,
      inspection_generation: row.inspection_generation,
      binding_sha256: row.binding_sha256,
      network_plan_sha256: plan?.plan_sha256 ?? null,
      observed_at: null as string | null,
    };
    const unavailable = (
      error_code:
        | "inspection_status_invalid"
        | "inspection_status_unavailable"
        | "inspection_server_identity_changed"
        | "inspection_authority_closed"
        | "inspection_input_required",
    ) =>
      NodeInstallationInspectionStatus.parse({
        ...base,
        status: "unavailable",
        error_code,
      });
    if (
      row.operation_id !== operationId ||
      row.node_id !== addition.intent.node_id ||
      row.region_id !== addition.intent.request.region_id ||
      row.provider_instance_id !== addition.provider_instance_id ||
      !plan ||
      plan.intent_hash !== addition.intent_hash ||
      plan.status === "blocked"
    )
      return unavailable("inspection_status_invalid");
    if (row.inspection_json) {
      const observed = NodeInstallationInspection.safeParse(
        JSON.parse(row.inspection_json),
      );
      if (
        !observed.success ||
        observed.data.operation_id !== operationId ||
        observed.data.node_id !== row.node_id ||
        observed.data.region_id !== row.region_id ||
        observed.data.provider_instance_id !== row.provider_instance_id ||
        observed.data.profile_sha256 !== row.profile_sha256 ||
        observed.data.binding_sha256 !== row.binding_sha256 ||
        observed.data.network_plan_sha256 !== plan.plan_sha256
      )
        return unavailable("inspection_status_invalid");
      return NodeInstallationInspectionStatus.parse({
        ...base,
        status: "reported",
        error_code: null,
        observed_at: observed.data.observed_at,
      });
    }
    if (
      !addition.slot_held ||
      !["audited", "bootstrapping"].includes(addition.status)
    )
      return unavailable("inspection_authority_closed");
    const container = this.ctx.container;
    if (!container?.running)
      return unavailable("inspection_status_unavailable");
    if (
      (await this.ctx.storage.get<string>(
        "inspection_server_binding_sha256",
      )) !== row.binding_sha256
    )
      return unavailable("inspection_server_identity_changed");
    const signal = AbortSignal.timeout(5000);
    let response: Response | undefined;
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("inspection_status_unavailable"));
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      response = await Promise.race([
        container.getTcpPort(8080).fetch(
          new Request(`http://localhost:8080/v1/inspections/${operationId}`, {
            headers: { Authorization: `Bearer ${binding.inspection_token}` },
            signal,
          }),
        ),
        aborted,
      ]);
      const raw = await inspectionStatusBody(response, signal);
      if (
        response.status === 404 &&
        z
          .strictObject({ error_code: z.literal("inspection_input_required") })
          .safeParse(raw).success
      )
        return unavailable("inspection_input_required");
      const native = nativeInspectionStatus.safeParse(raw);
      if (
        response.status !== 200 ||
        !native.success ||
        native.data.operation_id !== operationId ||
        native.data.expected_generation !== row.inspection_generation ||
        native.data.binding_sha256 !== row.binding_sha256 ||
        native.data.network_plan_sha256 !== plan.plan_sha256 ||
        (native.data.status === "failed"
          ? native.data.error_code === null
          : native.data.error_code !== null)
      )
        return unavailable("inspection_status_invalid");
      const current = await loadNodeInstallationBinding(this.env, operationId),
        currentPlan = await this.env.DB.prepare(
          "SELECT plan_sha256 FROM node_network_preparations WHERE operation_id=?",
        )
          .bind(operationId)
          .first<{ plan_sha256: string }>();
      if (
        !current ||
        current.row.binding_sha256 !== row.binding_sha256 ||
        current.row.inspection_generation !== row.inspection_generation ||
        currentPlan?.plan_sha256 !== plan.plan_sha256
      )
        return unavailable("inspection_status_invalid");
      return NodeInstallationInspectionStatus.parse({
        ...base,
        status: native.data.status,
        error_code: native.data.error_code,
      });
    } catch (error) {
      return unavailable(
        error instanceof Error && error.message === "inspection_status_invalid"
          ? "inspection_status_invalid"
          : "inspection_status_unavailable",
      );
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
      void response?.body?.cancel().catch(() => {});
    }
  }
  async #proofObservation(operationId: string, mode: NodeProofMode) {
    OperationId.parse(operationId);
    NodeProofMode.parse(mode);
    if (!this.ctx.id.equals(this.env.NODE_BOOTSTRAP.idFromName(operationId)))
      throw new Error("proof_container_identity_mismatch");
    const binding = await loadNodeInstallationBinding(this.env, operationId);
    if (!binding)
      throw new ApiError("not_found", "Installation binding unavailable");
    const plan = await this.env.DB.prepare(
      "SELECT intent_hash,plan_sha256,status,readback_at FROM node_network_preparations WHERE operation_id=?",
    )
      .bind(operationId)
      .first<{
        intent_hash: string;
        plan_sha256: string;
        status: string;
        readback_at: string | null;
      }>();
    const session = NodeProofStatus.shape.session_id.safeParse(
      (await this.ctx.storage.get<string>(`proof_current:${mode}`)) ?? null,
    );
    const raw =
      session.success && session.data
        ? await this.ctx.storage.get<NodeProofExecutionInput>(
            `proof_input:${session.data}`,
          )
        : undefined;
    const parsed = NodeProofExecutionInput.safeParse(raw);
    const base = {
      operation_id: operationId,
      mode,
      session_id: session.success ? session.data : null,
      binding_sha256: binding.row.binding_sha256,
      plan_sha256: plan?.plan_sha256 ?? null,
      input_hash: parsed.success ? parsed.data.claims.input_hash : null,
    };
    const unavailable = (
      error_code:
        | "proof_status_invalid"
        | "proof_status_unavailable"
        | "proof_input_required"
        | "proof_server_identity_changed"
        | "proof_authority_closed",
    ) => ({
      base,
      binding,
      input: null,
      error_code,
      recheck: async () => error_code,
    });
    if (!session.success) return unavailable("proof_status_invalid");
    if (!session.data || raw === undefined)
      return unavailable("proof_input_required");
    if (!parsed.success || !plan) return unavailable("proof_status_invalid");
    const input = parsed.data,
      claims = input.claims,
      inputDigest = await installationHash(input);
    const authority = async () => {
      const current = await loadNodeInstallationBinding(this.env, operationId),
        addition = await readNodeAddition(this.env.DB, operationId),
        currentPlan = await this.env.DB.prepare(
          "SELECT intent_hash,plan_sha256,status,readback_at FROM node_network_preparations WHERE operation_id=?",
        )
          .bind(operationId)
          .first<typeof plan>(),
        job = await this.env.DB.prepare(
          "SELECT node_id,region_id,input_hash,authorized,admitted,cancelled FROM node_bootstrap_jobs WHERE operation_id=?",
        )
          .bind(operationId)
          .first<{
            node_id: string;
            region_id: string;
            input_hash: string;
            authorized: number;
            admitted: number;
            cancelled: number;
          }>();
      if (
        !addition.slot_held ||
        !["audited", "bootstrapping"].includes(addition.status) ||
        !job?.authorized ||
        job.admitted ||
        job.cancelled
      )
        return "proof_authority_closed" as const;
      if (
        !current ||
        !currentPlan ||
        currentPlan.status === "blocked" ||
        !currentPlan.readback_at ||
        claims.operation_id !== operationId ||
        claims.mode !== mode ||
        claims.session_id !== session.data ||
        current.row.binding_sha256 !== binding.row.binding_sha256 ||
        current.row.inspection_generation !== claims.inspection_generation ||
        claims.binding_sha256 !== current.row.binding_sha256 ||
        claims.node_id !== current.row.node_id ||
        claims.region_id !== current.row.region_id ||
        claims.provider_instance_id !== current.row.provider_instance_id ||
        current.row.node_id !== addition.intent.node_id ||
        current.row.region_id !== addition.intent.request.region_id ||
        current.row.provider_instance_id !== addition.provider_instance_id ||
        currentPlan.intent_hash !== addition.intent_hash ||
        currentPlan.plan_sha256 !== plan.plan_sha256 ||
        claims.plan_sha256 !== currentPlan.plan_sha256 ||
        input.binding.plan_sha256 !== currentPlan.plan_sha256 ||
        input.binding.readback_at !== currentPlan.readback_at ||
        job.node_id !== claims.node_id ||
        job.region_id !== claims.region_id ||
        job.input_hash !== claims.input_hash ||
        input.bootstrap.input_hash !== job.input_hash ||
        (mode === "postjoin" &&
          (addition.checkpoint?.stage !== "joined" ||
            addition.checkpoint.reference !== claims.checkpoint_reference)) ||
        (await this.ctx.storage.get<string>(`proof_current:${mode}`)) !==
          session.data ||
        (await installationHash(
          await this.ctx.storage.get(`proof_input:${session.data}`),
        )) !== inputDigest
      )
        return "proof_status_invalid" as const;
      if (
        (await this.ctx.storage.get<string>(
          "inspection_server_binding_sha256",
        )) !== binding.row.binding_sha256
      )
        return "proof_server_identity_changed" as const;
      return null;
    };
    const initial = await authority();
    if (initial) return unavailable(initial);
    return { base, binding, input, error_code: null, recheck: authority };
  }
  /** Observe only the existing native proof; no registration or retry changes. */
  async proofStatus(operationId: string, mode: NodeProofMode) {
    const state = await this.#proofObservation(operationId, mode),
      { base, binding } = state;
    const unavailable = (error_code: string) =>
      NodeProofStatus.parse({ ...base, status: "unavailable", error_code });
    if (state.error_code) return unavailable(state.error_code);
    const container = this.ctx.container;
    if (!container?.running) return unavailable("proof_status_unavailable");
    const signal = AbortSignal.timeout(5000);
    let response: Response | undefined;
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("proof_status_unavailable"));
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      response = await Promise.race([
        container.getTcpPort(8080).fetch(
          new Request(
            `http://localhost:8080/v1/proofs/${operationId}/${mode}`,
            {
              headers: { Authorization: `Bearer ${binding.inspection_token}` },
              signal,
            },
          ),
        ),
        aborted,
      ]);
      const body = await inspectionStatusBody(response, signal),
        changed = await state.recheck();
      if (changed) return unavailable(changed);
      if (
        response.status === 404 &&
        z
          .strictObject({ error_code: z.literal("proof_input_required") })
          .safeParse(body).success
      )
        return unavailable("proof_input_required");
      const native = nativeProofStatus.safeParse(body);
      if (
        response.status !== 200 ||
        !native.success ||
        native.data.operation_id !== operationId ||
        native.data.mode !== mode ||
        native.data.session_id !== base.session_id ||
        (native.data.status === "failed"
          ? native.data.error_code === null
          : native.data.error_code !== null)
      )
        return unavailable("proof_status_invalid");
      return NodeProofStatus.parse({
        ...base,
        status: native.data.status,
        error_code: native.data.error_code,
      });
    } catch (error) {
      return unavailable(
        error instanceof Error && error.message === "inspection_status_invalid"
          ? "proof_status_invalid"
          : "proof_status_unavailable",
      );
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
      void response?.body?.cancel().catch(() => {});
    }
  }
  /** Summarize retained source journals locally; never contact or wake the Container. */
  async proofJournalStatus(operationId: string) {
    const state = await this.#proofObservation(operationId, "preparation"),
      base = {
        ...state.base,
        issued_at: state.input?.claims.issued_at ?? null,
        expires_at: state.input?.claims.expires_at ?? null,
      };
    const unavailable = (error_code: string) =>
      NodeProofJournalStatus.parse({
        ...base,
        status: "unavailable",
        error_code,
        journals: [],
      });
    if (state.error_code) return unavailable(state.error_code);
    const prefix = "proof_owner:source:",
      rows = await this.ctx.storage.list<Record<string, unknown>>({
        prefix,
        limit: 65,
      });
    if (rows.size > 64) return unavailable("proof_journal_limit");
    const journals = [];
    const uid = z.uuid().nullable();
    for (const [key, value] of rows) {
      const id = key.slice(prefix.length),
        record = value?.state;
      if (
        !/^[a-f0-9]{64}$/.test(id) ||
        !z.uuid().safeParse(value?.session_id).success ||
        !record ||
        typeof record !== "object" ||
        Array.isArray(record)
      )
        return unavailable("proof_status_invalid");
      const journal = record as Record<string, unknown>,
        stage = NodeProofJournalEntry.shape.stage.safeParse(journal.stage),
        namespace = uid.safeParse(journal.namespace_uid),
        pod = uid.safeParse(journal.pod_uid);
      if (!stage.success || !namespace.success || !pod.success)
        return unavailable("proof_status_invalid");
      journals.push({
        key_sha256: await statusIdentifierHash(id),
        stage: stage.data,
        namespace_uid_sha256:
          namespace.data === null
            ? null
            : await statusIdentifierHash(namespace.data),
        pod_uid_sha256:
          pod.data === null ? null : await statusIdentifierHash(pod.data),
        matches_current_session: value.session_id === state.base.session_id,
      });
    }
    const changed = await state.recheck();
    if (changed) return unavailable(changed);
    const result = NodeProofJournalStatus.parse({
      ...base,
      status: "observed",
      error_code: null,
      journals,
    });
    if (new TextEncoder().encode(JSON.stringify(result)).length > 32768)
      return unavailable("proof_journal_limit");
    return result;
  }
  async getProofInput(
    operationId: string,
    sessionId: string,
  ): Promise<NodeProofExecutionInput | null> {
    if (
      !this.ctx.id.equals(
        this.env.NODE_BOOTSTRAP.idFromName(OperationId.parse(operationId)),
      )
    )
      throw new Error("proof_container_identity_mismatch");
    if (!/^[a-f0-9-]{36}$/.test(sessionId))
      throw new Error("proof_session_invalid");
    return (
      (await this.ctx.storage.get<NodeProofExecutionInput>(
        `proof_input:${sessionId}`,
      )) ?? null
    );
  }
  /** Read the sealed initial inspection assignment; never prepare or start work. */
  async getInspectionInput(
    operationId: string,
  ): Promise<NodeInspectionInput | null> {
    OperationId.parse(operationId);
    if (!this.ctx.id.equals(this.env.NODE_BOOTSTRAP.idFromName(operationId)))
      throw new Error("bootstrap_container_identity_mismatch");
    const raw = await this.ctx.storage.get("inspection_input");
    if (raw === undefined) return null;
    const input = NodeInspectionInput.parse(raw);
    await assertNodeInspectionInputCurrent(this.env, operationId, input);
    return input;
  }
  async proofOwnership(
    operationId: string,
    sessionId: string,
    request: {
      action: "read" | "save" | "expired";
      kind: "source" | "postjoin";
      key?: string;
      state?: unknown;
      originalInput?: unknown;
      publicSource?: unknown;
    },
  ) {
    const input = await this.getProofInput(operationId, sessionId);
    if (!input) throw new Error("proof_input_unavailable");
    const prefix = `proof_owner:${request.kind}:`;
    if (request.action === "expired") {
      const rows = await this.ctx.storage.list<Record<string, unknown>>({
        prefix,
        limit: 65,
      });
      if (rows.size > 64) throw new Error("proof_ownership_limit");
      return {
        entries: [...rows.entries()]
          .filter(
            ([, value]) =>
              value.session_id !== sessionId &&
              (value.state as { stage?: string })?.stage !== "cleaned",
          )
          .map(([key, value]) => ({ key: key.slice(prefix.length), ...value })),
      };
    }
    const key = request.key;
    if (
      !key ||
      !(request.kind === "source" ? /^[a-f0-9]{64}$/ : /^[a-f0-9-]{36}$/).test(
        key,
      )
    )
      throw new Error("proof_ownership_key_invalid");
    let location = prefix + key;
    let previous =
      await this.ctx.storage.get<Record<string, unknown>>(location);
    if (request.action === "read") {
      if (!previous && request.kind === "postjoin") {
        const alias = await this.ctx.storage.get<string>(
          `proof_owner_alias:${sessionId}`,
        );
        if (alias) {
          const retained =
            await this.ctx.storage.get<Record<string, unknown>>(alias);
          if (!retained) throw new Error("proof_cleanup_ownership_missing");
          return { entry: retained };
        }
        const rows = await this.ctx.storage.list<Record<string, unknown>>({
          prefix,
          limit: 65,
        });
        if (rows.size > 64) throw new Error("proof_ownership_limit");
        const dirty = [...rows.entries()].filter(
          ([, entry]) =>
            (entry.state as { stage?: string })?.stage !== "cleaned",
        );
        if (dirty.length > 1)
          throw new Error("proof_cleanup_ownership_ambiguous");
        if (dirty[0]) {
          await this.ctx.storage.put(
            `proof_owner_alias:${sessionId}`,
            dirty[0][0],
          );
          return { entry: dirty[0][1] };
        }
      }
      return { entry: previous ?? null };
    }
    const state = request.state;
    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      JSON.stringify(request).length > 512 * 1024
    )
      throw new Error("proof_ownership_invalid");
    const next = state as Record<string, unknown>,
      alias =
        request.kind === "postjoin"
          ? await this.ctx.storage.get<string>(`proof_owner_alias:${sessionId}`)
          : undefined;
    if (alias && next.session_id !== sessionId) {
      location = alias;
      previous = await this.ctx.storage.get<Record<string, unknown>>(alias);
    }
    const old = previous?.state as Record<string, unknown> | undefined;
    if (old) {
      for (const field of [
        "source_sha256",
        "input_sha256",
        "invocation_id",
        "kind",
        "namespace_name",
        "namespace_uid",
        "pod_uid",
        "scratch_directory",
        "mount_source",
        "node_sha256",
        "node_bytes",
        "cli_sha256",
        "cli_bytes",
        "traffic_nonce",
        "session_id",
        "input_hash",
        "plan_sha256",
        "receipt_sha256",
      ])
        if (
          old[field] !== undefined &&
          old[field] !== null &&
          JSON.stringify(old[field]) !== JSON.stringify(next[field])
        )
          throw new Error("proof_ownership_identity_changed");
      if (
        old.namespace_create_attempted === true &&
        next.namespace_create_attempted !== true
      )
        throw new Error("proof_ownership_identity_changed");
      if (Array.isArray(old.pods)) {
        if (!Array.isArray(next.pods) || next.pods.length !== old.pods.length)
          throw new Error("proof_ownership_identity_changed");
        for (const entry of old.pods) {
          const pod = entry as Record<string, unknown>;
          const replacement = next.pods.find(
            (value: unknown) =>
              value &&
              typeof value === "object" &&
              (value as Record<string, unknown>).name === pod.name,
          ) as Record<string, unknown> | undefined;
          if (
            !replacement ||
            ["name", "node_name", "node_uid", "role"].some(
              (field) => pod[field] !== replacement[field],
            ) ||
            (pod.uid !== null &&
              pod.uid !== undefined &&
              pod.uid !== replacement.uid) ||
            (pod.create_attempted === true &&
              replacement.create_attempted !== true)
          )
            throw new Error("proof_ownership_identity_changed");
        }
      }
      if (
        previous!.originalInput !== undefined &&
        JSON.stringify(previous!.originalInput) !==
          JSON.stringify(request.originalInput)
      )
        throw new Error("proof_ownership_input_changed");
      if (
        previous!.publicSource !== undefined &&
        JSON.stringify(previous!.publicSource) !==
          JSON.stringify(request.publicSource)
      )
        throw new Error("proof_ownership_source_changed");
      const stages = [
        "intent",
        "ready",
        "running",
        "measured",
        "cleanup",
        "cleaned",
      ];
      if (
        typeof old.stage === "string" &&
        typeof next.stage === "string" &&
        stages.includes(old.stage) &&
        stages.indexOf(next.stage) < stages.indexOf(old.stage)
      )
        throw new Error("proof_ownership_rewind");
    }
    await this.ctx.storage.put(location, {
      session_id: previous?.session_id ?? sessionId,
      state,
      ...(request.originalInput !== undefined
        ? { originalInput: request.originalInput }
        : {}),
      ...(request.publicSource !== undefined
        ? { publicSource: request.publicSource }
        : {}),
    });
    return { saved: true };
  }
  async prove(operationId: string, mode: NodeProofMode) {
    const previous = this.proofTurn;
    let release!: () => void;
    this.proofTurn = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.proveSerial(operationId, mode);
    } finally {
      release();
    }
  }
  private async proveSerial(operationId: string, mode: NodeProofMode) {
    OperationId.parse(operationId);
    if (!this.ctx.id.equals(this.env.NODE_BOOTSTRAP.idFromName(operationId)))
      throw new Error("proof_container_identity_mismatch");
    const container = this.ctx.container;
    if (!container) throw new Error("proof_container_unavailable");
    const binding = await loadNodeInstallationBinding(this.env, operationId);
    if (!binding) return { operation_id: operationId, status: "waiting" };
    const marker = await this.ctx.storage.get<string>(
      "inspection_server_binding_sha256",
    );
    if (
      (marker !== undefined && marker !== binding.row.binding_sha256) ||
      (container.running && marker === undefined)
    )
      throw new Error("proof_server_identity_changed");
    await this.ctx.storage.put(
      "inspection_server_binding_sha256",
      binding.row.binding_sha256,
    );
    if (!container.running)
      container.start({
        enableInternet: true,
        env: {
          PORT: "8080",
          PGCF_BOOTSTRAP_SERVER_BEARER: binding.inspection_token,
        },
      });
    await container.setInactivityTimeout(600000);
    await this.ctx.storage.setAlarm(Date.now() + 600000);
    await this.#waitForPort(container);
    const oldSession = await this.ctx.storage.get<string>(
      `proof_current:${mode}`,
    );
    if (oldSession) {
      const response = await container.getTcpPort(8080).fetch(
        new Request(`http://localhost:8080/v1/proofs/${operationId}/${mode}`, {
          headers: { Authorization: `Bearer ${binding.inspection_token}` },
          signal: AbortSignal.timeout(10000),
        }),
      );
      if (response.ok) {
        const text = await response.text();
        if (text.length > 4096) throw new Error("proof_status_limit");
        const status = JSON.parse(text) as { status: string };
        if (status.status === "running")
          return { operation_id: operationId, status: "running" };
      } else await response.body?.cancel();
    }
    let sourceBinding = await this.ctx.storage.get<NodeProofSourceBinding>(
      "proof_source_binding",
    );
    if (sourceBinding === undefined) {
      // Earlier versions already persisted provider-verified input. Adopt its
      // association only; fresh claims and current CF authority are checked below.
      for (const previousMode of ["preparation", "postjoin"] as const) {
        const previousSession = await this.ctx.storage.get<string>(
          `proof_current:${previousMode}`,
        );
        if (!previousSession) continue;
        const previous = await this.ctx.storage.get(
          `proof_input:${previousSession}`,
        );
        if (previous === undefined)
          throw new Error("proof_source_binding_missing");
        const candidate = proofSourceBinding(
          NodeProofExecutionInput.parse(previous),
        );
        if (
          sourceBinding &&
          canonicalNodeProof(sourceBinding) !== canonicalNodeProof(candidate)
        )
          throw new Error("proof_source_binding_changed");
        sourceBinding = candidate;
      }
    }
    const input = await prepareNodeProofInput(this.env, operationId, mode, {
      sourceBinding,
    });
    if (!input) return { operation_id: operationId, status: "waiting" };
    const association = proofSourceBinding(input);
    await this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get("proof_source_binding");
      if (
        stored !== undefined &&
        canonicalNodeProof(NodeProofSourceBinding.parse(stored)) !==
          canonicalNodeProof(association)
      )
        throw new Error("proof_source_binding_changed");
      if (stored === undefined)
        await txn.put("proof_source_binding", association);
      await txn.put(`proof_input:${input.claims.session_id}`, input);
      await txn.put(`proof_current:${mode}`, input.claims.session_id);
    });
    const response = await container.getTcpPort(8080).fetch(
      new Request("http://localhost:8080/v1/proofs", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${binding.inspection_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(30000),
      }),
    );
    await response.body?.cancel();
    if (!response.ok) throw new Error("proof_container_refused");
    return {
      operation_id: operationId,
      status: "running",
      session_id: input.claims.session_id,
    };
  }
  async start(operationId: string) {
    OperationId.parse(operationId);
    if (!this.ctx.id.equals(this.env.NODE_BOOTSTRAP.idFromName(operationId)))
      throw new Error("bootstrap_container_identity_mismatch");
    const row = await readBootstrapJob(this.env.DB, operationId);
    if (
      [
        "awaiting_verification",
        "quarantine_release_intent",
        "quarantine_released",
      ].includes(JSON.parse(row.checkpoint_json).stage)
    )
      return bootstrapJobStatus(row);
    await this.#register(operationId);
    return bootstrapJobStatus(await readBootstrapJob(this.env.DB, operationId));
  }
  async admit(operationId: string) {
    OperationId.parse(operationId);
    if (!this.ctx.id.equals(this.env.NODE_BOOTSTRAP.idFromName(operationId)))
      throw new Error("bootstrap_container_identity_mismatch");
    const row = await readBootstrapJob(this.env.DB, operationId);
    if (!(await admissionAuthority(this.env, row)).admission_authorized)
      throw new Error("bootstrap_admission_not_authorized");
    const { container, serverBearer } = await this.#register(operationId, true);
    const signal = AbortSignal.timeout(30_000);
    const response = await container.getTcpPort(8080).fetch(
      new Request(`http://localhost:8080/v1/jobs/${operationId}/admit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serverBearer}` },
        signal,
      }),
    );
    if (!response.ok) {
      const code = await nativeAdmissionCode(response, signal);
      throw new Error(
        code
          ? `bootstrap_admission_unconfirmed_${response.status}_${code}`
          : "bootstrap_admission_unconfirmed",
      );
    }
    await response.body?.cancel();
    return bootstrapJobStatus(await readBootstrapJob(this.env.DB, operationId));
  }
  async status(operationId: string) {
    OperationId.parse(operationId);
    if (!this.ctx.id.equals(this.env.NODE_BOOTSTRAP.idFromName(operationId)))
      throw new Error("bootstrap_container_identity_mismatch");
    return bootstrapJobStatus(await readBootstrapJob(this.env.DB, operationId));
  }
  override async alarm() {
    await this.ctx.container?.destroy();
  }
}
