// SPDX-License-Identifier: Apache-2.0
import { DurableObject } from "cloudflare:workers";
import { OperationId } from "@pgcf/contracts";
import type { Env } from "./env.ts";
import {
  bootstrapJobInput,
  bootstrapJobStatus,
  readBootstrapJob,
  admissionAuthority,
} from "./domain/bootstrap-jobs.ts";
import { readNodeAddition } from "./domain/node-state.ts";
import { hasVerifiedNodePreparation } from "./domain/node-network.ts";
import { prepareNodeInspectionInput } from "./domain/node-inspection.ts";
import { loadNodeInstallationBinding } from "./domain/node-installation.ts";
import {
  NodeProofExecutionInput,
  type NodeProofMode,
} from "@pgcf/contracts/node-proof";
import { prepareNodeProofInput } from "./domain/node-proof-execution.ts";

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

export class NodeBootstrap extends DurableObject<Env> {
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
    const current = await prepareNodeInspectionInput(this.env, operationId);
    if (
      !current ||
      current.binding_sha256 !== input.binding_sha256 ||
      current.network_plan_sha256 !== input.network_plan_sha256 ||
      current.expected_generation !== input.expected_generation
    )
      throw new Error("inspection_authority_changed");
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
    const input = await prepareNodeProofInput(this.env, operationId, mode);
    if (!input) return { operation_id: operationId, status: "waiting" };
    await this.ctx.storage.put(`proof_input:${input.claims.session_id}`, input);
    await this.ctx.storage.put(
      `proof_current:${mode}`,
      input.claims.session_id,
    );
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
